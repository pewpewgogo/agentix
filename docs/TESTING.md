# Testing Agentix Applications

`@agentix/testing` exercises operations through the same dispatcher used in
production while keeping time, randomness, and infrastructure deterministic.
It complements Vitest or another test runner; it does not replace one.

## Test an operation through the dispatcher

`testCommand` and `testQuery` require an already assembled `Application`. They
do not construct adapters or fake infrastructure for you.

```ts
import { describe, expect, it } from "vitest";
import {
  assertEffectSequence,
  assertEventSequence,
  testCommand,
} from "@agentix/testing";

describe("orders.create", () => {
  it("charges, commits, and emits in the declared flow", async () => {
    const result = await testCommand({
      application,
      operation: createOrder,
      input: createOrder.input.parse({
        customerId: "customer-1",
        productId: "product-1",
        quantity: 2,
      }),
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;

    expect(result.outcome.ok).toBe(true);
    assertEffectSequence(result.trace ?? [], [
      "customer-storage.get",
      "product-storage.reserve",
      "payment-gateway.charge",
      "order-ids.next",
      "order-clock.now",
      "order-events.commit-paid",
    ]);
    assertEventSequence(result.trace ?? [], ["orders.created"]);
  });
});
```

The harness grants the operation's declared permissions to a deterministic test
principal unless `principal` is supplied. Tracing defaults to `true`. Input,
permission, output, error, effect, and event boundaries are still enforced.

Trace helpers include:

- `assertEffectSequence`
- `assertEventSequence`
- `assertTraceEquals`
- `assertNoEffects`
- `assertNoEvents`

## Associate tests with operations

Make the relationship between a test and operation visible to the compiler:

```ts
export const createOrderTest = defineOperationTest({
  id: "orders.create.happy-path",
  operation: createOrder,
});
```

`defineOperationTest` and `associateOperationTest` create metadata values only.
They do not register or execute a test. Keep normal `describe`/`it` blocks and
assertions in the same file. Explicit associations let `agentix inspect`,
`affected`, and `verify` find the intended tests without relying only on
filenames.

## Deterministic time and IDs

```ts
const clock = createDeterministicClock({
  start: "2040-01-01T00:00:00.000Z",
  stepMs: 1_000,
});

clock.now(); // 2040-01-01T00:00:00.000Z
clock.now(); // 2040-01-01T00:00:01.000Z

const ids = createDeterministicIdGenerator({
  prefix: "order-",
  start: 1,
  padding: 3,
});

ids.next(); // order-001
ids.next(); // order-002
```

Both helpers expose `peek`, `reset`, and `calls`. The clock also supports
`advanceBy` and `set`. Bind their functions behind explicit time/random ports;
domain code should never read ambient time or randomness directly.

## Record port calls

`createRecordingAdapter` wraps one port implementation and records inputs,
outputs, and thrown exceptions:

```ts
const recording = createRecordingAdapter(OrderStore, {
  get: ({ id }) => ok(orders.get(id)),
  save: (order) => {
    orders.set(order.id, order);
    return ok(order);
  },
});

const application = createApplication({
  features: [ordersFeature],
  adapters: [bindPort(OrderStore, recording.operations)],
  mode: "test",
});

// Dispatch an operation, then inspect recording.calls().
```

The recording wrapper is not itself a core `BoundPortAdapter`; pass its
`.operations` to `bindPort`. Call records are appended when handlers complete.
For concurrent effects, use each record's `sequence` field to reconstruct
invocation order.

`createScriptedEffect` provides a resettable sequence of returned values or
thrown errors. It is useful for retry and compensation tests; wrap the scripted
handler in a port implementation that returns the port's required `Outcome`.

## Reuse adapter contracts

An adapter contract runs the same behavioral cases against different
implementations:

```ts
const contract = defineAdapterContract<typeof memoryStore.operations>({
  id: "order-store.contract",
  cases: [
    {
      id: "missing-order",
      operation: "get",
      input: { id: OrderId.parse("missing") },
      assert(output) {
        expect(output).toEqual(ok(undefined));
      },
    },
  ],
});

await runAdapterContract(contract, memoryStore.operations);
await runAdapterContract(contract, databaseStore.operations);
```

Cases run sequentially and execution stops at the first failure. Construct a
fresh adapter or reset its state when cases must be isolated.

## Check invariants

Use `checkInvariant` for a boolean result and `assertInvariant` for an exception
that includes the invariant ID and evidence:

```ts
assertInvariant(paidOrderHasPayment, { order, payment });
```

`checkInvariantProperty` integrates with `fast-check`. It first validates every
generated evidence value with the invariant's schema, then runs the predicate.
Its default seed and run count are fixed for reproducibility; explicit
`parameters` can override them.

Declaring an invariant on an operation does not execute it. Test or operation
code must provide evidence and call it explicitly.

## Deterministic replay

Replay records are schema-versioned, JSON-only descriptions of:

- the operation ID and kind;
- input and principal;
- ordered effect inputs and returned/thrown results; and
- the expected outcome and events.

Use `defineReplayRecord` for trusted in-memory data and `parseReplayRecord` for
deserialized unknown input. `replay(record, runner)` supplies a caller-driven
effect function and checks that calls, outcome, events, and effect consumption
match exactly.

Replay does not automatically capture an application dispatch and does not
automatically locate or execute a core operation. The application supplies the
runner. This keeps operation lookup, migration, and compatibility policy
explicit.

## Repository test commands

```sh
npm run typecheck
npm test
npm run test:unit
npm run test:acceptance
npm run test:phase5
```

Run a focused workspace while developing:

```sh
npm test --workspace @agentix/framework-app
npm test --workspace @agentix/testing
```

The shared acceptance suite is the behavioral-equivalence gate between the
Agentix and plain TypeScript commerce applications. Framework-only architecture
tests supplement that suite; they cannot replace black-box behavior checks.
