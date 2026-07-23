import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createFrozenCohortManifest } from "./cohort.js";
import { canonicalJson, hashInstructionSet, sha256 } from "./hash.js";
import { resolveProvisioningConfiguration } from "./provisioning.js";
import {
  validateRunRecord,
  writeImmutableRunCorrection,
} from "./result-store.js";
import { runBenchmark, type BenchmarkRunOptions } from "./runner.js";
import { createConfirmatorySchedule } from "./schedule.js";
import { createUnavailableProviderUsage } from "./telemetry.js";
import {
  HARNESS_SCHEMA_VERSION,
  type AgentAdapter,
  type BenchmarkLifecycleHooks,
  type BenchmarkProvisioningPlan,
  type EvaluationSummary,
  type LifecycleCheck,
  type TaskReference,
} from "./types.js";
import { snapshotWorkspace } from "./workspace.js";

const tasks: readonly TaskReference[] = Array.from({ length: 10 }, (_, index) => ({
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: `task-${String(index + 1).padStart(2, "0")}`,
  version: 1,
}));

const passingEvaluation = (): EvaluationSummary => ({
  checks: [
    "acceptance",
    "hidden-regression",
    "typecheck",
    "architecture",
    "prohibited-shortcuts",
    "task-specific",
  ].map((name): LifecycleCheck => ({
    name,
    status: "passed",
    durationMs: 1,
    details: null,
  })),
  success: true,
  failureCategory: null,
  invalidRunReason: null,
});

interface ConfirmatorySetupInput {
  readonly runId: string;
  readonly taskId?: string;
  readonly timeoutMs?: number;
  readonly timeoutMsByTask?: Readonly<Record<string, number>>;
  readonly lifecycleTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly mutablePathPrefixes?: readonly string[];
  readonly provision?: BenchmarkProvisioningPlan["provision"];
  readonly preflight?: BenchmarkLifecycleHooks["preflight"];
  readonly evaluate?: BenchmarkLifecycleHooks["evaluate"];
  readonly adapterRun?: AgentAdapter["run"];
  readonly terminate?: NonNullable<AgentAdapter["confirmatorySession"]>["terminate"];
  readonly verify?: NonNullable<AgentAdapter["confirmatorySession"]>["verify"];
}

