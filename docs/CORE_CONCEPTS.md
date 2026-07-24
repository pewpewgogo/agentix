# Core Concepts

Agentix turns application boundaries into ordinary immutable TypeScript values.
Those values drive runtime validation and can be projected into a machine index
without decorators, reflection metadata, or a global registry.

## Feature capsules

A feature capsule is a directory convention plus a `FeatureDescriptor`. It owns
one business capability and normally contains:

```text
src/features/orders/
  contract.ts       public schemas, ports, and events
  model.ts          private domain types and pure rules, when needed
  operations.ts     commands and queries
  invariants.ts     executable policies
  feature.ts        feature descriptor and public dependencies
  orders.test.ts    associated tests
```

Other features may import only the public `contract.ts` surface. The consuming
feature also declares the imported contract in `dependencies`:

```ts
export const orders = defineFeature({
  id: "orders",
  contract: ordersContract,
  dependencies: [customersContract, productsContract],
  operations: [createOrder, getOrder],
  invariants: [paidOrderHasPayment],
  events: [OrderCreated],
  ports: [OrderStore],
});
```

The compiler reports private cross-feature imports and missing dependency
declarations. This is an architecture rule, not a security sandbox: hostile
JavaScript or dependencies can bypass it.

## Schemas

Every boundary uses a `Schema<T>` with two operations:

- `parse(value)` returns `T` or throws `SchemaValidationError`.
- `safeParse(value)` returns a success/failure result with structured issues for
  normal validation.

A custom schema, hostile proxy, or throwing input getter can still throw while a
schema executes. Dispatch reports an operation-input schema exception as the
`INPUT_VALIDATION_FAILED` fault. Effect-input and event-payload schema or event
snapshot exceptions are latched as `INVALID_EFFECT_INPUT` and
`INVALID_EVENT_PAYLOAD`, so operation code cannot catch them and return success.

The built-in constructors are `string`, `number`, `boolean`, `literal`, `array`,
`object`, `optional`, `union`, `refine`, and `id`; the same functions are
available through the `schema` object.

```ts
const ProductId = schema.id("product");
const Product = schema.object({
  id: ProductId,
  name: schema.string(),
  stock: schema.refine(schema.number(), Number.isSafeInteger, {
    id: "safe-stock",
    message: "Stock must be a safe integer",
  }),
  description: schema.optional(schema.string()),
});

type Product = Infer<typeof Product>;
```

Important behavior:

- object schemas reject unknown keys;
- number schemas reject `NaN` and infinities;
- optional means the property may be absent or `undefined`;
- an ID accepts any non-empty string and brands it at the type level—it does not
  trim or enforce a format; and
- schema parsing does not promise deep immutability of returned application
  data.

## Commands and queries

An operation descriptor declares the full boundary around one action:

| Field | Meaning |
| --- | --- |
| `id` | Stable application-wide identifier |
| `input` / `output` | Runtime schemas and inferred TypeScript types |
| `errors` | Map of expected domain-error codes to detail schemas |
| `permissions` | Every permission the principal must have |
| `effects` | Exact port operations available to `execute` |
| `emits` | Exact event emitters available to a command |
| `invariants` | Policies the operation declares it preserves |
| `execute` | Ordinary synchronous or asynchronous TypeScript |

Commands may declare reads, writes, time, randomness, external calls, and
events. Queries cannot declare a `write` effect and cannot emit events; both the
types and application construction enforce this rule. `EffectKind` is not an
orthogonal mutability model: an `external` adapter can still have side effects,
so mutating external work belongs in commands.

Descriptor IDs and permission strings must be non-empty and contain no
whitespace. IDs must be unique across the assembled application.

## Outcomes, rejections, and faults

Domain code returns an `Outcome`:

```ts
return ok(order);
return err(domainError("ORDER_NOT_FOUND", { id: input.id }));
```

Expected business failure is data, not an exception. The dispatcher validates
both the error code and its details schema.

The outer `DispatchResult` separates three classes of result:

| Dispatch kind | Meaning |
| --- | --- |
| `completed` | Execution returned a valid success or declared domain error |
| `rejected` | Unknown operation, missing permission, or invalid input |
| `fault` | Invalid boundary data or an unexpected exception |

A completed dispatch can therefore contain `outcome.ok === false`. Do not map
all non-successful business outcomes to framework faults.

## Ports, effects, and adapters

A port describes infrastructure without implementing it:

```ts
export const Payments = definePort({
  id: "payments",
  operations: {
    charge: portOperation({
      id: "payments.charge",
      kind: "external",
      input: ChargeInput,
      output: ChargeResult,
      errors: { PAYMENT_DECLINED: schema.object({}) },
    }),
  },
});
```

