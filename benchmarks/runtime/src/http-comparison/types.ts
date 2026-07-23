export const HTTP_STACKS = [
  "agentix-node",
  "express",
  "nestjs-express",
] as const;

export type HttpStack = (typeof HTTP_STACKS)[number];

export interface StartedHttpTarget {
  readonly stack: HttpStack;
  readonly origin: string;
  close(): Promise<void>;
}

export interface HttpTarget {
  readonly stack: HttpStack;
  start(): Promise<StartedHttpTarget>;
}

export type HttpComparisonMetric =
  | "cold-ready"
  | "http-valid"
  | "http-invalid"
  | "ready-rss"
  | "process-max-rss-ready";

export type HttpComparisonPhase = "warmup" | "measured";

export interface HttpComparisonSample {
  readonly metric: HttpComparisonMetric;
  readonly stack: HttpStack;
  readonly iteration: number;
  readonly phase: HttpComparisonPhase;
  readonly value: number;
  readonly unit: "nanoseconds" | "bytes";
}

export interface HttpComparisonUnavailable {
  readonly metric: HttpComparisonMetric;
  readonly stack: HttpStack;
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
  readonly unit: HttpComparisonSample["unit"];
  readonly distribution: HttpComparisonDistribution;
}

export interface HttpComparisonReport {
  readonly schemaVersion: 1;
  readonly kind: "agentix-http-framework-comparison";
  readonly classification: "exploratory";
  readonly eligibleForConfirmatoryUse: false;
  readonly generatedAt: string;
  readonly seed: string;
  readonly configuration: {
    readonly warmupIterations: number;
    readonly measuredIterations: number;
    readonly processIterations: number;
    readonly processMetrics: boolean;
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
  };
  readonly measurementPlanSha256: string;
  readonly samples: readonly HttpComparisonSample[];
  readonly summaries: readonly HttpComparisonSummary[];
  readonly unavailable: readonly HttpComparisonUnavailable[];
  readonly limitations: readonly string[];
}