const confirmatorySetup = async (
  input: ConfirmatorySetupInput,
): Promise<{ readonly options: BenchmarkRunOptions; readonly adapterRun: AgentAdapter["run"] }> => {
  const root = await mkdtemp(join(tmpdir(), "agentix-confirm-"));
  const fixtures = join(root, "fixtures");
  const fixture = join(fixtures, "fixture-v1");
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(join(fixture, "src", "value.ts"), "export const value = 1;\n");
  const timeoutMs = input.timeoutMs ?? 1_000;
  const lifecycleTimeoutMs = input.lifecycleTimeoutMs ?? 1_000;
  const shutdownTimeoutMs = input.shutdownTimeoutMs ?? 200;
  const instructions = {
    system: "system",
    developer: "developer",
    user: "change value",
    tools: ["read", "write"],
    permissions: { network: false },
    limits: { seconds: 1 },
  };
  const environment = {
    containerImage: "sha256:test-image",
    hostClass: "test-host-v1",
    packageManager: "npm@frozen",
    dependencyCachePolicy: "offline-cache-v1",
    networkPolicy: "disabled",
    toolVersions: { typescript: "frozen-test-version" },
  };
  const provisioning: BenchmarkProvisioningPlan = {
    command: ["npm", "install", "--offline"],
    cachePolicy: environment.dependencyCachePolicy,
    mutablePathPrefixes: input.mutablePathPrefixes ?? ["packages/app/dist"],
    provision: input.provision ?? (async ({ workspacePath }) => {
      await mkdir(join(workspacePath, "node_modules", "package"), { recursive: true });
      await writeFile(join(workspacePath, "node_modules", "package", "index.js"), "x\n");
      await mkdir(join(workspacePath, "packages", "app", "dist"), { recursive: true });
      await writeFile(join(workspacePath, "packages", "app", "dist", "index.js"), "built\n");
      await writeFile(join(workspacePath, "compile.tsbuildinfo"), "generated\n");
      return [{ name: "dependency-install", status: "passed", durationMs: 1, details: null }];
    }),
  };
  const hooks: BenchmarkLifecycleHooks = {
    preflight: input.preflight ?? (async ({ workspacePath }) => {
      await writeFile(join(workspacePath, "packages", "app", "dist", "preflight.js"), "checked\n");
      return [{ name: "clean-fixture", status: "passed", durationMs: 1, details: null }];
    }),
    evaluate: input.evaluate ?? (async () => passingEvaluation()),
  };
  const configuration = {
    provider: "provider-test",
    model: "model-exact-v1",
    serviceTier: "standard",
    reasoning: { effort: "high" },
  };
  const defaultRun: AgentAdapter["run"] = async ({ workspacePath }) => {
    await writeFile(join(workspacePath, "src", "value.ts"), "export const value = 2;\n");
    return {
      provider: configuration.provider,
      model: configuration.model,
      serviceTier: configuration.serviceTier,
      responseIds: ["response-1"],
      completionReason: "complete",
      usage: createUnavailableProviderUsage("test provider omitted usage"),
      artifacts: [],
    };
  };
  const adapterRun = input.adapterRun ?? vi.fn(defaultRun);
  const adapter: AgentAdapter = {
    id: "external-confirmatory-test",
    kind: "external_provider",
    configuration,
    confirmatorySession: {
      verify: input.verify ?? (async (context) => ({
        isolated: true,
        killable: true,
        kind: "os-level-process-sandbox",
        workspacePath: context.workspacePath,
        networkPolicy: context.networkPolicy,
        attestationReference: "sandbox-session-1",
      })),
      terminate: input.terminate ?? (async () => undefined),
    },
    run: adapterRun,
  };
  const schedule = createConfirmatorySchedule({
    tasks,
    repetitions: 5,
    seed: "confirmatory-seed-v1",
  });
  const scheduled = schedule.runs.find((run) =>
    run.task.id === (input.taskId ?? "task-01") &&
    run.arm === "framework" &&
    run.repetition === 1,
  );
  if (scheduled === undefined) throw new Error("Expected scheduled slot.");
  const identity = {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    runId: input.runId,
    task: scheduled.task,
    arm: scheduled.arm,
    repetition: scheduled.repetition,
    scheduleSeed: schedule.seed,
    fixtureRevision: "fixture-v1",
    evaluatorRevision: "evaluator-v1",
    analysisRevision: "analysis-v1",
  } as const;
  const fixtureManifest = await snapshotWorkspace(fixture);
  const taskKeys = tasks.map((task) => `${task.id}@${task.version}`);
  const timeoutMsByTask = Object.fromEntries(
    taskKeys.map((key) => [key, input.timeoutMsByTask?.[key] ?? timeoutMs]),
  );
  const armPins = <T>(value: T) => ({ framework: value, plain: value });
  const provisioningConfiguration = resolveProvisioningConfiguration({
    plan: provisioning,
    environmentCachePolicy: environment.dependencyCachePolicy,
  });
  const cohort = createFrozenCohortManifest({
    schemaVersion: 1,
    cohortId: "cohort-v1",
    scheduleSeed: schedule.seed,
    scheduleHash: schedule.scheduleHash,
    provider: configuration.provider,
    exactModel: configuration.model,
    serviceTier: configuration.serviceTier,
    reasoningConfigurationHash: sha256(canonicalJson(configuration.reasoning)),
    instructionBundleByTask: Object.fromEntries(
      taskKeys.map((key) => [key, hashInstructionSet(instructions).bundle]),
    ),
    fixtureRevisionByTask: Object.fromEntries(
      taskKeys.map((key) => [key, armPins("fixture-v1")]),
    ),
    fixtureManifestHashByTask: Object.fromEntries(
      taskKeys.map((key) => [key, armPins(fixtureManifest.manifestHash)]),
    ),
    evaluatorRevisionByTask: Object.fromEntries(
      taskKeys.map((key) => [key, armPins("evaluator-v1")]),
    ),
    analysisRevision: "analysis-v1",
    timeoutMsByTask,
    lifecycleTimeoutMs,
    shutdownTimeoutMs,
    provisioningConfigurationHash: provisioningConfiguration.hash,
    networkPolicy: environment.networkPolicy,
    dependencyCachePolicy: environment.dependencyCachePolicy,
    hostClass: environment.hostClass,
    containerImage: environment.containerImage,
    packageManager: environment.packageManager,
    toolVersionsHash: sha256(canonicalJson(environment.toolVersions)),
    pricingSnapshotId: null,
    pricingCurrency: null,
  });
  return {
    adapterRun,
    options: {
      mode: "confirmatory",
      identity,
      fixture: { fixturesRoot: fixtures, relativePath: "fixture-v1" },
      workspaceRunsRoot: join(root, "workspaces"),
      resultsRoot: join(root, "results"),
      instructions,
      adapter,
      provisioning,
      hooks,
      timeoutMs,
      lifecycleTimeoutMs,
      shutdownTimeoutMs,
      confirmatory: { schedule, ordinal: scheduled.ordinal, cohort },
      pricing: null,
      environment,
      externalProviderGate: { approved: true, approvalReference: "test-approval-1" },
    },
  };
};

