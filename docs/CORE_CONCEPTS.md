# Core Concepts

Agentix models application boundaries as ordinary immutable TypeScript values.
Descriptors drive runtime validation and are statically projected into a
machine index — no decorators, reflection, or global registries. One feature is
one file; everything an operation can do is declared on the operation itself.

## Operations

`command()` (may write and emit) and `query()` (read-only; write effects and
`emits` are rejected at type level and at runtime) build unbound operations.
`feature(id, { operations })` binds them, deriving stable ids
`${featureId}.${key}`:

```ts
create: command({
  input: Note,                     // runtime schema; also the static type via s.Infer
  output: Note,                    // validated on every completion
  errors: { NOTE_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
  permissions: ["notes:write"],    // optional; absent => anonymous allowed
  http: { method: "POST", path: "/notes", status: 201 },
  effects: { load: NoteStorage.get, save: NoteStorage.save },
  async execute({ input, effects, fail }) {
    if (await effects.load(input.id)) return fail("NOTE_ALREADY_EXISTS", { id: input.id });
    return effects.save(input);
  },
}),
```

`execute` returns a plain output value or a `fail(...)` result. It receives
only what is declared: `input` (parsed), `effects` (declared port operations),
`emit` (declared events), and `fail` (typed against `errors`).

Error declarations unify code, HTTP status, and details schema:
`CODE: { http?: number, details?: shape | Schema }`; a bare schema is shorthand
for `{ details }`. `fail(code, details)` RETURNS the declared failure — do not
throw it.

## Ports and adapters

A port declares the operations the domain may call; an adapter implements them.
Port operations declare `input`/`output` schemas only — there is no error
channel. Model expected alternatives in the output schema; let unexpected
failures throw (they become `EFFECT_FAILURE` faults):

```ts
import { port, s } from "@agentix/core";

export const Payments = port("payments", {
  charge: port.external({
    input: s.object({ orderId: s.string(), amountCents: s.number({ int: true, min: 0 }) }),
    output: s.union([
      s.object({ status: s.literal("captured"), reference: s.string() }),
      s.object({ status: s.literal("declined"), reason: s.string() }),
    ]),
  }),
});

export const Clock = port("clock", {
  now: port.time({ input: s.object({}), output: s.string() }),
});

export const systemClock = Clock.adapter({
  now: () => new Date().toISOString(),
});
```

Operation kinds: `port.read`, `port.write`, `port.time`, `port.random`,
`port.external`. Kinds gate query purity (`write` is forbidden in queries) and
let the test package derive deterministic fakes. Operations are addressable as
`Port.opName`; adapters return plain values or throw — never wrap results.

### port.store

`port.store(id, objectSchema)` (schema must contain `id`) expands to a CRUD
port: `get(id) -> record | undefined`, `save(record) -> record`,
`delete(id) -> boolean`, `list({}) -> record[]`, plus `.memory()`, a built-in
Map-backed adapter keyed by `id`:

```ts
export const NoteStorage = port.store("noteStorage", Note);
// effects: { load: NoteStorage.get, save: NoteStorage.save }
// adapters: [NoteStorage.memory()]
```

## Effects: the plain-value contract

Inside `execute`, `effects.name(input)` is an async function. The runtime
validates the effect input against the port operation's input schema in every
mode, calls the adapter, and (outside production) re-validates the adapter's
output. Effects return plain values; an adapter throw surfaces as a
dispatch fault (`EFFECT_FAILURE`), never as a domain error.

## Outcomes, rejections, faults

`app.dispatch(idOrDescriptor, { input, principal?, trace? })` returns one of
three kinds:

| Kind | Meaning | Contents |
| --- | --- | --- |
| `completed` | Operation ran | `outcome` (`{ok:true,value}` or `{ok:false,error:{code,details}}`), `events` |
| `rejected` | Never ran | `error.code`: `UNKNOWN_OPERATION`, `PERMISSION_DENIED`, `INVALID_INPUT` (with `issues`) |
| `fault` | Defect | `error.code`: e.g. `EFFECT_FAILURE`, `INVALID_OUTPUT`, `INVARIANT_VIOLATION`, `EXECUTION_FAILED` |

