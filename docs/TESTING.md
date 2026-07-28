# Testing

`@agentixdev/testing` runs operations through the exact production dispatcher
with deterministic infrastructure. It complements Vitest (or any runner); it
does not replace one.

## createTestApplication

Builds an app where every port operation reachable from the features is bound:
your adapters win; uncovered operations get recording fakes. `port.store`
ports get the `.memory()` equivalent (detected by the exact `preset ===
"store"` tag those operations carry — a hand-built port that merely looks
like a store is NOT memory-faked), `time` ops a deterministic clock, `random`
ops seeded ids; anything else throws with a clear message until overridden.

```ts
import { createTestApplication } from "@agentixdev/testing";

const harness = createTestApplication({ features: [notes] });
const { app, calls, clock, ids } = harness;

await app.call("notes.create", { id: "n1", title: "First", body: "" });

calls.of("noteStorage.save");       // recorded calls for one port operation
calls.all();                        // every recorded call in sequence
calls.reset();

harness.reset();                    // fresh-app semantics without rebuilding
```

- `overrides` replace one derived fake by port-operation id:
  `overrides: { "noteStorage.get": () => ({ id: "n1", title: "Cached", body: "" }) }`.
  Unknown keys throw listing all valid keys. Ports covered by a real adapter
  cannot be overridden per-op (core allows one adapter per port). Overrides
  receive the same `(input, { signal })` arguments as core adapter handlers.
- `clock` starts at `2000-01-01T00:00:00.000Z`, +1s per `now()`; `ids` yields
  `"id-1"`, `"id-2"`, ...
- `mode` defaults to `"test"`; `authorize`, `observer`, and `subscribers` pass
  through to `createApplication` verbatim.
- `calls` records EVERY bound port operation — auto-bound fakes, overrides,
  and your own adapters. User adapters are wrapped transparently: the wrapper
  forwards `(input, { signal })` unchanged and returns (and records) the
  handler's resolved value as the same reference, so wrapping never alters
  adapter behavior. Calls that reject because the effect signal aborted
  (`timeoutMs` or dispatch abort) are recorded as `"threw"` at their original
  sequence position, even when they settle after the dispatch faulted.

### harness.reset()

`harness.reset()` gives fresh-app semantics without rebuilding: it clears
every auto-bound store's records, empties the recorded call log, and resets
the deterministic clock and id sequences to their initial values.

**`reset()` does NOT touch user-supplied adapter state.** Adapters you pass
in own their state (a memory Map, a database, ...); the harness only wraps
them for call recording and cannot reset them. Rebuild the harness — or reset
the adapter yourself — when a user adapter must start fresh.

### Lifecycle: started() and close()

`createTestApplication` never auto-starts. `await harness.started()` awaits
`app.start()` (running every user-adapter `init` hook in registration order)
and resolves to the same harness, so setup reads as one expression:

```ts
const { app } = await createTestApplication({
  features: [notes],
  adapters: [postgresNotes], // adapter built with port.adapter(impl, { init, dispose })
}).started();

// ... tests ...

await app.close(); // dispose hooks in reverse order; then dispatch faults APPLICATION_CLOSED
```

Auto-bound fakes need no hooks; lifecycle hooks on your adapters survive the
recording wrapper unchanged.

## testHttp

Drives any `{ fetch(request) }` handler without a socket:

```ts
import { TEST_PRINCIPAL_HEADER, testHttp } from "@agentixdev/testing";
import type { Principal } from "@agentixdev/core";

const handler = createHttpHandler(app, {
  authenticate: (request) => {
    const raw = request.headers(TEST_PRINCIPAL_HEADER);
    return raw === undefined ? null : (JSON.parse(raw) as Principal);
  },
});

const http = testHttp(handler);

const created = await http.post(
  "/notes",
  { id: "n1", title: "First", body: "" },
  { principal: { id: "tester", permissions: ["notes:write"] } },
);
// created.status, created.body (JSON-parsed), created.headers, created.text
```

Methods: `get`/`delete(path, opts?)`, `post`/`put`/`patch(path, body?, opts?)`,
`request({ method, path, body?, headers?, principal?, token? })`. `token`
becomes `authorization: Bearer <token>`; `principal` is JSON in the
`TEST_PRINCIPAL_HEADER` header — wire the authenticate hook above to
round-trip it.

## Operation harnesses

`testCommand`/`testQuery` dispatch one operation with tracing on and a
principal that holds exactly the operation's permissions (override with
`principal`):

```ts
import { assertEffectSequence, testCommand } from "@agentixdev/testing";

const created = await testCommand({
  application: app,
  operation: notes.operations.create,
  input: { id: "n1", title: "First", body: "" },
});
expect(created.kind).toBe("completed");
if (created.kind === "completed" && created.trace !== undefined) {
  assertEffectSequence(created.trace, ["noteStorage.get", "noteStorage.save"]);
}
```

The result is the full three-way `DispatchResult`, so rejected and faulted
paths are testable. Trace assertions: `assertEffectSequence`,
`assertEventSequence`, `assertTraceEquals`, `assertNoEffects`, `assertNoEvents`.

## Deterministic capabilities

Standalone versions of the fakes used by `createTestApplication`:

```ts
const clock = createDeterministicClock({ stepMs: 1_000 });
clock.now();  // "2000-01-01T00:00:00.000Z", then +1s per call
clock.peek(); clock.advanceBy(60_000); clock.set("2001-01-01"); clock.reset();

const ids = createDeterministicIdGenerator();
ids.next();   // "id-1", "id-2", ...
```

`createScriptedEffect<Input, Output>(steps)` returns `{ handler, remaining,
reset }` for effect handlers with an explicit response script (including
thrown steps).

## Recording adapters

Wrap a real implementation so its calls are observable, then pass it straight
to `createApplication`/`createTestApplication`:

```ts
const recording = createRecordingAdapter(NoteStorage, {
  get: (id) => memory.get(id),
  save: (note) => { memory.set(note.id, note); return note; },
  delete: (id) => memory.delete(id),
  list: () => [...memory.values()],
});
// adapters: [recording]; recording.calls() / recording.reset()
```

## Adapter contracts

Define one behavioral contract and run it against every implementation of a
port (memory fake, SQL adapter, HTTP client):

```ts
const storageContract = defineAdapterContract<{
  save: (note: Note) => Note | Promise<Note>;
  get: (id: string) => Note | undefined | Promise<Note | undefined>;
}>({
  id: "note-storage",
  cases: [
    {
      id: "save-returns-the-record",
      operation: "save",
      input: { id: "n1", title: "First", body: "" },
      assert: (saved) => expect(saved.id).toBe("n1"),
    },
  ],
});

const result = await runAdapterContract(storageContract, implementation);
// result.passedCases
```

## Ensures helpers

`checkEnsures(operation, { input, output })` returns violated ensure names;
`assertEnsures` throws `EnsureViolationError`; `checkEnsuresProperty({
operation, contexts })` runs a seeded fast-check property over generated
contexts (fixed seed, reproducible).

## Test association

`defineOperationTest({ id, operation })` / `associateOperationTest(operation)`
are plain value declarations the compiler reads to associate a test file with
an operation. A test file inside a feature segment with no markers associates
all of that feature's operations automatically.