describe("confirmatory hardening", () => {
  it("allows pinned dependency/generated provisioning and measures from post-preflight baseline", async () => {
    const { options } = await confirmatorySetup({ runId: "confirm-success" });
    expect(Object.isFrozen(options.confirmatory?.cohort)).toBe(true);
    expect(Object.isFrozen(options.confirmatory?.cohort.fixtureRevisionByTask)).toBe(true);
    const result = await runBenchmark(options);
    expect(result.record.finalSuccess).toBe(true);
    expect(result.record.patch.filesModified.map(({ path }) => path)).toEqual(["src/value.ts"]);
    expect(result.record.confirmatoryEvidence).toMatchObject({
      ordinal: options.confirmatory?.ordinal,
      approvalReference: "test-approval-1",
    });
    expect(result.record.artifacts.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "harness/initial-fixture-manifest.json",
      "harness/baseline-manifest.json",
      "harness/final-manifest.json",
      "harness/normalized-patch.json",
    ]));
    expect(() => validateRunRecord({
      ...result.record,
      provisioning: [],
    }, result.record.identity.runId)).toThrow(/provisioning evidence must be nonempty/u);
  });

  it("keeps append-only corrections on the original confirmatory schedule and cohort binding", async () => {
    const { options } = await confirmatorySetup({ runId: "confirm-correction-source" });
    const source = await runBenchmark(options);
    const artifacts = await Promise.all(source.record.artifacts.map(async (artifact) => ({
      name: artifact.name,
      mediaType: artifact.mediaType,
      data: await readFile(join(source.runDirectory, "artifacts", artifact.name)),
    })));
    const {
      artifacts: _artifacts,
      correction: _correction,
      ...sourceDraft
    } = source.record;

    await expect(writeImmutableRunCorrection({
      resultsRoot: options.resultsRoot,
      draft: {
        ...sourceDraft,
        identity: {
          ...sourceDraft.identity,
          runId: "confirm-correction-wrong-binding",
        },
        confirmatoryEvidence: {
          ...sourceDraft.confirmatoryEvidence!,
          approvalReference: "different-confirmatory-approval",
        },
      },
      artifacts,
      supersededRunId: source.record.identity.runId,
      reason: "Attempted to change a frozen confirmatory binding.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    })).rejects.toThrow(/frozen schedule and cohort binding/u);

    const corrected = await writeImmutableRunCorrection({
      resultsRoot: options.resultsRoot,
      draft: {
        ...sourceDraft,
        identity: {
          ...sourceDraft.identity,
          runId: "confirm-correction-valid",
        },
        completionReason: "corrected non-binding note",
      },
      artifacts,
      supersededRunId: source.record.identity.runId,
      reason: "Correct a non-binding operator note while retaining raw evidence.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    });
    expect(corrected.record.confirmatoryEvidence)
      .toEqual(source.record.confirmatoryEvidence);
    expect(corrected.record.correction?.supersededRunId)
      .toBe(source.record.identity.runId);
  });

  it("binds the agent timeout to the selected scheduled task", async () => {
    const timeoutMsByTask = Object.fromEntries(
      tasks.map((task) => [
        `${task.id}@${task.version}`,
        task.id === "task-10" ? 900 : 1_800,
      ]),
    );
    const accepted = await confirmatorySetup({
      runId: "confirm-task-timeout",
      taskId: "task-10",
      timeoutMs: 900,
      timeoutMsByTask,
    });
    const result = await runBenchmark(accepted.options);
    expect(result.record.timeoutMs).toBe(900);

    const frozenCohort = accepted.options.confirmatory?.cohort;
    if (frozenCohort === undefined) throw new Error("Expected frozen cohort.");
    const { manifestHash: _manifestHash, ...cohortInput } = frozenCohort;
    const wrongKeys = Object.fromEntries(
      Object.entries(frozenCohort.timeoutMsByTask).filter(
        ([key]) => key !== "task-10@1",
      ),
    );
    expect(() => createFrozenCohortManifest({
      ...cohortInput,
      timeoutMsByTask: { ...wrongKeys, "wrong-task@1": 900 },
    })).toThrow(/task-keyed pin maps/u);

    const mismatched = await confirmatorySetup({
      runId: "confirm-wrong-task-timeout",
      taskId: "task-10",
      timeoutMs: 1_800,
      timeoutMsByTask,
    });
    await expect(runBenchmark(mismatched.options)).rejects.toThrow(
      /task timeout/u,
    );
  });

  it("rejects a provisioning source mutation while permitting dependency output", async () => {
    const { options, adapterRun } = await confirmatorySetup({
      runId: "confirm-provision-source-mutation",
      async provision({ workspacePath }) {
        await mkdir(join(workspacePath, "node_modules", "ok"), { recursive: true });
        await writeFile(join(workspacePath, "node_modules", "ok", "x.js"), "ok\n");
        await writeFile(join(workspacePath, "src", "value.ts"), "mutated by provision\n");
        return [{ name: "install", status: "passed", durationMs: 1, details: null }];
      },
    });
    const result = await runBenchmark(options);
    expect(result.record.completionStatus).toBe("preflight_failed");
    expect(result.record.provisioning).toContainEqual(expect.objectContaining({
      name: "provisioning-workspace-integrity",
      status: "failed",
    }));
    expect(adapterRun).not.toHaveBeenCalled();
  });

  it("rejects a preflight source mutation before invoking the provider", async () => {
    const { options, adapterRun } = await confirmatorySetup({
      runId: "confirm-preflight-source-mutation",
      async preflight({ workspacePath }) {
        await writeFile(join(workspacePath, "src", "value.ts"), "mutated by preflight\n");
        return [{ name: "clean", status: "passed", durationMs: 1, details: null }];
      },
    });
    const result = await runBenchmark(options);
    expect(result.record.completionStatus).toBe("preflight_failed");
    expect(result.record.preflight).toContainEqual(expect.objectContaining({
      name: "preflight-workspace-integrity",
      status: "failed",
    }));
    expect(adapterRun).not.toHaveBeenCalled();
  });

  it("rejects unsafe mutable prefixes before provisioning or provider invocation", async () => {
    await expect(confirmatorySetup({
      runId: "confirm-unsafe-prefix",
      mutablePathPrefixes: ["src"],
    })).rejects.toThrow(/not a safe generated\/dependency path/u);
  });

  it("derives evaluator success instead of trusting an empty rubber stamp", async () => {
    const { options } = await confirmatorySetup({
      runId: "confirm-rubber-stamp",
      async evaluate() {
        return {
          checks: [],
          success: true,
          failureCategory: null,
          invalidRunReason: null,
        };
      },
    });
    const result = await runBenchmark(options);
    expect(result.record.completionStatus).toBe("completed");
    expect(result.record.evaluation.success).toBe(false);
    expect(result.record.evaluation.invalidRunReason).toMatch(/required evaluator check acceptance/u);
    expect(result.record.finalSuccess).toBe(false);
  });

  it("keeps agent completion separate when the evaluator times out", async () => {
    const { options } = await confirmatorySetup({
      runId: "confirm-evaluator-timeout",
      lifecycleTimeoutMs: 250,
      shutdownTimeoutMs: 100,
      evaluate: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(passingEvaluation()), { once: true });
      }),
    });
    const result = await runBenchmark(options);
    expect(result.record.completionStatus).toBe("completed");
    expect(result.record.agentOutcome?.status).toBe("completed");
    expect(result.record.evaluatorOutcome?.status).toBe("timed_out");
    expect(result.record.finalSuccess).toBe(false);
  });

  it("bounds a preflight that ignores abort and seals unavailable evidence", async () => {
    const { options, adapterRun } = await confirmatorySetup({
      runId: "confirm-preflight-unsettled",
      lifecycleTimeoutMs: 30,
      shutdownTimeoutMs: 5,
      preflight: async () => new Promise(() => undefined),
    });
    const result = await runBenchmark(options);
    expect(result.record.completionStatus).toBe("preflight_failed");
    expect(result.record.finalizationOutcome?.status).toBe("evidence_unavailable");
    expect(result.record.patch.evidenceAvailability).toBe("unavailable");
    expect(adapterRun).not.toHaveBeenCalled();
  });

  it("terminates and awaits a timed-out agent before evaluation and snapshot", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    let workspace = "";
    const { options } = await confirmatorySetup({
      runId: "confirm-agent-timeout",
      timeoutMs: 5,
      shutdownTimeoutMs: 50,
      adapterRun: async (context) => {
        workspace = context.workspacePath;
        await new Promise<void>((resolve) => { release = resolve; });
        order.push("agent-settled");
        return {
          provider: "provider-test",
          model: "model-exact-v1",
          serviceTier: "standard",
          responseIds: [],
          completionReason: "late",
          usage: createUnavailableProviderUsage("late"),
          artifacts: [],
        };
      },
      async terminate() {
        order.push("terminate");
        release?.();
      },
      async evaluate() {
        order.push("evaluate");
        throw new Error("evaluator infrastructure failed after timeout");
      },
    });
    const result = await runBenchmark(options);
    expect(workspace).toBe(result.workspacePath);
    expect(order).toEqual(["terminate", "agent-settled", "evaluate"]);
    expect(result.record.completionStatus).toBe("timeout");
    expect(result.record.agentOutcome?.shutdownConfirmed).toBe(true);
    expect(result.record.evaluatorOutcome?.status).toBe("failed");
    expect(result.record.patch.evidenceAvailability).toBe("available");
  });

  it("seals unavailable evidence when a timed-out adapter never settles", async () => {
    const evaluate = vi.fn(async () => passingEvaluation());
    const { options } = await confirmatorySetup({
      runId: "confirm-unsettled-agent",
      timeoutMs: 5,
      shutdownTimeoutMs: 5,
      adapterRun: async () => new Promise(() => undefined),
      evaluate,
    });
    const result = await runBenchmark(options);
    expect(result.record.agentOutcome).toMatchObject({
      status: "timeout",
      shutdownConfirmed: false,
    });
    expect(result.record.finalizationOutcome?.status).toBe("evidence_unavailable");
    expect(result.record.patch.evidenceAvailability).toBe("unavailable");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("records an agent-created symlink as a valid workspace-policy failure", async () => {
    const { options } = await confirmatorySetup({
      runId: "confirm-symlink",
      async adapterRun({ workspacePath }) {
        await symlink("src/value.ts", join(workspacePath, "alias.ts"));
        return {
          provider: "provider-test",
          model: "model-exact-v1",
          serviceTier: "standard",
          responseIds: [],
          completionReason: "complete",
          usage: createUnavailableProviderUsage("test"),
          artifacts: [],
        };
      },
    });
    const result = await runBenchmark(options);
    expect(result.record.finalizationOutcome?.status).toBe("evidence_unavailable");
    expect(result.record.evaluation.failureCategory).toBe("prohibited workspace entry");
    expect(result.record.evaluation.invalidRunReason).toBeNull();
    expect(result.record.evaluation.checks).toContainEqual(expect.objectContaining({
      name: "workspace-policy",
      status: "failed",
    }));
  });

  it("rejects a mismatched exact schedule slot before invoking the provider", async () => {
    const { options, adapterRun } = await confirmatorySetup({ runId: "confirm-slot-mismatch" });
    if (options.confirmatory === undefined) throw new Error("Missing test binding.");
    await expect(runBenchmark({
      ...options,
      confirmatory: {
        ...options.confirmatory,
        ordinal: options.confirmatory.ordinal === 1 ? 2 : 1,
      },
    })).rejects.toThrow(/Confirmatory cohort mismatch/u);
    expect(adapterRun).not.toHaveBeenCalled();
  });

  it("rejects a sandbox attestation that is not bound to the materialized workspace", async () => {
    const { options, adapterRun } = await confirmatorySetup({
      runId: "confirm-bad-sandbox",
      async verify(context) {
        return {
          isolated: true,
          killable: true,
          kind: "os-level-process-sandbox",
          workspacePath: `${context.workspacePath}-other`,
          networkPolicy: context.networkPolicy,
          attestationReference: "wrong-session",
        };
      },
    });
    await expect(runBenchmark(options)).rejects.toThrow(/attestation does not match/u);
    expect(adapterRun).not.toHaveBeenCalled();
  });
});
