import {
  canonicalJson,
  deriveAccountedTokens,
  deriveProviderCost,
  sha256,
  type LifecycleCheck,
  type PricingSnapshot,
  type RawUsageField,
  type RunRecord,
  type ScheduledRun,
} from "@agentixdev/benchmark-harness";
import { isAbsolute } from "node:path";

import { distribution, wilson95 } from "./statistics.js";
import type {
  AnalysisConfiguration,
  AnalysisInput,
  AnalyzedRun,
  ArmSummary,
  BreakEven,
  ExperimentReport,
  Implementation,
  Outlier,
  PairedBlockDifference,
  ProtocolDeviation,
  SecondaryMetricSummary,
  TaskSummary,
} from "./types.js";
import {
  ANALYSIS_VERSION,
  FROZEN_THRESHOLDS,
  parseAnalysisConfiguration,
  parsePricingSnapshot,
  slotKey,
  taskKey,
  validateSchedule,
} from "./validation.js";

const REQUIRED_EVALUATOR_CHECKS = [
  "acceptance",
  "hidden-regression",
  "typecheck",
  "architecture",
  "prohibited-shortcuts",
  "task-specific",
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;

const same = (left: unknown, right: unknown): boolean =>
  left === undefined || right === undefined
    ? left === right
    : canonicalJson(left) === canonicalJson(right);

const evidenceValue = (value: unknown): string =>
  value === undefined ? "undefined" : canonicalJson(value);

const repeatedValues = (values: readonly string[]): ReadonlySet<string> => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return repeated;
};

const expectedCheckPass = (
  check: LifecycleCheck,
  implementation: Implementation,
): boolean =>
  check.status === "passed" ||
  (check.name === "architecture" &&
    implementation === "plain" &&
    check.status === "not_applicable");

interface SuccessDerivation {
  readonly evaluationSuccess: boolean;
  readonly finalSuccess: boolean;
  readonly crossCheckReasons: readonly string[];
}

const deriveSuccess = (record: RunRecord): SuccessDerivation => {
  const checksByName = new Map<string, LifecycleCheck[]>();
  for (const check of record.evaluation.checks) {
    const selected = checksByName.get(check.name) ?? [];
    selected.push(check);
    checksByName.set(check.name, selected);
  }
  const reasons: string[] = [];
  const evaluatorCompleted = record.evaluatorOutcome?.status === "completed";
  let requiredPass = evaluatorCompleted;
  if (evaluatorCompleted) {
    for (const name of REQUIRED_EVALUATOR_CHECKS) {
      const checks = checksByName.get(name) ?? [];
      if (checks.length !== 1) {
        reasons.push(`required evaluator check ${name} appears ${checks.length} times`);
        requiredPass = false;
        continue;
      }
      const check = checks[0];
      if (check === undefined || !expectedCheckPass(check, record.identity.arm)) {
        requiredPass = false;
      }
    }
  }
  const noAdditionalFailure = record.evaluation.checks.every(
    ({ status }) => status !== "failed",
  );
  const expectedEvaluationSuccess =
    evaluatorCompleted && requiredPass && noAdditionalFailure;
  const preflightPresent = record.preflight.length > 0;
  const preflightPass =
    preflightPresent && record.preflight.every(({ status }) => status === "passed");
  if (!preflightPresent) reasons.push("confirmatory preflight evidence is missing");
  const provisioningPresent =
    record.provisioning !== undefined && record.provisioning.length > 0;
  const provisioningPass =
    provisioningPresent &&
    record.provisioning?.every(({ status }) => status === "passed") === true;
  if (!provisioningPresent) {
    reasons.push("confirmatory provisioning evidence is missing");
  }
  const terminalEvidencePass =
    record.agentOutcome?.status === "completed" &&
    record.agentOutcome.shutdownConfirmed &&
    record.evaluatorOutcome?.status === "completed" &&
    record.finalizationOutcome?.status === "completed";
  const expectedFinalSuccess =
    record.completionStatus === "completed" &&
    terminalEvidencePass &&
    provisioningPass &&
    preflightPass &&
    expectedEvaluationSuccess;
  if (record.evaluation.success !== expectedEvaluationSuccess) {
    reasons.push(
      `evaluation.success=${record.evaluation.success} disagrees with required checks=${expectedEvaluationSuccess}`,
    );
  }
  if (record.finalSuccess !== expectedFinalSuccess) {
    reasons.push(
      `finalSuccess=${record.finalSuccess} disagrees with derived success=${expectedFinalSuccess}`,
    );
  }
  return {
    evaluationSuccess: expectedEvaluationSuccess,
    finalSuccess: expectedFinalSuccess,
    crossCheckReasons: reasons,
  };
};

const addMismatch = (
  reasons: string[],
  deviations: ProtocolDeviation[],
  run: RunRecord,
  slot: string,
  code: string,
  detail: string,
  material = true,
): void => {
  reasons.push(detail);
  deviations.push({ code, runId: run.identity.runId, slot, detail, material });
};

const addDeviation = (
  deviations: ProtocolDeviation[],
  run: RunRecord,
  slot: string,
  code: string,
  detail: string,
  material = false,
): void => {
  deviations.push({ code, runId: run.identity.runId, slot, detail, material });
};

