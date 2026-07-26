export {
  COMPILER_VERSION,
  INDEX_SCHEMA_VERSION,
} from "./types.js";
export type * from "./types.js";
export { analyzeProject } from "./scanner.js";
export { generateIndex } from "./generate.js";
export {
  OPERATION_CONTEXT_BYTE_LIMIT,
  createOperationContext,
  createOperationDetail,
} from "./context.js";
export { computeAffected, planVerification, workspaceVerificationPlan } from "./affected.js";
export { checkIndexStaleness, readIndex } from "./manifest.js";
export {
  createSourceManifest,
  discoverSourceFiles,
  featureSegmentOf,
  repositoryPath,
  stableJson,
  toPosixPath,
  type StableJsonOptions,
} from "./files.js";

import { analyzeProject } from "./scanner.js";
import type { AnalyzeOptions, CompilerDiagnostic } from "./types.js";

export const checkArchitecture = (
  options: AnalyzeOptions,
): readonly CompilerDiagnostic[] =>
  analyzeProject(options).diagnostics.filter((diagnostic) =>
    diagnostic.code.startsWith("architecture.") ||
    diagnostic.code.startsWith("operation.query-"),
  );
