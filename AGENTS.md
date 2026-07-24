# Agentix agent entry

Agentix is a research-stage TypeScript framework for bounded codebase maintenance.
TypeScript source is authoritative; `.agentix/index.json` is an ignored,
disposable output and is never trusted as CLI input.

## Start with bounded context

```sh
npm ci
npm run build
npm exec -- agentix inspect <operation-id> --root <application> --json --compact
```

For an operation, `inspect` returns an `operation-context` artifact rather than
the full index. Check these fields before editing:

- `analysis.agentixValid` — Agentix architecture and metadata diagnostics only;
- `analysis.complete` — whether static relationships were resolved;
- `analysis.typecheck` — inspect always reports `not-run`; `verify` returns a
  separate `tsc` result;
- `analysis.sourceDigest` — binds the artifact to the inspected source tree;
- `projection.truncated` and `projection.omissions` — whether the 8 KiB artifact
  summarized anything and how to expand it safely; and
- `affected` plus `verification` — conservative change and test scope.

Do not paste or read the full generated index when an inspect artifact answers
the task. If context is invalid/incomplete, run
`npm exec -- agentix verify <id>` and widen inspection instead of assuming a
narrow scope. Run omission commands from the declared `application-root` cwd.

## Repository map

- `packages/core` — schemas, descriptors, outcomes, application dispatch.
- `packages/compiler` — static architecture analysis and context projection.
- `packages/cli` — inspect, graph, affected, verify, and scaffold UX.
- `packages/testing` — deterministic harnesses, contracts, traces, replay.
- `packages/adapters-http` — Web HTTP adapter and optional Node host.
- `examples/framework-app` — parity-tested commerce application.
- `benchmarks` — historical evidence and isolated maintenance harnesses.

## Non-negotiable boundaries

- Keep application behavior in ordinary TypeScript and dependencies explicit.
- Use declared `Outcome` values for expected domain failures.
- Domain code receives only declared effects; do not add ambient I/O, clocks,
  randomness, environment access, or global registries.
- Queries do not declare write effects or emit events.
- Emitted events are dispatch data, not delivery, persistence, or an outbox.
- Compensation and transaction semantics stay explicit in application code.
- Relative NodeNext imports use `.js` suffixes.
- Never hand-edit generated indexes or benchmark result evidence.

The frozen v1 benchmark reads source from its pinned Git revision. Do not refresh
v1 entry hashes to make product changes pass; create a new intervention for a new
study corpus.

## Verification

Use a targeted workspace command while iterating, then before handoff run:

```sh
npm run build
npm run verify
npm run benchmark:corpus:check
git diff --check
```

Run acceptance tests when behavior or adapters change. Update the public guide
and API reference whenever a public shape, default, or command output changes.
