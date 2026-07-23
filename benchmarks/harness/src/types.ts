export const HARNESS_SCHEMA_VERSION = 1 as const;
export const SCHEDULE_SCHEMA_VERSION = 1 as const;

export type BenchmarkArm = "framework" | "plain";
export type ExecutionMode = "smoke" | "confirmatory";

export interface TaskReference {
  readonly schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  readonly id: string;
  readonly version: number;
}

export interface RunIdentity {
  readonly schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  readonly runId: string;
  readonly task: TaskReference;
  readonly arm: BenchmarkArm;
  readonly repetition: number;
  readonly scheduleSeed: string;
  readonly fixtureRevision: string;
  readonly evaluatorRevision: string;
  readonly analysisRevision: string;
}

export interface ArmPins<T> {
  readonly framework: T;
  readonly plain: T;
}

export interface ScheduledRun {
  readonly ordinal: number;
  readonly blockId: string;
  readonly task: TaskReference;
  readonly arm: BenchmarkArm;
  readonly repetition: number;
}

export interface ScheduleDocument {
  readonly schemaVersion: typeof SCHEDULE_SCHEMA_VERSION;
  readonly seed: string;
  readonly repetitions: number;
  readonly taskCount: number;
  readonly scheduleHash: string;
  readonly runs: readonly ScheduledRun[];
}

export interface FrozenCohortManifest {
  readonly schemaVersion: 1;
  readonly cohortId: string;
  readonly scheduleSeed: string;
  readonly scheduleHash: string;
  readonly provider: string;
  readonly exactModel: string;
  readonly serviceTier: string;
  readonly reasoningConfigurationHash: string;
  readonly instructionBundleByTask: Readonly<Record<string, string>>;
  readonly fixtureRevisionByTask: Readonly<Record<string, ArmPins<string>>>;
  readonly fixtureManifestHashByTask: Readonly<Record<string, ArmPins<string>>>;
  readonly evaluatorRevisionByTask: Readonly<Record<string, ArmPins<string>>>;
  readonly analysisRevision: string;
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

export type FrozenCohortManifestInput = Omit<
  FrozenCohortManifest,
  "manifestHash"
>;

export interface ConfirmatoryRunBinding {
  readonly schedule: ScheduleDocument;
  readonly ordinal: number;
  readonly cohort: FrozenCohortManifest;
}

export interface InstructionSet {
  readonly system: string;
  readonly developer: string;
  readonly user: string;
  readonly tools: readonly string[];
  readonly permissions: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
}

export interface InstructionHashes {
  readonly algorithm: "sha256";
  readonly normalization: "unicode-nfc+lf";
  readonly system: string;
  readonly developer: string;
  readonly user: string;
  readonly tools: string;
  readonly permissions: string;
  readonly limits: string;
  readonly bundle: string;
}

export type UsageAvailability = "reported" | "unavailable";

export interface RawUsageField {
  /** A copied provider counter. Null means the provider did not expose it. */
  readonly value: number | null;
  readonly availability: UsageAvailability;
  readonly reason: string | null;
}

export type ReasoningTokenRelation =
  | "included_in_output"
  | "additional_to_output"
  | "unknown";

export type ProviderTotalRelation =
  | "authoritative_non_overlapping_total"
  | "unknown";

export type InputTokenRelation =
  | "uncached_and_cached_disjoint"
  | "input_includes_cached"
  | "unknown";

export interface RawProviderUsage {
  readonly uncachedInputTokens: RawUsageField;
  readonly cachedInputTokens: RawUsageField;
  readonly outputTokens: RawUsageField;
  readonly reasoningTokens: RawUsageField;
  readonly providerTotalTokens: RawUsageField;
  /** Required for confirmatory records. Missing legacy values are ambiguous. */
  readonly inputTokenRelation?: InputTokenRelation;
  readonly reasoningTokenRelation: ReasoningTokenRelation;
  readonly providerTotalRelation: ProviderTotalRelation;
  readonly semantics: string;
}

export type AccountedTokens =
  | {
      readonly availability: "available";
      readonly value: number;
      readonly source: "non_overlapping_components" | "provider_total";
      readonly formula: string;
    }
  | {
      readonly availability: "unavailable";
      readonly value: null;
      readonly source: null;
      readonly reason: string;
    };

export interface PricingSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly serviceTier: string;
  readonly currency: string;
  readonly effectiveAt: string;
  readonly unitTokens: number;
  readonly perUnit: {
    readonly uncachedInput: number | null;
    readonly cachedInput: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
  };
}