The five effect kinds are `read`, `write`, `time`, `random`, and `external`.
They describe capability intent; they do not add transactions, retries,
scheduling, or a proof of adapter purity.

An adapter binds every operation in one port:

```ts
const payments = bindPort(Payments, {
  charge(input) {
    return gateway.approve(input)
      ? ok({ status: "approved" as const })
      : err(domainError("PAYMENT_DECLINED", {}));
  },
});
```

The execution context exposes effects by the aliases selected in the operation,
not by their port keys. Effect input, the `Outcome` envelope, and effect
success/error payloads are schema-validated in every runtime mode. Operation
output and domain-error details are likewise validated in every mode.

Dispatch closes the capability window as soon as `execute` settles, then drains
every effect already started during that window before completing. Draining does
not extend the window: a captured effect called from a later timer is rejected.
Boundary faults are fatal to the dispatch even when operation code catches the
thrown wrapper error; they cannot be converted into a successful outcome.

## Permissions and principals

A `Principal` contains a stable `id` and a list or set of granted permissions.
The dispatcher requires every permission declared by the operation:

```ts
const actor = principal("user-42", ["orders:create", "orders:read"]);
```

Permission checks run before input parsing. This avoids exposing input-shape
details or doing request-dependent work for an unauthorized actor. Identity and
role resolution belong in an inbound adapter or application-owned port; Agentix
has no global identity store.

## Events

An event is a versioned, schema-backed descriptor:

```ts
const OrderCreated = defineEvent({
  id: "orders.created",
  version: 1,
  payload: OrderCreatedPayload,
});
```

A command may emit only the aliases in its `emits` map. The runtime validates
the payload and returns ordered `EmittedEvent` values on every completed
dispatch, independently of optional tracing. At emission, payload graphs made
of arrays and plain objects are detached and deeply frozen, preserving cyclic or
shared references. Non-plain values returned by a custom `Schema` are opaque. A
fault exposes no completed-event list; an enabled trace may still show an
attempted emission before the fault.
Core does **not** provide an event bus, persistence, delivery, or an outbox. An
application that needs those guarantees models them through an explicit port
and transaction boundary.

## Invariants

An invariant is a named pure predicate over schema-validated evidence:

```ts
const paidOrderHasPayment = defineInvariant({
  id: "orders.paid-order-has-payment",
  dependsOn: [ordersContract, paymentsContract],
  evidence: PaidOrderEvidence,
  check: ({ order, payment }) =>
    order.status !== "paid" || payment?.orderId === order.id,
});
```

Listing an invariant on an operation creates dependency and verification
metadata. It does not install a hidden production hook. The operation or its
tests must call the predicate explicitly. `@agentix/testing` supplies assertion
and property-test helpers.

## Application assembly

`createApplication` receives all features and adapters explicitly. Construction
validates:

- duplicate stable IDs;
- missing, duplicate, or self feature dependencies;
- query writes or event emission;
- duplicate adapters;
- adapter/port identity mismatches; and
- missing or incomplete adapters.

There is no container scan, startup hook, shutdown hook, automatic adapter
disposal, transaction manager, or global application instance.

Runtime modes are `production`, `development`, and `test`. The default mode is
`production`. Tracing defaults on in development/test and off in production;
`trace` on the application or one dispatch can override that default.

## Dispatch lifecycle

Every dispatch follows the same visible order:

1. Resolve the registered operation by stable ID and, for descriptor dispatch,
   require the exact registered descriptor identity.
2. Check all required permissions.
3. Parse input; distinguish ordinary `INVALID_INPUT` rejection from an
   `INPUT_VALIDATION_FAILED` schema-execution fault.
4. Construct the declared effect and event contexts.
5. Await `execute` and every effect it started.
6. Fail if any effect/event boundary fault occurred, even if it was caught.
7. Validate the returned outcome and its output/error data.
8. Return `completed` with emitted events, or `rejected`/`fault`; include a trace
   only when tracing is enabled.

Core does not add timeouts, cancellation, concurrency serialization, rollback,
or resource lifecycle. Those policies must be explicit in the application or
host.

## Generated index

The compiler projects statically recognizable descriptors into
`.agentix/index.json`. It includes source locations, dependencies, operations,
permissions, effects, events, invariants, tests, graph edges, diagnostics, and a
source-manifest digest.

The on-disk index is disposable and may be stale. The CLI reanalyzes TypeScript
before every answer and writes a fresh projection instead of trusting that file.
Operation inspection projects a bounded, source-digest-bound context artifact;
agents do not need the full index. Runtime dispatch never reads the index. See
[CLI and generated index](CLI.md) for the compiler's static-analysis conventions
and conservative widening rules.
