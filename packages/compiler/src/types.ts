export const INDEX_SCHEMA_VERSION = "1" as const;
export const COMPILER_VERSION = "0.1.0" as const;

export type DeclarationKind =
  | "feature"
  | "command"
  | "query"
  | "port"
  | "event"
  | "invariant"
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

export interface IndexedReference {
  readonly id: string;
  readonly source?: SourceLocation;
}

export interface IndexedFeature {
  readonly id: string;
  readonly symbol: string;
  readonly source: SourceLocation;
  readonly contract: {
    readonly expression: string;
    readonly source?: SourceLocation;
    readonly exports: readonly string[];
  };
  readonly dependencies: readonly string[];
  readonly consumers: readonly string[];
  readonly operations: readonly string[];
  readonly invariants: readonly string[];
  readonly tests: readonly string[];
}

export interface IndexedEffect {
  readonly name: string;
  readonly reference: string;
  readonly operationId?: string;
  readonly kind?: "read" | "write" | "time" | "random" | "external";
}

export interface IndexedOperation {
  readonly id: string;
  readonly symbol: string;
  readonly kind: "command" | "query";
  readonly feature?: string;
  readonly source: SourceLocation;
  readonly input?: string;
  readonly output?: string;
  readonly errors: readonly string[];
  readonly permissions: readonly string[];
  readonly effects: readonly IndexedEffect[];
  readonly events: readonly string[];
  readonly invariants: readonly string[];
  readonly tests: readonly string[];
}

export interface IndexedPortOperation {
  readonly name: string;
  readonly id: string;
  readonly kind: "read" | "write" | "time" | "random" | "external";
  readonly source: SourceLocation;
}

export interface IndexedPort {
  readonly id: string;
  readonly symbol: string;
  readonly source: SourceLocation;
  readonly operations: readonly IndexedPortOperation[];
}

export interface IndexedEvent {
  readonly id: string;
  readonly symbol: string;
  readonly version?: number;
  readonly source: SourceLocation;
}

export interface IndexedInvariant {
  readonly id: string;
  readonly symbol: string;
  readonly feature?: string;
  readonly source: SourceLocation;
  readonly dependencies: readonly string[];
  readonly preservers: readonly string[];
  readonly tests: readonly string[];
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
    | "operation-effect"
    | "operation-event"
    | "operation-invariant"
    | "operation-test"
    | "invariant-dependency";
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
  readonly invariants: readonly IndexedInvariant[];
  readonly tests: readonly IndexedTest[];
  readonly edges: readonly GraphEdge[];
  readonly likelyAffected: readonly {
    readonly target: string;
    readonly operations: readonly {
      readonly id: string;
      readonly reason: string;
    }[];
  }[];
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
  readonly schemaVersion: "1";
  readonly target: string;
  readonly widened: boolean;
  readonly items: readonly AffectedItem[];
  readonly diagnostics: readonly string[];
}

export interface VerificationPlan {
  readonly schemaVersion: "1";
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
  readonly schemaVersion: "1";
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
  readonly schemaVersion: "1";
  readonly target: string;
  readonly scope: "project" | "workspace";
  readonly reason: string;
  readonly typecheck: readonly string[];
  readonly tests: readonly string[];
  readonly testFiles: readonly string[];
}

/** Explicit, unbounded per-operation detail used to expand a bounded context. */
export interface OperationDetail extends IndexedOperation {
  readonly schemaVersion: "1";
  readonly artifactKind: "operation-detail";
  readonly analysis: OperationContextAnalysis;
  readonly verification: VerificationPlan;
}

/**
 * Bounded, source-bound context for one operation. The full generated index is
 * a disposable artifact; agents should consume this projection instead.
 */
export interface OperationContext {
  readonly schemaVersion: "1";
  readonly artifactKind: "operation-context";
  readonly id: string;
  readonly symbol: string;
  readonly kind: "command" | "query";
  readonly feature?: string;
  readonly source: SourceLocation;
  readonly input?: string;
  readonly output?: string;
  readonly errors: readonly string[];
  readonly permissions: readonly string[];
  readonly effects: readonly IndexedEffect[];
  readonly events: readonly string[];
  readonly invariants: readonly string[];
  readonly tests: readonly string[];
  readonly analysis: OperationContextAnalysis;
  readonly affected: OperationContextAffected;
  readonly verification: OperationContextVerification;
  readonly projection: OperationContextProjection;
}
