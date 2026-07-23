# CLI and Generated Index

The `agentix` CLI answers maintenance questions from TypeScript source and a
deterministic `.agentix/index.json` projection. The index accelerates discovery;
it is never used by runtime dispatch and never overrides source.

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
agentix inspect <feature-or-operation> [--json] [--root <directory>]
```

Feature output includes its source, dependencies, consumers, operations,
invariants, tests, affected closure, and verification plan. Operation output
includes schemas, permissions, errors, effects, events, invariants, tests, and
source location. Ports, events, and invariants can also be inspected by stable
ID, with the smaller metadata surface available for each kind.

```sh
npm exec -- agentix inspect orders.create --root examples/framework-app
npm exec -- agentix inspect orders.create --root examples/framework-app --json
```

Structured output carries `schemaVersion: "1"` and is suitable for tools and
coding-agent context.

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
agentix affected <feature-or-file> [--json] [--root <directory>]
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
agentix verify <feature-or-operation> [--json] [--root <directory>]
```

`verify`:

1. refreshes the index when stale;
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
agentix scaffold feature <lowercase-kebab-name> [--dry-run] [--root <directory>]
```

The command creates this conventional skeleton under `src/features/<name>`:

```text
contract.ts
model.ts
operations.ts
invariants.ts
feature.ts
<name>.test.ts
```

Preview first:

```sh
npm exec -- agentix scaffold feature shipping \
  --root path/to/your-app --dry-run
```

The scaffold refuses to overwrite an existing feature directory. It does not
register the feature in application assembly, define business operations, or
choose adapters; those changes remain explicit.

## Index refresh behavior

There is no `agentix generate` command. `inspect`, `graph`, `affected`, and
`verify` load the index and automatically write `.agentix/index.json` when it is
missing or stale. These read-looking commands can therefore update that ignored
generated file.

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
embedded in the index. Do not hand-edit or review it as source; regenerate from
TypeScript and diagnose any mismatch through the compiler or CLI.
