# CLI and Generated Index

The `agentix` CLI answers maintenance questions from static analysis of
TypeScript source. `.agentix/index.json` is a cache keyed by a deterministic
source digest: commands serve it while the digest matches and silently
re-analyze (rewriting it) when anything is stale, missing, or malformed. It is
not a signed artifact and is never used by runtime dispatch.

```sh
npm install --save-dev @agentixdev/cli
npm exec -- agentix help
```

All commands accept `--root <directory>` (the application to analyze),
`--json` (stable machine output) and `--compact` (single-line JSON). Exit
codes: `0` success, `1` verification failure, `2` invalid invocation,
`3` internal failure.

```text
agentix inspect <feature-or-operation> [--json [--compact]] [--root <directory>]
agentix inspect <operation> --full [--json [--compact]] [--root <directory>]
agentix context <operation> [--budget <bytes>] [--json [--compact]] [--root <directory>]
agentix graph [<feature>] [--format text|json|dot] [--root <directory>]
agentix affected <feature-or-file> [--json [--compact]] [--root <directory>]
agentix verify <feature-or-operation> [--json [--compact]] [--root <directory>]
agentix openapi [--bearer] [--health <path>] [--out <file>] [--compact] [--root <directory>]
agentix scaffold feature <name> [--dry-run] [--json [--compact]] [--root <directory>]
agentix mcp [--root <directory>]
```

## inspect

The primary command. For an operation it returns a bounded
`operation-context` artifact (hard 8 KiB cap) instead of the index:

- identity: `id`, `key`, `symbol`, `kind`, `feature`, `source`;
- `http` (method, path, status, derived per-error `errorStatus`), `errors`
  (`[{code, http?}]`), `permissions`, `effects`, `events`, `ensures`, `tests`;
- `excerpts` — bounded source text (≤1 KiB each): the input/output schema
  declarations, the `execute` signature, per-error details declarations, and
  effect signatures. This makes one artifact a sufficient change context;
- `analysis` — `agentixValid`, `complete`, `sourceDigest`, diagnostics;
- `affected` and `verification` — conservative change scope and the
  narrowest safe commands;
- `projection.truncated` + `projection.omissions` — anything omitted for the
  byte cap, each with an exact next action (a source location or a command to
  run from the application root).

`inspect <feature>` returns the indexed feature (exports, dependencies,
consumers, operations, events, tests) plus `affected` and `verification`.
Port ids, port-operation ids, and event ids are also inspectable.
`inspect <operation> --full` returns the unbounded `operation-detail`.

## context

`agentix context <operation>` packs ONE `change-context` artifact with
everything a typical change needs — designed to REPLACE reading the feature
file and its test directly, not to add to those reads (for the sandbox notes
app the compact JSON costs fewer bytes than the two direct reads; a CLI test
enforces this):

- identity: `id`, `source` (`file:line`), `http` (method/path/status), the
  error/status table (`errors: [{code, http?}]`), and `permissions`/`events`/
  `ensures` when present (the operation kind is visible in the excerpt; the
  owning feature is the `id` prefix);
- `excerpt` — the operation's FULL `key: command({...})` declaration text,
  line-preserving but de-indented to column 0;
- `exports` — the feature file's public contract summary (its export names);
- `effects` (`alias=portOperationId`) plus `portSignatures`, the unique
  port-operation signature texts the effects resolve to;
- `tests` — every associated suite; the primary one (the smallest file,
  ties broken by path) embeds its full de-indented `source`, the rest are
  listed by `file` reference;
- `affected` — the conservative closure ids — and `verification`, the
  pasteable `typecheck`/`tests` commands from the narrowest safe plan;
- `writes` — the writes-recipe: the files a typical change edits, in order
  (the feature file, then the primary test);
- `projection` — present only when `--budget <bytes>` (default 16384,
  measured on the compact JSON) forced omissions; each omission carries an
  exact next action, exactly like `inspect`. Budgets below the smallest
  projection fail with an actionable error.

## graph

`agentix graph` prints the dependency graph (optionally scoped to a feature);
`--format json` emits `{schemaVersion:"2", edges}` with kinds
`feature-dependency`, `feature-operation`, `port-operation`,
`operation-effect`, `operation-event`, `operation-test`; `--format dot`
renders Graphviz input.

## affected

`agentix affected <feature-or-file>` computes the conservative closure from
the change target over the graph: operations, consumers, tests, with reasons
per item. Unresolved static edges inside an indexed feature seed that feature
into the closure (reason `conservative-widening`) while keeping the scope
narrow; unresolved edges outside any indexed feature widen to the whole
workspace (`widened: true`).

## verify

`agentix verify <target>` plans and runs verification, reporting each check:

- Narrow scope — when the closure is un-widened, there are no architecture
  errors, a tsconfig is found, and at least one associated test is selected:
  project-scoped `tsc -b` plus `vitest run <selected test files>`.
- Workspace scope otherwise (honors `package.json` `typecheck`/`test` scripts).

JSON output: `{schemaVersion:"2", target, passed, plan, diagnostics, checks:
[{command, status, stdout, stderr}]}`. `passed` requires zero architecture
errors and every command exiting 0.

## openapi

`agentix openapi` generates an OpenAPI 3.1 document (JSON only, deterministic
byte-for-byte) from the analyzed project: every operation with `http`
metadata becomes a path+method whose behavior mirrors the HTTP adapter:

- schemas come from static evaluation of the `s.*` expressions (including
  `record`, `tuple`, `union`, `literal`, `refine`, and `id`); strict objects
  emit `additionalProperties: false`. Anything not statically evaluable is
  documented permissively and reported as a warning on stderr;
- parameters mirror the adapter's default request mapper exactly: only
  object-shape input keys are read from path parameters and (for GET/DELETE)
  the query string, with string→number/boolean coercion, optional fields
  unwrapped; POST/PUT/PATCH inputs become the JSON `requestBody`;
- responses use the fixed envelope: `{ok:true, value}` on the success status
  (`http.status`, default 200) and per-status `{ok:false, error:{code,
  details}}` for the unified error declarations (`http`-less declarations
  land on the 422 default). Statuses the operation does not claim get the
  standard shapes: 400 `INVALID_INPUT`/`INVALID_JSON`, 403
  `PERMISSION_DENIED` (permissioned operations), 404 `NOT_FOUND`, 405
  `METHOD_NOT_ALLOWED`, 500 `INTERNAL` (as `components/responses` refs);
- `--bearer` declares the app-level bearer authentication choice: a
  `bearerAuth` security scheme applied to permissioned operations (their
  required permissions are listed in the operation description) plus their
  401 response; `--health <path>` documents the liveness endpoint;
- `--out <file>` writes the document (path resolved against the invocation
  directory) instead of printing it; `--compact` emits single-line JSON.

Runtime-only configuration (`defineHttpRoute` overrides, custom
`authenticate` hooks) is invisible to static analysis and absent from the
document.

## scaffold

`agentix scaffold feature <name>` writes the single-file v2 layout directly
into `src/features/`: one feature file (schema + store port + create/get
operations with unified errors and routes) and one colocated test.

```json
{
  "schemaVersion": "2",
  "dryRun": false,
  "feature": "invoices",
  "files": ["src/features/invoices.test.ts", "src/features/invoices.ts"],
  "nextActions": ["..."]
}
```

`--dry-run` prints without writing. Names are lowercase kebab-case.

## mcp

`agentix mcp` serves the commands above as a stdio [MCP](https://modelcontextprotocol.io)
server so coding agents can call them as tools. Register it with Claude Code
from the application root (requires `@agentixdev/cli` installed there):

```sh
claude mcp add agentix -- npm exec -- agentix mcp --root .
```

- Tools `inspect`, `context`, `graph`, `affected`, `verify`, `scaffold`, and
  `openapi` are thin wrappers over the identical CLI implementations: each
  call returns the command's `--json --compact` output as one text content
  block. Tool descriptions carry the byte budgets and cost notes (`context`
  replaces file reads; `verify` runs subprocesses) agents need to pick the
  cheapest sufficient artifact.
- `--root` is fixed when the server starts. Every tool call re-validates
  `.agentix/index.json` through the digest fast path, so sources edited
  mid-session are re-analyzed automatically on the next call.
- Failures — unknown ids, invalid arguments, failed verification — come back
  as `isError` tool results carrying the CLI's error text; a tool call never
  takes the server down. `openapi` schema-degradation warnings arrive as a
  second text content block after the document.

## Architecture diagnostics

Analysis emits diagnostics with stable codes; `verify` fails on `error`
severity:

- `architecture.private-cross-feature-import` — cross-feature imports must
  target the other feature's feature file (the file IS the public contract);
- `architecture.one-feature-per-file` — each file declares exactly one
  `feature()`; a second declaration in the same file is an error (imports of
  the file would be ambiguous);
- `architecture.ambient-fetch|time|randomness|environment|filesystem|database`
  — ambient capabilities inside `src/features/` (all non-test files);
- `architecture.unresolved-dynamic-import`;
- `operation.query-write-effect`, `operation.query-emits-event`;
- `metadata.*` — descriptors must be statically analyzable (literal ids,
  inline or same-file `command()`/`query()` calls, `Port.opName` effect
  references). Spread or computed members in an `operations` literal (feature
  or port) emit `metadata.static-operation-required` errors; spreads inside
  `effects`/`emits` emit warning-severity `metadata.static-effect-required` /
  `metadata.static-emit-required`. All of these also record an unresolved
  entry so `affected`/`verify` widen the owning feature's subgraph
  conservatively instead of silently omitting the hidden declarations.

## Index shape (schema version 2)

`.agentix/index.json`: `{schemaVersion:"2", compilerVersion, sourceManifest,
features, operations, ports, events, tests, edges, diagnostics, unresolved}`.
Operations carry derived ids (`feature.key`), schema excerpts (with a
statically evaluated `description` tree when the `s.*` expression is
analyzable), unified errors (`[{code, http?, details?, detailsDescription?}]`),
`http` with derived `errorStatus`, effects, events, ensures names,
`executeSignature`, and the full de-indented `declarationText` (≤8 KiB).
Single-file features claim the
name up to the first dot: `src/features/notes.ts`, dotted siblings such as
`notes.helpers.ts`, colocated tests (`notes.test.ts`,
`notes.integration.test.ts`), and the directory form `notes/` all map to the
same feature segment `notes`.

Prefer the CLI to reading the index; the `@agentixdev/compiler` package exposes
the same data programmatically (`generateIndex`, `computeAffected`,
`planVerification`, `createOperationContext`, `createChangeContext`,
`createOpenApiDocument`).
