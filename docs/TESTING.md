# Testing

`@agentix/testing` runs operations through the exact production dispatcher
with deterministic infrastructure. It complements Vitest (or any runner); it
does not replace one.

## createTestApplication

Builds an app where every port operation reachable from the features is bound:
your adapters win; uncovered operations get recording fakes. `port.store`
ports get the `.memory()` equivalent, `time` ops a deterministic clock,
`random` ops seeded ids; anything else throws with a clear message until
overridden.

```ts
import { createTestApplication } from "@agentix/testing";

const { app, calls, clock, ids } = createTestApplication({ features: [notes] });

await app.call("notes.create", { id: "n1", title: "First", body: "" });

calls.of("noteStorage.save");       // recorded calls for one port operation
calls.all();                        // every recorded call in sequence
calls.reset();
```

- `overrides` replace one derived fake by port-operation id:
  `overrides: { "noteStorage.get": () => ({ id: "n1", title: "Cached", body: "" }) }`.
  Unknown keys throw listing all valid keys. Ports covered by a real adapter
  cannot be overridden per-op (core allows one adapter per port).
- `clock` starts at `2000-01-01T00:00:00.000Z`, +1s per `now()`; `ids` yields
  `"id-1"`, `"id-2"`, ...
- `mode` defaults to `"test"`; `authorize` passes through to `createApplication`.
- Only auto-bound fakes are recorded; wrap a real adapter with
  `createRecordingAdapter` if you need its log.

## testHttp

Drives any `{ fetch(request) }` handler without a socket:

```ts
import { TEST_PRINCIPAL_HEADER, testHttp } from "@agentix/testing";
import type { Principal } from "@agentix/core";

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
import { assertEffectSequence, testCommand } from "@agentix/testing";

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