export type DerivedCost =
  | {
      readonly availability: "available";
      readonly amount: number;
      readonly currency: string;
      readonly pricingSnapshotId: string;
      readonly formula: string;
    }
  | {
      readonly availability: "unavailable";
      readonly amount: null;
      readonly currency: string | null;
      readonly pricingSnapshotId: string | null;
      readonly reason: string;
    };

export type FileObservationSource =
  | "direct_read"
  | "search_result"
  | "compiler_diagnostic"
  | "generated_index"
  | "rendered"
  | "semantic_tool"
  | "other";

export type AgentEventInput =
  | {
      readonly type: "assistant_turn";
      readonly turnId: string;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly toolName: string;
      readonly status: "succeeded" | "failed";
      readonly retryOfCallId: string | null;
    }
  | {
      readonly type: "command";
      readonly commandId: string;
      readonly toolCallId: string | null;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly classification: "test" | "other";
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly durationMs: number;
      readonly retryOfCommandId: string | null;
    }
  | {
      readonly type: "file_observation";
      readonly path: string | null;
      readonly source: FileObservationSource;
      readonly bytesSurfaced: number | null;
      readonly linesSurfaced: number | null;
    }
  | {
      readonly type: "file_write";
      readonly path: string;
      readonly status: "succeeded" | "failed";
    };

export type AgentEvent = AgentEventInput & {
  readonly sequence: number;
  readonly elapsedMs: number;
};

