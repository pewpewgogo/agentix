import type {
  InstructionHashes,
  PricingSnapshot,
  RunRecord,
  ScheduleDocument,
} from "@agentix/benchmark-harness";

export type Implementation = "framework" | "plain";
export type Verdict = "SUPPORTED" | "NOT SUPPORTED" | "INCONCLUSIVE";

export interface FrozenThresholds {
  readonly correctnessMargin: 0.05;
  readonly minimumTokenReduction: 0.2;
  readonly minimumImprovedCategories: 7;
}

export interface ArmPins<T> {
  readonly framework: T;
  readonly plain: T;
}

export interface CohortPins {
  readonly schemaVersion: 1;
  readonly cohortId: string;
  readonly provider: string;
  readonly exactModel: string;
  readonly serviceTier: string;
  readonly reasoningConfigurationHash: string;
  readonly instructionBundleByTask: Readonly<Record<string, string>>;
  readonly fixtureRevisionByTask: Readonly<Record<string, ArmPins<string>>>;
  readonly fixtureManifestHashByTask: Readonly<Record<string, ArmPins<string>>>;
  readonly evaluatorRevisionByTask: Readonly<Record<string, ArmPins<string>>>;
  readonly analysisRevision: string;
  readonly scheduleSeed: string;
  readonly scheduleHash: string;
  /** Agent wall-clock limit selected by the scheduled task key (`id@version`). */
  readonly timeoutMsByTask: Readonly<Record<string, number>>;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly provisioningConfigurationHash: string;
  readonly networkPolicy: string;
  readonly dependencyCachePolicy: string;
  readonly hostClass: string | null;
  readonly containerImage: string | null;
  readonly packageManager: string | null;
  readonly toolVersionsHash: string;
  readonly pricingSnapshotId: string | null;
  readonly pricingCurrency: string | null;
  readonly manifestHash: string;
}

export interface ManifestHashes {
  readonly schedule: string;
  readonly taskCorpus: string;
  readonly evaluator: string;
  readonly analysisSource: string;
  readonly equivalenceEvidence: string;
  readonly runtimeDxEvidence: string;
  readonly constructionCostEvidence: string | null;
  readonly pricingSnapshot: string | null;
}

export interface ConstructionMetricInput {
  readonly value: number | null;
  readonly unavailableReason: string | null;
}

export interface ConstructionMoneyInput extends ConstructionMetricInput {
  readonly currency: string | null;
}

export interface ConstructionCostInput {
  readonly tokens: ConstructionMetricInput;
  readonly money: ConstructionMoneyInput;
}

export interface AnalysisConfiguration {
  readonly schemaVersion: 1;
  readonly analysisVersion: string;
  readonly studyPhase: "confirmatory" | "pilot";
  readonly thresholds: FrozenThresholds;
  readonly cohort: CohortPins;
  readonly manifestHashes: ManifestHashes;
  readonly gates: {
    readonly equivalencePassed: boolean;
    readonly freshSessionReproductionEstablished: boolean;
    readonly runtimeAndDxBudgetsPassed: boolean | null;
    readonly criticalRegressionReviewPassed: boolean | null;
    readonly protocolCompromised: boolean;
  };
  readonly constructionCost: ConstructionCostInput;
  readonly runIds: readonly string[];
}

export interface AnalysisEvidenceInput {
  readonly analysisSourceHash: string;
}

export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
  readonly confidence: 0.95;
}

export interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly max: number;
  readonly iqr: number;
  readonly values: readonly number[];
}

export interface SecondaryMetricSummary {
  readonly assistantTurns: Distribution | null;
  readonly toolCalls: Distribution | null;
  readonly failedToolCalls: Distribution | null;
  readonly commands: Distribution | null;
  readonly filesInspected: Distribution | null;
  readonly uniqueSourceFilesInspected: Distribution | null;
  readonly repeatFileObservations: Distribution | null;
  readonly unattributedFileObservations: Distribution | null;
  readonly filesModified: Distribution | null;
  readonly generatedFilesModified: Distribution | null;
  readonly linesAdded: Distribution | null;
  readonly linesDeleted: Distribution | null;
  readonly testCommands: Distribution | null;
  readonly failedAttempts: Distribution | null;
  readonly retries: Distribution | null;
  readonly wallClockMilliseconds: Distribution | null;
}

export interface ArmSummary {
  readonly validRuns: number;
  readonly invalidRuns: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: number | null;
  readonly successInterval: WilsonInterval | null;
  readonly successfulAccountedTokens: Distribution | null;
  readonly failedAccountedTokens: Distribution | null;
  readonly allAccountedTokens: Distribution | null;
  readonly successfulMoneyCost: Distribution | null;
  readonly moneyCurrency: string | null;
  readonly secondary: SecondaryMetricSummary;
}

export interface TaskSummary {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly framework: ArmSummary;
  readonly plain: ArmSummary;
  readonly successRateDifference: number | null;
  readonly tokenReduction: number | null;
  readonly frameworkToPlainTokenRatio: number | null;
  readonly tokenImproved: boolean;
}

export interface PairedBlockDifference {
  readonly blockId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly repetition: number;
  readonly frameworkRunId: string;
  readonly plainRunId: string;
  readonly successDifference: number;
  readonly accountedTokenDifference: number | null;
  readonly toolCallDifference: number;
  readonly filesInspectedDifference: number;
  readonly uniqueSourceFilesInspectedDifference: number;
  readonly failedAttemptDifference: number;
  readonly retryDifference: number;
  readonly wallClockDifferenceMilliseconds: number;
}

