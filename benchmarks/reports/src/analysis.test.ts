import {
  canonicalJson,
  createConfirmatorySchedule,
  deriveAccountedTokens,
  HARNESS_SCHEMA_VERSION,
  hashInstructionSet,
  reportedUsage,
  sha256,
  unavailableUsage,
  type RawProviderUsage,
  type PricingSnapshot,
  type RunRecord,
  type TaskReference,
} from "@agentix/benchmark-harness";
import { describe, expect, it } from "vitest";

import { analyzeExperiment } from "./analyze.js";
import { renderMarkdown } from "./render.js";
import { wilson95 } from "./statistics.js";
import type { AnalysisConfiguration, AnalysisInput } from "./types.js";
import { ANALYSIS_VERSION, FROZEN_THRESHOLDS, taskKey } from "./validation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TOOL_VERSIONS = { node: "v24.16.0", typescript: "7.0.2" };
const REASONING = { effort: "high", summary: "none" };
const PRICING_SNAPSHOT: PricingSnapshot = {
  schemaVersion: 1,
  id: "pricing-v1",
  provider: "provider",
  model: "exact-model-v1",
  serviceTier: "standard",
  currency: "USD",
  effectiveAt: "2040-01-01T00:00:00.000Z",
  unitTokens: 1_000,
  perUnit: {
    uncachedInput: 0.1,
    cachedInput: 0.1,
    output: 0.1,
    reasoning: null,
  },
};
const tasks: readonly TaskReference[] = Array.from(
  { length: 10 },
  (_, index) => ({
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: `task-${String(index + 1).padStart(2, "0")}`,
    version: 1,
  }),
);

const timeoutMsForTask = (task: TaskReference): number =>
  task.id === "task-10" ? 900_000 : 1_800_000;

const usage = (tokens: number): RawProviderUsage => ({
  uncachedInputTokens: reportedUsage(Math.floor(tokens / 2)),
  cachedInputTokens: reportedUsage(0),
  outputTokens: reportedUsage(tokens - Math.floor(tokens / 2)),
  reasoningTokens: unavailableUsage("reasoning is included but not split out"),
  providerTotalTokens: unavailableUsage("provider total is not exposed"),
  inputTokenRelation: "uncached_and_cached_disjoint",
  reasoningTokenRelation: "included_in_output",
  providerTotalRelation: "unknown",
  semantics: "Synthetic raw counters; reasoning is included in output.",
});

const requiredChecks = (arm: "framework" | "plain") => [
  { name: "acceptance", status: "passed" as const, durationMs: 1, details: null },
  {
    name: "hidden-regression",
    status: "passed" as const,
    durationMs: 1,
    details: null,
  },
  { name: "typecheck", status: "passed" as const, durationMs: 1, details: null },
  {
    name: "architecture",
    status: arm === "framework" ? ("passed" as const) : ("not_applicable" as const),
    durationMs: 1,
    details: null,
  },
  {
    name: "prohibited-shortcuts",
    status: "passed" as const,
    durationMs: 1,
    details: null,
  },
  {
    name: "task-specific",
    status: "passed" as const,
    durationMs: 1,
    details: null,
  },
];

const instructionsFor = (task: TaskReference) =>
  hashInstructionSet({
    system: "system",
    developer: "developer",
    user: `Implement ${task.id}@${task.version}`,
    tools: ["read", "write", "exec"],
    permissions: { network: false },
    limits: { seconds: timeoutMsForTask(task) / 1_000 },
  });

