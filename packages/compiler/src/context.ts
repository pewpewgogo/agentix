import { computeAffected, planVerification } from "./affected.js";
import { stableJson } from "./files.js";
import {
  COMPILER_VERSION,
  type AffectedItem,
  type AgentIndex,
  type IndexedOperation,
  type OperationContext,
  type OperationContextAnalysis,
  type OperationContextOmission,
  type OperationContextVerification,
  type OperationDetail,
} from "./types.js";

export const OPERATION_CONTEXT_BYTE_LIMIT = 8 * 1024;

interface ProjectionLimits {
  readonly operationItems: number;
  readonly effects: number;
  readonly targetDiagnostics: number;
  readonly targetUnresolved: number;
  readonly affectedItems: number;
  readonly affectedReasons: number;
  readonly affectedDiagnostics: number;
  readonly verificationTestFiles: number;
  readonly includeSchemas: boolean;
  readonly forceWorkspaceVerification: boolean;
}

interface ProjectionState {
  readonly omissions: OperationContextOmission[];
}

const projectionLevels: readonly ProjectionLimits[] = [
  {
    operationItems: 16,
    effects: 12,
    targetDiagnostics: 8,
    targetUnresolved: 8,
    affectedItems: 16,
    affectedReasons: 2,
    affectedDiagnostics: 4,
    verificationTestFiles: 16,
    includeSchemas: true,
    forceWorkspaceVerification: false,
  },
  {
    operationItems: 4,
    effects: 3,
    targetDiagnostics: 2,
    targetUnresolved: 2,
    affectedItems: 4,
    affectedReasons: 1,
    affectedDiagnostics: 1,
    verificationTestFiles: 4,
    includeSchemas: true,
    forceWorkspaceVerification: false,
  },
  {
    operationItems: 0,
    effects: 0,
    targetDiagnostics: 0,
    targetUnresolved: 0,
    affectedItems: 0,
    affectedReasons: 0,
    affectedDiagnostics: 0,
    verificationTestFiles: 0,
    includeSchemas: false,
    forceWorkspaceVerification: true,
  },
];

const compare = (left: string, right: string): number => left.localeCompare(right);

const commandExpansion = (
  command: "affected" | "detail",
  operation: IndexedOperation,
): OperationContextOmission["expand"] => ({
  kind: "command",
  cwd: "application-root",
  argv: [
    "npm",
    "exec",
    "--",
    "agentix",
    command === "detail" ? "inspect" : "affected",
    ...(command === "detail" ? ["--full"] : []),
    "--root",
    ".",
    "--json",
    "--",
    operation.id,
  ],
});

const operationAnalysis = (
  index: AgentIndex,
  operation: IndexedOperation,
): OperationContextAnalysis => {
  const targetDiagnostics = index.diagnostics
    .filter((diagnostic) => diagnostic.source.file === operation.source.file);
  const targetUnresolved = index.unresolved
    .filter((entry) => entry.includes(operation.id) || entry.includes(operation.source.file))
    .sort(compare);
  const errors = index.diagnostics.filter(({ severity }) => severity === "error").length;
  return {
    compilerVersion: COMPILER_VERSION,
    sourceDigest: index.sourceManifest.digest,
    agentixValid: errors === 0,
    complete: index.unresolved.length === 0,
    typecheck: "not-run",
    project: {
      errors,
      warnings: index.diagnostics.length - errors,
      unresolved: index.unresolved.length,
    },
    targetDiagnostics,
    targetUnresolved,
  };
};

const take = <T>(
  values: readonly T[],
  limit: number,
  path: string,
  expand: OperationContextOmission["expand"],
  state: ProjectionState,
): readonly T[] => {
  const included = values.slice(0, limit);
  if (included.length < values.length) {
    state.omissions.push({
      path,
      total: values.length,
      included: included.length,
      expand,
    });
  }
  return included;
};

const projectVerification = (
  index: AgentIndex,
  operation: IndexedOperation,
  rootDir: string,
  limits: ProjectionLimits,
  state: ProjectionState,
): OperationContextVerification => {
  const plan = planVerification(index, operation.id, rootDir);
  const mustWiden = limits.forceWorkspaceVerification ||
    plan.testFiles.length > limits.verificationTestFiles ||
    plan.typecheck.length > 24 || plan.tests.length > 24;
  if (!mustWiden) return plan;

  if (plan.testFiles.length > 0) {
    state.omissions.push({
      path: "verification.testFiles",
      total: plan.testFiles.length,
      included: 0,
      expand: commandExpansion("detail", operation),
    });
  }
  const workspace = planVerification(index, "tsconfig.json", rootDir);
  return {
    schemaVersion: "1",
    target: operation.id,
    scope: "workspace",
    reason: "The bounded context omits part of the narrow plan, so verification widens to the workspace.",
    typecheck: workspace.typecheck,
    tests: workspace.tests,
    testFiles: [],
  };
};