const analyzeRecord = (
  record: RunRecord,
  configuration: AnalysisConfiguration,
  scheduled: ScheduledRun,
  pricingSnapshot: PricingSnapshot | null,
  reusedWorkspacePaths: ReadonlySet<string>,
  reusedAttestationReferences: ReadonlySet<string>,
  reusedResponseIds: ReadonlySet<string>,
  deviations: ProtocolDeviation[],
): AnalyzedRun => {
  const slot = slotKey(scheduled);
  const key = taskKey(record.identity.task);
  const arm = record.identity.arm;
  const reasons: string[] = [];
  const cohort = configuration.cohort;
  if (record.mode !== "confirmatory") {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PHASE_MISMATCH",
      `run mode ${record.mode} is not confirmatory`,
    );
  }
  const confirmatoryEvidence = record.confirmatoryEvidence;
  if (confirmatoryEvidence === undefined || confirmatoryEvidence === null) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "CONFIRMATORY_BINDING_MISSING",
      "confirmatory schedule, cohort, sandbox, and session evidence is missing",
    );
  } else {
    const evidenceComparisons: readonly [string, unknown, unknown][] = [
      ["bound schedule hash", confirmatoryEvidence.scheduleHash, configuration.cohort.scheduleHash],
      [
        "bound schedule content hash",
        confirmatoryEvidence.scheduleContentHash,
        configuration.manifestHashes.schedule,
      ],
      ["bound schedule ordinal", confirmatoryEvidence.ordinal, scheduled.ordinal],
      ["bound schedule block", confirmatoryEvidence.blockId, scheduled.blockId],
      [
        "bound cohort manifest",
        confirmatoryEvidence.cohortManifestHash,
        configuration.cohort.manifestHash,
      ],
      [
        "bound initial fixture manifest",
        confirmatoryEvidence.initialFixtureManifestHash,
        cohort.fixtureManifestHashByTask[key]?.[arm],
      ],
      [
        "bound provisioning configuration",
        confirmatoryEvidence.provisioningConfigurationHash,
        cohort.provisioningConfigurationHash,
      ],
      [
        "bound lifecycle timeout",
        confirmatoryEvidence.lifecycleTimeoutMs,
        cohort.lifecycleTimeoutMs,
      ],
      [
        "bound shutdown timeout",
        confirmatoryEvidence.shutdownTimeoutMs,
        cohort.shutdownTimeoutMs,
      ],
      [
        "bound tool versions",
        confirmatoryEvidence.toolVersionsHash,
        cohort.toolVersionsHash,
      ],
      ["sandbox network policy", confirmatoryEvidence.sandbox.networkPolicy, cohort.networkPolicy],
    ];
    for (const [name, observed, expected] of evidenceComparisons) {
      if (!same(observed, expected)) {
        addMismatch(
          reasons,
          deviations,
          record,
          slot,
          "CONFIRMATORY_BINDING_MISMATCH",
          `${name} mismatch: observed ${evidenceValue(observed)}, expected ${evidenceValue(expected)}`,
        );
      }
    }
    if (
      confirmatoryEvidence.sandbox.isolated !== true ||
      confirmatoryEvidence.sandbox.killable !== true ||
      confirmatoryEvidence.sandbox.kind !== "os-level-process-sandbox" ||
      !isAbsolute(confirmatoryEvidence.sandbox.workspacePath) ||
      confirmatoryEvidence.sandbox.attestationReference.trim().length === 0 ||
      confirmatoryEvidence.approvalReference.trim().length === 0
    ) {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "SANDBOX_ATTESTATION_INVALID",
        "confirmatory sandbox/provider attestation is missing isolation, killability, absolute workspace, or approval/reference evidence",
      );
    }
    if (
      reusedWorkspacePaths.has(confirmatoryEvidence.sandbox.workspacePath) ||
      reusedAttestationReferences.has(confirmatoryEvidence.sandbox.attestationReference)
    ) {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "SESSION_ISOLATION_REUSED",
        "confirmatory workspace or sandbox attestation was reused across records",
      );
    }
  }
  if (record.responseIds.some((responseId) => reusedResponseIds.has(responseId))) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PROVIDER_SESSION_REUSED",
      "provider response/session identity was reused across confirmatory records",
    );
  }
  const pinComparisons: readonly [string, unknown, unknown][] = [
    ["provider", record.provider, cohort.provider],
    ["exact model", record.model, cohort.exactModel],
    ["service tier", record.serviceTier, cohort.serviceTier],
    [
      "reasoning configuration hash",
      sha256(canonicalJson(record.reasoningConfiguration)),
      cohort.reasoningConfigurationHash,
    ],
    ["instruction bundle", record.instructionHashes.bundle, cohort.instructionBundleByTask[key]],
    ["fixture revision", record.identity.fixtureRevision, cohort.fixtureRevisionByTask[key]?.[arm]],
    ["evaluator revision", record.identity.evaluatorRevision, cohort.evaluatorRevisionByTask[key]?.[arm]],
    ["analysis revision", record.identity.analysisRevision, cohort.analysisRevision],
    ["schedule seed", record.identity.scheduleSeed, cohort.scheduleSeed],
    ["task timeout", record.timeoutMs, cohort.timeoutMsByTask[key]],
    ["network policy", record.environment.networkPolicy, cohort.networkPolicy],
    [
      "dependency cache policy",
      record.environment.dependencyCachePolicy,
      cohort.dependencyCachePolicy,
    ],
    ["host class", record.environment.hostClass, cohort.hostClass],
    ["container image", record.environment.containerImage, cohort.containerImage],
    ["package manager", record.environment.packageManager, cohort.packageManager],
    [
      "tool versions hash",
      sha256(canonicalJson(record.environment.toolVersions)),
      cohort.toolVersionsHash,
    ],
    ["pricing snapshot ID", record.cost.pricingSnapshotId, cohort.pricingSnapshotId],
    ["pricing currency", record.cost.currency, cohort.pricingCurrency],
  ];
  for (const [name, observed, expected] of pinComparisons) {
    if (!same(observed, expected)) {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "COHORT_PIN_MISMATCH",
        `${name} mismatch: observed ${evidenceValue(observed)}, expected ${evidenceValue(expected)}`,
      );
    }
  }

  const expectedAgentStatus =
    record.completionStatus === "preflight_failed"
      ? "not_run"
      : record.completionStatus === "evaluator_error"
        ? "completed"
        : record.completionStatus;
  const agentOutcome = record.agentOutcome;
  if (agentOutcome === undefined) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "TERMINAL_OUTCOME_MISSING",
      "separate confirmatory agent outcome is missing",
    );
  } else {
    if (agentOutcome.status !== expectedAgentStatus) {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "TERMINAL_OUTCOME_MISMATCH",
        `agent outcome ${agentOutcome.status} disagrees with completion status ${record.completionStatus}`,
      );
    }
    if (!agentOutcome.shutdownConfirmed) {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "TERMINATION_NOT_CONFIRMED",
        "agent/provider session shutdown was not confirmed before final evidence capture",
      );
    }
  }
  const evaluatorOutcome = record.evaluatorOutcome;
  const evaluatorOutcomeMatches =
    evaluatorOutcome !== undefined &&
    (record.completionStatus === "preflight_failed"
      ? evaluatorOutcome.status === "not_run"
      : record.completionStatus === "evaluator_error"
        ? evaluatorOutcome.status === "failed" ||
          evaluatorOutcome.status === "timed_out" ||
          evaluatorOutcome.status === "aborted"
        : true);
  if (!evaluatorOutcomeMatches) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      evaluatorOutcome === undefined
        ? "TERMINAL_OUTCOME_MISSING"
        : "TERMINAL_OUTCOME_MISMATCH",
      evaluatorOutcome === undefined
        ? "separate confirmatory evaluator outcome is missing"
        : `evaluator outcome ${evaluatorOutcome.status} disagrees with completion status ${record.completionStatus}`,
    );
  }
  if (
    evaluatorOutcome !== undefined &&
    evaluatorOutcome.status !== "completed" &&
    record.completionStatus !== "preflight_failed"
  ) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "EVALUATOR_EVIDENCE_UNAVAILABLE",
      `evaluator terminal status ${evaluatorOutcome.status} is not usable correctness evidence`,
      false,
    );
  }
  const workspacePolicyChecks = record.evaluation.checks.filter(
    ({ name, status }) => name === "workspace-policy" && status === "failed",
  );
  const agentCausedWorkspacePolicyFailure =
    record.evaluation.failureCategory === "prohibited workspace entry" &&
    record.evaluation.invalidRunReason === null &&
    workspacePolicyChecks.length === 1 &&
    record.finalizationOutcome?.status === "evidence_unavailable" &&
    record.patch.evidenceAvailability === "unavailable";
  if (record.finalizationOutcome === undefined) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "TERMINAL_OUTCOME_MISSING",
      "separate confirmatory finalization outcome is missing",
    );
  } else if (record.finalizationOutcome.status !== "completed") {
    if (agentCausedWorkspacePolicyFailure) {
      addDeviation(
        deviations,
        record,
        slot,
        "AGENT_WORKSPACE_POLICY_FAILURE",
        "agent-created prohibited workspace entry prevented exact finalization evidence",
      );
    } else {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "FINALIZATION_EVIDENCE_UNAVAILABLE",
        "final workspace and patch evidence was unavailable",
        false,
      );
    }
  }

  const patch = record.patch;
  const patchPaths = patch.filesModified.map(({ path }) => path);
  const patchLinesAdded = patch.filesModified.reduce(
    (total, file) => total + file.linesAdded,
    0,
  );
  const patchLinesDeleted = patch.filesModified.reduce(
    (total, file) => total + file.linesDeleted,
    0,
  );
  const generatedFiles = patch.filesModified.filter(({ generated }) => generated).length;
  const exactPatchEvidence =
    patch.evidenceAvailability === "available" &&
    patch.evidenceUnavailableReason === null &&
    typeof patch.baselineManifestHash === "string" &&
    SHA256.test(patch.baselineManifestHash) &&
    SHA256.test(patch.finalManifestHash) &&
    SHA256.test(patch.finalDiffHash);
  if (!exactPatchEvidence) {
    if (agentCausedWorkspacePolicyFailure) {
      addDeviation(
        deviations,
        record,
        slot,
        "AGENT_PATCH_EVIDENCE_UNAVAILABLE",
        "exact patch evidence is unavailable because of the agent-created prohibited entry",
      );
    } else {
      addMismatch(
        reasons,
        deviations,
        record,
        slot,
        "PATCH_EVIDENCE_UNAVAILABLE",
        "exact baseline/final manifest and diff evidence is unavailable",
        false,
      );
    }
  }
  if (
    new Set(patchPaths).size !== patchPaths.length ||
    patch.totalFilesModified !== patch.filesModified.length ||
    patch.generatedFilesModified !== generatedFiles ||
    patch.linesAdded !== patchLinesAdded ||
    patch.linesDeleted !== patchLinesDeleted
  ) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PATCH_SUMMARY_CROSS_CHECK_FAILED",
      "stored patch aggregates disagree with exact per-file patch evidence",
    );
  }
  if (record.usage.inputTokenRelation === undefined) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "INPUT_ACCOUNTING_RELATION_MISSING",
      "confirmatory raw usage omits the input-token overlap relation",
    );
  }

  if (record.evaluation.invalidRunReason !== null) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PREREGISTERED_INVALID_RUN",
      record.evaluation.invalidRunReason,
      false,
    );
  }
  if (record.provisioning === undefined || record.provisioning.length === 0) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PROVISIONING_EVIDENCE_MISSING",
      "confirmatory provisioning evidence is missing",
    );
  } else if (record.provisioning.some(({ status }) => status !== "passed")) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PROVISIONING_NOT_PASSED",
      "confirmatory provisioning contains a check that did not pass",
      false,
    );
  }
  if (
    record.completionStatus === "preflight_failed" ||
    record.completionStatus === "evaluator_error"
  ) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "INFRASTRUCTURE_TERMINAL_STATUS",
      `terminal status ${record.completionStatus} is invalid infrastructure evidence`,
      false,
    );
  }
  if (record.preflight.length === 0 || record.preflight.some(({ status }) => status !== "passed")) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "PREFLIGHT_NOT_PASSED",
      record.preflight.length === 0
        ? "confirmatory preflight evidence is missing"
        : "confirmatory preflight contains a check that did not pass",
      false,
    );
  }

  const success = deriveSuccess(record);
  for (const detail of success.crossCheckReasons) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "SUCCESS_CROSS_CHECK_FAILED",
      detail,
    );
  }
  const accounted = deriveAccountedTokens(record.usage);
  if (!same(accounted, record.accountedTokens)) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "ACCOUNTING_CROSS_CHECK_FAILED",
      "stored accountedTokens disagrees with raw usage and declared overlap semantics",
    );
  }
  const accountedTokens = accounted.availability === "available" ? accounted.value : null;
  const tokenUnavailableReason =
    accounted.availability === "unavailable" ? accounted.reason : null;
  const derivedCost = deriveProviderCost({
    usage: record.usage,
    pricing: pricingSnapshot,
    provider: record.provider,
    model: record.model,
    serviceTier: record.serviceTier,
  });
  if (
    pricingSnapshot !== null &&
    Date.parse(pricingSnapshot.effectiveAt) > Date.parse(record.startedAt)
  ) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "COST_CROSS_CHECK_FAILED",
      "pinned pricing snapshot became effective after the run started",
    );
  }
  if (!same(derivedCost, record.cost)) {
    addMismatch(
      reasons,
      deviations,
      record,
      slot,
      "COST_CROSS_CHECK_FAILED",
      "stored monetary cost disagrees with raw usage and the pinned pricing snapshot",
    );
  }
  const moneyCost = derivedCost.availability === "available" ? derivedCost.amount : null;
  const moneyCurrency =
    derivedCost.availability === "available" ? derivedCost.currency : null;
  const valid = reasons.length === 0;
  return Object.freeze({
    source: record,
    slot,
    valid,
    invalidReasons: Object.freeze(reasons),
    success: valid && success.finalSuccess,
    accountedTokens,
    tokenUnavailableReason,
    moneyCost,
    moneyCurrency,
    failureCategory:
      success.finalSuccess
        ? null
        : record.evaluation.failureCategory ??
          (record.completionStatus === "completed"
            ? "evaluator failure"
            : record.completionStatus.replaceAll("_", " ")),
    rawRecordHash: sha256(canonicalJson(record)),
  });
};

