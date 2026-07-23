import { cpus, release } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { validateConfirmatoryBinding } from "./cohort.js";
import {
  deriveEvaluationSummary,
  validateLifecycleChecks,
} from "./evaluation.js";
import { canonicalJson, hashInstructionSet, sha256 } from "./hash.js";
import { deriveProviderCost } from "./pricing.js";
import { resolveProvisioningConfiguration } from "./provisioning.js";
import {
  writeImmutableRunResult,
  type WrittenRunResult,
} from "./result-store.js";
import {
  createUnavailableProviderUsage,
  deriveAccountedTokens,
  TelemetryRecorder,
  validateProviderUsage,
} from "./telemetry.js";
import {
  HARNESS_SCHEMA_VERSION,
  type AgentAdapter,
  type AgentAdapterResult,
  type AgentArtifactInput,
  type AgentExecutionOutcome,
  type BenchmarkLifecycleHooks,
  type BenchmarkProvisioningPlan,
  type ConfirmatoryEvidence,
  type ConfirmatoryRunBinding,
  type ConfirmatorySandboxVerification,
  type EnvironmentSnapshot,
  type EvaluationSummary,
  type EvaluatorExecutionOutcome,
  type ExecutionMode,
  type ExternalProviderGate,
  type FinalizationOutcome,
  type FixtureSource,
  type InstructionSet,
  type LifecycleCheck,
  type PatchSummary,
  type PricingSnapshot,
  type RunCompletionStatus,
  type RunEnvironmentInput,
  type RunIdentity,
} from "./types.js";
import {
  createNormalizedWorkspacePatch,
  diffWorkspaceSnapshots,
  hashProtectedWorkspaceManifest,
  materializeWorkspace,
  PathConfinementError,
  serializeWorkspaceManifest,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "./workspace.js";

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface BenchmarkRunOptions {
  readonly mode: ExecutionMode;
  readonly identity: RunIdentity;
  readonly fixture: FixtureSource;
  readonly workspaceRunsRoot: string;
  readonly resultsRoot: string;
  readonly instructions: InstructionSet;
  readonly adapter: AgentAdapter;
  readonly hooks?: BenchmarkLifecycleHooks;
  readonly provisioning?: BenchmarkProvisioningPlan;
  readonly timeoutMs: number;
  readonly lifecycleTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly confirmatory?: ConfirmatoryRunBinding;
  readonly pricing: PricingSnapshot | null;
  readonly environment: RunEnvironmentInput;
  readonly generatedPathPrefixes?: readonly string[];
  readonly signal?: AbortSignal;
  readonly externalProviderGate?: ExternalProviderGate;
}

export interface BenchmarkRunOutput extends WrittenRunResult {
  readonly workspacePath: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const positiveDuration = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive and finite.`);
  }
};

const validateIdentity = (identity: RunIdentity): void => {
  if (
    identity.schemaVersion !== HARNESS_SCHEMA_VERSION ||
    identity.task.schemaVersion !== HARNESS_SCHEMA_VERSION
  ) {
    throw new TypeError("Unsupported run or task schema version.");
  }
  if (
    identity.runId.trim().length === 0 ||
    identity.task.id.trim().length === 0 ||
    !Number.isSafeInteger(identity.task.version) ||
    identity.task.version < 1 ||
    !Number.isSafeInteger(identity.repetition) ||
    identity.repetition < 1
  ) {
    throw new TypeError("Malformed run identity.");
  }
  for (const [name, value] of Object.entries({
    scheduleSeed: identity.scheduleSeed,
    fixtureRevision: identity.fixtureRevision,
    evaluatorRevision: identity.evaluatorRevision,
    analysisRevision: identity.analysisRevision,
  })) {
    if (value.trim().length === 0) {
      throw new TypeError(`${name} must be pinned and nonempty.`);
    }
  }
};

const captureEnvironment = (input: RunEnvironmentInput): EnvironmentSnapshot => {
  if (
    input.dependencyCachePolicy.trim().length === 0 ||
    input.networkPolicy.trim().length === 0
  ) {
    throw new TypeError("Cache and network policies must be recorded.");
  }
  for (const [tool, version] of Object.entries(input.toolVersions)) {
    if (tool.trim().length === 0 || version.trim().length === 0) {
      throw new TypeError("Tool-version entries must be nonempty.");
    }
  }
  const hostCpus = cpus();
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    cpuModel: hostCpus[0]?.model ?? "unavailable",
    cpuCount: hostCpus.length,
    containerImage: input.containerImage,
    hostClass: input.hostClass,
    packageManager: input.packageManager,
    dependencyCachePolicy: input.dependencyCachePolicy,
    networkPolicy: input.networkPolicy,
    toolVersions: { node: process.version, ...input.toolVersions },
  };
};

const notRunEvaluation = (reason: string): EvaluationSummary => ({
  checks: [],
  success: false,
  failureCategory: null,
  invalidRunReason: reason,
});

const assertExecutionGate = (options: BenchmarkRunOptions): void => {
  positiveDuration("Agent timeout", options.timeoutMs);
  positiveDuration(
    "Lifecycle timeout",
    options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS,
  );
  positiveDuration(
    "Shutdown timeout",
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
  if (options.mode === "confirmatory") {
    if (options.adapter.kind === "scripted") {
      throw new TypeError("The scripted adapter is smoke-only and cannot run confirmatory trials.");
    }
    if (options.hooks === undefined) {
      throw new TypeError("Confirmatory trials require preflight and external evaluator hooks.");
    }
    if (options.confirmatory === undefined) {
      throw new TypeError("Confirmatory trials require an exact schedule and cohort binding.");
    }
    if (options.provisioning === undefined) {
      throw new TypeError("Confirmatory trials require an explicit frozen provisioning phase.");
    }
    if (options.adapter.confirmatorySession === undefined) {
      throw new TypeError(
        "Confirmatory adapters require a runtime-verifiable, killable sandbox session.",
      );
    }
  }
  const configuration = options.adapter.configuration;
  if (
    configuration.provider.trim().length === 0 ||
    configuration.model.trim().length === 0 ||
    configuration.serviceTier.trim().length === 0
  ) {
    throw new TypeError("The adapter must pin provider, exact model, and service tier.");
  }
  if (options.adapter.kind === "external_provider") {
    if (
      options.externalProviderGate?.approved !== true ||
      options.externalProviderGate.approvalReference.trim().length === 0
    ) {
      throw new TypeError(
        "External provider adapters require an explicit approval gate before invocation.",
      );
    }
  }
  if (options.provisioning !== undefined) {
    if (
      options.provisioning.command.length === 0 ||
      options.provisioning.command.some((part) => part.trim().length === 0) ||
      options.provisioning.cachePolicy.trim().length === 0 ||
      options.provisioning.cachePolicy !== options.environment.dependencyCachePolicy
    ) {
      throw new TypeError(
        "Provisioning must pin a nonempty command and match the environment cache policy.",
      );
    }
  }
};

type BoundedResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | {
      readonly status: "failed" | "timed_out" | "aborted";
      readonly reason: string;
      readonly settled: boolean;
    };

const settleWithin = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly settled: false }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const runBounded = async <T>(input: {
  readonly label: string;
  readonly timeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly outerSignal?: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<BoundedResult<T>> => {
  const controller = new AbortController();
  let cause: "timed_out" | "aborted" | null = null;
  let wakeAbort = (): void => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    wakeAbort = () => reject(new Error(`${input.label} aborted.`));
    controller.signal.addEventListener("abort", wakeAbort, { once: true });
  });
  const onOuterAbort = (): void => {
    cause = "aborted";
    controller.abort();
  };
  if (input.outerSignal?.aborted === true) onOuterAbort();
  else input.outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    cause = "timed_out";
    controller.abort();
  }, input.timeoutMs);
  const work = Promise.resolve().then(() => input.run(controller.signal));
  const settledWork = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    const result = await Promise.race([settledWork, abort]);
    if (!result.ok) {
      return { status: "failed", reason: errorMessage(result.error), settled: true };
    }
    return { status: "completed", value: result.value };
  } catch {
    const status: "timed_out" | "aborted" =
      (cause as "timed_out" | "aborted" | null) ?? "aborted";
    const settlement = await settleWithin(settledWork, input.shutdownTimeoutMs);
    return {
      status,
      reason:
        status === "timed_out"
          ? `${input.label} exceeded ${input.timeoutMs} ms.`
          : `${input.label} was externally aborted.`,
      settled: settlement.settled,
    };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", wakeAbort);
    input.outerSignal?.removeEventListener("abort", onOuterAbort);
  }
};

interface AgentResult {
  readonly result: AgentAdapterResult | null;
  readonly status: RunCompletionStatus;
  readonly reason: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly outcome: AgentExecutionOutcome;
}

const executeAgent = async (input: {
  readonly adapter: AgentAdapter;
  readonly identity: RunIdentity;
  readonly workspacePath: string;
  readonly instructions: InstructionSet;
  readonly timeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly networkPolicy: string;
  readonly confirmatory: boolean;
  readonly outerSignal?: AbortSignal;
  readonly recorder: TelemetryRecorder;
}): Promise<AgentResult> => {
  const controller = new AbortController();
  let abortCause: "timeout" | "external" | null = null;
  let wakeAbort = (): void => undefined;
  const onExternalAbort = (): void => {
    abortCause = "external";
    controller.abort();
  };
  if (input.outerSignal?.aborted === true) onExternalAbort();
  else input.outerSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const startedAt = new Date().toISOString();
  const start = performance.now();
  if (controller.signal.aborted) {
    input.outerSignal?.removeEventListener("abort", onExternalAbort);
    const reason = "Run was externally aborted before adapter invocation.";
    return {
      result: null,
      status: "aborted",
      reason,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - start,
      outcome: { status: "aborted", reason, shutdownConfirmed: true },
    };
  }
  const timer = setTimeout(() => {
    abortCause = "timeout";
    controller.abort();
  }, input.timeoutMs);
  const abort = new Promise<never>((_resolve, reject) => {
    wakeAbort = () => reject(new Error("Agent execution aborted."));
    controller.signal.addEventListener("abort", wakeAbort, { once: true });
  });
  const work = Promise.resolve().then(() =>
    input.adapter.run({
      runId: input.identity.runId,
      workspacePath: input.workspacePath,
      instructions: input.instructions,
      signal: controller.signal,
      emit: (event) => input.recorder.emit(event),
    }),
  );
  const settledWork = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    const settled = await Promise.race([settledWork, abort]);
    if (!settled.ok) throw settled.error;
    const result = settled.value;
    validateProviderUsage(result.usage);
    if (input.confirmatory && result.usage.inputTokenRelation === undefined) {
      throw new TypeError("Confirmatory usage must declare the input-token overlap relation.");
    }
    if (
      result.provider !== input.adapter.configuration.provider ||
      result.model !== input.adapter.configuration.model ||
      result.serviceTier !== input.adapter.configuration.serviceTier
    ) {
      throw new TypeError(
        "Provider response metadata does not match the pinned adapter configuration.",
      );
    }
    return {
      result,
      status: "completed",
      reason: result.completionReason,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - start,
      outcome: {
        status: "completed",
        reason: result.completionReason,
        shutdownConfirmed: true,
      },
    };
  } catch (error: unknown) {
    if (abortCause === null) {
      const reason = errorMessage(error);
      return {
        result: null,
        status: "agent_error",
        reason,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
        outcome: { status: "agent_error", reason, shutdownConfirmed: true },
      };
    }
    let terminationConfirmed = !input.confirmatory;
    let terminationFailure: string | null = null;
    if (input.confirmatory && input.adapter.confirmatorySession !== undefined) {
      try {
        const termination = await settleWithin(
          input.adapter.confirmatorySession.terminate({
            runId: input.identity.runId,
            workspacePath: input.workspacePath,
            networkPolicy: input.networkPolicy,
            reason: abortCause === "timeout" ? "timeout" : "external_abort",
          }),
          input.shutdownTimeoutMs,
        );
        terminationConfirmed = termination.settled;
        if (!termination.settled) terminationFailure = "session termination timed out";
      } catch (error: unknown) {
        terminationConfirmed = false;
        terminationFailure = `session termination failed: ${errorMessage(error)}`;
      }
    }
    const settlement = await settleWithin(settledWork, input.shutdownTimeoutMs);
    const shutdownConfirmed = terminationConfirmed && settlement.settled;
    const status = abortCause === "timeout" ? "timeout" : "aborted";
    const baseReason =
      status === "timeout"
        ? `Agent exceeded ${input.timeoutMs} ms.`
        : "Run was externally aborted.";
    const reason = terminationFailure === null
      ? baseReason
      : `${baseReason} ${terminationFailure}.`;
    return {
      result: null,
      status,
      reason,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - start,
      outcome: { status, reason, shutdownConfirmed },
    };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", wakeAbort);
    input.outerSignal?.removeEventListener("abort", onExternalAbort);
  }
};

const unavailablePatch = (
  baseline: WorkspaceSnapshot,
  reason: string,
  forensic: string,
): PatchSummary => ({
  filesModified: [],
  totalFilesModified: 0,
  generatedFilesModified: 0,
  linesAdded: 0,
  linesDeleted: 0,
  finalDiffHash: sha256(forensic),
  finalManifestHash: baseline.manifestHash,
  baselineManifestHash: baseline.manifestHash,
  evidenceAvailability: "unavailable",
  evidenceUnavailableReason: reason,
});

const failedCheck = (name: string, details: string): LifecycleCheck => ({
  name,
  status: "failed",
  durationMs: 0,
  details,
});

export const runBenchmark = async (
  options: BenchmarkRunOptions,
): Promise<BenchmarkRunOutput> => {
  validateIdentity(options.identity);
  assertExecutionGate(options);
  const confirmatoryBinding = options.confirmatory === undefined
    ? null
    : structuredClone(options.confirmatory);
  const lifecycleTimeoutMs =
    options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const environment = captureEnvironment(options.environment);
  const instructionHashes = hashInstructionSet(options.instructions);
  const materialized = await materializeWorkspace({
    fixturesRoot: options.fixture.fixturesRoot,
    fixtureRelativePath: options.fixture.relativePath,
    runsRoot: options.workspaceRunsRoot,
    runId: options.identity.runId,
  });
  const initialFixture = await snapshotWorkspace(materialized.workspacePath);
  const provisioningConfiguration = resolveProvisioningConfiguration({
    ...(options.provisioning === undefined ? {} : { plan: options.provisioning }),
    environmentCachePolicy: options.environment.dependencyCachePolicy,
  });
  const mutablePathPrefixes = provisioningConfiguration.mutablePathPrefixes;
  const provisioningConfigurationHash = provisioningConfiguration.hash;
  const protectedFixtureHash = hashProtectedWorkspaceManifest(
    initialFixture,
    mutablePathPrefixes,
  );

  let confirmatoryEvidence: ConfirmatoryEvidence | null = null;
  if (options.mode === "confirmatory") {
    if (confirmatoryBinding === null) {
      throw new TypeError("Confirmatory binding disappeared after execution gating.");
    }
    const binding: ConfirmatoryRunBinding = confirmatoryBinding;
    const bindingEvidence = validateConfirmatoryBinding({
      binding,
      identity: options.identity,
      instructionHashes,
      adapter: options.adapter.configuration,
      environment: options.environment,
      timeoutMs: options.timeoutMs,
      lifecycleTimeoutMs,
      shutdownTimeoutMs,
      provisioningConfigurationHash,
      pricingSnapshotId: options.pricing?.id ?? null,
      pricingCurrency: options.pricing?.currency ?? null,
      fixtureManifestHash: initialFixture.manifestHash,
    });
    const verification = await runBounded({
      label: "Sandbox verification",
      timeoutMs: lifecycleTimeoutMs,
      shutdownTimeoutMs,
      ...(options.signal === undefined ? {} : { outerSignal: options.signal }),
      run: (signal) => {
        if (signal.aborted) throw new Error("Sandbox verification aborted.");
        return (options.adapter.confirmatorySession as NonNullable<AgentAdapter["confirmatorySession"]>).verify({
          runId: options.identity.runId,
          workspacePath: materialized.workspacePath,
          networkPolicy: options.environment.networkPolicy,
        });
      },
    });
    if (verification.status !== "completed") {
      throw new TypeError(`Confirmatory sandbox verification failed: ${verification.reason}`);
    }
    const sandbox: ConfirmatorySandboxVerification = verification.value;
    if (
      sandbox.isolated !== true ||
      sandbox.killable !== true ||
      sandbox.kind !== "os-level-process-sandbox" ||
      resolve(sandbox.workspacePath) !== resolve(materialized.workspacePath) ||
      sandbox.networkPolicy !== options.environment.networkPolicy ||
      sandbox.attestationReference.trim().length === 0
    ) {
      throw new TypeError("Confirmatory sandbox attestation does not match this run.");
    }
    confirmatoryEvidence = {
      scheduleHash: binding.schedule.scheduleHash,
      scheduleContentHash: bindingEvidence.scheduleContentHash,
      ordinal: binding.ordinal,
      blockId: bindingEvidence.scheduled.blockId,
      cohortManifestHash: binding.cohort.manifestHash,
      initialFixtureManifestHash: initialFixture.manifestHash,
      provisioningConfigurationHash,
      lifecycleTimeoutMs,
      shutdownTimeoutMs,
      toolVersionsHash: sha256(canonicalJson(options.environment.toolVersions)),
      approvalReference:
        options.externalProviderGate?.approvalReference ?? "non-external-confirmatory-adapter",
      sandbox,
    };
  }

  const lifecycleContext = {
    identity: options.identity,
    workspacePath: materialized.workspacePath,
  };
  let provisioning: readonly LifecycleCheck[] = [];
  let provisioningSettled = true;
  if (options.provisioning !== undefined) {
    const result = await runBounded({
      label: "Provisioning",
      timeoutMs: lifecycleTimeoutMs,
      shutdownTimeoutMs,
      ...(options.signal === undefined ? {} : { outerSignal: options.signal }),
      run: (signal) => options.provisioning?.provision({
        ...lifecycleContext,
        signal,
      }) ?? Promise.resolve([]),
    });
    if (result.status === "completed") {
      try {
        validateLifecycleChecks(result.value, "provisioning");
        provisioning = result.value;
      } catch (error: unknown) {
        provisioning = [failedCheck("provisioning-infrastructure", errorMessage(error))];
      }
    } else {
      provisioningSettled = result.settled;
      provisioning = [failedCheck("provisioning-infrastructure", result.reason)];
    }
  }
  if (options.mode === "confirmatory" && provisioning.length === 0) {
    provisioning = [
      failedCheck("provisioning-infrastructure", "Provisioning returned no evidence."),
    ];
  }
  if (provisioningSettled) {
    try {
      const afterProvisioning = await snapshotWorkspace(materialized.workspacePath);
      if (
        hashProtectedWorkspaceManifest(afterProvisioning, mutablePathPrefixes) !==
        protectedFixtureHash
      ) {
        provisioning = [
          ...provisioning,
          failedCheck(
            "provisioning-workspace-integrity",
            "Provisioning changed a protected fixture path.",
          ),
        ];
      }
    } catch (error: unknown) {
      provisioning = [
        ...provisioning,
        failedCheck("provisioning-workspace-integrity", errorMessage(error)),
      ];
    }
  }
  let preflight: readonly LifecycleCheck[] = [];
  let preflightSettled = provisioningSettled;
  const provisioningFailed = provisioning.some(({ status }) => status !== "passed");
  if (options.hooks !== undefined && !provisioningFailed && provisioningSettled) {
    const result = await runBounded({
      label: "Preflight",
      timeoutMs: lifecycleTimeoutMs,
      shutdownTimeoutMs,
      ...(options.signal === undefined ? {} : { outerSignal: options.signal }),
      run: (signal) => options.hooks?.preflight({ ...lifecycleContext, signal }) ?? Promise.resolve([]),
    });
    if (result.status === "completed") {
      try {
        validateLifecycleChecks(result.value, "preflight");
        preflight = result.value;
      } catch (error: unknown) {
        preflight = [failedCheck("preflight-infrastructure", errorMessage(error))];
      }
    } else {
      preflightSettled = result.settled;
      preflight = [failedCheck("preflight-infrastructure", result.reason)];
    }
  }
  if (options.mode === "confirmatory" && preflight.length === 0) {
    preflight = [failedCheck("preflight-infrastructure", "Confirmatory preflight returned no evidence.")];
  }
  let baseline = initialFixture;
  if (preflightSettled) {
    try {
      const afterPreflight = await snapshotWorkspace(materialized.workspacePath);
      baseline = afterPreflight;
      if (
        hashProtectedWorkspaceManifest(afterPreflight, mutablePathPrefixes) !==
        protectedFixtureHash
      ) {
        preflight = [
          ...preflight,
          failedCheck(
            "preflight-workspace-integrity",
            "Preflight changed a protected fixture path.",
          ),
        ];
      }
    } catch (error: unknown) {
      preflight = [
        ...preflight,
        failedCheck("preflight-workspace-integrity", errorMessage(error)),
      ];
    }
  }

  const recorder = new TelemetryRecorder();
  const preflightFailed =
    provisioningFailed || preflight.some(({ status }) => status !== "passed");
  let execution: AgentResult;
  let evaluation = notRunEvaluation("external_evaluator_not_configured_for_smoke");
  let evaluatorOutcome: EvaluatorExecutionOutcome = {
    status: "not_run",
    reason: "Evaluator was not configured.",
  };
  let adapterResult: AgentAdapterResult | null = null;
  let lifecycleSettled = provisioningSettled && preflightSettled;
  if (preflightFailed || !preflightSettled) {
    const instant = new Date().toISOString();
    const reason = "Preflight failed; the agent was not invoked.";
    execution = {
      result: null,
      status: "preflight_failed",
      reason,
      startedAt: instant,
      endedAt: instant,
      durationMs: 0,
      outcome: { status: "not_run", reason, shutdownConfirmed: preflightSettled },
    };
    evaluation = notRunEvaluation("preflight_failed");
    evaluatorOutcome = { status: "not_run", reason: "Preflight failed." };
  } else {
    execution = await executeAgent({
      adapter: options.adapter,
      identity: options.identity,
      workspacePath: materialized.workspacePath,
      instructions: options.instructions,
      timeoutMs: options.timeoutMs,
      shutdownTimeoutMs,
      networkPolicy: options.environment.networkPolicy,
      confirmatory: options.mode === "confirmatory",
      ...(options.signal === undefined ? {} : { outerSignal: options.signal }),
      recorder,
    });
    adapterResult = execution.result;
    if (execution.outcome.shutdownConfirmed && options.hooks !== undefined) {
      const result = await runBounded({
        label: "External evaluator",
        timeoutMs: lifecycleTimeoutMs,
        shutdownTimeoutMs,
        ...(options.signal === undefined ? {} : { outerSignal: options.signal }),
        run: (signal) => options.hooks?.evaluate({ ...lifecycleContext, signal }) ??
          Promise.resolve(notRunEvaluation("evaluator_missing")),
      });
      if (result.status === "completed") {
        try {
          evaluation = deriveEvaluationSummary({
            supplied: result.value,
            mode: options.mode,
            arm: options.identity.arm,
          });
          evaluatorOutcome = { status: "completed", reason: "Evaluator completed." };
        } catch (error: unknown) {
          evaluation = notRunEvaluation("external_evaluator_invalid_output");
          evaluatorOutcome = { status: "failed", reason: errorMessage(error) };
        }
      } else {
        lifecycleSettled = lifecycleSettled && result.settled;
        evaluation = notRunEvaluation(
          result.status === "timed_out"
            ? "external_evaluator_timeout"
            : result.status === "aborted"
              ? "external_evaluator_aborted"
              : "external_evaluator_infrastructure_failure",
        );
        evaluatorOutcome = { status: result.status, reason: result.reason };
      }
    } else if (!execution.outcome.shutdownConfirmed) {
      evaluation = notRunEvaluation("agent_shutdown_unconfirmed");
      evaluatorOutcome = {
        status: "not_run",
        reason: "Agent shutdown was not confirmed; evaluator was not invoked.",
      };
    }
  }

  const evidenceArtifacts: AgentArtifactInput[] = [
    {
      name: "harness/initial-fixture-manifest.json",
      mediaType: "application/json",
      data: serializeWorkspaceManifest(initialFixture),
    },
    {
      name: "harness/baseline-manifest.json",
      mediaType: "application/json",
      data: serializeWorkspaceManifest(baseline),
    },
  ];
  if (confirmatoryBinding !== null) {
    evidenceArtifacts.push(
      {
        name: "harness/schedule.json",
        mediaType: "application/json",
        data: `${canonicalJson(confirmatoryBinding.schedule)}\n`,
      },
      {
        name: "harness/cohort-manifest.json",
        mediaType: "application/json",
        data: `${canonicalJson(confirmatoryBinding.cohort)}\n`,
      },
    );
  }
  let finalizationOutcome: FinalizationOutcome;
  let patch: PatchSummary;
  if (!execution.outcome.shutdownConfirmed || !lifecycleSettled) {
    const reason = !execution.outcome.shutdownConfirmed
      ? "Agent shutdown could not be confirmed before finalization."
      : "A lifecycle hook did not settle after abort.";
    const forensic = `${canonicalJson({
      schemaVersion: 1,
      reason,
      baselineManifestHash: baseline.manifestHash,
      agentOutcome: execution.outcome,
      evaluatorOutcome,
    })}\n`;
    patch = unavailablePatch(baseline, reason, forensic);
    finalizationOutcome = { status: "evidence_unavailable", reason };
    evidenceArtifacts.push({
      name: "harness/finalization-unavailable.json",
      mediaType: "application/json",
      data: forensic,
    });
    evaluation = { ...evaluation, success: false, invalidRunReason: "workspace_finalization_unavailable" };
  } else {
    try {
      const finalSnapshot = await snapshotWorkspace(materialized.workspacePath);
      const normalizedPatch = createNormalizedWorkspacePatch(baseline, finalSnapshot);
      patch = diffWorkspaceSnapshots(
        baseline,
        finalSnapshot,
        options.generatedPathPrefixes ?? [],
      );
      finalizationOutcome = { status: "completed", reason: "Workspace evidence captured." };
      evidenceArtifacts.push(
        {
          name: "harness/final-manifest.json",
          mediaType: "application/json",
          data: serializeWorkspaceManifest(finalSnapshot),
        },
        {
          name: "harness/normalized-patch.json",
          mediaType: "application/json",
          data: normalizedPatch,
        },
      );
    } catch (error: unknown) {
      const reason = `Workspace finalization failed: ${errorMessage(error)}`;
      const forensic = `${canonicalJson({
        schemaVersion: 1,
        reason,
        baselineManifestHash: baseline.manifestHash,
      })}\n`;
      patch = unavailablePatch(baseline, reason, forensic);
      finalizationOutcome = { status: "evidence_unavailable", reason };
      evidenceArtifacts.push({
        name: "harness/finalization-unavailable.json",
        mediaType: "application/json",
        data: forensic,
      });
      evaluation = error instanceof PathConfinementError
        ? {
            checks: [
              ...evaluation.checks,
              failedCheck("workspace-policy", errorMessage(error)),
            ],
            success: false,
            failureCategory: "prohibited workspace entry",
            invalidRunReason: evaluation.invalidRunReason,
          }
        : {
            ...evaluation,
            success: false,
            invalidRunReason: "workspace_finalization_failure",
          };
    }
  }

  const usage = adapterResult?.usage ??
    createUnavailableProviderUsage("No complete provider response was available for this run.");
  const cost = adapterResult === null
    ? {
        availability: "unavailable" as const,
        amount: null,
        currency: options.pricing?.currency ?? null,
        pricingSnapshotId: options.pricing?.id ?? null,
        reason: "No complete provider usage was available.",
      }
    : deriveProviderCost({
        usage,
        pricing: options.pricing,
        provider: options.adapter.configuration.provider,
        model: options.adapter.configuration.model,
        serviceTier: options.adapter.configuration.serviceTier,
      });
  const finalSuccess =
    execution.outcome.status === "completed" &&
    provisioning.every(({ status }) => status === "passed") &&
    preflight.length > 0 &&
    preflight.every(({ status }) => status === "passed") &&
    evaluatorOutcome.status === "completed" &&
    evaluation.success &&
    finalizationOutcome.status === "completed";
  const written = await writeImmutableRunResult({
    resultsRoot: options.resultsRoot,
    draft: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      mode: options.mode,
      identity: options.identity,
      adapterId: options.adapter.id,
      instructionHashes,
      environment,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      durationMs: execution.durationMs,
      timeoutMs: options.timeoutMs,
      completionStatus: execution.status,
      completionReason: execution.reason,
      agentOutcome: execution.outcome,
      evaluatorOutcome,
      finalizationOutcome,
      confirmatoryEvidence,
      provider: options.adapter.configuration.provider,
      model: options.adapter.configuration.model,
      serviceTier: options.adapter.configuration.serviceTier,
      reasoningConfiguration: options.adapter.configuration.reasoning,
      responseIds: adapterResult?.responseIds ?? [],
      usage,
      accountedTokens: deriveAccountedTokens(usage),
      cost,
      provisioning,
      preflight,
      interaction: recorder.summarize(),
      patch,
      evaluation,
      finalSuccess,
    },
    artifacts: [...(adapterResult?.artifacts ?? []), ...evidenceArtifacts],
  });
  return { ...written, workspacePath: materialized.workspacePath };
};
