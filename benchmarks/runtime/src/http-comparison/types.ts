export const HTTP_STACKS = [
  "agentix-node",
  "express",
  "nestjs-express",
] as const;

export type HttpStack = (typeof HTTP_STACKS)[number];

/**
 * Validation-work conditions.
 *
 * - "default": Express and NestJS behave byte-identically to the v1 targets
 *   (hand-written guard on the echo input, no output validation). Agentix
 *   always validates input and output, so its work is constant.
 * - "validated": Express and NestJS additionally run zod input AND output
 *   validation, matching the work Agentix always performs.
 */
export const HTTP_CONDITIONS = ["default", "validated"] as const;

export type HttpCondition = (typeof HTTP_CONDITIONS)[number];

export const HTTP_WORKLOADS = [
  "echo-valid",
  "echo-invalid",
  "param-get",
  "echo-batch",
] as const;

export type HttpWorkload = (typeof HTTP_WORKLOADS)[number];

/** In-flight request count for the concurrency batch workload. */
export const BATCH_CONCURRENCY = 8;

export interface StartedHttpTarget {
  readonly stack: HttpStack;
  readonly origin: string;
  close(): Promise<void>;
}

/** Target modules export `stack` plus this condition-aware starter. */
export type HttpTargetStart = (
  condition: HttpCondition,
) => Promise<StartedHttpTarget>;

export type HttpComparisonMetric =
  | "cold-ready"
  | "http-valid"
  | "http-invalid"
  | "http-param"
  | "http-batch"
  | "ready-rss"
  | "process-max-rss-ready";

export type HttpComparisonPhase = "warmup" | "measured";

export interface HttpComparisonSample {
  readonly metric: HttpComparisonMetric;
  readonly stack: HttpStack;
  readonly condition: HttpCondition;
  /** Null on fresh-process metrics, which serve no HTTP workload. */
  readonly workload: HttpWorkload | null;
  /** In-flight requests for HTTP workloads (1 or the batch size); null otherwise. */
  readonly concurrency: number | null;
  readonly iteration: number;
  readonly phase: HttpComparisonPhase;
  readonly value: number;
  readonly unit: "nanoseconds" | "bytes";
}

export interface HttpComparisonUnavailable {
  readonly metric: HttpComparisonMetric;
  readonly stack: HttpStack;
  readonly condition: HttpCondition;
  readonly iteration: number | null;
  readonly phase: HttpComparisonPhase | null;
  readonly reason: string;
}

export interface HttpComparisonDistribution {
  readonly count: number;
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly p95: number;
  readonly max: number;
  readonly iqr: number;
  readonly samples: readonly number[];
}

export interface HttpComparisonSummary {
  readonly metric: HttpComparisonMetric;
  readonly stack: HttpStack;
  readonly condition: HttpCondition;
  readonly workload: HttpWorkload | null;
  readonly concurrency: number | null;
  readonly unit: HttpComparisonSample["unit"];
  readonly distribution: HttpComparisonDistribution;
  /**
   * Derived throughput for the batch workload only:
   * concurrency / (median batch-completion seconds).
   */
  readonly requestsPerSecond?: number;
}

export interface HttpComparisonMethodology {
  readonly version: "v2";
  readonly processIsolation:
    | "per-target-child-process"
    | "in-process-shared-event-loop";
  readonly recommendedProcessIsolation: "per-target-child-process";
  readonly supersedes: string;
  readonly changesFromV1: readonly string[];
}

export interface HttpComparisonReport {
  readonly schemaVersion: 2;
  readonly kind: "agentix-http-framework-comparison";
  readonly classification: "exploratory";
  readonly eligibleForConfirmatoryUse: false;
  readonly methodology: HttpComparisonMethodology;
  readonly generatedAt: string;
  readonly seed: string;
  readonly configuration: {
    readonly warmupIterations: number;
    readonly measuredIterations: number;
    readonly processIterations: number;
    readonly processMetrics: boolean;
    readonly isolatedProcesses: boolean;
    readonly batchConcurrency: number;
    readonly conditions: readonly HttpCondition[];
  };
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly osRelease: string;
    readonly cpuModel: string;
    readonly cpuCount: number;
    readonly totalMemoryBytes: number;
  };
  readonly repository: {
    readonly gitCommit: string | null;
    readonly dirty: boolean;
    readonly packageLockSha256: string;
    readonly comparisonSourceSha256: string;
  };
  readonly dependencies: {
    readonly agentix: string;
    readonly express: string;
    readonly nestjsCore: string;
    readonly nestjsPlatformExpress: string;
    readonly zod: string;
  };
  readonly measurementPlanSha256: string;
  readonly samples: readonly HttpComparisonSample[];
  readonly summaries: readonly HttpComparisonSummary[];
  readonly unavailable: readonly HttpComparisonUnavailable[];
  readonly limitations: readonly string[];
}