export interface Outlier {
  readonly runId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly implementation: Implementation;
  readonly metric:
    | "accountedTokens"
    | "moneyCost"
    | "assistantTurns"
    | "toolCalls"
    | "failedToolCalls"
    | "commands"
    | "filesInspected"
    | "uniqueSourceFilesInspected"
    | "repeatFileObservations"
    | "unattributedFileObservations"
    | "filesModified"
    | "generatedFilesModified"
    | "linesAdded"
    | "linesDeleted"
    | "testCommands"
    | "failedAttempts"
    | "retries"
    | "wallClockMilliseconds";
  readonly value: number;
  readonly lowerFence: number;
  readonly upperFence: number;
}

export interface ProtocolDeviation {
  readonly code: string;
  readonly runId: string | null;
  readonly slot: string | null;
  readonly detail: string;
  readonly material: boolean;
}

export interface InvalidRunEvidence {
  readonly runId: string;
  readonly slot: string;
  readonly reasons: readonly string[];
  readonly rawRecordHash: string;
}

export interface AnalyzedRun {
  readonly source: RunRecord;
  readonly slot: string;
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
  readonly success: boolean;
  readonly accountedTokens: number | null;
  readonly tokenUnavailableReason: string | null;
  readonly moneyCost: number | null;
  readonly moneyCurrency: string | null;
  readonly failureCategory: string | null;
  readonly rawRecordHash: string;
}

export type BreakEven =
  | {
      readonly status: "available";
      readonly maintenanceTasks: number;
      readonly unit: "tokens" | "money";
      readonly currency: string | null;
    }
  | {
      readonly status: "no-break-even";
      readonly unit: "tokens" | "money";
      readonly currency: string | null;
    }
  | {
      readonly status: "unavailable";
      readonly unit: "tokens" | "money";
      readonly currency: string | null;
      readonly reason: string;
    };

export interface ExperimentReport {
  readonly schemaVersion: 1;
  readonly analysisVersion: string;
  readonly thresholds: FrozenThresholds;
  readonly verdict: Verdict;
  readonly verdictReasons: readonly string[];
  readonly noninferiorityRule: {
    readonly method: "observed_point_difference";
    readonly margin: 0.05;
    readonly note: string;
  };
  readonly prerequisites: {
    readonly confirmatoryOnly: boolean;
    readonly scheduleComplete: boolean;
    readonly atLeastFiveValidRepetitionsPerCell: boolean;
    readonly rawTokenTelemetryCompleteForSuccesses: boolean;
    readonly cohortPinsMatch: boolean;
    readonly crossChecksPass: boolean;
    readonly equivalencePassed: boolean;
    readonly freshSessionReproductionEstablished: boolean;
    readonly runtimeAndDxBudgetsPassed: boolean | null;
    readonly criticalRegressionReviewPassed: boolean | null;
    readonly protocolCompromised: boolean;
  };
  readonly evidence: {
    readonly scheduleHash: string;
    readonly scheduleContentHash: string;
    readonly cohortManifestHash: string;
    readonly configurationHash: string;
    readonly analysisSourceHash: string;
    readonly pricingSnapshotContentHash: string | null;
    readonly manifestHashes: ManifestHashes;
    readonly recordHashes: Readonly<Record<string, string>>;
  };
  readonly aggregate: {
    readonly framework: ArmSummary;
    readonly plain: ArmSummary;
    readonly successRateDifference: number | null;
    readonly tokenReduction: number | null;
    readonly improvedTaskCategories: number;
    readonly taskNormalizedFrameworkToPlainRatios: Distribution | null;
  };
  readonly tasks: readonly TaskSummary[];
  readonly pairedBlockDifferences: readonly PairedBlockDifference[];
  readonly invalidRuns: readonly InvalidRunEvidence[];
  readonly missingSlots: readonly string[];
  readonly failuresByCategory: Readonly<Record<string, number>>;
  readonly missingness: Readonly<Record<string, number>>;
  readonly outliers: readonly Outlier[];
  readonly protocolDeviations: readonly ProtocolDeviation[];
  readonly constructionCost: ConstructionCostInput & {
    readonly evidenceHash: string | null;
  };
  readonly breakEven: {
    readonly tokens: BreakEven;
    readonly money: BreakEven;
  };
}

export interface AnalysisInput {
  readonly records: readonly RunRecord[];
  readonly schedule: ScheduleDocument;
  readonly configuration: AnalysisConfiguration;
  readonly pricingSnapshot: PricingSnapshot | null;
  readonly evidence: AnalysisEvidenceInput;
}

export interface PublishedReportManifest {
  readonly schemaVersion: 1;
  readonly analysisVersion: string;
  readonly inputs: {
    readonly schedule: { readonly path: string; readonly sha256: string };
    readonly configuration: { readonly path: string; readonly sha256: string };
    readonly analysisSource: { readonly path: string; readonly sha256: string };
    readonly pricingSnapshot: {
      readonly path: string;
      readonly sha256: string;
    } | null;
    readonly recordsRoot: string;
    readonly recordHashes: Readonly<Record<string, string>>;
  };
  readonly outputs: {
    readonly json: { readonly path: string; readonly sha256: string };
    readonly markdown: { readonly path: string; readonly sha256: string };
  };
}

export type { InstructionHashes };
