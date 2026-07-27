# `@agentix/cli` API

Every public export, one line each. Command surface and artifact shapes: the
repository's `docs/CLI.md`.

## Binary

- `agentix` — `inspect`, `context`, `graph`, `affected`, `verify`, `openapi`, `scaffold feature`, `mcp`, `help`; common flags `--root <dir>`, `--json`, `--compact`; `inspect --full`, `context --budget <bytes>`, `graph --format text|json|dot`, `openapi --bearer --health <path> --out <file>`, `scaffold --dry-run`; `mcp` takes only `--root`.

## Programmatic

- `runCli(argv, {cwd?, io?, runProcess?, startMcpServer?}?): number` — the binary's exact contract with injectable cwd, IO, process runner, and MCP starter (for tests).
- `ExitCode` — `{success: 0, verificationFailure: 1, invalidInvocation: 2, internalFailure: 3}`.
- `createMcpServer(rootDir): Server` — the `agentix mcp` server for one fixed application root: tools `inspect`, `context`, `graph`, `affected`, `verify`, `scaffold`, `openapi` as thin CLI wrappers returning compact JSON text results (`isError` + the CLI's error text on failure); connect it to any `@modelcontextprotocol/sdk` transport.
- `startMcpServer(rootDir): Promise<void>` — connects a `createMcpServer` instance to stdio; what `agentix mcp` runs.
- Types: `CliDependencies` (`{cwd?, io?, runProcess?, startMcpServer?}`), `CliIO` (`{stdout, stderr}` writers), `ProcessResult` (`{status, stdout, stderr}`), `ProcessRunner` (`(command, args, cwd) => ProcessResult`).

All JSON artifacts are `schemaVersion: "2"`; `inspect <operation>` emits the
compiler's `OperationContext`, `inspect --full` an `OperationDetail`,
`context` a byte-budgeted `ChangeContext` (the one-artifact change pack that
replaces reading the feature file and its primary test), `openapi` a
deterministic OpenAPI 3.1 document, `scaffold`
`{schemaVersion, dryRun, feature, files, nextActions}`.