const metricDistribution = (
  runs: readonly AnalyzedRun[],
  select: (run: AnalyzedRun) => number,
) => distribution(runs.map(select));

const secondarySummary = (runs: readonly AnalyzedRun[]): SecondaryMetricSummary => ({
  assistantTurns: metricDistribution(
    runs,
    (run) => run.source.interaction.assistantTurns,
  ),
  toolCalls: metricDistribution(runs, (run) => run.source.interaction.toolCalls),
  failedToolCalls: metricDistribution(
    runs,
    (run) => run.source.interaction.failedToolCalls,
  ),
  commands: metricDistribution(runs, (run) => run.source.interaction.commands),
  filesInspected: metricDistribution(
    runs,
    (run) => run.source.interaction.filesOpened.length,
  ),
  uniqueSourceFilesInspected: metricDistribution(
    runs,
    (run) => run.source.interaction.uniqueSourceFilesOpened.length,
  ),
  repeatFileObservations: metricDistribution(
    runs,
    (run) => run.source.interaction.repeatFileObservations,
  ),
  unattributedFileObservations: metricDistribution(
    runs,
    (run) => run.source.interaction.unattributedFileObservations,
  ),
  filesModified: metricDistribution(
    runs,
    (run) => run.source.patch.totalFilesModified,
  ),
  generatedFilesModified: metricDistribution(
    runs,
    (run) => run.source.patch.generatedFilesModified,
  ),
  linesAdded: metricDistribution(runs, (run) => run.source.patch.linesAdded),
  linesDeleted: metricDistribution(runs, (run) => run.source.patch.linesDeleted),
  testCommands: metricDistribution(
    runs,
    (run) => run.source.interaction.testCommands.length,
  ),
  failedAttempts: metricDistribution(
    runs,
    (run) => run.source.interaction.failedAttempts,
  ),
  retries: metricDistribution(runs, (run) => run.source.interaction.retries),
  wallClockMilliseconds: metricDistribution(runs, (run) => run.source.durationMs),
});

