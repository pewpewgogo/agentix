# Agentix v2 — FINAL implementation spec (validated)

This spec supersedes design-v2.md. It folds in three adversarial validation verdicts
(scratchpad/verdict-*.json) whose amendments were verified with the repo's tsc 7.0.2 and
microbenchmarks on this machine. Companion artifacts:
- `scratchpad/verified-d1-type-signatures.ts` — WORKING generic signatures (checked with tsc 7.0.2).
  Follow these patterns exactly; three naive alternatives were reproduced as broken.
- `scratchpad/v2-amended/src/**` — the target sandbox notes-app, measured at 2,974–3,195 chars
  (Express arm: 3,118). This is the acceptance target for authoring density.
- `scratchpad/verdict-migration-risk-performance-rea.json` — measured perf budget + migration list.

Repo root (worktree): /Users/mac/WebstormProjects/agentix/.claude/worktrees/agent-first-framework-overhaul
Rules that always apply: relative NodeNext imports use `.js` suffixes; never touch frozen v1
benchmark evidence (append-only results, new files only); TypeScript source is source of truth.

## 0. Goals and acceptance criteria

1. Agent-first: add-an-endpoint in sandbox notes-app = 2 files WRITTEN (feature file + test),
   2 files READ. Verified by the new change-cost scenario in token-budget.
2. Token: v2 notes-app full-src chars ≤ Express arm (like-for-like tests).
3. Perf: Agentix median HTTP latency ≤ Express AND ≤ NestJS on the comparison workloads
   (same-process method AND isolated-process method).
4. General-purpose: NestJS-class coverage for HTTP APIs (validation, typed errors, auth,
   DI-by-adapters, testing) — not decorators/middleware parity.
Final gates: `npm run build && npm run verify` green; acceptance suite green in BOTH
mode:"test" and mode:"production"; benchmarks re-run with new v2 result files.

## 1. Core authoring API (@agentix/core)

One feature = one file. Exact target shape (from v2-amended, THE canonical example):

```ts
import { command, feature, port, query, s } from "@agentix/core";

export const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});
export type Note = s.Infer<typeof Note>;

export const NoteStorage = port.store("noteStorage", Note);

export const notes = feature("notes", {
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: { NOTE_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStorage.get, save: NoteStorage.save },
      async execute({ input, effects, fail }) {
        if (await effects.load(input.id)) return fail("NOTE_ALREADY_EXISTS", { id: input.id });
        return effects.save(input);
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStorage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
  },
});
```

Note the error form UNIFIES code, HTTP status, and details schema in ONE declaration
(amendment A7): `errors: { CODE: { http?: number, details?: Record<string, Schema> | Schema } }`.
A bare Schema value is also accepted as shorthand for `{ details }`. `fail(code, details)` is
injected into execute, typed against the op's errors map, and returns a value execute returns
(internally an Outcome failure — `fail` RETURNS, it does not throw).

### Factories (exactly one name per concept — delete all aliases)

- `command({input, output, errors?, permissions?, http?, effects?, emits?, ensures?, execute})`
  → UnboundOperation (id-less). `query(...)` same minus emits, write effects rejected at type
  level AND runtime (keep the existing WithoutWriteEffects conditional-guard pattern).
- `feature(id, {operations, events?})` → FeatureDescriptor. Operation ids DERIVED:
  `${featureId}.${key}` via template-literal mapped types (see verified signatures:
  BindOperations). No `ports:` list — required ports are derived from operation effects.
  No defineFeatureContract. Feature deps are implicit via imports.
- `port(id, {opName: port.read({input, output}) | port.write(...) | port.time(...) |
  port.random(...) | port.external(...)})` → PortDescriptor with ops addressable as
  `Port.opName` (amendment A4; reserve/collide-check against port's own keys: id, adapter,
  operations). Port ops declare input/output ONLY — no error channel. Expected alternative
  results are modeled in the output schema (unions); unexpected adapter failures throw →
  dispatch fault EFFECT_FAILURE.
- `port.store(id, objectSchema)` → CRUD preset requiring shape.id: ops get(input: idSchema,
  output: optional(schema)), save(write, input: schema, output: schema), delete(write,
  input: idSchema, output: s.boolean()), list(read, input: s.object({}), output:
  s.array(schema)); PLUS `.memory()` returning a built-in Map-backed adapter.
- `Port.adapter(impl)` → BoundPortAdapter (NON-generic return, verified requirement).
  Impl functions return PLAIN VALUES or throw (no Outcome wrapping) — amendment A1.
- `event(id, version, payloadSchema)` → EventDescriptor (positional args).
- Invariants: `ensures: { name: { evidence?: Schema, check(ctx): boolean } }` on the operation,
  EXECUTED after successful completion in dev/test modes only (fault INVARIANT_VIOLATION on
  false). Standalone defineInvariant is DELETED.
