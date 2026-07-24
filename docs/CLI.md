# CLI and Generated Index

The `agentix` CLI answers maintenance questions by analyzing TypeScript source
into a deterministic projection. It writes `.agentix/index.json` for discovery,
but never trusts that generated file as command input. The index is not used by
runtime dispatch and never overrides source.

## Run the repository-local CLI

Agentix is not published, so build and invoke the workspace binary from a clone:

```sh
npm ci
npm run build
npm exec -- agentix help
```

Use `--root` to select the application to analyze:

```sh
npm exec -- agentix inspect orders.create --root examples/framework-app
```

`--root` is accepted by every command. Paths in output are normalized relative
to that root.

## `inspect`

```text
agentix inspect <feature-or-operation> [--json [--compact]] [--root <directory>]
agentix inspect <operation> --full [--json [--compact]] [--root <directory>]
```

Feature output includes its source, dependencies, consumers, operations,
invariants, tests, affected closure, and verification plan. Operation output
includes schemas, permissions, errors, effects, events, invariants, tests, and
source location. It is a bounded `operation-context` projection, not the full
generated index. Ports, port operations/effect IDs, events, and invariants can
also be inspected by stable ID, with the smaller metadata surface available for
each kind. `agentix --help` and `<command> --help` print the full command surface
without analyzing an application.

```sh
npm exec -- agentix inspect orders.create --root examples/framework-app
npm exec -- agentix inspect orders.create --root examples/framework-app \
  --json --compact
```

`--compact` requires `--json` and emits the same deterministic artifact as
single-line JSON. It is intended for agent prompts and machine transport where
formatting bytes are pure context overhead. Plain `--json` remains indented for
people, logs, and diffs. The flag is available on every command that supports
JSON output.

Structured operation output carries `schemaVersion: "1"`,
`artifactKind: "operation-context"`, the source-manifest digest, project and
target Agentix diagnostics, completeness, affected scope, and verification
commands. `analysis.typecheck` is always `"not-run"`: inspect never executes or
records `tsc`. `verify` performs typechecking and returns a separate result.

The serialized operation artifact has a hard 8 KiB limit. `projection.truncated`
is never silent: every omitted collection records its total/included counts and
either an exact source location or an `npm exec -- agentix` expansion command
with its required cwd. Workspace-widened affected sets carry totals and
kind-counts rather than enumerating the whole repository. Runnable verification
commands are never truncated; the plan widens to workspace verification if a
narrow command cannot be represented safely.

`--full` is an explicit, unbounded expansion for one operation only. It returns
`artifactKind: "operation-detail"` with the complete operation metadata, target
diagnostics/unresolved entries, and verification plan. Default agent entry
should remain the bounded context; use the exact `--full` command supplied by an
omission when the missing collection is material.

## `graph`

```text
agentix graph [<feature>] [--format text|json|dot] [--root <directory>]
```

Without a feature, `graph` emits the complete indexed graph. A feature argument
selects related dependency, operation, effect, event, invariant, and test edges.

```sh
npm exec -- agentix graph orders --root examples/framework-app
npm exec -- agentix graph orders --root examples/framework-app --format dot \
  > orders.dot
```

DOT generation has no Graphviz runtime dependency; rendering the file is a
separate user choice.

## `affected`

```text
agentix affected <feature-or-file> [--json [--compact]] [--root <directory>]
```

`affected` returns the conservative closure for any indexed feature, operation,
port operation, port, event, invariant, test, or repository-relative file.
Every selected item contains reasons. Unknown ownership, configuration changes,
and unresolved relationships widen the result rather than claiming an unsafe
narrow scope.

```sh
npm exec -- agentix affected src/features/orders/operations.ts \
  --root examples/framework-app
```

Check `widened` in JSON output before using the result to select automated work.

## `verify`

```text
agentix verify <feature-or-operation> [--json [--compact]] [--root <directory>]
```

`verify`:

1. reanalyzes source and writes the generated index;
2. rejects architecture errors;
3. computes a verification plan;
4. runs the planned typecheck; and
5. runs the planned tests if typechecking passed.

The planner narrows only when project references and associated tests prove a
smaller scope safe. Otherwise it calls the application's workspace-level
`npm run typecheck` and `npm test` scripts.

```sh
npm exec -- agentix verify orders.create --root examples/framework-app
```

`--json` keeps the summary on stdout and embeds subprocess results. Human mode
streams command output and diagnostics normally.

## `scaffold feature`

```text
agentix scaffold feature <lowercase-kebab-name> [--dry-run] [--json [--compact]] [--root <directory>]
```

The command creates this conventional skeleton under `src/features/<name>`:

```text
contract.ts
feature.ts
<name>.test.ts
```

Preview first:

```sh
npm exec -- agentix scaffold feature shipping \
  --root path/to/your-app --dry-run
```

The default is intentionally minimal: it does not create empty model,
operations, or invariant modules. Structured output includes `nextActions` with
registration plus pasteable `npm exec` inspection and verification commands;
they `cd` to the selected `--root` first. The scaffold refuses to
overwrite an existing feature directory. It does not register the feature in
application assembly, define business operations, or choose adapters; those
changes remain explicit.

## Index refresh behavior

There is no `agentix generate` command. `inspect`, `graph`, `affected`, and
`verify` reanalyze source and write `.agentix/index.json`. They do not accept a
same-version cache as authority, even when its source digest looks current.
These read-looking commands can therefore update that ignored generated file.

For programmatic generation:

```ts
import { generateIndex } from "@agentix/compiler";

const { index, json, outputFile } = generateIndex({
  rootDir: "/absolute/path/to/application",
  write: true,
});
```

Generation returns an index even when it contains diagnostics. Call
`checkArchitecture`, inspect `index.diagnostics`, or use `agentix verify` when
errors must fail the workflow.

## Static-analysis conventions

For predictable indexing:

- place features under `src/features/<feature>/...`;
- declare descriptors as named variables initialized directly with
  `defineFeature`, `defineCommand`, `defineQuery`, `definePort`, `defineEvent`,
  or `defineInvariant`;
- use literal stable IDs and static object/array metadata;
- keep cross-feature imports on `contract.ts` public surfaces; and
- use `defineOperationTest` or `associateOperationTest` for precise test links.

The compiler is conservative static analysis, not TypeScript execution. Dynamic
construction or indirection can be unresolved and widen verification. The
index currently models feature dependencies, operations, port operations,
events, invariants, and tests; it does not claim complete runtime call-graph or
event-consumer analysis.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Verification failed |
| 2 | Invalid invocation or unknown target |
| 3 | Internal CLI failure |

Programmatic consumers can import `runCli` and `ExitCode` from `@agentix/cli`
and inject I/O or a process runner for deterministic tests.

## Generated-file policy

`.agentix/index.json` is an ignored generated artifact. Its source manifest is
embedded in the index, but the CLI still derives every answer from source. Do
not hand-edit or review it as source; regenerate from TypeScript and diagnose
any mismatch through the compiler or CLI.