const armSummary = (
  runs: readonly AnalyzedRun[],
  implementation: Implementation,
): ArmSummary => {
  const arm = runs.filter(({ source }) => source.identity.arm === implementation);
  const valid = arm.filter(({ valid }) => valid);
  const successful = valid.filter(({ success }) => success);
  const failed = valid.filter(({ success }) => !success);
  const moneyCurrencies = new Set(
    successful.flatMap(({ moneyCurrency }) =>
      moneyCurrency === null ? [] : [moneyCurrency],
    ),
  );
  const moneyCurrency = moneyCurrencies.size === 1 ? [...moneyCurrencies][0] ?? null : null;
  const successfulMoney =
    moneyCurrencies.size <= 1
      ? successful.flatMap(({ moneyCost }) => (moneyCost === null ? [] : [moneyCost]))
      : [];
  return Object.freeze({
    validRuns: valid.length,
    invalidRuns: arm.length - valid.length,
    successes: successful.length,
    failures: failed.length,
    successRate: valid.length === 0 ? null : successful.length / valid.length,
    successInterval: wilson95(successful.length, valid.length),
    successfulAccountedTokens: distribution(
      successful.flatMap(({ accountedTokens }) =>
        accountedTokens === null ? [] : [accountedTokens],
      ),
    ),
    failedAccountedTokens: distribution(
      failed.flatMap(({ accountedTokens }) =>
        accountedTokens === null ? [] : [accountedTokens],
      ),
    ),
    allAccountedTokens: distribution(
      valid.flatMap(({ accountedTokens }) =>
        accountedTokens === null ? [] : [accountedTokens],
      ),
    ),
    successfulMoneyCost: distribution(successfulMoney),
    moneyCurrency,
    secondary: Object.freeze(secondarySummary(valid)),
  });
};

const reduction = (plain: number | null, framework: number | null): number | null =>
  plain === null || framework === null || plain <= 0
    ? null
    : (plain - framework) / plain;

const ratio = (framework: number | null, plain: number | null): number | null =>
  framework === null || plain === null || plain <= 0 ? null : framework / plain;

const taskSummary = (
  key: string,
  runs: readonly AnalyzedRun[],
): TaskSummary => {
  const [taskId, rawVersion] = key.split("@");
  const taskVersion = Number(rawVersion);
  const selected = runs.filter((run) => taskKey(run.source.identity.task) === key);
  const framework = armSummary(selected, "framework");
  const plain = armSummary(selected, "plain");
  const frameworkMedian = framework.successfulAccountedTokens?.median ?? null;
  const plainMedian = plain.successfulAccountedTokens?.median ?? null;
  const tokenReduction = reduction(plainMedian, frameworkMedian);
  return Object.freeze({
    taskId: taskId ?? key,
    taskVersion,
    framework,
    plain,
    successRateDifference:
      framework.successRate === null || plain.successRate === null
        ? null
        : framework.successRate - plain.successRate,
    tokenReduction,
    frameworkToPlainTokenRatio: ratio(frameworkMedian, plainMedian),
    tokenImproved: tokenReduction !== null && tokenReduction > 0,
  });
};