- DELETED from public surface: defineCommand/defineQuery/defineFeature/definePort/defineEvent/
  defineInvariant/defineFeatureContract/defineContract/defineAdapter/bindPort/portOperation
  aliases, FeatureContract, domainError as an app-facing requirement. `ok/err/matchOutcome`
  remain exported (adapters/tests may use them) but app code shouldn't need them.

### Typing (follow verified-d1-type-signatures.ts EXACTLY)

- command/query return UnboundOperation<Kind, Input, Output, Errors, Effects, Emits>;
  feature() binds ids: BindOperations<FeatureId, Ops> with `${FeatureId}.${K}` literal ids.
  Same pattern for ports (`${PortId}.${K}`).
- Collections typed as `const Ops extends Readonly<Record<string, unknown>>` PLUS an
  `Ops & ValidOperations<Ops>` parameter intersection — never a bare
  `Record<string, AnyUnboundOperation>` constraint (poisons omitted optional fields:
  errors would infer as ErrorSchemaMap instead of never — reproduced bug).
- Handler-mapped types keep conditional guards:
  `{ [N in keyof Effects]: Effects[N] extends AnyPortOperation ? EffectHandler<Effects[N]> : never }`
  — load-bearing for assignability under strictFunctionTypes. execute stays METHOD syntax.
- `http` on the DESCRIPTOR is variance-neutral (Readonly<Record<string, number>> for statuses);
  the `keyof Errors` checking lives ONLY in the authoring parameter type.
- Application: `Application<Ops>` with Ops unconstrained;
  ApplicationOperations<Features> = UnionToIntersection of per-feature id-keyed records;
  dispatch/call typed via guarded helpers OpInput/OpOutput/OpError.

### Runtime (createApplication + dispatch)

```ts
const app = createApplication({
  features: [notes],
  adapters: [NoteStorage.memory()],
  mode?: "production" | "development" | "test",  // default from NODE_ENV (A6)
  authorize?: (principal, operation) => boolean,  // optional custom hook; default permission-subset
});
```

- Startup validation (keep): duplicate ids, adapter coverage for every port op reachable from
  effects, query-purity, http route conflicts (also validated here: duplicate method+path).
- `app.dispatch(opOrId, {input, principal?, trace?})` → Promise<DispatchResult> — UNCHANGED
  3-way semantics (completed/rejected/fault), events, optional trace. Adapter/testing surface.
- NEW `app.call(id, input, opts?)` → Promise<Outcome<Output, Error>> (A9): sugar over dispatch;
  rejections and faults THROW DispatchError{kind, code}; completed → outcome. App/test surface.
- NEW export `authorize(operation, principal)` — the single permission gate, used by dispatch
  AND callable by HTTP adapter BEFORE body read (risk amendment; keeps 403-before-body-parse).
- `permissions` optional: absent ⇒ no principal required, anonymous OK (A2).
- Events: `emits: {name: eventDescriptor}`, `emit.name(payload)` validated; completed dispatch
  returns events. In production: snapshot (structural detach) but NO deep freeze; dev/test:
  snapshot + deep freeze. Update core tests accordingly (application.test.ts:251-252 contract
  change is DELIBERATE).

### Dispatch fast path (all modes)

Precompute per operation at createApplication: effect handler table (closures bound ONCE),
emitter factory, permission Set, id→operation Map, error-code set, ensures list. Per dispatch:
- No trace machinery unless trace:true — no entry construction, no freeze, no trace array.
  Fault latching (lifecycle.boundaryFault) and drainPendingEffects MUST survive trace-off.
- new Set(principal.permissions) only when principal.permissions is not already a Set.
- Object.freeze of results/contexts only in dev/test.
- mode "production" skips ONLY effect-output re-parse (internal boundary). ALWAYS keep:
  input parse, permission check, operation output parse, declared-error details parse,
  event payload validation (external boundaries; measured cost ~0.16µs — immaterial).
- schema.ts: no [...path, key] spreads (lazy path build on failure only), no per-parse key
  sort (precomputed key set; shape keys presorted at creation), no freeze in production.

### Schema v2 (s namespace)

Additions: `s.string({min?, max?, trim?, pattern?})`, `s.number({min?, max?, int?})`,
`s.object()` returns ObjectSchema exposing `.shape`, `s.boolean()`, keep literal/array/
optional/union/refine/id. `trim` is the only transform (runs before validation). Object
parsing stays strict/reject-unknown-keys (acceptance suite depends on it). Export `s` as the
namespace (keep `schema` as a secondary named export for continuity if trivial, else drop).

## 2. HTTP adapter v2 (@agentix/adapters-http)

