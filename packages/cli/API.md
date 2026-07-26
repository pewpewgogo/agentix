# `@agentix/cli` API

Every public export, one line each. Command surface and artifact shapes: the
repository's `docs/CLI.md`.

## Binary

- `agentix` — `inspect`, `graph`, `affected`, `verify`, `scaffold feature`, `help`; common flags `--root <dir>`, `--json`, `--compact`; `inspect --full`, `graph --format text|json|dot`, `scaffold --dry-run`.

## Programmatic

- `runCli(argv, {cwd?, io?, runProcess?}?): Promise<number>` — the binary's exact contract with injectable cwd, IO, and process runner (for tests).
- `ExitCode` — `{success: 0, verificationFailure: 1, invalidInvocation: 2, internalFailure: 3}`.
- Types: `CliDependencies` (`{cwd?, io?, runProcess?}`), `CliIO` (`{out, error}` writers), `ProcessResult` (`{status, stdout, stderr}`), `ProcessRunner` (`(command, args, cwd) => ProcessResult`).

All JSON artifacts are `schemaVersion: "2"`; `inspect <operation>` emits the
compiler's `OperationContext`, `inspect --full` an `OperationDetail`,
`scaffold` `{schemaVersion, dryRun, feature, files, nextActions}`.
