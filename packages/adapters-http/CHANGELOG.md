# @agentixdev/adapters-http

## 0.2.0

### Minor Changes

- 6443b3a: Agent-first v2: single-file feature authoring with derived registration, and a
  faster runtime. Breaking pre-1.0 API change.

  - One feature per file: `feature(id, { operations })` derives operation ids
    (`featureId.key`), required ports, and HTTP routes from operation
    descriptors. `defineFeatureContract`, `defineFeature`, `defineCommand`,
    `defineQuery`, `definePort`, `defineEvent`, `defineInvariant`, `bindPort`,
    and all aliases are removed in favor of `feature`/`command`/`query`/`port`/
    `event` plus per-operation `ensures`.
  - Effects hand adapters' plain return values to `execute`; declared domain
    failures are raised with the injected typed `fail(code, details)`. Errors
    declare code, HTTP status, and details schema once:
    `errors: { CODE: { http, details } }`.
  - `port.store(id, schema)` ships a CRUD port preset with a built-in
    `.memory()` adapter. `createApplication` gains `authorize`, NODE_ENV-derived
    `mode`, and `app.call()` returning an `Outcome`; `app.authorize` exposes the
    effective permission gate.
  - HTTP: routes auto-derive from operation `http` metadata; the handler exposes
    `fetch` (edge) and `handle` (runtime-neutral); `serveNode` serves compiled
    routes on raw req/res. Fixed JSON response envelope
    (`{ok: true, value} | {ok: false, error}`); authoring statuses restricted to
    200..599 excluding 204/205/304.
  - Compiler/CLI understand the v2 shape: single-file feature segments, bounded
    source excerpts in `inspect` artifacts, narrow `verify` plans for
    workspace-root vitest configs, deterministic locale-independent index
    ordering, conservative widening for spread/computed descriptor members.
  - Testing: `createTestApplication` (auto-faked ports, deterministic clock/ids)
    and `testHttp`; replay harness removed.
  - Every runtime mode validates effect outputs and detaches them (production
    differs from dev/test only in freezing, event deep-freeze, and `ensures`
    execution).

- 2973515: Production runtime and agent-leverage features on top of the v2 authoring
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

### Patch Changes

- Updated dependencies [6443b3a]
- Updated dependencies [2973515]
  - @agentixdev/core@0.2.0

## 0.1.0

### Minor Changes

- 7ec1fb5: Publish the first public Agentix framework packages with coordinated versions,
  package metadata, provenance, and automated release management.

### Patch Changes

- Updated dependencies [7ec1fb5]
  - @agentix/core@0.1.0
