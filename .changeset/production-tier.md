---
"@agentix/core": minor
"@agentix/compiler": minor
"@agentix/cli": minor
"@agentix/testing": minor
"@agentix/adapters-http": minor
---

Production runtime and agent-leverage features on top of the v2 authoring
model.

- Core: `DispatchObserver` (span-token threading, per-dispatch and per-effect
  durations, zero cost when unconfigured), dispatch `signal`/`meta` with
  `DISPATCH_ABORTED`, per-effect `timeoutMs` with linked `AbortSignal` and
  `EFFECT_TIMEOUT`, `subscription()` in-process event delivery, adapter
  `init`/`dispose` hooks with idempotent `app.start()`/`app.close()`
  (`APPLICATION_CLOSED`), `s.record`/`s.tuple`, `preset` tag on `port.store`
  operations.
- HTTP: per-request `x-request-id` (adopted or minted) on every response and
  in dispatch meta, `health` path, CORS with preflight, `responseHeaders`
  hook, `cookie(name)` auth accessor, `serveNode` graceful drain
  (`gracefulTimeoutMs`, `closeApplication`) and client-abort wiring; authored
  statuses restricted to envelope-compatible codes.
- CLI: `agentix openapi` (deterministic OpenAPI 3.1 from descriptors),
  `agentix context` (one-artifact change pack costing less than reading the
  files it replaces), `agentix mcp` (stdio MCP server exposing all tools).
- Testing: exact store-preset detection, harness `reset()`, transparent
  user-adapter call recording, observer/subscriber forwarding, `started()`.
- Platform: Node `>=22.12.0 <25`; `typescript/unstable/sync` behind an
  actionable guard with an exact 7.0.2 pin.
