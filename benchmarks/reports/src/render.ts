import type {
  BreakEven,
  Distribution,
  ExperimentReport,
  WilsonInterval,
} from "./types.js";

const percent = (value: number | null): string =>
  value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;

const median = (value: Distribution | null): string =>
  value === null ? "unavailable" : String(value.median);

const distributionSummary = (value: Distribution | null): string =>
  value === null
    ? "unavailable"
    : `n=${value.count}; min=${value.min}; q1=${value.q1}; median=${value.median}; q3=${value.q3}; max=${value.max}; IQR=${value.iqr}`;

const interval = (value: WilsonInterval | null): string =>
  value === null
    ? "unavailable"
    : `${percent(value.lower)} to ${percent(value.upper)} (Wilson 95%)`;

const breakEven = (value: BreakEven): string => {
  if (value.status === "available") {
    return `${value.maintenanceTasks} maintenance tasks (${value.unit}${
      value.currency === null ? "" : `, ${value.currency}`
    })`;
  }
  if (value.status === "no-break-even") return `no break-even (${value.unit})`;
  return `unavailable (${value.unit}): ${value.reason}`;
};

const evidenceHash = (value: string | null): string => value ?? "unavailable";

export const renderMarkdown = (report: ExperimentReport): string => {
  const lines = [
    "# Agent maintenance benchmark report",
    "",
    `Verdict: **${report.verdict}**`,
    "",
    ...report.verdictReasons.map((reason) => `- ${reason}`),
    "",
    "## Frozen decision rule",
    "",
    `- Analysis version: \`${report.analysisVersion}\`.`,
    `- Correctness margin: ${report.thresholds.correctnessMargin}.`,
    `- Minimum median token reduction: ${report.thresholds.minimumTokenReduction}.`,
    `- Minimum improved categories: ${report.thresholds.minimumImprovedCategories}.`,
    `- Noninferiority method: ${report.noninferiorityRule.method}.`,
    `- ${report.noninferiorityRule.note}`,
    "",
    "## Aggregate",
    "",
    "| Metric | Framework | Plain |",
    "| --- | ---: | ---: |",
    `| Valid runs | ${report.aggregate.framework.validRuns} | ${report.aggregate.plain.validRuns} |`,
    `| Invalid/replacement runs retained | ${report.aggregate.framework.invalidRuns} | ${report.aggregate.plain.invalidRuns} |`,
    `| Successes / failures | ${report.aggregate.framework.successes} / ${report.aggregate.framework.failures} | ${report.aggregate.plain.successes} / ${report.aggregate.plain.failures} |`,
    `| Success rate | ${percent(report.aggregate.framework.successRate)} | ${percent(report.aggregate.plain.successRate)} |`,
    `| Success-rate interval | ${interval(report.aggregate.framework.successInterval)} | ${interval(report.aggregate.plain.successInterval)} |`,
    `| Successful accounted-token median | ${median(report.aggregate.framework.successfulAccountedTokens)} | ${median(report.aggregate.plain.successfulAccountedTokens)} |`,
    `| Failed accounted-token median | ${median(report.aggregate.framework.failedAccountedTokens)} | ${median(report.aggregate.plain.failedAccountedTokens)} |`,
    `| All available accounted-token median | ${median(report.aggregate.framework.allAccountedTokens)} | ${median(report.aggregate.plain.allAccountedTokens)} |`,
    `| Successful monetary median | ${median(report.aggregate.framework.successfulMoneyCost)} ${report.aggregate.framework.moneyCurrency ?? ""} | ${median(report.aggregate.plain.successfulMoneyCost)} ${report.aggregate.plain.moneyCurrency ?? ""} |`,
    `| Assistant-turn median | ${median(report.aggregate.framework.secondary.assistantTurns)} | ${median(report.aggregate.plain.secondary.assistantTurns)} |`,
    `| Tool-call median | ${median(report.aggregate.framework.secondary.toolCalls)} | ${median(report.aggregate.plain.secondary.toolCalls)} |`,
    `| Failed tool-call median | ${median(report.aggregate.framework.secondary.failedToolCalls)} | ${median(report.aggregate.plain.secondary.failedToolCalls)} |`,
    `| Command median | ${median(report.aggregate.framework.secondary.commands)} | ${median(report.aggregate.plain.secondary.commands)} |`,
    `| Files inspected median | ${median(report.aggregate.framework.secondary.filesInspected)} | ${median(report.aggregate.plain.secondary.filesInspected)} |`,
    `| Unique source files inspected median | ${median(report.aggregate.framework.secondary.uniqueSourceFilesInspected)} | ${median(report.aggregate.plain.secondary.uniqueSourceFilesInspected)} |`,
    `| Repeat file-observation median | ${median(report.aggregate.framework.secondary.repeatFileObservations)} | ${median(report.aggregate.plain.secondary.repeatFileObservations)} |`,
    `| Unattributed file-observation median | ${median(report.aggregate.framework.secondary.unattributedFileObservations)} | ${median(report.aggregate.plain.secondary.unattributedFileObservations)} |`,
    `| Files modified median | ${median(report.aggregate.framework.secondary.filesModified)} | ${median(report.aggregate.plain.secondary.filesModified)} |`,
    `| Generated files modified median | ${median(report.aggregate.framework.secondary.generatedFilesModified)} | ${median(report.aggregate.plain.secondary.generatedFilesModified)} |`,
    `| Lines added/deleted median | ${median(report.aggregate.framework.secondary.linesAdded)} / ${median(report.aggregate.framework.secondary.linesDeleted)} | ${median(report.aggregate.plain.secondary.linesAdded)} / ${median(report.aggregate.plain.secondary.linesDeleted)} |`,
    `| Test commands median | ${median(report.aggregate.framework.secondary.testCommands)} | ${median(report.aggregate.plain.secondary.testCommands)} |`,
    `| Failed attempts median | ${median(report.aggregate.framework.secondary.failedAttempts)} | ${median(report.aggregate.plain.secondary.failedAttempts)} |`,
    `| Retries median | ${median(report.aggregate.framework.secondary.retries)} | ${median(report.aggregate.plain.secondary.retries)} |`,
    `| Wall-clock milliseconds median | ${median(report.aggregate.framework.secondary.wallClockMilliseconds)} | ${median(report.aggregate.plain.secondary.wallClockMilliseconds)} |`,
    "",
    `Framework-minus-plain observed success rate: ${percent(report.aggregate.successRateDifference)}.`,
    `Median successful token reduction: ${percent(report.aggregate.tokenReduction)}.`,
    `Improved task categories: ${report.aggregate.improvedTaskCategories}/10.`,
    `Median task-normalized framework/plain token ratio: ${median(report.aggregate.taskNormalizedFrameworkToPlainRatios)}.`,
    "",
    "## Aggregate distributions",
    "",
    "Each available distribution reports count, range, quartiles, median, and IQR. Failed runs are reported separately and are never assigned a synthetic token penalty.",
    "",
    "| Metric | Framework distribution | Plain distribution |",
    "| --- | --- | --- |",
    `| Successful accounted tokens | ${distributionSummary(report.aggregate.framework.successfulAccountedTokens)} | ${distributionSummary(report.aggregate.plain.successfulAccountedTokens)} |`,
    `| Failed accounted tokens | ${distributionSummary(report.aggregate.framework.failedAccountedTokens)} | ${distributionSummary(report.aggregate.plain.failedAccountedTokens)} |`,
    `| All available accounted tokens | ${distributionSummary(report.aggregate.framework.allAccountedTokens)} | ${distributionSummary(report.aggregate.plain.allAccountedTokens)} |`,
    `| Successful monetary cost | ${distributionSummary(report.aggregate.framework.successfulMoneyCost)} | ${distributionSummary(report.aggregate.plain.successfulMoneyCost)} |`,
    `| Assistant turns | ${distributionSummary(report.aggregate.framework.secondary.assistantTurns)} | ${distributionSummary(report.aggregate.plain.secondary.assistantTurns)} |`,
    `| Tool calls | ${distributionSummary(report.aggregate.framework.secondary.toolCalls)} | ${distributionSummary(report.aggregate.plain.secondary.toolCalls)} |`,
    `| Failed tool calls | ${distributionSummary(report.aggregate.framework.secondary.failedToolCalls)} | ${distributionSummary(report.aggregate.plain.secondary.failedToolCalls)} |`,
    `| Commands | ${distributionSummary(report.aggregate.framework.secondary.commands)} | ${distributionSummary(report.aggregate.plain.secondary.commands)} |`,
    `| Files inspected | ${distributionSummary(report.aggregate.framework.secondary.filesInspected)} | ${distributionSummary(report.aggregate.plain.secondary.filesInspected)} |`,
    `| Unique source files inspected | ${distributionSummary(report.aggregate.framework.secondary.uniqueSourceFilesInspected)} | ${distributionSummary(report.aggregate.plain.secondary.uniqueSourceFilesInspected)} |`,
    `| Repeat file observations | ${distributionSummary(report.aggregate.framework.secondary.repeatFileObservations)} | ${distributionSummary(report.aggregate.plain.secondary.repeatFileObservations)} |`,
    `| Unattributed file observations | ${distributionSummary(report.aggregate.framework.secondary.unattributedFileObservations)} | ${distributionSummary(report.aggregate.plain.secondary.unattributedFileObservations)} |`,
    `| Files modified | ${distributionSummary(report.aggregate.framework.secondary.filesModified)} | ${distributionSummary(report.aggregate.plain.secondary.filesModified)} |`,
    `| Generated files modified | ${distributionSummary(report.aggregate.framework.secondary.generatedFilesModified)} | ${distributionSummary(report.aggregate.plain.secondary.generatedFilesModified)} |`,
    `| Lines added | ${distributionSummary(report.aggregate.framework.secondary.linesAdded)} | ${distributionSummary(report.aggregate.plain.secondary.linesAdded)} |`,
    `| Lines deleted | ${distributionSummary(report.aggregate.framework.secondary.linesDeleted)} | ${distributionSummary(report.aggregate.plain.secondary.linesDeleted)} |`,
    `| Test commands | ${distributionSummary(report.aggregate.framework.secondary.testCommands)} | ${distributionSummary(report.aggregate.plain.secondary.testCommands)} |`,
    `| Failed attempts | ${distributionSummary(report.aggregate.framework.secondary.failedAttempts)} | ${distributionSummary(report.aggregate.plain.secondary.failedAttempts)} |`,
    `| Retries | ${distributionSummary(report.aggregate.framework.secondary.retries)} | ${distributionSummary(report.aggregate.plain.secondary.retries)} |`,
    `| Wall-clock milliseconds | ${distributionSummary(report.aggregate.framework.secondary.wallClockMilliseconds)} | ${distributionSummary(report.aggregate.plain.secondary.wallClockMilliseconds)} |`,
    "",
    "## Per task",
    "",
    "| Task | Version | Framework success | Plain success | Token reduction | F/P ratio | Improved |",
    "| --- | ---: | ---: | ---: | ---: | ---: | :---: |",
    ...report.tasks.map((task) =>
      `| ${task.taskId} | ${task.taskVersion} | ${percent(task.framework.successRate)} | ${percent(task.plain.successRate)} | ${percent(task.tokenReduction)} | ${task.frameworkToPlainTokenRatio ?? "unavailable"} | ${task.tokenImproved ? "yes" : "no"} |`,
    ),
    "",
    "### Per-task successful-token distributions",
    "",
    "| Task | Framework distribution | Plain distribution |",
    "| --- | --- | --- |",
    ...report.tasks.map((task) =>
      `| ${task.taskId}@${task.taskVersion} | ${distributionSummary(task.framework.successfulAccountedTokens)} | ${distributionSummary(task.plain.successfulAccountedTokens)} |`,
    ),
    "",
    "## Paired blocked differences",
    "",
    "Differences are framework minus plain and are descriptive.",
    "",
    "| Block | Task | Rep | Success | Tokens | Tool calls | Files | Source files | Failed attempts | Retries | Wall ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.pairedBlockDifferences.map((pair) =>
      `| ${pair.blockId} | ${pair.taskId}@${pair.taskVersion} | ${pair.repetition} | ${pair.successDifference} | ${pair.accountedTokenDifference ?? "unavailable"} | ${pair.toolCallDifference} | ${pair.filesInspectedDifference} | ${pair.uniqueSourceFilesInspectedDifference} | ${pair.failedAttemptDifference} | ${pair.retryDifference} | ${pair.wallClockDifferenceMilliseconds} |`,
    ),
    "",
    "## Integrity and cohort prerequisites",
    "",
    ...Object.entries(report.prerequisites).map(
      ([name, value]) => `- ${name}: ${String(value)}.`,
    ),
    `- Invalid/replacement records retained: ${report.invalidRuns.length}.`,
    `- Missing scheduled cells: ${report.missingSlots.length}.`,
    `- Protocol deviations: ${report.protocolDeviations.length}.`,
    `- Within-task/arm outliers retained: ${report.outliers.length}.`,
    "",
    "## Failures and missingness",
    "",
    ...Object.entries(report.failuresByCategory).map(
      ([category, count]) => `- Failure ${category}: ${count}.`,
    ),
    ...Object.entries(report.missingness).map(
      ([field, count]) => `- Missing ${field}: ${count}.`,
    ),
    "",
    "## Invalid runs and deviations",
    "",
    ...(report.invalidRuns.length === 0
      ? ["- No invalid replacement records."]
      : report.invalidRuns.map(
          (run) => `- ${run.runId} (${run.slot}): ${run.reasons.join("; ")} [${run.rawRecordHash}]`,
        )),
    ...(report.protocolDeviations.length === 0
      ? ["- No protocol deviations."]
      : report.protocolDeviations.map(
          (entry) =>
            `- ${entry.code}${entry.runId === null ? "" : ` / ${entry.runId}`}: ${entry.detail} (material=${entry.material}).`,
        )),
    ...(report.missingSlots.length === 0
      ? ["- No missing scheduled slots."]
      : report.missingSlots.map((slot) => `- Missing slot: ${slot}.`)),
    ...(report.outliers.length === 0
      ? ["- No within-task/arm Tukey-fence outliers."]
      : report.outliers.map(
          (entry) =>
            `- Outlier ${entry.runId} / ${entry.metric}: ${entry.value}, fences ${entry.lowerFence} to ${entry.upperFence}.`,
        )),
    "",
    "## Construction cost and break-even",
    "",
    `- Construction tokens: ${report.constructionCost.tokens.value ?? `unavailable: ${report.constructionCost.tokens.unavailableReason}`}.`,
    `- Construction money: ${report.constructionCost.money.value ?? `unavailable: ${report.constructionCost.money.unavailableReason}`} ${report.constructionCost.money.currency ?? ""}.`,
    `- Construction evidence: ${evidenceHash(report.constructionCost.evidenceHash)}.`,
    `- Token break-even: ${breakEven(report.breakEven.tokens)}.`,
    `- Money break-even: ${breakEven(report.breakEven.money)}.`,
    "",
    "## Evidence hashes",
    "",
    `- Schedule structural hash: ${report.evidence.scheduleHash}.`,
    `- Schedule content hash: ${report.evidence.scheduleContentHash}.`,
    `- Frozen cohort manifest hash: ${report.evidence.cohortManifestHash}.`,
    `- Configuration hash: ${report.evidence.configurationHash}.`,
    `- Analysis source hash: ${report.evidence.analysisSourceHash}.`,
    `- Pricing snapshot content hash: ${evidenceHash(report.evidence.pricingSnapshotContentHash)}.`,
    ...Object.entries(report.evidence.manifestHashes).map(
      ([name, value]) => `- Manifest ${name}: ${evidenceHash(value)}.`,
    ),
    ...Object.entries(report.evidence.recordHashes).map(
      ([runId, value]) => `- Raw record ${runId}: ${value}.`,
    ),
    "",
  ];
  return lines.join("\n");
};
