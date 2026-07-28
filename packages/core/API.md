# `@agentixdev/core` API

Every public export, one line each. Full model: the repository's
`docs/CORE_CONCEPTS.md`.

## Schemas (`s` namespace)

- `s.string({min?, max?, trim?, pattern?}?): Schema<string>` — `trim` runs before validation.
- `s.number({min?, max?, int?}?): Schema<number>`
- `s.boolean(): Schema<boolean>`
- `s.literal(value): Schema<value>` — string/number/boolean/null literal.
- `s.object(shape): ObjectSchema<shape>` — strict; rejects unknown keys; exposes `.shape`.
- `s.array(item): Schema<Item[]>`
- `s.record(valueSchema): Schema<Record<string, V>>` — open string-keyed map; every value validated (no unknown-key policy; no coercion).
- `s.tuple([a, b, ...]): Schema<[A, B, ...]>` — fixed-length tuple; element-wise validation (no coercion).
- `s.optional(schema): OptionalSchema<T>` — accepts `undefined`.
- `s.union([a, b, ...]): Schema<A | B>` — first matching member wins.
- `s.refine(base, predicate, {id, message} | id): Schema<T>`
- `s.id(brand): Schema<BrandedId<brand>>` — non-empty branded string.
- `s.Infer<S>` / top-level `Infer<S>` — static type of a schema.
- Every schema: `safeParse(value): ParseResult<T>`, `parse(value): T` (throws `SchemaValidationError`), `description`.
- `SchemaValidationError` — `TypeError` with structured `issues`.
- Types: `Schema`, `ObjectSchema`, `OptionalSchema`, `SchemaShape`, `ObjectOutput`,
  `StringOptions`, `NumberOptions`, `RefinementOptions`, `LiteralValue`, `BrandedId`,
  `ParseSuccess`, `ParseFailure`, `ParseResult`, `SchemaIssue`, `SchemaIssueCode`,
  `SchemaPathSegment`, `SchemaDescription`, `TupleOutput`.

## Outcomes

- `ok(value)` / `err(error)` — construct `Outcome<T, E>` values.
- `isOutcome(value)` — structural guard.
- `matchOutcome(outcome, {ok, err})` — exhaustive fold.
- Types: `Outcome<T, E>`, `Success<T>`, `Failure<E>`.

## Descriptors

- `command({input, output, errors?, permissions?, http?, effects?, emits?, ensures?, execute})` — unbound command.
- `query({...})` — unbound query; write effects and `emits` rejected (type + runtime).
- `feature(id, {operations, events?})` — binds ids `${id}.${key}`.
- `port(id, {opName: port.read|write|time|random|external({input, output, timeoutMs?})})` — ops addressable as `Port.opName`; `timeoutMs` faults over-budget effect calls with `EFFECT_TIMEOUT`.
- `Port.adapter(impl, hooks?: {init?, dispose?})` — binds plain-value handlers; handlers optionally take `(input, {signal})` (signal aborts on timeout/dispatch abort); hooks run on `app.start()`/`app.close()`.
- `port.store(id, objectSchema, {timeoutMs?}?)` — CRUD preset `get/save/delete/list` + `.memory()` adapter; schema must have `id`; `timeoutMs` applies to all four ops.
- `event(id, version, payloadSchema)` — event descriptor (positional).
- `subscription(event, handler)` — typed in-process subscriber `(payload, {operationId}) => void|Promise<void>`; registered via `createApplication({subscribers})`.
- `FAIL_RESULT` — symbol branding `fail(...)` results.
- Errors: `errors: { CODE: { http?, details? } | Schema }`; injected `fail(code, details)` RETURNS the declared failure.
- Types: `UnboundOperation`, `BoundOperation`, `AnyUnboundOperation`, `AnyBoundOperation`,
  `CommandDefinition`, `QueryDefinition`, `ExecutionContext`, `ExecuteResult`, `FailFn`,
  `OperationFailure`, `DeclaredError`, `ErrorConfig`, `ErrorSpec`, `ErrorSpecMap`,
  `ErrorDetails`, `FeatureDescriptor`, `AnyFeature`, `BindOperations`, `ValidOperations`,
  `PortDescriptor`, `AnyPort`, `PortFactory`, `PortOperationFactory`,
  `PortOperationDescriptor`, `UnboundPortOperation`, `AnyPortOperation`,
  `BoundPortOperations`, `ValidPortOps`, `PortImplementation`, `BoundPortAdapter`,
  `AdapterHandler`, `AdapterCallOptions`, `AdapterHooks`, `EffectHandler`,
  `EffectContext`, `EffectKind`, `EffectMap`,
  `StorePort`, `StoreOperations`, `StorePortOptions`, `StoreShape`, `Subscription`,
  `SubscriptionContext`, `EventDescriptor`, `EventEmitter`,
  `EventMap`, `EnsuresMap`, `OperationEnsure`, `EnsureContext`, `AuthoredHttp`,
  `HttpMetadata`, `HttpMethod`, `WithoutWriteEffects`, `MaybePromise`.

## Application

- `createApplication({features, adapters?, mode?, authorize?, observer?, subscribers?})` — startup-validated app; `mode` defaults from `NODE_ENV`; does NOT auto-start.
- `app.dispatch(idOrDescriptor, {input, principal?, trace?, meta?, signal?})` — `completed | rejected | fault`; `meta` is an opaque observer passthrough; `signal` cancels cooperatively (fault `DISPATCH_ABORTED`).
- `app.call(id, input, {principal?}?)` — returns `Outcome`; throws `DispatchError` otherwise.
- `app.start()` — runs adapter `init` hooks in registration order; idempotent; returns the app.
- `app.close()` — runs adapter `dispose` hooks in reverse order; idempotent; awaits an in-flight `start()` first (that `start()` then rejects); does NOT drain in-flight dispatches (hosts drain first); later dispatches fault `APPLICATION_CLOSED`.
- `app.getOperation(id)`; `app.operations`; `app.features`; `app.mode`.
- `DispatchObserver` — optional `dispatchStarted` (returns the `token` handed to later callbacks) / `dispatchSettled` / `effectSettled` / `eventEmitted` / `subscriberFailed`; throwing observers never affect results; zero overhead when unconfigured.
- `app.authorize(operation, principal?)` — the EFFECTIVE gate (custom hook when provided, else the default); used by HTTP adapters pre-body. A throwing hook faults dispatch with `AUTHORIZE_FAILED`.
- `authorize(operation, principal?)` — the default permission-subset gate.
- `principal(id, permissions)` — frozen `Principal`.
- `DispatchError` — `{kind: "rejected"|"fault", code, operationId, detail}`.
- `ApplicationDefinitionError` — carries every startup `issue`.
- Types: `Application`, `ApplicationDefinition`, `ApplicationOperations`,
  `OperationsRecordOf`, `OpInput`, `OpOutput`, `OpError`, `UnionToIntersection`,
  `DispatchOptions`, `CallOptions`, `DispatchResult`, `CompletedDispatch`,
  `RejectedDispatch`, `FaultedDispatch`, `DispatchObserver`,
  `DispatchRejectionError`, `DispatchFaultError`,
  `DispatchFaultCode`, `UnknownOperationError`, `PermissionDeniedError`,
  `InvalidInputError`, `EmittedEvent`, `ExecutionTrace`, `TraceEntry`,
  `EffectTraceEntry`, `EventTraceEntry`, `Principal`, `RuntimeMode`,
  `ApplicationDefinitionIssue`, `ApplicationDefinitionIssueCode`.