const makeRecord = (
  scheduled: ReturnType<typeof createConfirmatorySchedule>["runs"][number],
  tokens: number,
  binding: {
    readonly scheduleHash: string;
    readonly scheduleContentHash: string;
    readonly cohortManifestHash: string;
    readonly baselineManifestHash: string;
  },
): RunRecord => {
  const rawUsage = usage(tokens);
  const id = `${scheduled.task.id}-${scheduled.arm}-${scheduled.repetition}`;
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    mode: "confirmatory",
    identity: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      runId: id,
      task: scheduled.task,
      arm: scheduled.arm,
      repetition: scheduled.repetition,
      scheduleSeed: "committed-seed-v1",
      fixtureRevision: `${scheduled.task.id}-${scheduled.arm}-fixture-v1`,
      evaluatorRevision: `${scheduled.task.id}-${scheduled.arm}-evaluator-v1`,
      analysisRevision: "analysis-code-v1",
    },
    adapterId: "provider-adapter-v1",
    instructionHashes: instructionsFor(scheduled.task),
    environment: {
      node: "v24.16.0",
      platform: "darwin",
      architecture: "arm64",
      osRelease: "test",
      cpuModel: "test",
      cpuCount: 8,
      containerImage: "benchmark-image-v1",
      hostClass: "host-v1",
      packageManager: "npm@11.13.0",
      dependencyCachePolicy: "published-packages-only",
      networkPolicy: "disabled",
      toolVersions: TOOL_VERSIONS,
    },
    startedAt: "2040-01-01T00:00:00.000Z",
    endedAt: "2040-01-01T00:00:01.000Z",
    durationMs: scheduled.arm === "framework" ? 800 : 1_000,
    timeoutMs: timeoutMsForTask(scheduled.task),
    completionStatus: "completed",
    completionReason: "complete",
    agentOutcome: {
      status: "completed",
      reason: "complete",
      shutdownConfirmed: true,
    },
    evaluatorOutcome: { status: "completed", reason: "evaluation completed" },
    finalizationOutcome: { status: "completed", reason: "evidence captured" },
    confirmatoryEvidence: {
      scheduleHash: binding.scheduleHash,
      scheduleContentHash: binding.scheduleContentHash,
      ordinal: scheduled.ordinal,
      blockId: scheduled.blockId,
      cohortManifestHash: binding.cohortManifestHash,
      initialFixtureManifestHash: binding.baselineManifestHash,
      provisioningConfigurationHash: HASH_B,
      lifecycleTimeoutMs: 60_000,
      shutdownTimeoutMs: 30_000,
      toolVersionsHash: sha256(canonicalJson(TOOL_VERSIONS)),
      approvalReference: "approved-test-provider-run",
      sandbox: {
        isolated: true,
        killable: true,
        kind: "os-level-process-sandbox",
        workspacePath: `/tmp/agentix-benchmark/${id}`,
        networkPolicy: "disabled",
        attestationReference: `sandbox-${id}`,
      },
    },
    provider: "provider",
    model: "exact-model-v1",
    serviceTier: "standard",
    reasoningConfiguration: REASONING,
    responseIds: [`response-${id}`],
    usage: rawUsage,
    accountedTokens: deriveAccountedTokens(rawUsage),
    cost: {
      availability: "unavailable",
      amount: null,
      currency: null,
      pricingSnapshotId: null,
      reason: "No pricing snapshot was supplied.",
    },
    provisioning: [
      { name: "dependencies", status: "passed", durationMs: 1, details: null },
    ],
    preflight: [
      { name: "fixture", status: "passed", durationMs: 1, details: null },
    ],
    interaction: {
      assistantTurns: 2,
      toolCalls: scheduled.arm === "framework" ? 8 : 10,
      toolCallsByType: { read: 3, exec: scheduled.arm === "framework" ? 5 : 7 },
      failedToolCalls: 0,
      commands: 2,
      testCommands: [
        {
          commandId: "test-1",
          argv: ["npm", "test"],
          cwd: ".",
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
        },
      ],
      failedAttempts: 0,
      retries: 0,
      filesOpened:
        scheduled.arm === "framework"
          ? ["src/a.ts", "src/b.ts", "README.md"]
          : ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "README.md"],
      uniqueSourceFilesOpened:
        scheduled.arm === "framework"
          ? ["src/a.ts", "src/b.ts"]
          : ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      repeatFileObservations: 0,
      unattributedFileObservations: 0,
      events: [],
    },
    patch: {
      filesModified: [
        {
          path: "src/a.ts",
          kind: "modified",
          linesAdded: 3,
          linesDeleted: 1,
          binary: false,
          generated: false,
        },
        {
          path: "src/b.ts",
          kind: "added",
          linesAdded: 1,
          linesDeleted: 0,
          binary: false,
          generated: false,
        },
      ],
      totalFilesModified: 2,
      generatedFilesModified: 0,
      linesAdded: 4,
      linesDeleted: 1,
      finalDiffHash: HASH_A,
      finalManifestHash: HASH_B,
      baselineManifestHash: binding.baselineManifestHash,
      evidenceAvailability: "available",
      evidenceUnavailableReason: null,
    },
    evaluation: {
      checks: requiredChecks(scheduled.arm),
      success: true,
      failureCategory: null,
      invalidRunReason: null,
    },
    finalSuccess: true,
    artifacts: [],
  };
};

