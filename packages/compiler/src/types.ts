export const INDEX_SCHEMA_VERSION = "2" as const;
export const COMPILER_VERSION = "0.2.0" as const;

export type DeclarationKind =
  | "feature"
  | "command"
  | "query"
  | "port"
  | "event"
  | "test";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export type DiagnosticSeverity = "error" | "warning";

export interface CompilerDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source: SourceLocation;
}

export interface ManifestEntry {
  readonly file: string;
  readonly sha256: string;
}

export interface SourceManifest {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly files: readonly ManifestEntry[];
}

/**
 * Bounded source excerpt for a schema reference: `text` is the collapsed
 * reference/inline expression, `declaration` the resolved declaration text
 * (each capped at 1 KiB), `source` the declaration's location.
 */
export interface SchemaExcerpt {
  readonly text: string;
  readonly declaration?: string;
  readonly source?: SourceLocation;
}

export interface IndexedFeature {
  readonly id: string;
  readonly symbol: string;
  readonly source: SourceLocation;
  /** Exported names of the feature file — its public contract. */
  readonly exports: readonly string[];
  /** Feature ids this feature imports (derived from feature-file imports). */
  readonly dependencies: readonly string[];
  readonly consumers: readonly string[];
  readonly operations: readonly string[];
  /** Event ids declared in the feature definition's `events` list. */
  readonly events: readonly string[];
  readonly tests: readonly string[];
}

export interface IndexedEffect {
  readonly name: string;
  readonly reference: string;
  readonly operationId?: string;
  readonly kind?: "read" | "write" | "time" | "random" | "external";
}

/** Unified error declaration: `{ CODE: { http?, details? } }` or bare schema. */
export interface IndexedOperationError {
  readonly code: string;
  readonly http?: number;
  /** Bounded source text of the details schema declaration (≤1 KiB). */
  readonly details?: string;
}

export interface IndexedHttp {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  /** Derived from the unified error declarations' `http` numbers. */
  readonly errorStatus: Readonly<Record<string, number>>;
}

export interface IndexedOperation {
  readonly id: string;
  /** The operations-object key the id was derived from. */
  readonly key: string;
  /** Addressable expression, e.g. `notes.operations.create`. */
  readonly symbol: string;
  readonly kind: "command" | "query";
  readonly feature?: string;
  readonly source: SourceLocation;
  readonly input?: SchemaExcerpt;
  readonly output?: SchemaExcerpt;
  readonly errors: readonly IndexedOperationError[];
  readonly http?: IndexedHttp;
  readonly permissions: readonly string[];
  readonly effects: readonly IndexedEffect[];
  /** Event ids emitted via `emits`. */
  readonly events: readonly string[];
  /** Names of post-completion invariants declared via `ensures`. */
  readonly ensures: readonly string[];
  /** Bounded `execute` signature text (≤1 KiB, body elided). */
  readonly executeSignature?: string;
  readonly tests: readonly string[];
}

export interface IndexedPortOperation {
  readonly name: string;
  readonly id: string;
  readonly kind: "read" | "write" | "time" | "random" | "external";
  readonly source: SourceLocation;
  /** Bounded declaration text of the port operation (≤1 KiB). */
  readonly signature?: string;
}

export interface IndexedPort {
  readonly id: string;
  readonly symbol: string;
  readonly feature?: string;
  readonly source: SourceLocation;
  readonly operations: readonly IndexedPortOperation[];
}

export interface IndexedEvent {
  readonly id: string;
  readonly symbol: string;
  readonly version?: number;
  readonly feature?: string;
  readonly source: SourceLocation;
}

export interface IndexedTest {
  readonly id: string;
  readonly source: SourceLocation;
  readonly operations: readonly string[];
  readonly features: readonly string[];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind:
    | "feature-dependency"
    | "feature-operation"
    | "port-operation"
    | "operation-effect"
    | "operation-event"
    | "operation-test";
  readonly reason: string;
}

export interface AgentIndex {
  readonly schemaVersion: typeof INDEX_SCHEMA_VERSION;
  readonly compilerVersion: typeof COMPILER_VERSION;
  readonly sourceManifest: SourceManifest;
  readonly features: readonly IndexedFeature[];
  readonly operations: readonly IndexedOperation[];
  readonly ports: readonly IndexedPort[];
  readonly events: readonly IndexedEvent[];
  readonly tests: readonly IndexedTest[];
  readonly edges: readonly GraphEdge[];
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly unresolved: readonly string[];
}

export interface AnalyzeOptions {
  readonly rootDir: string;
  readonly files?: readonly string[];
  readonly include?: readonly string[];
}

export interface GenerateOptions extends AnalyzeOptions {
  readonly outputFile?: string;
  readonly write?: boolean;
}