```ts
const handler = createHttpHandler(app, {
  authenticate?: PrincipalExtractor,      // opt-in; absent ⇒ anonymous principal
  onError?: (error, requestInfo) => void, // default console.error in dev, no-op in prod
  routes?: [...defineHttpRoute overrides] // additive/override for custom mapping
});
```

- Routes AUTO-DERIVED from app's operations' `http` metadata (no features param — A5).
- `handler` is an OBJECT (risk amendment): `handler.fetch(request)` Web entry (edge-safe,
  acceptance suite uses it) + compiled route table exposed for hosts.
- `serveNode(handler, {port, host?, maxBodyBytes?})` — RAW req/res fast path: no undici
  Request/Response construction; parse path once; method-bucketed route table:
  Map<method, {static: Map<path, route>, params: route[] sorted static-segments-first}>;
  405 Allow computed lazily. Request flow: route match → authenticate → core authorize()
  (403 BEFORE body read — acceptance requires it) → read body (single copy, cap) →
  JSON.parse → default mapRequest (merge path params + query + body per input schema keys,
  schema-aware coercion of number/boolean params) → dispatch → respond via
  res.end(prestringified JSON) with precomputed per-route status/headers.
- Response envelope (matches acceptance + v2-amended tests): completed ok ⇒
  `{ok: true, value}` status = http.status ?? 200; completed error ⇒ `{ok: false,
  error: {code, details}}` status = per-error http ?? 422; rejected INVALID_INPUT ⇒ 400
  {ok:false, error:{code:"INVALID_INPUT", issues}}; PERMISSION_DENIED ⇒ 403;
  UNKNOWN route ⇒ 404; fault ⇒ 500 opaque `{ok:false, error:{code:"INTERNAL"}}` + onError.
- Delete the adapter-level permission DUPLICATE check (core authorize is the single source).
- Fix static-vs-param precedence (static-first, deterministic) + malformed percent-encoding
  handling (skip candidate, not 400-abort).
- Keep web.ts edge entry working from the same compiled table (Request-based, for
  acceptance + edge runtimes).

Perf budget (measured, sequential loopback): raw-path target 41–44µs vs Express 49–53µs.
~85–90% of the current gap is undici Request/Headers/Response — the raw host eliminates it.
Schema-compiled serialization NOT needed; do not build it.

## 3. Compiler + CLI v2 (lockstep — the scanner keys on the NEW shape)

scanner.ts changes (enumerated + verified by the type/scanner reviewer):
1. descriptorCalls maps the NEW names: feature/command/query/port/event (+ port.store,
   port.read/write/time/random/external via property-callee names — calledName already
   returns the property name).
2. feature()/port(): id from ARG 0 string literal, def object ARG 1; event() positional
   (id, version, payload) — per-kind shape checks replace the single static-object rule.
3. Operations: iterate the feature's `operations` object literal (reuse the existing
   port-operations extraction mechanism: property key + unwrap(initializer) must be a
   command()/query() call); derive id `${featureId}.${key}`; register property symbols in
   operationBySymbol + text fallback (same dual mechanism as portOperationBySymbol).
4. Port-op kind from callee name (port.write → "write"); port.store expands to its 4 ops.
5. Effects resolve `NoteStorage.save` property access (port-op symbol map handles it).
6. Extract `http` metadata + unified error {http, details} into the index.
7. featureSegment: single-file features — `src/features/notes.ts` ⇒ feature file (segment
   "notes"), `src/features/notes/…` dirs still allowed; test association: `notes.test.ts`
   next to it or `associateOperationTest` markers.
8. Public-contract rule: the FEATURE FILE is the public contract (cross-feature imports must
   target a feature file); delete the contract.ts basename rule.
9. Delete likelyAffected from the index (nothing consumes it).
10. Fix exportedNames for `export { a, b }` / re-exports.

affected.ts: (a) drop the resolve(project) !== resolve(rootDir) clause — allow narrow scope
(vitest run <selected tests>) for root-tsconfig apps whenever the closure is un-widened;
(b) unresolved-edge widening scoped to the reachable subgraph (global only for unresolved in
shared files); (c) build adjacency Map once (kill O(V·E) BFS filter); compute affected once
per inspect (pass into planVerification).

context.ts (inspect): embed BOUNDED SOURCE EXCERPTS — input/output/error schema declaration
text (≤1KiB each), execute signature, port-op signatures — under the existing 8KiB cap +
omissions ledger. This makes inspect a one-artifact change context.

cli.ts: scaffold emits the v2 single-file template (feature file + test); update all command
plumbing for new index shape; keep exit codes; keep re-analysis-per-invocation (trust
decision) BUT wire readIndex + checkIndexStaleness as the fast path when digests match.

## 4. Testing v2 (@agentix/testing)

- `createTestApplication({features, adapters?, overrides?})` — auto-binds any uncovered port
  op to a RECORDING FAKE (fails loudly on call if no default derivable: port.store gets
  .memory(); time → deterministic clock; random → seeded ids; others → configurable stub
  that throws with a clear message unless overridden). Returns {app, calls, clock, ids}.