const projectContext = (
  index: AgentIndex,
  operation: IndexedOperation,
  rootDir: string,
  limits: ProjectionLimits,
): OperationContext => {
  const state: ProjectionState = { omissions: [] };
  const detailExpansion = commandExpansion("detail", operation);
  const affectedExpansion = commandExpansion("affected", operation);
  const analysis = operationAnalysis(index, operation);
  const affected = computeAffected(index, operation.id, rootDir);
  const counts = new Map<AffectedItem["kind"], number>();
  for (const item of affected.items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }

  const includedAffected = affected.widened
    ? take(affected.items, 0, "affected.items", affectedExpansion, state)
    : take(
      affected.items,
      limits.affectedItems,
      "affected.items",
      affectedExpansion,
      state,
    );
  let totalReasons = 0;
  let includedReasons = 0;
  const affectedItems = includedAffected.map((item) => {
    totalReasons += item.reasons.length;
    const reasons = item.reasons.slice(0, limits.affectedReasons);
    includedReasons += reasons.length;
    return {
      id: item.id,
      kind: item.kind,
      reasons,
      totalReasons: item.reasons.length,
    };
  });
  if (includedReasons < totalReasons) {
    state.omissions.push({
      path: "affected.items[].reasons",
      total: totalReasons,
      included: includedReasons,
      expand: affectedExpansion,
    });
  }

  const input = limits.includeSchemas ? operation.input : undefined;
  const output = limits.includeSchemas ? operation.output : undefined;
  if (!limits.includeSchemas && operation.input !== undefined) {
    state.omissions.push({
      path: "input",
      total: 1,
      included: 0,
      expand: detailExpansion,
    });
  }
  if (!limits.includeSchemas && operation.output !== undefined) {
    state.omissions.push({
      path: "output",
      total: 1,
      included: 0,
      expand: detailExpansion,
    });
  }

  const verification = projectVerification(index, operation, rootDir, limits, state);
  return {
    schemaVersion: "1",
    artifactKind: "operation-context",
    id: operation.id,
    symbol: operation.symbol,
    kind: operation.kind,
    ...(operation.feature === undefined ? {} : { feature: operation.feature }),
    source: operation.source,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    errors: take(
      operation.errors,
      limits.operationItems,
      "errors",
      detailExpansion,
      state,
    ),
    permissions: take(
      operation.permissions,
      limits.operationItems,
      "permissions",
      detailExpansion,
      state,
    ),
    effects: take(
      operation.effects,
      limits.effects,
      "effects",
      detailExpansion,
      state,
    ),
    events: take(
      operation.events,
      limits.operationItems,
      "events",
      detailExpansion,
      state,
    ),
    invariants: take(
      operation.invariants,
      limits.operationItems,
      "invariants",
      detailExpansion,
      state,
    ),
    tests: take(
      operation.tests,
      limits.operationItems,
      "tests",
      detailExpansion,
      state,
    ),
    analysis: {
      ...analysis,
      targetDiagnostics: take(
        analysis.targetDiagnostics,
        limits.targetDiagnostics,
        "analysis.targetDiagnostics",
        detailExpansion,
        state,
      ),
      targetUnresolved: take(
        analysis.targetUnresolved,
        limits.targetUnresolved,
        "analysis.targetUnresolved",
        detailExpansion,
        state,
      ),
    },
    affected: {
      schemaVersion: "1",
      target: operation.id,
      widened: affected.widened,
      totalItems: affected.items.length,
      countsByKind: [...counts]
        .map(([kind, count]) => ({ kind, count }))
        .sort((left, right) => compare(left.kind, right.kind)),
      items: affectedItems,
      diagnostics: take(
        affected.diagnostics,
        limits.affectedDiagnostics,
        "affected.diagnostics",
        affectedExpansion,
        state,
      ),
    },
    verification,
    projection: {
      byteLimit: OPERATION_CONTEXT_BYTE_LIMIT,
      truncated: state.omissions.length > 0,
      omissions: state.omissions,
    },
  };
};

export const createOperationDetail = (
  index: AgentIndex,
  target: string,
  rootDir: string,
): OperationDetail | undefined => {
  const operation = index.operations.find((candidate) => candidate.id === target);
  if (operation === undefined) return undefined;
  return {
    schemaVersion: "1",
    artifactKind: "operation-detail",
    ...operation,
    analysis: operationAnalysis(index, operation),
    verification: planVerification(index, operation.id, rootDir),
  };
};

export const createOperationContext = (
  index: AgentIndex,
  target: string,
  rootDir: string,
): OperationContext | undefined => {
  const operation = index.operations.find((candidate) => candidate.id === target);
  if (operation === undefined) return undefined;

  for (const limits of projectionLevels) {
    const context = projectContext(index, operation, rootDir, limits);
    if (Buffer.byteLength(stableJson(context)) <= OPERATION_CONTEXT_BYTE_LIMIT) {
      return context;
    }
  }
  throw new Error(
    `Operation '${operation.id}' has scalar identity metadata larger than the 8 KiB context limit.`,
  );
};
