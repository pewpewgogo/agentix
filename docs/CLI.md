# CLI and Generated Index

The `agentix` CLI answers maintenance questions from static analysis of
TypeScript source. `.agentix/index.json` is a cache keyed by a deterministic
source digest: commands serve it while the digest matches and silently
re-analyze (rewriting it) when anything is stale, missing, or malformed. It is
not a signed artifact and is never used by runtime dispatch.

```sh
npm install --save-dev @agentix/cli
npm exec -- agentix help
```

All commands accept `--root <directory>` (the application to analyze),
`--json` (stable machine output) and `--compact` (single-line JSON). Exit
codes: `0` success, `1` verification failure, `2` invalid invocation,
`3` internal failure.

```text
agentix inspect <feature-or-operation> [--json [--compact]] [--root <directory>]
agentix inspect <operation> --full [--json [--compact]] [--root <directory>]
agentix graph [<feature>] [--format text|json|dot] [--root <directory>]
agentix affected <feature-or-file> [--json [--compact]] [--root <directory>]
agentix verify <feature-or-operation> [--json [--compact]] [--root <directory>]
agentix scaffold feature <name> [--dry-run] [--json [--compact]] [--root <directory>]
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

## Architecture diagnostics

Analysis emits diagnostics with stable codes; `verify` fails on `error`
severity:

- `architecture.private-cross-feature-import` — cross-feature imports must
  target the other feature's feature file (the file IS the public contract);
- `architecture.ambient-fetch|time|randomness|environment|filesystem|database`
  — ambient capabilities inside `src/features/` (all non-test files);
- `architecture.unresolved-dynamic-import`;
- `operation.query-write-effect`, `operation.query-emits-event`;
- `metadata.*` — descriptors must be statically analyzable (literal ids,
  inline or same-file `command()`/`query()` calls, `Port.opName` effect
  references).

## Index shape (schema version 2)

`.agentix/index.json`: `{schemaVersion:"2", compilerVersion, sourceManifest,
features, operations, ports, events, tests, edges, diagnostics, unresolved}`.
Operations carry derived ids (`feature.key`), schema excerpts, unified errors
(`[{code, http?, details?}]`), `http` with derived `errorStatus`, effects,
events, ensures names, and `executeSignature`. Single-file features map
`src/features/notes.ts`, `notes.test.ts`, and `notes/` to the same feature
segment.

Prefer the CLI to reading the index; the `@agentix/compiler` package exposes
the same data programmatically (`generateIndex`, `computeAffected`,
`planVerification`, `createOperationContext`).