const makeInput = (): AnalysisInput => {
  const schedule = createConfirmatorySchedule({
    tasks,
    repetitions: 5,
    seed: "committed-seed-v1",
  });
  const pins = Object.fromEntries(
    tasks.map((task) => [taskKey(task), instructionsFor(task).bundle]),
  );
  const fixtures = Object.fromEntries(
    tasks.map((task) => [
      taskKey(task),
      {
        framework: `${task.id}-framework-fixture-v1`,
        plain: `${task.id}-plain-fixture-v1`,
      },
    ]),
  );
  const evaluators = Object.fromEntries(
    tasks.map((task) => [
      taskKey(task),
      {
        framework: `${task.id}-framework-evaluator-v1`,
        plain: `${task.id}-plain-evaluator-v1`,
      },
    ]),
  );
  const fixtureManifests = Object.fromEntries(
    tasks.map((task) => [
      taskKey(task),
      { framework: HASH_A, plain: HASH_A },
    ]),
  );
  const cohortInput: Omit<AnalysisConfiguration["cohort"], "manifestHash"> = {
    schemaVersion: 1,
    cohortId: "confirmatory-cohort-v1",
    scheduleSeed: schedule.seed,
    scheduleHash: schedule.scheduleHash,
    provider: "provider",
    exactModel: "exact-model-v1",
    serviceTier: "standard",
    reasoningConfigurationHash: sha256(canonicalJson(REASONING)),
    instructionBundleByTask: pins,
    fixtureRevisionByTask: fixtures,
    fixtureManifestHashByTask: fixtureManifests,
    evaluatorRevisionByTask: evaluators,
    analysisRevision: "analysis-code-v1",
    timeoutMsByTask: Object.fromEntries(
      tasks.map((task) => [taskKey(task), timeoutMsForTask(task)]),
    ),
    lifecycleTimeoutMs: 60_000,
    shutdownTimeoutMs: 30_000,
    provisioningConfigurationHash: HASH_B,
    networkPolicy: "disabled",
    dependencyCachePolicy: "published-packages-only",
    hostClass: "host-v1",
    containerImage: "benchmark-image-v1",
    packageManager: "npm@11.13.0",
    toolVersionsHash: sha256(canonicalJson(TOOL_VERSIONS)),
    pricingSnapshotId: null,
    pricingCurrency: null,
  };
  const cohort: AnalysisConfiguration["cohort"] = {
    ...cohortInput,
    manifestHash: sha256(canonicalJson(cohortInput)),
  };
  const scheduleContentHash = sha256(canonicalJson(schedule));
  const records = schedule.runs.map((scheduled) =>
    makeRecord(scheduled, scheduled.arm === "framework" ? 80 : 100, {
      scheduleHash: schedule.scheduleHash,
      scheduleContentHash,
      cohortManifestHash: cohort.manifestHash,
      baselineManifestHash: fixtureManifests[taskKey(scheduled.task)]?.[scheduled.arm] ?? "",
    }),
  );
  const configuration: AnalysisConfiguration = {
    schemaVersion: 1,
    analysisVersion: ANALYSIS_VERSION,
    studyPhase: "confirmatory",
    thresholds: FROZEN_THRESHOLDS,
    cohort,
    manifestHashes: {
      schedule: scheduleContentHash,
      taskCorpus: HASH_A,
      evaluator: HASH_B,
      analysisSource: HASH_A,
      equivalenceEvidence: HASH_B,
      runtimeDxEvidence: HASH_A,
      constructionCostEvidence: null,
      pricingSnapshot: null,
    },
    gates: {
      equivalencePassed: true,
      freshSessionReproductionEstablished: true,
      runtimeAndDxBudgetsPassed: true,
      criticalRegressionReviewPassed: true,
      protocolCompromised: false,
    },
    constructionCost: {
      tokens: { value: null, unavailableReason: "historical telemetry unavailable" },
      money: {
        value: null,
        unavailableReason: "historical telemetry unavailable",
        currency: null,
      },
    },
    runIds: records.map(({ identity }) => identity.runId),
  };
  return {
    records,
    schedule,
    configuration,
    pricingSnapshot: null,
    evidence: { analysisSourceHash: HASH_A },
  };
};

const replaceRecord = (
  input: AnalysisInput,
  index: number,
  update: (record: RunRecord) => RunRecord,
): AnalysisInput => ({
  ...input,
  records: input.records.map((record, selected) =>
    selected === index ? update(record) : record,
  ),
});