- `testHttp(handler)` — `.get(path, opts?)/.post(path, body, opts?)/.request(...)` against
  handler.fetch, returning {status, body (parsed), headers}. Supports principal/token opts.
- Keep: contracts, deterministic capabilities, traces, association markers. DELETE replay.ts
  + replay.test.ts (293+108 LOC, zero usage).
- Update harnesses to v2 descriptors (dispatch surface unchanged).

## 5. Applications

- sandbox/notes-app: REPLACE with the v2-amended arm (scratchpad/v2-amended/src/** is the
  target, adapted as needed to the final API) + keep AGENTS.md (update inspect guidance).
  It now serves REAL HTTP identical to the Express arm (POST /notes 201/409,
  GET /notes/:id 200/404). Keep both test variants (dispatch-level + HTTP-level).
- examples/framework-app: rewrite each feature as ONE file (orders.ts, customers.ts,
  products.ts, payments.ts…), app assembly shrinks to adapters + createApplication +
  createHttpHandler. MUST keep examples/shared-contract acceptance green — it is black-box
  (Web Request/Response + scripted now/orderIds/paymentOutcomes seams) and survives v2 iff:
  reject-unknown-keys stays, input normalization (trim) runs before execute, Web handler
  entry exists, 403-before-body-parse holds, invalid generated order IDs still rejected
  (keep the guard in execute — production mode doesn't skip operation output/error checks).
  Run acceptance in mode:"test" AND mode:"production" (parameterize the factory).
- examples/plain-app: untouched.

## 6. Benchmarks + token budget (the proof)

HYGIENE (hard rules): never modify existing benchmarks/results/*.json; new files
`http-frameworks-exploratory-v2-<date>.json` with supersession note; NEW seed constant
(no 'v1' lineage); classification stays exploratory; fixtures for the maintenance corpus:
new fixtures/v2 + new lock only if needed — do NOT refresh v1 hashes (benchmark:corpus:check
must still pass untouched).

http-comparison harness:
- Rewrite agentix target to v2 API; REMOVE its redundant 3rd validation (mapResponse
  re-parse). Express/NestJS targets unchanged in the default condition; ADD a second
  condition where Express/NestJS use zod validation on input+output (equal work).
- Add `--isolated` mode: each target in its own child process (the shared-event-loop method
  inflated the gap ~10x); keep the in-process mode for continuity.
- Add workloads: param route (GET /notes/:id), and a concurrency batch mode (N=8 in-flight).
- Record method changes in the results file + docs/HTTP_FRAMEWORK_BENCHMARK.md addendum
  (append a v2 section; do not rewrite v1 findings).

sandbox/token-budget/run.mjs:
- Add CHANGE-COST scenario: scripted "add notes.delete" per arm — tokens of files an agent
  must READ + WRITE counts, symmetric methodology (grep-based discovery for ALL arms).
- Fix asymmetric 'affected': conventional arms modeled as file-list + grep + matched files
  (not full src).
- Stamp git commit + estimator version into results. Keep chars/4 (documented heuristic).

Runtime dispatch smoke (benchmarks/runtime/src/benchmark.ts): port its echo feature to v2;
new result files only (identity change documented).

## 7. Docs (agent-first)

- Rewrite: GETTING_STARTED, CORE_CONCEPTS, API_REFERENCE, HTTP, TESTING, CLI for v2.
- docs/ARCHITECTURE.md: add a dated v2 revision section amending the explicit-registration
  principle ("explicitness lives on the operation descriptor; aggregation is derived") —
  do not silently rewrite the frozen record; mark superseded principles.
- NEW docs/AUTHORING.md ~150 lines: the complete single-file feature cheat sheet.
- Each package: README.md with ONE complete copy-pasteable example + API.md (every export,
  one-line signature); add both to package.json files array (ship offline docs).
- AGENTS.md: update for v2 authoring + CLI.
- README.md: update examples + claims (keep honest research-status framing; new numbers only
  as exploratory).

## 8. Phase plan (gates in parentheses)

P1 core v2 (tsc -b packages/core + core tests green).
P2 parallel: adapters-http v2; compiler→cli v2; testing v2 (each package's tsc + tests green;
   http/testing may stub against core dist).
P3 parallel: sandbox arm; framework-app + acceptance (BOTH modes); CLI fixtures.
P4 parallel: benchmarks harness + token-budget; docs sweep.
P5 integration: npm run build && npm run verify; sandbox:test; acceptance; benchmark runs;
   perf tuning loop until goal 3 numbers hold; final adversarial review workflow; fixes.
NOTE: full-repo verify is NOT expected green until P3 ends (hard API break, no compat shim);
package-local suites are the intermediate gates.
