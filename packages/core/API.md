# `@agentix/core` API

Every public export, one line each. Full model: the repository's
`docs/CORE_CONCEPTS.md`.

## Schemas (`s` namespace)

- `s.string({min?, max?, trim?, pattern?}?): Schema<string>` — `trim` runs before validation.
- `s.number({min?, max?, int?}?): Schema<number>`
- `s.boolean(): Schema<boolean>`
- `s.literal(value): Schema<value>` — string/number/boolean/null literal.
- `s.object(shape): ObjectSchema<shape>` — strict; rejects unknown keys; exposes `.shape`.
- `s.array(item): Schema<Item[]>`
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
  `SchemaPathSegment`, `SchemaDescription`.

## Outcomes

- `ok(value)` / `err(error)` — construct `Outcome<T, E>` values.
- `isOutcome(value)` — structural guard.
- `matchOutcome(outcome, {ok, err})` — exhaustive fold.
- Types: `Outcome<T, E>`, `Success<T>`, `Failure<E>`.

## Descriptors

- `command({input, output, errors?, permissions?, http?, effects?, emits?, ensures?, execute})` — unbound command.
- `query({...})` — unbound query; write effects and `emits` rejected (type + runtime).
- `feature(id, {operations, events?})` — binds ids `${id}.${key}`.
- `port(id, {opName: port.read|write|time|random|external({input, output})})` — ops addressable as `Port.opName`; `Port.adapter(impl)` binds plain-value handlers.
- `port.store(id, objectSchema)` — CRUD preset `get/save/delete/list` + `.memory()` adapter; schema must have `id`.
- `event(id, version, payloadSchema)` — event descriptor (positional).
- `FAIL_RESULT` — symbol branding `fail(...)` results.
- Errors: `errors: { CODE: { http?, details? } | Schema }`; injected `fail(code, details)` RETURNS the declared failure.
- Types: `UnboundOperation`, `BoundOperation`, `AnyUnboundOperation`, `AnyBoundOperation`,
  `CommandDefinition`, `QueryDefinition`, `ExecutionContext`, `ExecuteResult`, `FailFn`,
  `OperationFailure`, `DeclaredError`, `ErrorConfig`, `ErrorSpec`, `ErrorSpecMap`,
  `ErrorDetails`, `FeatureDescriptor`, `AnyFeature`, `BindOperations`, `ValidOperations`,
  `PortDescriptor`, `AnyPort`, `PortFactory`, `PortOperationFactory`,
  `PortOperationDescriptor`, `UnboundPortOperation`, `AnyPortOperation`,
  `BoundPortOperations`, `ValidPortOps`, `PortImplementation`, `BoundPortAdapter`,
  `AdapterHandler`, `EffectHandler`, `EffectContext`, `EffectKind`, `EffectMap`,
  `StorePort`, `StoreOperations`, `StoreShape`, `EventDescriptor`, `EventEmitter`,
  `EventMap`, `EnsuresMap`, `OperationEnsure`, `EnsureContext`, `AuthoredHttp`,
  `HttpMetadata`, `HttpMethod`, `WithoutWriteEffects`, `MaybePromise`.

## Application

- `createApplication({features, adapters?, mode?, authorize?})` — startup-validated app; `mode` defaults from `NODE_ENV`.
- `app.dispatch(idOrDescriptor, {input, principal?, trace?})` — `completed | rejected | fault`.
- `app.call(id, input, {principal?}?)` — returns `Outcome`; throws `DispatchError` otherwise.
- `app.getOperation(id)`; `app.operations`; `app.features`; `app.mode`.
- `app.authorize(operation, principal?)` — the EFFECTIVE gate (custom hook when provided, else the default); used by HTTP adapters pre-body. A throwing hook faults dispatch with `AUTHORIZE_FAILED`.
- `authorize(operation, principal?)` — the default permission-subset gate.
- `principal(id, permissions)` — frozen `Principal`.
- `DispatchError` — `{kind: "rejected"|"fault", code, operationId, detail}`.
- `ApplicationDefinitionError` — carries every startup `issue`.
- Types: `Application`, `ApplicationDefinition`, `ApplicationOperations`,
  `OperationsRecordOf`, `OpInput`, `OpOutput`, `OpError`, `UnionToIntersection`,
  `DispatchOptions`, `CallOptions`, `DispatchResult`, `CompletedDispatch`,
  `RejectedDispatch`, `FaultedDispatch`, `DispatchRejectionError`, `DispatchFaultError`,
  `DispatchFaultCode`, `UnknownOperationError`, `PermissionDeniedError`,
  `InvalidInputError`, `EmittedEvent`, `ExecutionTrace`, `TraceEntry`,
  `EffectTraceEntry`, `EventTraceEntry`, `Principal`, `RuntimeMode`,
  `ApplicationDefinitionIssue`, `ApplicationDefinitionIssueCode`.