const pairedDifferences = (
  scheduleRuns: readonly ScheduledRun[],
  selectedBySlot: ReadonlyMap<string, AnalyzedRun>,
): readonly PairedBlockDifference[] => {
  const blocks = new Map<string, ScheduledRun[]>();
  for (const scheduled of scheduleRuns) {
    const block = blocks.get(scheduled.blockId) ?? [];
    block.push(scheduled);
    blocks.set(scheduled.blockId, block);
  }
  const differences: PairedBlockDifference[] = [];
  for (const [blockId, block] of blocks) {
    const frameworkSlot = block.find(({ arm }) => arm === "framework");
    const plainSlot = block.find(({ arm }) => arm === "plain");
    if (frameworkSlot === undefined || plainSlot === undefined) continue;
    const framework = selectedBySlot.get(slotKey(frameworkSlot));
    const plain = selectedBySlot.get(slotKey(plainSlot));
    if (framework === undefined || plain === undefined) continue;
    differences.push({
      blockId,
      taskId: framework.source.identity.task.id,
      taskVersion: framework.source.identity.task.version,
      repetition: framework.source.identity.repetition,
      frameworkRunId: framework.source.identity.runId,
      plainRunId: plain.source.identity.runId,
      successDifference: Number(framework.success) - Number(plain.success),
      accountedTokenDifference:
        framework.success &&
        plain.success &&
        framework.accountedTokens !== null &&
        plain.accountedTokens !== null
          ? framework.accountedTokens - plain.accountedTokens
          : null,
      toolCallDifference:
        framework.source.interaction.toolCalls - plain.source.interaction.toolCalls,
      filesInspectedDifference:
        framework.source.interaction.filesOpened.length -
        plain.source.interaction.filesOpened.length,
      uniqueSourceFilesInspectedDifference:
        framework.source.interaction.uniqueSourceFilesOpened.length -
        plain.source.interaction.uniqueSourceFilesOpened.length,
      failedAttemptDifference:
        framework.source.interaction.failedAttempts -
        plain.source.interaction.failedAttempts,
      retryDifference:
        framework.source.interaction.retries - plain.source.interaction.retries,
      wallClockDifferenceMilliseconds:
        framework.source.durationMs - plain.source.durationMs,
    });
  }
  return Object.freeze(
    differences.sort((left, right) => left.blockId.localeCompare(right.blockId)),
  );
};

const outliers = (runs: readonly AnalyzedRun[]): readonly Outlier[] => {
  const valid = runs.filter(({ valid }) => valid);
  const metrics = [
    ["accountedTokens", (run: AnalyzedRun) => run.accountedTokens],
    ["moneyCost", (run: AnalyzedRun) => run.moneyCost],
    ["assistantTurns", (run: AnalyzedRun) => run.source.interaction.assistantTurns],
    ["toolCalls", (run: AnalyzedRun) => run.source.interaction.toolCalls],
    ["failedToolCalls", (run: AnalyzedRun) => run.source.interaction.failedToolCalls],
    ["commands", (run: AnalyzedRun) => run.source.interaction.commands],
    ["filesInspected", (run: AnalyzedRun) => run.source.interaction.filesOpened.length],
    [
      "uniqueSourceFilesInspected",
      (run: AnalyzedRun) => run.source.interaction.uniqueSourceFilesOpened.length,
    ],
    [
      "repeatFileObservations",
      (run: AnalyzedRun) => run.source.interaction.repeatFileObservations,
    ],
    [
      "unattributedFileObservations",
      (run: AnalyzedRun) => run.source.interaction.unattributedFileObservations,
    ],
    ["filesModified", (run: AnalyzedRun) => run.source.patch.totalFilesModified],
    [
      "generatedFilesModified",
      (run: AnalyzedRun) => run.source.patch.generatedFilesModified,
    ],
    ["linesAdded", (run: AnalyzedRun) => run.source.patch.linesAdded],
    ["linesDeleted", (run: AnalyzedRun) => run.source.patch.linesDeleted],
    [
      "testCommands",
      (run: AnalyzedRun) => run.source.interaction.testCommands.length,
    ],
    ["failedAttempts", (run: AnalyzedRun) => run.source.interaction.failedAttempts],
    ["retries", (run: AnalyzedRun) => run.source.interaction.retries],
    ["wallClockMilliseconds", (run: AnalyzedRun) => run.source.durationMs],
  ] as const;
  const groups = Map.groupBy(
    valid,
    (run) => `${taskKey(run.source.identity.task)}|${run.source.identity.arm}`,
  );
  const result: Outlier[] = [];
  for (const group of groups.values()) {
    for (const [metric, select] of metrics) {
      const values = group.flatMap((run) => {
        const value = select(run);
        return value === null ? [] : [{ run, value }];
      });
      const summary = distribution(values.map(({ value }) => value));
      if (summary === null) continue;
      const lowerFence = summary.q1 - 1.5 * summary.iqr;
      const upperFence = summary.q3 + 1.5 * summary.iqr;
      for (const { run, value } of values) {
        if (value < lowerFence || value > upperFence) {
          result.push({
            runId: run.source.identity.runId,
            taskId: run.source.identity.task.id,
            taskVersion: run.source.identity.task.version,
            implementation: run.source.identity.arm,
            metric,
            value,
            lowerFence,
            upperFence,
          });
        }
      }
    }
  }
  return Object.freeze(
    result.sort((left, right) =>
      `${left.taskId}:${left.implementation}:${left.metric}:${left.runId}`.localeCompare(
        `${right.taskId}:${right.implementation}:${right.metric}:${right.runId}`,
      ),
    ),
  );
};

const failureCategories = (
  runs: readonly AnalyzedRun[],
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const run of runs.filter(({ valid, success }) => valid && !success)) {
    const category = run.failureCategory ?? "unclassified";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
};

const usageMissing = (field: RawUsageField): boolean => field.availability !== "reported";

export const calculateBreakEven = (input: {
  readonly constructionCost: number | null;
  readonly constructionUnavailableReason: string | null;
  readonly plainMedianTaskCost: number | null;
  readonly frameworkMedianTaskCost: number | null;
  readonly unit: "tokens" | "money";
  readonly currency: string | null;
}): BreakEven => {
  if (
    input.constructionCost === null ||
    input.plainMedianTaskCost === null ||
    input.frameworkMedianTaskCost === null
  ) {
    return {
      status: "unavailable",
      unit: input.unit,
      currency: input.currency,
      reason:
        input.constructionUnavailableReason ??
        "compatible construction or successful-task cost is unavailable",
    };
  }
  if (
    [
      input.constructionCost,
      input.plainMedianTaskCost,
      input.frameworkMedianTaskCost,
    ].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new TypeError("Break-even inputs must be finite and nonnegative.");
  }
  const savings = input.plainMedianTaskCost - input.frameworkMedianTaskCost;
  if (savings <= 0) {
    return {
      status: "no-break-even",
      unit: input.unit,
      currency: input.currency,
    };
  }
  return {
    status: "available",
    maintenanceTasks: input.constructionCost / savings,
    unit: input.unit,
    currency: input.currency,
  };
};

