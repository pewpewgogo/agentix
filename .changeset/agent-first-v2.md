---
"@agentixdev/core": minor
"@agentixdev/compiler": minor
"@agentixdev/cli": minor
"@agentixdev/testing": minor
"@agentixdev/adapters-http": minor
---

Agent-first v2: single-file feature authoring with derived registration, and a
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