Declared domain failures are data (`outcome.ok === false`). Rejections are the
caller's fault; faults are the application's fault and are opaque to HTTP
clients.

`app.call(id, input, { principal? })` is sugar for the common case: it returns
the `Outcome` and throws `DispatchError` (with `kind`, `code`, `detail`) on
rejections and faults:

```ts
const outcome = await app.call("notes.get", { id: "n1" });
if (outcome.ok) console.log(outcome.value.title);
```

Traces are strictly opt-in (`trace: true` per dispatch); no trace machinery
runs otherwise.

## Events

`event(id, version, payloadSchema)` declares an event; operations reference it
in `emits` and call `emit.name(payload)` during execution:

```ts
export const NoteArchived = event("notes.archived", 1, s.object({ id: s.string() }));

archive: command({
  // ...
  emits: { archived: NoteArchived },
  async execute({ input, effects, emit }) {
    const removed = await effects.remove(input.id);
    if (removed) emit.archived({ id: input.id });
    return removed;
  },
}),
```

Payloads are validated on emit. A completed dispatch returns the events;
publication, persistence, and delivery are explicitly the caller's concern —
there is no outbox or bus inside the framework.

## Ensures

`ensures` are named postconditions on the operation, executed after successful
completion in development and test modes only; a false check faults the
dispatch with `INVARIANT_VIOLATION`:

```ts
ensures: {
  "id-preserved": {
    check: ({ input, output }) => output.id === input.id,
  },
},
```

An optional `evidence` schema is authoring metadata for tooling; it is not
executed at runtime.

## Modes and the production validation policy

`createApplication({ mode })` accepts `"production" | "development" | "test"`;
the default derives from `NODE_ENV` (`production`/`test` map directly, anything
else is `development`).

Always on, in every mode: input parsing, permission checks, operation output
validation, declared-error details validation, event payload validation, and
effect input AND output validation. Because effect outputs are re-parsed in
every mode, `execute` always receives a detached parse product — mutating a
loaded record never writes through to adapter/store state, in production too.
Production skips only interior double-checks that cannot change data
semantics:

| Check | dev/test | production |
| --- | --- | --- |
| External boundaries (input, output, errors, events, effect inputs) | on | on |
| Effect output re-validation (detached parse product) | on | on |
| `ensures` postconditions | on | off |
| Deep-freeze of results/contexts/event payloads | on | off (payloads stay detached) |

## Authorization

`permissions: [...]` on an operation requires a `principal` whose permissions
are a superset; operations without permissions accept anonymous dispatches.
The default gate is the exported `authorize(operation, principal?)` subset
check. The EFFECTIVE gate — the custom hook when one was provided, else the
default — is exposed as `app.authorize(operation, principal?)`; dispatch uses
it, and the HTTP adapter calls `app.authorize` before reading a request body,
so a custom hook is honored on every entry:

```ts
import { authorize, principal } from "@agentix/core";

const admin = principal("admin", ["notes:write"]);
await app.call("notes.create", input, { principal: admin });
```

A custom hook replaces the decision (not the plumbing):

```ts
createApplication({
  features: [notes],
  adapters: [NoteStorage.memory()],
  authorize: (who, operation) => operation.kind === "query" || who !== undefined,
});
```

Denials by a custom hook report `missingPermissions` from the default subset
diff, which is `[]` when the hook denies despite satisfied permissions.

A hook that throws never rejects the dispatch promise: dispatch resolves with
an `AUTHORIZE_FAILED` fault (HTTP adapters answer 500 and call `onError`).

## Application assembly

```ts
const app = createApplication({ features: [notes], adapters: [NoteStorage.memory()] });
```

Startup validation fails fast with `ApplicationDefinitionError` listing every
issue: `DUPLICATE_ID`, `DUPLICATE_ADAPTER`, `MISSING_ADAPTER`,
`INCOMPLETE_ADAPTER`, `QUERY_WRITE_EFFECT`, `QUERY_EMITS_EVENT`,
`HTTP_ROUTE_CONFLICT`. Required ports are derived from operation effects — a
feature never lists its ports, and the app never registers routes.
