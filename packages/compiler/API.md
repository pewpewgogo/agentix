# `@agentixdev/compiler` API

Every public export, one line each. Artifact shapes: the repository's
`docs/CLI.md`.

## Analysis

- `analyzeProject({rootDir, files?, include?}): AgentIndex` — full static analysis to the schema-2 index (no writes).
- `generateIndex({rootDir, outputFile?, write?, files?, include?}): GeneratedIndex` — deterministic `{index, json, outputFile}`; writes `.agentix/index.json` when `write: true`.
- `checkArchitecture(options): readonly CompilerDiagnostic[]` — architecture + query-purity diagnostics only.

## Index cache

- `readIndex(rootDir, path?): AgentIndex` — reads and shape-checks a cached index (throws on malformed).
- `checkIndexStaleness(index, rootDir): {stale, reason?}` — schema/compiler version + source-digest staleness.
- `INDEX_SCHEMA_VERSION` — `"2"`. `COMPILER_VERSION` — the analyzer version stamped into indexes.

## Affected scope and verification

- `computeAffected(index, target, rootDir?): AffectedResult` — conservative closure with per-item reasons; `widened: true` only when unresolved edges fall outside any indexed feature.
- `planVerification(index, target, rootDir, affected?): VerificationPlan` — narrow project-scoped `tsc`/`vitest` argv when safe; pass a precomputed `affected` to avoid recomputation.
- `workspaceVerificationPlan(target, rootDir, reason): VerificationPlan` — workspace-scope plan honoring `package.json` `typecheck`/`test` scripts.

## Context artifacts

- `createOperationContext(index, id, rootDir): OperationContext | undefined` — bounded artifact (`OPERATION_CONTEXT_BYTE_LIMIT` = 8192 bytes) with source excerpts and an omissions ledger.
- `createOperationDetail(index, id, rootDir): OperationDetail | undefined` — unbounded per-operation detail.
- `OPERATION_CONTEXT_BYTE_LIMIT` — the 8 KiB projection cap.
- `createChangeContext(index, id, rootDir, {budgetBytes?}?): ChangeContext | undefined` — the one-artifact change pack (operation declaration + primary test source + tables/closure/plan/recipe), byte-budgeted (`CHANGE_CONTEXT_DEFAULT_BUDGET` = 16384) with the omissions ledger; throws when the budget is below the smallest projection.
- `CHANGE_CONTEXT_DEFAULT_BUDGET` — the 16 KiB default `--budget`.

## OpenAPI

- `createOpenApiDocument(index, {title?, version?, bearer?, health?}?): OpenApiResult` — deterministic OpenAPI 3.1 `{document, warnings}` mirroring the HTTP adapter (envelope responses, default-mapper parameters, standard 400/403/404/405/500 shapes, optional bearer scheme and health path).
- `schemaDescriptionToJsonSchema(description): JsonSchema` — statically evaluated `SchemaDescription` tree to JSON Schema (strict objects emit `additionalProperties: false`).

## Files and helpers

- `discoverSourceFiles(rootDir, explicitFiles?): string[]` — deterministic sorted source discovery.
- `createSourceManifest(rootDir, sourceFiles): SourceManifest` — per-file sha256 digests + combined digest (includes config files).
- `stableJson(value, {compact?}?): string` — stable-key JSON serialization.
- `toPosixPath(path)`, `repositoryPath(rootDir, path)` — path normalization.
- `featureSegmentOf(path): string | undefined` — single-file paths take the name up to the first dot, so `src/features/notes.ts`, `notes.helpers.ts`, `notes.test.ts`, `notes.integration.test.ts`, and `notes/` all map to segment `"notes"`.
- `compareStrings(left, right): number` — deterministic code-unit comparator used for all index ordering (never locale-dependent).

## Types

`AgentIndex`, `AnalyzeOptions`, `GenerateOptions`, `GeneratedIndex`,
`IndexedFeature`, `IndexedOperation`, `IndexedOperationError`, `IndexedHttp`,
`IndexedEffect`, `IndexedPort`, `IndexedPortOperation`, `IndexedEvent`,
`IndexedTest`, `SchemaExcerpt`, `SchemaDescription`, `GraphEdge`,
`CompilerDiagnostic`, `DiagnosticSeverity`, `DeclarationKind`,
`SourceLocation`, `SourceManifest`, `ManifestEntry`, `AffectedResult`,
`AffectedItem`, `AffectedReason`, `VerificationPlan`, `OperationContext`,
`OperationContextAnalysis`, `OperationContextAffected`,
`OperationContextAffectedItem`, `OperationContextExcerpts`,
`OperationContextOmission`, `OperationContextProjection`,
`OperationContextVerification`, `OperationDetail`, `ChangeContext`,
`ChangeContextTest`, `ChangeContextVerification`, `ChangeContextOptions`,
`OpenApiOptions`, `OpenApiResult`, `StableJsonOptions`.
