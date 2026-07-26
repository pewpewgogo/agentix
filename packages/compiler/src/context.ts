import { computeAffected, planVerification, workspaceVerificationPlan } from "./affected.js";
import { stableJson } from "./files.js";
import {
  COMPILER_VERSION,
  type AffectedItem,
  type AffectedResult,
  type AgentIndex,
  type IndexedOperation,
  type OperationContext,
  type OperationContextAnalysis,
  type OperationContextExcerpts,
  type OperationContextOmission,
  type OperationContextVerification,
  type OperationDetail,
} from "./types.js";

export const OPERATION_CONTEXT_BYTE_LIMIT = 8 * 1024;

type ExcerptLevel = "full" | "core" | "none";

interface ProjectionLimits {
  readonly operationItems: number;
  readonly effects: number;
  readonly targetDiagnostics: number;
  readonly targetUnresolved: number;
  readonly affectedItems: number;
  readonly affectedReasons: number;
  readonly affectedDiagnostics: number;
  readonly verificationTestFiles: number;
  readonly excerpts: ExcerptLevel;
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
    excerpts: "full",
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
    excerpts: "core",
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
    excerpts: "none",
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

/**
 * Bounded source excerpts. "full" embeds schema declarations, the execute
 * signature, error detail schemas, and port operation signatures; "core"
 * keeps only input/output/execute; "none" drops the section entirely with
 * an omission ledger entry.
 */
const projectExcerpts = (
  index: AgentIndex,
  operation: IndexedOperation,
  limits: ProjectionLimits,
  state: ProjectionState,
): OperationContextExcerpts | undefined => {
  const detailExpansion = commandExpansion("detail", operation);
  const input = operation.input?.declaration ?? operation.input?.text;
  const output = operation.output?.declaration ?? operation.output?.text;
  const execute = operation.executeSignature;
  const errorTexts = operation.errors
    .filter((error) => error.details !== undefined)
    .map((error) => ({ code: error.code, text: error.details as string }));
  const signatureByOperationId = new Map<string, string>();
  for (const port of index.ports) {
    for (const portOperation of port.operations) {
      if (portOperation.signature !== undefined) {
        signatureByOperationId.set(portOperation.id, portOperation.signature);
      }
    }
  }
  const effectSignatures = operation.effects
    .filter((effect) => effect.operationId !== undefined)
    .map((effect) => ({
      name: effect.name,
      signature: signatureByOperationId.get(effect.operationId as string),
    }))
    .filter((entry): entry is { name: string; signature: string } => entry.signature !== undefined);
  const total =
    (input === undefined ? 0 : 1) +
    (output === undefined ? 0 : 1) +
    (execute === undefined ? 0 : 1) +
    errorTexts.length +
    effectSignatures.length;

  if (limits.excerpts === "none") {
    if (total > 0) {
      state.omissions.push({
        path: "excerpts",
        total,
        included: 0,
        expand: detailExpansion,
      });
    }
    return undefined;
  }
  if (limits.excerpts === "core") {
    const omitted = errorTexts.length + effectSignatures.length;
    if (omitted > 0) {
      state.omissions.push({
        path: "excerpts",
        total,
        included: total - omitted,
        expand: detailExpansion,
      });
    }
    if (input === undefined && output === undefined && execute === undefined) return undefined;
    return {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(execute === undefined ? {} : { execute }),
    };
  }
  if (total === 0) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(execute === undefined ? {} : { execute }),
    ...(errorTexts.length === 0
      ? {}
      : {
          errors: take(errorTexts, limits.operationItems, "excerpts.errors", detailExpansion, state),
        }),
    ...(effectSignatures.length === 0
      ? {}
      : {
          effects: take(effectSignatures, limits.effects, "excerpts.effects", detailExpansion, state),
        }),
  };
};

const projectVerification = (
  index: AgentIndex,
  operation: IndexedOperation,
  rootDir: string,
  affected: AffectedResult,
  limits: ProjectionLimits,
  state: ProjectionState,
): OperationContextVerification => {
  const plan = planVerification(index, operation.id, rootDir, affected);
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
  return workspaceVerificationPlan(
    operation.id,
    rootDir,
    "The bounded context omits part of the narrow plan, so verification widens to the workspace.",
  );
};

const projectContext = (
  index: AgentIndex,
  operation: IndexedOperation,
  rootDir: string,
  affected: AffectedResult,
  limits: ProjectionLimits,
): OperationContext => {
  const state: ProjectionState = { omissions: [] };
  const detailExpansion = commandExpansion("detail", operation);
  const affectedExpansion = commandExpansion("affected", operation);
  const analysis = operationAnalysis(index, operation);
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

  const excerpts = projectExcerpts(index, operation, limits, state);
  const verification = projectVerification(index, operation, rootDir, affected, limits, state);
  return {
    schemaVersion: "2",
    artifactKind: "operation-context",
    id: operation.id,
    key: operation.key,
    symbol: operation.symbol,
    kind: operation.kind,
    ...(operation.feature === undefined ? {} : { feature: operation.feature }),
    source: operation.source,
    ...(operation.http === undefined ? {} : { http: operation.http }),
    errors: take(
      operation.errors.map((error) => ({
        code: error.code,
        ...(error.http === undefined ? {} : { http: error.http }),
      })),
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
    ensures: take(
      operation.ensures,
      limits.operationItems,
      "ensures",
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
    ...(excerpts === undefined ? {} : { excerpts }),
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
      schemaVersion: "2",
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
  const affected = computeAffected(index, operation.id, rootDir);
  return {
    schemaVersion: "2",
    artifactKind: "operation-detail",
    ...operation,
    analysis: operationAnalysis(index, operation),
    verification: planVerification(index, operation.id, rootDir, affected),
  };
};

export const createOperationContext = (
  index: AgentIndex,
  target: string,
  rootDir: string,
): OperationContext | undefined => {
  const operation = index.operations.find((candidate) => candidate.id === target);
  if (operation === undefined) return undefined;

  // One affected computation per inspect; reused by every projection level
  // and by the verification plan.
  const affected = computeAffected(index, operation.id, rootDir);
  for (const limits of projectionLevels) {
    const context = projectContext(index, operation, rootDir, affected, limits);
    if (Buffer.byteLength(stableJson(context)) <= OPERATION_CONTEXT_BYTE_LIMIT) {
      return context;
    }
  }
  throw new Error(
    `Operation '${operation.id}' has scalar identity metadata larger than the 8 KiB context limit.`,
  );
};