export interface TestCommandObservation {
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface InteractionSummary {
  readonly assistantTurns: number;
  readonly toolCalls: number;
  readonly toolCallsByType: Readonly<Record<string, number>>;
  readonly failedToolCalls: number;
  readonly commands: number;
  readonly testCommands: readonly TestCommandObservation[];
  readonly failedAttempts: number;
  readonly retries: number;
  readonly filesOpened: readonly string[];
  readonly uniqueSourceFilesOpened: readonly string[];
  readonly repeatFileObservations: number;
  readonly unattributedFileObservations: number;
  readonly events: readonly AgentEvent[];
}

export interface AgentArtifactInput {
  readonly name: string;
  readonly mediaType: string;
  readonly data: string | Uint8Array;
}

export interface AgentAdapterResult {
  readonly provider: string;
  readonly model: string;
  readonly serviceTier: string;
  readonly responseIds: readonly string[];
  readonly completionReason: string;
  readonly usage: RawProviderUsage;
  readonly artifacts: readonly AgentArtifactInput[];
}

export interface AgentConfiguration {
  readonly provider: string;
  /** Must be an exact immutable model identifier, not an unpinned alias. */
  readonly model: string;
  readonly serviceTier: string;
  readonly reasoning: Readonly<Record<string, unknown>>;
}

export interface AgentRunContext {
  readonly runId: string;
  readonly workspacePath: string;
  readonly instructions: InstructionSet;
  readonly signal: AbortSignal;
  emit(event: AgentEventInput): void;
}

export interface AgentAdapter {
  readonly id: string;
  readonly kind: "scripted" | "external_provider";
  readonly configuration: AgentConfiguration;
  readonly confirmatorySession?: ConfirmatorySessionController;
  /** Implementations must stop work and settle promptly when context.signal aborts. */
  run(context: AgentRunContext): Promise<AgentAdapterResult>;
}

export interface ConfirmatorySandboxVerification {
  readonly isolated: true;
  readonly killable: true;
  readonly kind: "os-level-process-sandbox";
  readonly workspacePath: string;
  readonly networkPolicy: string;
  readonly attestationReference: string;
}

export interface ConfirmatorySessionContext {
  readonly runId: string;
  readonly workspacePath: string;
  readonly networkPolicy: string;
}

export interface ConfirmatorySessionController {
  verify(
    context: ConfirmatorySessionContext,
  ): Promise<ConfirmatorySandboxVerification>;
  /** Resolves only after the provider/tool session can no longer mutate the workspace. */
  terminate(
    context: ConfirmatorySessionContext & {
      readonly reason: "timeout" | "external_abort";
    },
  ): Promise<void>;
}

export interface LifecycleContext {
  readonly identity: RunIdentity;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
}

export interface LifecycleCheck {
  readonly name: string;
  readonly status: "passed" | "failed" | "not_applicable";
  readonly durationMs: number;
  readonly details: string | null;
}

export interface EvaluationSummary {
  readonly checks: readonly LifecycleCheck[];
  readonly success: boolean;
  readonly failureCategory: string | null;
  readonly invalidRunReason: string | null;
}

export interface BenchmarkLifecycleHooks {
  preflight(context: LifecycleContext): Promise<readonly LifecycleCheck[]>;
  evaluate(context: LifecycleContext): Promise<EvaluationSummary>;
}

export interface BenchmarkProvisioningPlan {
  /** Exact argv used to provision the fixture; included in the frozen cohort hash. */
  readonly command: readonly [string, ...string[]];
  readonly cachePolicy: string;
  /** Dependency/build paths this phase is allowed to create or change. */
  readonly mutablePathPrefixes: readonly string[];
  provision(context: LifecycleContext): Promise<readonly LifecycleCheck[]>;
}

export interface FileChange {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly binary: boolean;
  readonly generated: boolean;
}

export interface PatchSummary {
  readonly filesModified: readonly FileChange[];
  readonly totalFilesModified: number;
  readonly generatedFilesModified: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly finalDiffHash: string;
  readonly finalManifestHash: string;
  readonly baselineManifestHash?: string;
  readonly evidenceAvailability?: "available" | "unavailable";
  readonly evidenceUnavailableReason?: string | null;
}

export interface AgentExecutionOutcome {
  readonly status: "completed" | "agent_error" | "timeout" | "aborted" | "not_run";
  readonly reason: string;
  readonly shutdownConfirmed: boolean;
}

export interface EvaluatorExecutionOutcome {
  readonly status: "completed" | "failed" | "timed_out" | "aborted" | "not_run";
  readonly reason: string;
}

export interface FinalizationOutcome {
  readonly status: "completed" | "evidence_unavailable";
  readonly reason: string;
}

export interface ConfirmatoryEvidence {
  readonly scheduleHash: string;
  readonly scheduleContentHash: string;
  readonly ordinal: number;
  readonly blockId: string;
  readonly cohortManifestHash: string;
  readonly initialFixtureManifestHash: string;
  readonly provisioningConfigurationHash: string;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly toolVersionsHash: string;
  readonly approvalReference: string;
  readonly sandbox: ConfirmatorySandboxVerification;
}

export interface EnvironmentSnapshot {
  readonly node: string;
  readonly platform: string;
  readonly architecture: string;
  readonly osRelease: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly containerImage: string | null;
  readonly hostClass: string | null;
  readonly packageManager: string | null;
  readonly dependencyCachePolicy: string;
  readonly networkPolicy: string;
  readonly toolVersions: Readonly<Record<string, string>>;
}

export interface ArtifactRecord {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type RunCompletionStatus =
  | "completed"
  | "agent_error"
  | "timeout"
  | "aborted"
  | "preflight_failed"
  | "evaluator_error";

/**
 * Provenance for an append-only correction. The hash identifies the exact
 * retained raw-result envelope, not merely the superseded run ID.
 */
export interface RunCorrectionProvenance {
  readonly schemaVersion: 1;
  readonly supersededRunId: string;
  readonly supersededRecordSha256: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface RunRecord {
  readonly schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  readonly mode: ExecutionMode;
  readonly identity: RunIdentity;
  readonly adapterId: string;
  readonly instructionHashes: InstructionHashes;
  readonly environment: EnvironmentSnapshot;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly completionStatus: RunCompletionStatus;
  readonly completionReason: string;
  readonly agentOutcome?: AgentExecutionOutcome;
  readonly evaluatorOutcome?: EvaluatorExecutionOutcome;
  readonly finalizationOutcome?: FinalizationOutcome;
  readonly confirmatoryEvidence?: ConfirmatoryEvidence | null;
  readonly provider: string;
  readonly model: string;
  readonly serviceTier: string;
  readonly reasoningConfiguration: Readonly<Record<string, unknown>>;
  readonly responseIds: readonly string[];
  readonly usage: RawProviderUsage;
  readonly accountedTokens: AccountedTokens;
  readonly cost: DerivedCost;
  readonly preflight: readonly LifecycleCheck[];
  readonly provisioning?: readonly LifecycleCheck[];
  readonly interaction: InteractionSummary;
  readonly patch: PatchSummary;
  readonly evaluation: EvaluationSummary;
  /** True only for a completed agent run whose preflight and evaluator passed. */
  readonly finalSuccess: boolean;
  /** Present only on a record written through the correction-specific API. */
  readonly correction?: RunCorrectionProvenance;
  readonly artifacts: readonly ArtifactRecord[];
}

export interface ExternalProviderGate {
  readonly approved: true;
  readonly approvalReference: string;
}

export interface FixtureSource {
  readonly fixturesRoot: string;
  readonly relativePath: string;
}

export interface RunEnvironmentInput {
  readonly containerImage: string | null;
  readonly hostClass: string | null;
  readonly packageManager: string | null;
  readonly dependencyCachePolicy: string;
  readonly networkPolicy: string;
  readonly toolVersions: Readonly<Record<string, string>>;
}