export interface GeneratedIndex {
  readonly index: AgentIndex;
  readonly json: string;
  readonly outputFile: string;
}

export interface AffectedReason {
  readonly from: string;
  readonly edge: GraphEdge["kind"] | "selected" | "conservative-widening";
  readonly message: string;
}

export interface AffectedItem {
  readonly id: string;
  readonly kind: DeclarationKind | "workspace";
  readonly reasons: readonly AffectedReason[];
}

export interface AffectedResult {
  readonly schemaVersion: "2";
  readonly target: string;
  readonly widened: boolean;
  readonly items: readonly AffectedItem[];
  readonly diagnostics: readonly string[];
}

export interface VerificationPlan {
  readonly schemaVersion: "2";
  readonly target: string;
  readonly scope: "project" | "workspace";
  readonly reason: string;
  readonly typecheck: readonly string[];
  readonly tests: readonly string[];
  readonly testFiles: readonly string[];
}

export interface OperationContextAnalysis {
  readonly compilerVersion: typeof COMPILER_VERSION;
  readonly sourceDigest: string;
  /** Agentix architecture/metadata validity. This is not a TypeScript typecheck. */
  readonly agentixValid: boolean;
  /** False when static relationships are unresolved and context must widen. */
  readonly complete: boolean;
  readonly typecheck: "not-run";
  readonly project: {
    readonly errors: number;
    readonly warnings: number;
    readonly unresolved: number;
  };
  readonly targetDiagnostics: readonly CompilerDiagnostic[];
  readonly targetUnresolved: readonly string[];
}

export interface OperationContextAffectedItem {
  readonly id: string;
  readonly kind: AffectedItem["kind"];
  readonly reasons: readonly AffectedReason[];
  /** Total reasons before bounded projection. */
  readonly totalReasons: number;
}

export interface OperationContextAffected {
  readonly schemaVersion: "2";
  readonly target: string;
  readonly widened: boolean;
  readonly totalItems: number;
  readonly countsByKind: readonly {
    readonly kind: AffectedItem["kind"];
    readonly count: number;
  }[];
  readonly items: readonly OperationContextAffectedItem[];
  readonly diagnostics: readonly string[];
}

export interface OperationContextOmission {
  readonly path: string;
  readonly total: number;
  readonly included: number;
  readonly expand:
    | {
        readonly kind: "source";
        readonly source: SourceLocation;
      }
    | {
        readonly kind: "command";
        readonly cwd: "application-root";
        readonly argv: readonly string[];
      };
}

export interface OperationContextProjection {
  readonly byteLimit: number;
  readonly truncated: boolean;
  /** Every omitted collection is reported here with an exact next action. */
  readonly omissions: readonly OperationContextOmission[];
}

export interface OperationContextVerification {
  readonly schemaVersion: "2";
  readonly target: string;
  readonly scope: "project" | "workspace";
  readonly reason: string;
  readonly typecheck: readonly string[];
  readonly tests: readonly string[];
  readonly testFiles: readonly string[];
}

/** Bounded source excerpts making the context a one-artifact change surface. */
export interface OperationContextExcerpts {
  readonly input?: string;
  readonly output?: string;
  readonly execute?: string;
  readonly errors?: readonly {
    readonly code: string;
    readonly text: string;
  }[];
  readonly effects?: readonly {
    readonly name: string;
    readonly signature: string;
  }[];
}

/** Explicit, unbounded per-operation detail used to expand a bounded context. */
export interface OperationDetail extends IndexedOperation {
  readonly schemaVersion: "2";
  readonly artifactKind: "operation-detail";
  readonly analysis: OperationContextAnalysis;
  readonly verification: VerificationPlan;
}

/**
 * Bounded, source-bound context for one operation. The full generated index is
 * a disposable artifact; agents should consume this projection instead.
 */
export interface OperationContext {
  readonly schemaVersion: "2";
  readonly artifactKind: "operation-context";
  readonly id: string;
  readonly key: string;
  readonly symbol: string;
  readonly kind: "command" | "query";
  readonly feature?: string;
  readonly source: SourceLocation;
  readonly http?: IndexedHttp;
  readonly errors: readonly {
    readonly code: string;
    readonly http?: number;
  }[];
  readonly permissions: readonly string[];
  readonly effects: readonly IndexedEffect[];
  readonly events: readonly string[];
  readonly ensures: readonly string[];
  readonly tests: readonly string[];
  readonly excerpts?: OperationContextExcerpts;
  readonly analysis: OperationContextAnalysis;
  readonly affected: OperationContextAffected;
  readonly verification: OperationContextVerification;
  readonly projection: OperationContextProjection;
}
