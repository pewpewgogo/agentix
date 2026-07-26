# `@agentix/cli`

The `agentix` command for [Agentix](https://pewpewgogo.github.io/agentix/)
applications: bounded inspection artifacts, dependency graphs, conservative
affected scope, narrow verification, and single-file feature scaffolding.

```sh
npm install --save-dev @agentix/cli
```

Agentix is research-stage, ESM-only, and pre-1.0.

## Example

```sh
# Scaffold one feature: src/features/invoices.ts + src/features/invoices.test.ts
npm exec -- agentix scaffold feature invoices --root .

# Bounded change context for one operation (<= 8 KiB, with source excerpts)
npm exec -- agentix inspect invoices.create --root . --json --compact

# Conservative closure and the narrowest safe checks for a change
npm exec -- agentix affected src/features/invoices.ts --root .
npm exec -- agentix verify invoices.create --root .
```

`inspect <operation> --json` returns an `operation-context` artifact: route,
unified errors with statuses, permissions, effects, tests, bounded source
excerpts (schemas, `execute` signature), the `affected` closure, the
`verification` plan, and a `projection.omissions` ledger with an exact next
action for anything the byte cap excluded. `verify` runs the plan and reports
each command; exit codes are `0` success, `1` verification failure,
`2` invalid invocation, `3` internal failure.

`.agentix/index.json` is a cache keyed by a source digest: served as-is while
the digest matches, re-analyzed and rewritten otherwise. It is never a runtime
input and never overrides TypeScript source.

The CLI is also programmable:

```ts
import { ExitCode, runCli } from "@agentix/cli";

const exitCode = await runCli(["inspect", "notes.create", "--json", "--compact"], {
  cwd: "/path/to/application",
});
if (exitCode !== ExitCode.success) process.exitCode = exitCode;
```

## Docs

- [API.md](API.md) — every export, one-line signatures (shipped with the package).
- [CLI guide](https://pewpewgogo.github.io/agentix/CLI.html) — every command,
  flag, and JSON artifact shape.