const assertPinMaps = (
  configuration: AnalysisConfiguration,
  taskKeys: readonly string[],
): void => {
  for (const [name, pins] of Object.entries({
    instructionBundleByTask: configuration.cohort.instructionBundleByTask,
    fixtureRevisionByTask: configuration.cohort.fixtureRevisionByTask,
    fixtureManifestHashByTask: configuration.cohort.fixtureManifestHashByTask,
    evaluatorRevisionByTask: configuration.cohort.evaluatorRevisionByTask,
    timeoutMsByTask: configuration.cohort.timeoutMsByTask,
  })) {
    const keys = Object.keys(pins).sort();
    if (!same(keys, [...taskKeys].sort())) {
      throw new TypeError(`${name} must pin exactly the ten scheduled task versions.`);
    }
  }
};

export const analyzeExperiment = (input: AnalysisInput): ExperimentReport => {
  const configuration = parseAnalysisConfiguration(input.configuration);
  const validatedSchedule = validateSchedule(input.schedule);
  const pricingSnapshot =
    input.pricingSnapshot === null
      ? null
      : parsePricingSnapshot(input.pricingSnapshot);
  const pricingSnapshotContentHash =
    pricingSnapshot === null ? null : sha256(canonicalJson(pricingSnapshot));
  assertPinMaps(configuration, validatedSchedule.taskKeys);
  if (
    configuration.cohort.scheduleSeed !== input.schedule.seed ||
    configuration.cohort.scheduleHash !== input.schedule.scheduleHash
  ) {
    throw new TypeError("Configuration schedule seed/hash pins do not match the schedule.");
  }
  if (configuration.manifestHashes.schedule !== validatedSchedule.contentHash) {
    throw new TypeError("Pinned schedule content hash does not match the schedule document.");
  }
  if (
    input.evidence.analysisSourceHash !== configuration.manifestHashes.analysisSource
  ) {
    throw new TypeError("Pinned analysis-source hash does not match the executing analyzer.");
  }
  if (pricingSnapshotContentHash !== configuration.manifestHashes.pricingSnapshot) {
    throw new TypeError(
      "Pinned pricing-snapshot content hash does not match the loaded snapshot.",
    );
  }
  if (
    pricingSnapshot !== null &&
    (pricingSnapshot.id !== configuration.cohort.pricingSnapshotId ||
      pricingSnapshot.provider !== configuration.cohort.provider ||
      pricingSnapshot.model !== configuration.cohort.exactModel ||
      pricingSnapshot.serviceTier !== configuration.cohort.serviceTier ||
      pricingSnapshot.currency !== configuration.cohort.pricingCurrency)
  ) {
    throw new TypeError(
      "Loaded pricing snapshot does not match the pinned provider/model/tier/currency cohort.",
    );
  }
  if (input.records.length !== configuration.runIds.length) {
    throw new TypeError("Loaded immutable record count does not match configured run IDs.");
  }
  const configuredIds = new Set(configuration.runIds);
  const observedIds = new Set<string>();
  for (const record of input.records) {
    if (observedIds.has(record.identity.runId)) {
      throw new TypeError(`Duplicate run ID ${record.identity.runId}.`);
    }
    if (!configuredIds.has(record.identity.runId)) {
      throw new TypeError(`Run ${record.identity.runId} is absent from the frozen cohort config.`);
    }
    observedIds.add(record.identity.runId);
  }
  if ([...configuredIds].some((runId) => !observedIds.has(runId))) {
    throw new TypeError("One or more configured immutable run records were not loaded.");
  }
  const reusedWorkspacePaths = repeatedValues(
    input.records.flatMap(({ confirmatoryEvidence }) =>
      confirmatoryEvidence === undefined || confirmatoryEvidence === null
        ? []
        : [confirmatoryEvidence.sandbox.workspacePath],
    ),
  );
  const reusedAttestationReferences = repeatedValues(
    input.records.flatMap(({ confirmatoryEvidence }) =>
      confirmatoryEvidence === undefined ||
      confirmatoryEvidence === null ||
      confirmatoryEvidence.sandbox.attestationReference.trim().length === 0
        ? []
        : [confirmatoryEvidence.sandbox.attestationReference],
    ),
  );
  const reusedResponseIds = repeatedValues(
    input.records.flatMap(({ responseIds }) => responseIds),
  );

  const deviations: ProtocolDeviation[] = [];
  if (new Set(input.records.map(({ adapterId }) => adapterId)).size !== 1) {
    deviations.push({
      code: "MIXED_ADAPTER_IMPLEMENTATIONS",
      runId: null,
      slot: null,
      detail: "confirmatory records use more than one agent adapter implementation",
      material: true,
    });
  }
  const dynamicEnvironments = new Set(
    input.records.map(({ environment }) =>
      canonicalJson({
        node: environment.node,
        platform: environment.platform,
        architecture: environment.architecture,
        osRelease: environment.osRelease,
        cpuModel: environment.cpuModel,
        cpuCount: environment.cpuCount,
      }),
    ),
  );
  if (dynamicEnvironments.size !== 1) {
    deviations.push({
      code: "MIXED_DYNAMIC_ENVIRONMENTS",
      runId: null,
      slot: null,
      detail: "confirmatory records do not share one exact runtime/OS/CPU environment",
      material: true,
    });
  }
  if (configuration.studyPhase !== "confirmatory") {
    deviations.push({
      code: "PILOT_COHORT",
      runId: null,
      slot: null,
      detail: "configuration declares a pilot rather than a confirmatory cohort",
      material: true,
    });
  }
  if (configuration.gates.protocolCompromised) {
    deviations.push({
      code: "CONFIGURED_PROTOCOL_COMPROMISE",
      runId: null,
      slot: null,
      detail: "frozen configuration declares a material protocol compromise",
      material: true,
    });
  }

  const analyzed: AnalyzedRun[] = [];
  for (const record of input.records) {
    const slot = slotKey({
      task: record.identity.task,
      arm: record.identity.arm,
      repetition: record.identity.repetition,
    });
    const scheduled = validatedSchedule.slots.get(slot);
    if (scheduled === undefined) {
      throw new TypeError(`Run ${record.identity.runId} occupies unscheduled cell ${slot}.`);
    }
    analyzed.push(
      analyzeRecord(
        record,
        configuration,
        scheduled,
        pricingSnapshot,
        reusedWorkspacePaths,
        reusedAttestationReferences,
        reusedResponseIds,
        deviations,
      ),
    );
  }

  const recordsBySlot = Map.groupBy(analyzed, ({ slot }) => slot);
  const selectedBySlot = new Map<string, AnalyzedRun>();
  const missingSlots: string[] = [];
  for (const slot of validatedSchedule.slots.keys()) {
    const valid = (recordsBySlot.get(slot) ?? []).filter(({ valid }) => valid);
    if (valid.length > 1) {
      throw new TypeError(`Duplicate valid terminal records occupy scheduled cell ${slot}.`);
    }
    if (valid.length === 0) {
      missingSlots.push(slot);
      deviations.push({
        code: "MISSING_VALID_TERMINAL_RECORD",
        runId: null,
        slot,
        detail: "no valid terminal record exists for the scheduled cell",
        material: false,
      });
    } else {
      const selected = valid[0];
      if (selected !== undefined) selectedBySlot.set(slot, selected);
    }
  }
  const selected = [...selectedBySlot.values()];
  const tasks = Object.freeze(
    validatedSchedule.taskKeys.map((key) => taskSummary(key, analyzed)),
  );
  const framework = armSummary(analyzed, "framework");
  const plain = armSummary(analyzed, "plain");
  const successRateDifference =
    framework.successRate === null || plain.successRate === null
      ? null
      : framework.successRate - plain.successRate;
  const tokenReduction = reduction(
    plain.successfulAccountedTokens?.median ?? null,
    framework.successfulAccountedTokens?.median ?? null,
  );
  const improvedTaskCategories = tasks.filter(({ tokenImproved }) => tokenImproved).length;
  const successful = selected.filter(({ success }) => success);
  const rawTokenTelemetryCompleteForSuccesses =
    successful.every(({ accountedTokens }) => accountedTokens !== null);
  const confirmatoryOnly =
    configuration.studyPhase === "confirmatory" &&
    input.records.every(({ mode }) => mode === "confirmatory");
  const cohortPinsMatch = !deviations.some(({ code }) => code === "COHORT_PIN_MISMATCH");
  const crossChecksPass = !deviations.some(({ code }) =>
    code === "SUCCESS_CROSS_CHECK_FAILED" ||
    code === "ACCOUNTING_CROSS_CHECK_FAILED" ||
    code === "COST_CROSS_CHECK_FAILED" ||
    code === "PATCH_SUMMARY_CROSS_CHECK_FAILED" ||
    code === "TERMINAL_OUTCOME_MISMATCH" ||
    code === "TERMINAL_OUTCOME_MISSING",
  );
  const scheduleComplete = missingSlots.length === 0;
  const atLeastFiveValidRepetitionsPerCell = scheduleComplete;
  const prerequisites = Object.freeze({
    confirmatoryOnly,
    scheduleComplete,
    atLeastFiveValidRepetitionsPerCell,
    rawTokenTelemetryCompleteForSuccesses,
    cohortPinsMatch,
    crossChecksPass,
    equivalencePassed: configuration.gates.equivalencePassed,
    freshSessionReproductionEstablished:
      configuration.gates.freshSessionReproductionEstablished,
    runtimeAndDxBudgetsPassed: configuration.gates.runtimeAndDxBudgetsPassed,
    criticalRegressionReviewPassed:
      configuration.gates.criticalRegressionReviewPassed,
    protocolCompromised:
      configuration.gates.protocolCompromised ||
      deviations.some(({ material }) => material),
  });
  const conclusive =
    prerequisites.confirmatoryOnly &&
    prerequisites.scheduleComplete &&
    prerequisites.atLeastFiveValidRepetitionsPerCell &&
    prerequisites.rawTokenTelemetryCompleteForSuccesses &&
    prerequisites.cohortPinsMatch &&
    prerequisites.crossChecksPass &&
    prerequisites.equivalencePassed &&
    prerequisites.freshSessionReproductionEstablished &&
    prerequisites.runtimeAndDxBudgetsPassed !== null &&
    prerequisites.criticalRegressionReviewPassed !== null &&
    !prerequisites.protocolCompromised;
  const conditions = {
    correctness:
      successRateDifference !== null &&
      successRateDifference >= -FROZEN_THRESHOLDS.correctnessMargin,
    tokenReduction:
      tokenReduction !== null &&
      tokenReduction >= FROZEN_THRESHOLDS.minimumTokenReduction,
    breadth:
      improvedTaskCategories >= FROZEN_THRESHOLDS.minimumImprovedCategories,
    criticalRegression: prerequisites.criticalRegressionReviewPassed === true,
    runtimeAndDx: prerequisites.runtimeAndDxBudgetsPassed === true,
  };
  let verdict: ExperimentReport["verdict"];
  const verdictReasons: string[] = [];
  if (!conclusive) {
    verdict = "INCONCLUSIVE";
    if (!prerequisites.confirmatoryOnly) verdictReasons.push("cohort contains smoke/pilot or mixed-phase evidence");
    if (!prerequisites.scheduleComplete) verdictReasons.push("one or more scheduled cells lacks a valid terminal record");
    if (!prerequisites.rawTokenTelemetryCompleteForSuccesses) verdictReasons.push("raw accounted-token telemetry is incomplete for successful runs");
    if (!prerequisites.cohortPinsMatch) verdictReasons.push("provider, model, instruction, revision, or environment cohort pins mismatch");
    if (!prerequisites.crossChecksPass) verdictReasons.push("stored success or accounting fields fail derivation cross-checks");
    if (!prerequisites.equivalencePassed) verdictReasons.push("behavioral equivalence is not established");
    if (!prerequisites.freshSessionReproductionEstablished) verdictReasons.push("fresh-session reproduction is not established");
    if (prerequisites.runtimeAndDxBudgetsPassed === null) verdictReasons.push("runtime and DX budget evidence is unavailable");
    if (prerequisites.criticalRegressionReviewPassed === null) verdictReasons.push("critical-regression review evidence is unavailable");
    if (prerequisites.protocolCompromised) verdictReasons.push("material protocol deviations are present");
  } else if (Object.values(conditions).every(Boolean)) {
    verdict = "SUPPORTED";
    verdictReasons.push("all preregistered observed-value conditions passed");
  } else {
    verdict = "NOT SUPPORTED";
    if (!conditions.correctness) verdictReasons.push("correctness non-inferiority failed");
    if (!conditions.tokenReduction) verdictReasons.push("the 20 percent median token-reduction threshold failed");
    if (!conditions.breadth) verdictReasons.push("fewer than seven task categories improved");
    if (!conditions.criticalRegression) verdictReasons.push("critical-regression review failed");
    if (!conditions.runtimeAndDx) verdictReasons.push("runtime or DX budgets failed");
  }

  const valid = analyzed.filter(({ valid }) => valid);
  const taskRatios = tasks.flatMap(({ frameworkToPlainTokenRatio }) =>
    frameworkToPlainTokenRatio === null ? [] : [frameworkToPlainTokenRatio],
  );
  const tokenBreakEven = calculateBreakEven({
    constructionCost: rawTokenTelemetryCompleteForSuccesses
      ? configuration.constructionCost.tokens.value
      : null,
    constructionUnavailableReason:
      rawTokenTelemetryCompleteForSuccesses
        ? configuration.constructionCost.tokens.unavailableReason
        : "successful-run accounted-token telemetry is incomplete",
    plainMedianTaskCost: rawTokenTelemetryCompleteForSuccesses
      ? plain.successfulAccountedTokens?.median ?? null
      : null,
    frameworkMedianTaskCost: rawTokenTelemetryCompleteForSuccesses
      ? framework.successfulAccountedTokens?.median ?? null
      : null,
    unit: "tokens",
    currency: null,
  });
  const compatibleMoneyCurrency =
    framework.moneyCurrency !== null && framework.moneyCurrency === plain.moneyCurrency
      ? framework.moneyCurrency
      : null;
  const successfulMoneyTelemetryComplete =
    (framework.successfulMoneyCost?.count ?? 0) === framework.successes &&
    (plain.successfulMoneyCost?.count ?? 0) === plain.successes;
  const constructionMoneyCompatible =
    successfulMoneyTelemetryComplete &&
    configuration.constructionCost.money.currency === compatibleMoneyCurrency;
  const moneyBreakEven = calculateBreakEven({
    constructionCost:
      constructionMoneyCompatible ? configuration.constructionCost.money.value : null,
    constructionUnavailableReason:
      constructionMoneyCompatible
        ? configuration.constructionCost.money.unavailableReason
        : successfulMoneyTelemetryComplete
          ? "construction and task monetary currencies are unavailable or incompatible"
          : "successful-run monetary telemetry is incomplete",
    plainMedianTaskCost: plain.successfulMoneyCost?.median ?? null,
    frameworkMedianTaskCost: framework.successfulMoneyCost?.median ?? null,
    unit: "money",
    currency: compatibleMoneyCurrency,
  });
  const recordHashes = Object.freeze(
    Object.fromEntries(
      analyzed
        .map(({ source, rawRecordHash }) => [source.identity.runId, rawRecordHash] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return Object.freeze({
    schemaVersion: 1,
    analysisVersion: ANALYSIS_VERSION,
    thresholds: FROZEN_THRESHOLDS,
    verdict,
    verdictReasons: Object.freeze(verdictReasons),
    noninferiorityRule: Object.freeze({
      method: "observed_point_difference",
      margin: 0.05,
      note:
        "Preregistered descriptive rule: framework minus plain observed success rate must be at least -0.05; Wilson intervals are reported per arm and are not a post-hoc decision threshold.",
    }),
    prerequisites,
    evidence: Object.freeze({
      scheduleHash: input.schedule.scheduleHash,
      scheduleContentHash: validatedSchedule.contentHash,
      cohortManifestHash: configuration.cohort.manifestHash,
      configurationHash: sha256(canonicalJson(configuration)),
      analysisSourceHash: input.evidence.analysisSourceHash,
      pricingSnapshotContentHash,
      manifestHashes: configuration.manifestHashes,
      recordHashes,
    }),
    aggregate: Object.freeze({
      framework,
      plain,
      successRateDifference,
      tokenReduction,
      improvedTaskCategories,
      taskNormalizedFrameworkToPlainRatios: distribution(taskRatios),
    }),
    tasks,
    pairedBlockDifferences: pairedDifferences(input.schedule.runs, selectedBySlot),
    invalidRuns: Object.freeze(
      analyzed
        .filter(({ valid }) => !valid)
        .map(({ source, slot, invalidReasons, rawRecordHash }) => ({
          runId: source.identity.runId,
          slot,
          reasons: invalidReasons,
          rawRecordHash,
        })),
    ),
    missingSlots: Object.freeze(missingSlots.sort()),
    failuresByCategory: failureCategories(analyzed),
    missingness: Object.freeze({
      accountedTokens: valid.filter(({ accountedTokens }) => accountedTokens === null).length,
      successfulAccountedTokens: valid.filter(
        ({ success, accountedTokens }) => success && accountedTokens === null,
      ).length,
      failedAccountedTokens: valid.filter(
        ({ success, accountedTokens }) => !success && accountedTokens === null,
      ).length,
      monetaryCost: valid.filter(({ moneyCost }) => moneyCost === null).length,
      uncachedInputTokens: valid.filter(({ source }) =>
        usageMissing(source.usage.uncachedInputTokens),
      ).length,
      cachedInputTokens: valid.filter(({ source }) =>
        usageMissing(source.usage.cachedInputTokens),
      ).length,
      outputTokens: valid.filter(({ source }) => usageMissing(source.usage.outputTokens))
        .length,
      reasoningTokens: valid.filter(({ source }) =>
        usageMissing(source.usage.reasoningTokens),
      ).length,
      providerTotalTokens: valid.filter(({ source }) =>
        usageMissing(source.usage.providerTotalTokens),
      ).length,
      missingInputTokenRelation: analyzed.filter(
        ({ source }) => source.usage.inputTokenRelation === undefined,
      ).length,
      ambiguousInputTokenRelation: valid.filter(
        ({ source }) => source.usage.inputTokenRelation === "unknown",
      ).length,
      ambiguousReasoningRelation: valid.filter(
        ({ source }) => source.usage.reasoningTokenRelation === "unknown",
      ).length,
      ambiguousProviderTotalRelation: valid.filter(
        ({ source }) => source.usage.providerTotalRelation === "unknown",
      ).length,
    }),
    outliers: outliers(analyzed),
    protocolDeviations: Object.freeze(deviations),
    constructionCost: Object.freeze({
      ...configuration.constructionCost,
      evidenceHash: configuration.manifestHashes.constructionCostEvidence,
    }),
    breakEven: Object.freeze({ tokens: tokenBreakEven, money: moneyBreakEven }),
  });
};