const failedRecord = (record: RunRecord): RunRecord => ({
  ...record,
  evaluation: {
    ...record.evaluation,
    checks: record.evaluation.checks.map((check) =>
      check.name === "hidden-regression" ? { ...check, status: "failed" } : check,
    ),
    success: false,
    failureCategory: "hidden regression",
  },
  finalSuccess: false,
});

describe("integrity-bound confirmatory analysis", () => {
  it("supports only a complete frozen confirmatory cohort satisfying fixed conditions", () => {
    const report = analyzeExperiment(makeInput());
    expect(report.verdict).toBe("SUPPORTED");
    expect(report.aggregate.tokenReduction).toBeCloseTo(0.2);
    expect(report.aggregate.improvedTaskCategories).toBe(10);
    expect(report.aggregate.framework.successInterval).toEqual(wilson95(50, 50));
    expect(report.pairedBlockDifferences).toHaveLength(50);
    expect(report.noninferiorityRule.method).toBe("observed_point_difference");
    expect(report.breakEven.tokens.status).toBe("unavailable");
  });

  it("binds each record to its scheduled task timeout", () => {
    const input = makeInput();
    const taskTenIndex = input.records.findIndex(
      (record) => record.identity.task.id === "task-10",
    );
    expect(taskTenIndex).toBeGreaterThanOrEqual(0);
    const wrongTimeout = replaceRecord(input, taskTenIndex, (record) => ({
      ...record,
      timeoutMs: 1_800_000,
    }));

    const report = analyzeExperiment(wrongTimeout);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.protocolDeviations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "COHORT_PIN_MISMATCH",
          detail: expect.stringContaining("task timeout mismatch"),
        }),
      ]),
    );
  });

  it("keeps the initial fixture pin separate from the post-preflight baseline", () => {
    const input = makeInput();
    const withGeneratedPreflightOutput = replaceRecord(input, 0, (record) => ({
      ...record,
      patch: {
        ...record.patch,
        baselineManifestHash: HASH_B,
      },
    }));

    const report = analyzeExperiment(withGeneratedPreflightOutput);
    expect(report.verdict).toBe("SUPPORTED");
    expect(report.protocolDeviations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COHORT_PIN_MISMATCH" }),
      ]),
    );
  });

  it("makes smoke, pilot, or mixed-phase inputs unconditionally inconclusive", () => {
    const smoke = replaceRecord(makeInput(), 0, (record) => ({ ...record, mode: "smoke" }));
    expect(analyzeExperiment(smoke).verdict).toBe("INCONCLUSIVE");

    const pilot = makeInput();
    expect(
      analyzeExperiment({
        ...pilot,
        configuration: { ...pilot.configuration, studyPhase: "pilot" },
      }).verdict,
    ).toBe("INCONCLUSIVE");
  });

  it("rejects threshold or analysis-version tampering", () => {
    const threshold = makeInput();
    expect(() =>
      analyzeExperiment({
        ...threshold,
        configuration: {
          ...threshold.configuration,
          thresholds: {
            ...threshold.configuration.thresholds,
            minimumTokenReduction: 0.19,
          } as unknown as typeof threshold.configuration.thresholds,
        },
      }),
    ).toThrow(/exactly 0.05, 0.20, and 7/u);

    const version = makeInput();
    expect(() =>
      analyzeExperiment({
        ...version,
        configuration: {
          ...version.configuration,
          analysisVersion: "analysis-v2",
        },
      }),
    ).toThrow(/Analysis version must be exactly/u);
  });

  it("rejects duplicate valid cells and unscheduled task versions", () => {
    const duplicate = makeInput();
    const replacement = {
      ...duplicate.records[0]!,
      identity: {
        ...duplicate.records[0]!.identity,
        runId: "duplicate-valid-run",
      },
      responseIds: ["response-duplicate-valid-run"],
      confirmatoryEvidence: {
        ...duplicate.records[0]!.confirmatoryEvidence!,
        sandbox: {
          ...duplicate.records[0]!.confirmatoryEvidence!.sandbox,
          workspacePath: "/tmp/agentix-benchmark/duplicate-valid-run",
          attestationReference: "sandbox-duplicate-valid-run",
        },
      },
    };
    expect(() =>
      analyzeExperiment({
        ...duplicate,
        records: [...duplicate.records, replacement],
        configuration: {
          ...duplicate.configuration,
          runIds: [...duplicate.configuration.runIds, replacement.identity.runId],
        },
      }),
    ).toThrow(/Duplicate valid terminal records/u);

    const pooled = replaceRecord(makeInput(), 0, (record) => ({
      ...record,
      identity: {
        ...record.identity,
        task: { ...record.identity.task, version: 2 },
      },
    }));
    expect(() => analyzeExperiment(pooled)).toThrow(/unscheduled cell/u);
  });

  it("retains an invalid replacement while using one valid terminal record", () => {
    const input = makeInput();
    const original = input.records[0]!;
    const invalid = {
      ...original,
      identity: { ...original.identity, runId: "invalid-attempt" },
      responseIds: ["response-invalid-attempt"],
      confirmatoryEvidence: {
        ...original.confirmatoryEvidence!,
        sandbox: {
          ...original.confirmatoryEvidence!.sandbox,
          workspacePath: "/tmp/agentix-benchmark/invalid-attempt",
          attestationReference: "sandbox-invalid-attempt",
        },
      },
      evaluation: {
        ...original.evaluation,
        invalidRunReason: "provider outage before usable response",
      },
    };
    const report = analyzeExperiment({
      ...input,
      records: [...input.records, invalid],
      configuration: {
        ...input.configuration,
        runIds: [...input.configuration.runIds, invalid.identity.runId],
      },
    });
    expect(report.verdict).toBe("SUPPORTED");
    expect(report.invalidRuns).toHaveLength(1);
    expect(report.invalidRuns[0]?.runId).toBe("invalid-attempt");
  });

  it("marks mixed model/revision cohorts as protocol evidence and inconclusive", () => {
    const mixed = replaceRecord(makeInput(), 0, (record) => ({
      ...record,
      model: "different-model-v2",
      identity: { ...record.identity, analysisRevision: "different-analysis" },
    }));
    const report = analyzeExperiment(mixed);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.prerequisites.cohortPinsMatch).toBe(false);
    expect(report.protocolDeviations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COHORT_PIN_MISMATCH", material: true }),
      ]),
    );
  });

  it("rejects legacy confirmatory records missing the new integrity evidence", () => {
    const legacy = replaceRecord(makeInput(), 0, (record) => {
      const { inputTokenRelation: _inputTokenRelation, ...rawUsage } = record.usage;
      const {
        agentOutcome: _agentOutcome,
        evaluatorOutcome: _evaluatorOutcome,
        confirmatoryEvidence: _confirmatoryEvidence,
        provisioning: _provisioning,
        ...legacyRecord
      } = record;
      const { baselineManifestHash: _baselineManifestHash, ...legacyPatch } =
        record.patch;
      return {
        ...legacyRecord,
        finalizationOutcome: {
          status: "evidence_unavailable" as const,
          reason: "legacy record did not capture final evidence",
        },
        usage: rawUsage,
        accountedTokens: deriveAccountedTokens(rawUsage),
        patch: {
          ...legacyPatch,
          evidenceAvailability: "unavailable" as const,
          evidenceUnavailableReason: "legacy patch summary",
        },
      };
    });
    const report = analyzeExperiment(legacy);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.protocolDeviations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CONFIRMATORY_BINDING_MISSING" }),
        expect.objectContaining({ code: "TERMINAL_OUTCOME_MISSING" }),
        expect.objectContaining({ code: "PROVISIONING_EVIDENCE_MISSING" }),
        expect.objectContaining({ code: "FINALIZATION_EVIDENCE_UNAVAILABLE" }),
        expect.objectContaining({ code: "PATCH_EVIDENCE_UNAVAILABLE" }),
        expect.objectContaining({ code: "INPUT_ACCOUNTING_RELATION_MISSING" }),
      ]),
    );
  });

  it("rejects stale cohort manifests and reused session attestations", () => {
    const stale = makeInput();
    expect(() =>
      analyzeExperiment({
        ...stale,
        configuration: {
          ...stale.configuration,
          cohort: {
            ...stale.configuration.cohort,
            timeoutMsByTask: {
              ...stale.configuration.cohort.timeoutMsByTask,
              "task-10@1": 1,
            },
          },
        },
      }),
    ).toThrow(/cohort manifest hash is stale/u);

    const reuseInput = makeInput();
    const firstSandbox = reuseInput.records[0]?.confirmatoryEvidence?.sandbox;
    if (firstSandbox === undefined) throw new Error("Expected sandbox evidence.");
    const reused = replaceRecord(reuseInput, 1, (record) => ({
      ...record,
      confirmatoryEvidence: {
        ...record.confirmatoryEvidence!,
        sandbox: {
          ...record.confirmatoryEvidence!.sandbox,
          workspacePath: firstSandbox.workspacePath,
          attestationReference: firstSandbox.attestationReference,
        },
      },
    }));
    const report = analyzeExperiment(reused);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.protocolDeviations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_ISOLATION_REUSED" }),
      ]),
    );
  });

  it("keeps ambiguous raw usage unavailable instead of trusting stored totals", () => {
    const ambiguous = replaceRecord(makeInput(), 0, (record) => {
      const rawUsage: RawProviderUsage = {
        ...record.usage,
        reasoningTokenRelation: "unknown",
        providerTotalRelation: "unknown",
      };
      return {
        ...record,
        usage: rawUsage,
        accountedTokens: deriveAccountedTokens(rawUsage),
      };
    });
    const report = analyzeExperiment(ambiguous);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.missingness["successfulAccountedTokens"]).toBe(1);
  });

  it("derives success from every required evaluator check and cross-checks booleans", () => {
    const missing = replaceRecord(makeInput(), 0, (record) => ({
      ...record,
      evaluation: {
        ...record.evaluation,
        checks: record.evaluation.checks.filter(
          ({ name }) => name !== "hidden-regression",
        ),
      },
    }));
    const report = analyzeExperiment(missing);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.prerequisites.crossChecksPass).toBe(false);
    expect(report.invalidRuns[0]?.reasons.join(" ")).toMatch(
      /required evaluator check hidden-regression/u,
    );
  });

  it("requires every confirmatory preflight check to pass", () => {
    const notApplicable = replaceRecord(makeInput(), 0, (record) => ({
      ...record,
      preflight: [
        {
          name: "fixture",
          status: "not_applicable" as const,
          durationMs: 1,
          details: "fixture check was skipped",
        },
      ],
      finalSuccess: false,
    }));
    const report = analyzeExperiment(notApplicable);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.invalidRuns[0]?.reasons.join(" ")).toMatch(
      /preflight contains a check that did not pass/u,
    );
  });

  it("reports failed-run token distributions without assigning penalties", () => {
    const failed = replaceRecord(makeInput(), 0, failedRecord);
    const report = analyzeExperiment(failed);
    expect(report.aggregate.framework.failures).toBe(1);
    expect(report.aggregate.framework.failedAccountedTokens).toMatchObject({
      count: 1,
      median: 80,
    });
    expect(report.failuresByCategory["hidden regression"]).toBe(1);
  });

  it("counts a finalized timeout as a valid failure without invented evaluator checks", () => {
    const input = makeInput();
    const frameworkIndex = input.records.findIndex(
      ({ identity }) => identity.arm === "framework",
    );
    const timedOut = replaceRecord(input, frameworkIndex, (record) => ({
      ...record,
      completionStatus: "timeout",
      completionReason: "agent deadline expired",
      agentOutcome: {
        status: "timeout",
        reason: "agent deadline expired",
        shutdownConfirmed: true,
      },
      evaluatorOutcome: { status: "completed", reason: "evaluator completed" },
      evaluation: {
        ...record.evaluation,
        failureCategory: "timeout",
      },
      finalSuccess: false,
    }));
    const report = analyzeExperiment(timedOut);
    expect(report.aggregate.framework.failures).toBe(1);
    expect(report.invalidRuns).toHaveLength(0);
    expect(report.failuresByCategory["timeout"]).toBe(1);
  });

  it("counts an agent-created prohibited workspace entry as a valid failure", () => {
    const input = makeInput();
    const frameworkIndex = input.records.findIndex(
      ({ identity }) => identity.arm === "framework",
    );
    const prohibitedEntry = replaceRecord(input, frameworkIndex, (record) => ({
      ...record,
      finalizationOutcome: {
        status: "evidence_unavailable" as const,
        reason: "Workspace symbolic links are prohibited.",
      },
      patch: {
        filesModified: [],
        totalFilesModified: 0,
        generatedFilesModified: 0,
        linesAdded: 0,
        linesDeleted: 0,
        finalDiffHash: HASH_A,
        finalManifestHash: record.patch.baselineManifestHash ?? HASH_A,
        baselineManifestHash: record.patch.baselineManifestHash ?? HASH_A,
        evidenceAvailability: "unavailable" as const,
        evidenceUnavailableReason: "Workspace symbolic links are prohibited.",
      },
      evaluation: {
        ...record.evaluation,
        checks: [
          ...record.evaluation.checks,
          {
            name: "workspace-policy",
            status: "failed" as const,
            durationMs: 0,
            details: "Workspace symbolic links are prohibited.",
          },
        ],
        success: false,
        failureCategory: "prohibited workspace entry",
      },
      finalSuccess: false,
    }));

    const report = analyzeExperiment(prohibitedEntry);
    expect(report.invalidRuns).toHaveLength(0);
    expect(report.aggregate.framework.failures).toBe(1);
    expect(report.failuresByCategory["prohibited workspace entry"]).toBe(1);
    expect(report.protocolDeviations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_WORKSPACE_POLICY_FAILURE",
          material: false,
        }),
      ]),
    );
  });

  it("computes token and compatible-currency monetary break-even from explicit construction inputs", () => {
    const input = makeInput();
    const records = input.records.map((record): RunRecord => {
      const rawUsage = record.usage;
      const tokens =
        (rawUsage.uncachedInputTokens.value ?? 0) +
        (rawUsage.cachedInputTokens.value ?? 0) +
        (rawUsage.outputTokens.value ?? 0);
      return {
        ...record,
        cost: {
          availability: "available",
          amount: (tokens * 0.1) / 1_000,
          currency: "USD",
          pricingSnapshotId: "pricing-v1",
          formula: "uncached_input + cached_input + output; prices per 1000 tokens",
        },
      };
    });
    const { manifestHash: _manifestHash, ...baseCohort } =
      input.configuration.cohort;
    const pricedCohortInput: Omit<
      AnalysisConfiguration["cohort"],
      "manifestHash"
    > = {
      ...baseCohort,
      pricingSnapshotId: "pricing-v1",
      pricingCurrency: "USD",
    };
    const configuration: AnalysisConfiguration = {
      ...input.configuration,
      cohort: {
        ...pricedCohortInput,
        manifestHash: sha256(canonicalJson(pricedCohortInput)),
      },
      manifestHashes: {
        ...input.configuration.manifestHashes,
        constructionCostEvidence: HASH_A,
        pricingSnapshot: sha256(canonicalJson(PRICING_SNAPSHOT)),
      },
      constructionCost: {
        tokens: { value: 1_000, unavailableReason: null },
        money: { value: 1, unavailableReason: null, currency: "USD" },
      },
    };
    const pricedRecords = records.map((record): RunRecord => {
      if (record.confirmatoryEvidence === undefined || record.confirmatoryEvidence === null) {
        throw new Error("Expected confirmatory evidence.");
      }
      return {
        ...record,
        confirmatoryEvidence: {
          ...record.confirmatoryEvidence,
          cohortManifestHash: configuration.cohort.manifestHash,
        },
      };
    });
    const pricedInput: AnalysisInput = {
      ...input,
      records: pricedRecords,
      pricingSnapshot: PRICING_SNAPSHOT,
      configuration,
    };
    const report = analyzeExperiment(pricedInput);
    expect(report.breakEven.tokens).toMatchObject({
      status: "available",
      maintenanceTasks: 50,
      unit: "tokens",
    });
    expect(report.breakEven.money.status).toBe("available");
    if (report.breakEven.money.status === "available") {
      expect(report.breakEven.money.maintenanceTasks).toBeCloseTo(500);
      expect(report.breakEven.money.currency).toBe("USD");
    }

    const tamperedRecords = [...pricedRecords];
    const first = tamperedRecords[0];
    if (first === undefined || first.cost.availability !== "available") {
      throw new Error("Expected an available synthetic cost.");
    }
    tamperedRecords[0] = {
      ...first,
      cost: { ...first.cost, amount: first.cost.amount + 1 },
    };
    const tampered = analyzeExperiment({ ...pricedInput, records: tamperedRecords });
    expect(tampered.verdict).toBe("INCONCLUSIVE");
    expect(tampered.prerequisites.crossChecksPass).toBe(false);
    expect(tampered.invalidRuns[0]?.reasons.join(" ")).toMatch(
      /stored monetary cost disagrees/u,
    );
  });

  it("uses the preregistered observed point difference for noninferiority", () => {
    let input = makeInput();
    const frameworkIndexes = input.records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.identity.arm === "framework")
      .slice(0, 3)
      .map(({ index }) => index);
    for (const index of frameworkIndexes) input = replaceRecord(input, index, failedRecord);
    const report = analyzeExperiment(input);
    expect(report.aggregate.successRateDifference).toBeCloseTo(-0.06);
    expect(report.verdict).toBe("NOT SUPPORTED");
    expect(report.verdictReasons).toContain("correctness non-inferiority failed");
  });

  it("returns NOT SUPPORTED when a complete cohort misses the fixed token threshold", () => {
    const input = makeInput();
    const records = input.records.map((record): RunRecord => {
      if (record.identity.arm !== "framework") return record;
      const rawUsage = usage(90);
      return {
        ...record,
        usage: rawUsage,
        accountedTokens: deriveAccountedTokens(rawUsage),
      };
    });
    const report = analyzeExperiment({ ...input, records });
    expect(report.verdict).toBe("NOT SUPPORTED");
    expect(report.aggregate.tokenReduction).toBeCloseTo(0.1);
    expect(report.verdictReasons).toContain(
      "the 20 percent median token-reduction threshold failed",
    );
  });

  it("treats a complete zero-success cohort as NOT SUPPORTED, not inconclusive", () => {
    const input = makeInput();
    const report = analyzeExperiment({
      ...input,
      records: input.records.map(failedRecord),
    });
    expect(report.prerequisites.rawTokenTelemetryCompleteForSuccesses).toBe(true);
    expect(report.verdict).toBe("NOT SUPPORTED");
  });

  it("rejects schedule hash and exact-slot corruption", () => {
    const hashMismatch = makeInput();
    expect(() =>
      analyzeExperiment({
        ...hashMismatch,
        schedule: { ...hashMismatch.schedule, scheduleHash: HASH_A },
      }),
    ).toThrow(/Schedule hash mismatch/u);

    const duplicateSlot = makeInput();
    const runs = [...duplicateSlot.schedule.runs];
    runs[1] = { ...runs[0]!, ordinal: 2 };
    const hashInput = {
      schemaVersion: duplicateSlot.schedule.schemaVersion,
      seed: duplicateSlot.schedule.seed,
      repetitions: duplicateSlot.schedule.repetitions,
      taskCount: duplicateSlot.schedule.taskCount,
      runs,
    };
    expect(() =>
      analyzeExperiment({
        ...duplicateSlot,
        schedule: {
          ...duplicateSlot.schedule,
          runs,
          scheduleHash: sha256(canonicalJson(hashInput)),
        },
      }),
    ).toThrow(/Duplicate scheduled slot|Malformed blocked pair/u);
  });

  it("renders frozen rules, distributions, deviations, construction gaps, and evidence refs", () => {
    const report = analyzeExperiment(makeInput());
    const secondary = report.aggregate.framework.secondary;
    expect(secondary.assistantTurns?.median).toBe(2);
    expect(secondary.toolCalls?.median).toBe(8);
    expect(secondary.failedToolCalls?.median).toBe(0);
    expect(secondary.commands?.median).toBe(2);
    expect(secondary.filesInspected?.median).toBe(3);
    expect(secondary.uniqueSourceFilesInspected?.median).toBe(2);
    expect(secondary.repeatFileObservations?.median).toBe(0);
    expect(secondary.unattributedFileObservations?.median).toBe(0);
    expect(secondary.filesModified?.median).toBe(2);
    expect(secondary.generatedFilesModified?.median).toBe(0);
    expect(secondary.linesAdded?.median).toBe(4);
    expect(secondary.linesDeleted?.median).toBe(1);
    expect(secondary.testCommands?.median).toBe(1);
    expect(secondary.failedAttempts?.median).toBe(0);
    expect(secondary.retries?.median).toBe(0);
    expect(secondary.wallClockMilliseconds?.median).toBe(800);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("## Frozen decision rule");
    expect(markdown).toContain("Failed accounted-token median");
    expect(markdown).toContain("Assistant-turn median");
    expect(markdown).toContain("Failed tool-call median");
    expect(markdown).toContain("Command median");
    expect(markdown).toContain("Repeat file-observation median");
    expect(markdown).toContain("Unattributed file-observation median");
    expect(markdown).toContain("Generated files modified median");
    expect(markdown).toContain("## Aggregate distributions");
    expect(markdown).toContain("IQR=");
    expect(markdown).toContain("Failed accounted tokens");
    expect(markdown).toContain("## Paired blocked differences");
    expect(markdown).toContain("Construction tokens: unavailable");
    expect(markdown).toContain("## Evidence hashes");
    expect(markdown).toContain("Raw record task-01-framework-1");
  });
});
