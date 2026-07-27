# Agentix agent entry

Agentix is a research-stage TypeScript framework for bounded codebase
maintenance. TypeScript source is authoritative. `.agentix/index.json` is a
cache keyed by a deterministic source digest: the CLI serves it while the
digest matches and re-analyzes otherwise; it is never a runtime input and
never overrides source.

## Start with bounded context

```sh
npm ci
npm run build
npm exec -- agentix inspect <operation-id> --root <application> --json --compact
```

For an operation, `inspect` returns a bounded `operation-context` artifact
(<= 8 KiB), not the full index. It contains the route, unified errors with
HTTP statuses, permissions, effects, tests, bounded source excerpts (input/
output schemas, `execute` signature), plus:

- `analysis.agentixValid` / `analysis.complete` — diagnostics and resolution;
- `analysis.sourceDigest` — binds the artifact to the inspected tree;
- `projection.truncated` + `projection.omissions` — what the byte cap
  excluded, each with an exact next action (run from the application root);
- `affected` + `verification` — conservative change scope and the narrowest
  safe typecheck/test commands.

Do not read the full generated index when an inspect artifact answers the
task. If context is invalid or incomplete, run
`npm exec -- agentix verify <id>` and widen inspection instead of assuming a
narrow scope. Before editing any feature, read `docs/AUTHORING.md` — a change
is normally 2 files: `src/features/<name>.ts` and `src/features/<name>.test.ts`.

## Single-file feature layout

One feature = one file. The feature file is the public contract: schema(s),
`port.store`/`port(...)` declarations, and `feature(id, { operations })` with
inline `command()`/`query()` calls. Operation ids derive as
`${featureId}.${key}`; routes derive from `http` metadata; required adapters
derive from `effects`. The app shell (`createApplication` +
`createHttpHandler`) changes only when a feature or port is added.
`agentix scaffold feature <name>` emits the canonical two files.

## Repository map

- `packages/core` — schemas (`s`), `command/query/feature/port/event`, dispatch.
- `packages/adapters-http` — auto-derived routes, fixed envelope, Node/edge hosts.
- `packages/testing` — `createTestApplication`, `testHttp`, harnesses, contracts.
- `packages/compiler` — static analysis, index, affected scope, context artifacts.
- `packages/cli` — `inspect`, `graph`, `affected`, `verify`, `scaffold`.
- `examples/framework-app` — parity-tested commerce application.
- `examples/pg-notes` — PostgreSQL-backed notes service; the persistence
  reference (`docs/PERSISTENCE.md`).
- `sandbox/` — three-arm notes apps for token/perf comparison.
- `benchmarks` — frozen evidence and isolated maintenance harnesses.

## Non-negotiable boundaries

- Application behavior stays in ordinary TypeScript; dependencies explicit.
- Declared domain failures go through the operation `errors` map and
  `fail(code, details)`; `fail` returns, it does not throw.
- Domain code receives only declared effects; no ambient I/O, clocks,
  randomness, environment access, or global registries in `src/features/`.
- Adapters return plain values or throw; expected alternatives belong in the
  port operation's output schema.
- Queries do not declare write effects or emit events.
- Cross-feature imports target the other feature's feature file only.
- Emitted events are dispatch data, not delivery, persistence, or an outbox.
- Compensation and transaction semantics stay explicit in application code.
- Relative NodeNext imports use `.js` suffixes.
- Never hand-edit benchmark result evidence; never refresh frozen v1
  benchmark entry hashes — new corpus means new intervention files.

## Verification

While iterating, use the narrow plan from `agentix verify <target>`. Before
handoff run:

```sh
npm run build
npm run verify
npm run benchmark:corpus:check
git diff --check
```

Run the acceptance suite (both `mode: "test"` and `mode: "production"`) when
behavior or adapters change. Update `docs/` and the affected package
`README.md`/`API.md` whenever a public shape, default, or command output
changes.
