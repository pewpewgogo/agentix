# API Reference

Every public export of the five packages, grouped by module. Packages are
ESM-only, one coordinated pre-1.0 version; supported entry points are the
package roots plus `@agentixdev/adapters-http/web` and `/node`. Each package also
ships this reference offline as `API.md`.

## `@agentixdev/core`

### Schemas (`s` namespace; types also exported top-level)

- `s.string({min?, max?, trim?, pattern?}?): Schema<string>` — `trim` runs before validation.
- `s.number({min?, max?, int?}?): Schema<number>`
- `s.boolean(): Schema<boolean>`
- `s.literal(value): Schema<value>` — string/number/boolean/null literal.
- `s.object(shape): ObjectSchema<shape>` — strict (unknown keys rejected); exposes `.shape`.
- `s.array(item): Schema<Item[]>`
- `s.record(valueSchema): Schema<Record<string, V>>` — open string-keyed map; every value validated (no unknown-key policy; HTTP param coercion never applies).
- `s.tuple([a, b, ...]): Schema<[A, B, ...]>` — fixed-length tuple; element-wise validation (no coercion).
- `s.optional(schema): OptionalSchema<T>` — accepts `undefined`.
- `s.union([a, b, ...]): Schema<A | B>` — first matching member wins.
- `s.refine(base, predicate, {id, message} | id): Schema<T>` — custom predicate on top of `base`.
- `s.id(brand): Schema<BrandedId<brand>>` — non-empty branded string id.
- `s.Infer<S>` / `Infer<S>` — static type of a schema.
- `SchemaValidationError` — thrown by `schema.parse`; carries `issues`.
- Every schema: `safeParse(value): ParseResult<T>` and `parse(value): T`.
- Types: `Schema<T>`, `ObjectSchema<Shape>`, `OptionalSchema<T>`, `SchemaShape`,
  `ObjectOutput<Shape>`, `StringOptions`, `NumberOptions`, `RefinementOptions`,
  `LiteralValue`, `BrandedId<Brand>`, `ParseSuccess<T>`, `ParseFailure`,
  `ParseResult<T>`, `SchemaIssue`, `SchemaIssueCode`, `SchemaPathSegment`,
  `SchemaDescription`, `TupleOutput<Schemas>`.

### Outcomes

- `ok(value): Outcome<T, never>` / `err(error): Outcome<never, E>`
- `isOutcome(value): value is Outcome<unknown, unknown>`
- `matchOutcome(outcome, {ok, err}): A | B`
- Types: `Outcome<T, E>`, `Success<T>`, `Failure<E>`.

### Descriptors

- `command({input, output, errors?, permissions?, http?, effects?, emits?, ensures?, execute}): UnboundOperation<"command", ...>`
- `query({...same minus emits; write effects rejected}): UnboundOperation<"query", ...>`
- `feature(id, {operations, events?}): FeatureDescriptor` — binds operation ids `${id}.${key}`.
- `port(id, {opName: port.read|write|time|random|external({input, output, timeoutMs?})})` — port with ops addressable as `Port.opName`; `timeoutMs` faults over-budget effect calls with `EFFECT_TIMEOUT`.
- `Port.adapter(impl, hooks?: {init?, dispose?})` — binds plain-value handlers; handlers optionally take `(input, {signal})` (signal aborts on timeout/dispatch abort); hooks run on `app.start()`/`app.close()`.
- `port.store(id, objectSchema, {timeoutMs?}?): StorePort` — CRUD preset (`get/save/delete/list`) + `.memory()` Map adapter; schema must have `id`; `timeoutMs` applies to all four ops.
- `event(id, version, payloadSchema): EventDescriptor`
- `subscription(event, handler): Subscription` — typed in-process subscriber `(payload, {operationId}) => void|Promise<void>`; registered via `createApplication({subscribers})`.
- `FAIL_RESULT` — symbol branding `fail(...)` results.
- Error declaration: `errors: { CODE: { http?, details? } | Schema }`; `fail(code, details)` is injected into `execute` and RETURNS the declared failure.
- Types: `UnboundOperation`, `BoundOperation`, `AnyUnboundOperation`,
  `AnyBoundOperation`, `CommandDefinition`, `QueryDefinition`,
  `ExecutionContext`, `ExecuteResult`, `FailFn`, `OperationFailure`,
  `DeclaredError`, `ErrorConfig`, `ErrorSpec`, `ErrorSpecMap`, `ErrorDetails`,
  `FeatureDescriptor`, `AnyFeature`, `BindOperations`, `ValidOperations`,
  `PortDescriptor`, `AnyPort`, `PortFactory`, `PortOperationFactory`,
  `PortOperationDescriptor`, `UnboundPortOperation`, `AnyPortOperation`,
  `BoundPortOperations`, `ValidPortOps`, `PortImplementation`,
  `BoundPortAdapter`, `AdapterHandler`, `AdapterCallOptions`, `AdapterHooks`,
  `EffectHandler`, `EffectContext`,
  `EffectKind`, `EffectMap`, `StorePort`, `StoreOperations`,
  `StorePortOptions`, `StoreShape`, `Subscription`, `SubscriptionContext`,
  `EventDescriptor`, `EventEmitter`, `EventMap`, `EnsuresMap`,
  `OperationEnsure`, `EnsureContext`, `AuthoredHttp`, `HttpMetadata`,
  `HttpMethod`, `WithoutWriteEffects`, `MaybePromise`.

### Application

- `createApplication({features, adapters?, mode?, authorize?, observer?, subscribers?}): Application` — validates ids, adapter coverage, query purity, route conflicts; `mode` defaults from `NODE_ENV`; does NOT auto-start.
- `app.dispatch(idOrDescriptor, {input, principal?, trace?, meta?, signal?}): Promise<DispatchResult>` — three-way `completed | rejected | fault`; `meta` is an opaque observer passthrough; `signal` cancels cooperatively (fault `DISPATCH_ABORTED`).
- `app.call(id, input, {principal?}?): Promise<Outcome>` — returns the outcome; throws `DispatchError` on rejected/fault.
- `app.start(): Promise<Application>` — runs adapter `init` hooks in registration order; idempotent (failed starts may retry); rejects after `close()`.
- `app.close(): Promise<void>` — runs adapter `dispose` hooks in reverse order; idempotent; awaits an in-flight `start()` first (that `start()` then rejects); does NOT drain in-flight dispatches (hosts drain first); later dispatches fault `APPLICATION_CLOSED`; dispose errors surface as `AggregateError`.
- `app.getOperation(id): AnyBoundOperation | undefined`; `app.operations`, `app.features`, `app.mode`.
- `DispatchObserver` — optional `dispatchStarted` (returns the `token` handed to later callbacks) / `dispatchSettled` / `effectSettled` / `eventEmitted` / `subscriberFailed`; throwing observers never affect results; zero overhead when unconfigured.
- `app.authorize(operation, principal?): boolean` — the EFFECTIVE gate: the custom `authorize` hook when provided, else the default subset check; HTTP adapters call it before reading a request body. A throwing hook faults dispatch with `AUTHORIZE_FAILED` (HTTP 500 + `onError`).
- `authorize(operation, principal?): boolean` — the default permission gate (subset check; no permissions ⇒ anonymous OK).
- `principal(id, permissions): Principal`
- `DispatchError` — thrown by `call`; `{kind, code, operationId, detail}`.
- `ApplicationDefinitionError` — thrown by `createApplication`; carries `issues`.
- Types: `Application<Ops>`, `ApplicationDefinition`, `ApplicationOperations`,
  `OperationsRecordOf`, `OpInput`, `OpOutput`, `OpError`,
  `UnionToIntersection`, `DispatchOptions`, `CallOptions`, `DispatchResult`,
  `CompletedDispatch`, `RejectedDispatch`, `FaultedDispatch`,
  `DispatchObserver`,
  `DispatchRejectionError`, `DispatchFaultError`, `DispatchFaultCode`,
  `UnknownOperationError`, `PermissionDeniedError`, `InvalidInputError`,
  `EmittedEvent`, `ExecutionTrace`, `TraceEntry`, `EffectTraceEntry`,
  `EventTraceEntry`, `Principal`, `RuntimeMode`,
  `ApplicationDefinitionIssue`, `ApplicationDefinitionIssueCode`.

## `@agentixdev/adapters-http`

Root re-exports `./web` plus `serveNode`; `./web` is edge-safe.

### Handler

- `createHttpHandler(app, {authenticate?, onError?, routes?, health?, cors?, responseHeaders?}?): HttpHandler` — routes auto-derived from operations' `http` metadata; every response carries `x-request-id` (adopted from a valid inbound header or generated), and dispatch receives `meta: {requestId}` plus the request's abort signal.
- `HttpHandler` — `{fetch(request), handle(request), routes, app}`.
- `RequestBodyLimitError` — throw from a custom host's `readBody` for a 413.
- `JSON_CONTENT_TYPE` — `"application/json; charset=utf-8"`.
- Types: `CreateHttpHandlerOptions`, `HandlerRequest`, `HandlerResponse`,
  `HttpErrorInfo` (includes `requestId`), `HttpErrorObserver`, `CorsOptions`,
  `ResponseHeadersContext`, `ResponseHeadersHook`.

### Authentication

- `createBearerPrincipalExtractor({resolve(token, request)}): PrincipalExtractor`
- `createTrustedHeaderPrincipalExtractor({idHeader?, permissionsHeader?, separator?}?): PrincipalExtractor`
- `AuthenticationError(message?, code?)` — throw from an extractor for a 401.
- `createCookieLookup(headers): (name) => string | undefined` — the lazy cookie parser behind `HttpRequestView.cookie` (exported for custom hosts).
- Types: `PrincipalExtractor`, `HttpRequestView` (with `cookie(name)`),
  `BearerPrincipalExtractorOptions`, `TrustedHeaderPrincipalOptions`.

### Routing

- `defineHttpRoute({method, path, operation, status?, errorStatus?, mapRequest?}): HttpRouteOverride` — the only escape hatch; replaces the operation's auto routes.
- `compileRouteTable(operations, overrides?): CompiledRouteTable` — for custom hosts.
- `matchRoute(table, method, path): MatchResult` — `matched | method_not_allowed | not_found`.
- `queryRecord(query): Record<string, string>` — first-value-wins query parsing.
- `EMPTY_PARAMS` — shared frozen empty params record.
- Types: `DefineHttpRouteOptions`, `HttpRouteOverride`, `HttpRequestContext`,
  `CompiledRoute`, `CompiledRouteTable`, `MatchResult`, `RouteBucket`,
  `RouteSegment`, `BuildInput`, `Awaitable`, re-exported `HttpMethod`.

### Node host (root and `./node`)

- `serveNode(handler, {port, host?, maxBodyBytes?, gracefulTimeoutMs?, closeApplication?}): Promise<NodeHttpServer>` — raw `node:http` fast path; `{server, url, close()}`. `close()` drains in-flight requests up to `gracefulTimeoutMs` (default 10 000 ms) before destroying sockets; with `closeApplication` it then awaits `handler.app.close()`. Client disconnects abort the in-flight dispatch; aborted requests never write.
- Types: `ServeNodeOptions`, `NodeHttpServer`.

## `@agentixdev/testing`

### Test application

- `createTestApplication({features, adapters?, overrides?, mode?, authorize?, observer?, subscribers?}): {app, calls, clock, ids, started, reset}` — auto-binds uncovered port ops to recording fakes (`preset === "store"`→memory, time→clock, random→ids, other→throwing stub); user adapters are wrapped for call recording (identity-preserving, hooks forwarded).
- `harness.started()` — awaits `app.start()`, resolves to the same harness; `harness.reset()` — clears fake store state, calls, clock, and ids (user-adapter state untouched).
- Types: `TestApplicationDefinition`, `TestApplication`, `TestCallLog`,
  `TestOverrideHandler`.

### HTTP driver

- `testHttp(handler): TestHttpClient` — `get/delete(path, opts?)`, `post/put/patch(path, body?, opts?)`, `request({...})`; responses `{status, body, headers, text}`.
- `TEST_PRINCIPAL_HEADER` — header carrying the JSON `principal` option.
- Types: `TestHttpHandler`, `TestHttpClient`, `TestHttpRequest`,
  `TestHttpRequestOptions`, `TestHttpResponse`.

### Harnesses

- `testCommand({application, operation, input, principal?, trace?}): Promise<DispatchResult>` — trace defaults on; principal defaults to one granting the operation's permissions.
- `testQuery({...}): Promise<DispatchResult>` — same for queries.
- Types: `HarnessApplication`, `OperationHarnessOptions`,
  `OperationHarnessResult`.

### Deterministic capabilities

- `createDeterministicClock({start?, stepMs?, project?}?): DeterministicClock` — `now/peek/advanceBy/set/reset/calls`.
- `createDeterministicIdGenerator({prefix?, start?, padding?, values?}?): DeterministicIdGenerator` — `next/peek/reset/calls`.
- Types: `DeterministicClock`, `DeterministicClockOptions`,
  `DeterministicIdGenerator`, `DeterministicIdGeneratorOptions`.

### Recording and scripting

- `createRecordingAdapter(port, handlers): RecordingAdapter` — a `BoundPortAdapter` plus `calls()`/`reset()`.
- `createScriptedEffect<Input, Output>(steps): ScriptedEffect` — `{handler, remaining, reset}`.
- Types: `RecordingAdapter`, `RecordingPortImplementation`,
  `RecordedEffectCall`, `ReturnedEffectCall`, `ThrownEffectCall`,
  `EffectHandler`, `ScriptedEffect`, `ScriptedEffectStep`, `Awaitable`.

### Contracts

- `defineAdapterContract<Adapter>({id, cases}): AdapterContract` — typed cases per adapter operation.
- `runAdapterContract(contract, adapter): Promise<AdapterContractResult>`
- Types: `AdapterContract`, `AdapterContractResult`, `ContractAdapter`.

### Ensures

- `checkEnsures(operation, {input, output}): string[]` — violated ensure names.
- `assertEnsures(operation, context): void` — throws `EnsureViolationError`.
- `checkEnsuresProperty({operation, contexts, parameters?}): void` — seeded fast-check property.
- Types: `EnsureContextOf`, `CheckEnsuresPropertyOptions`; class `EnsureViolationError`.

### Traces and association

- `assertEffectSequence(trace, effectIds)` / `assertEventSequence(trace, eventIds)`
- `assertTraceEquals(actual, expected)`; `assertNoEffects(trace)`; `assertNoEvents(trace)`; class `TraceAssertionError`.
- `defineOperationTest({id, operation})` / `associateOperationTest(operation, id?)` — compiler-readable test associations.
- Types: `ExecutionTraceLike`, `EffectTraceLike`, `EventTraceLike`,
  `AssociableOperation`, `OperationTestAssociation`,
  `DefineOperationTestOptions`.

## `@agentixdev/compiler`

- `analyzeProject({rootDir, files?, include?}): AgentIndex` — static analysis to the schema-2 index.
- `generateIndex({rootDir, outputFile?, write?, ...}): GeneratedIndex` — deterministic `{index, json, outputFile}`.
- `readIndex(rootDir, path?): AgentIndex` — reads and shape-checks a cached index.
- `checkIndexStaleness(index, rootDir): {stale, reason?}` — digest/version staleness check.
- `computeAffected(index, target, rootDir?): AffectedResult` — conservative closure with per-item reasons.
- `planVerification(index, target, rootDir, affected?): VerificationPlan` — narrowest safe typecheck + test commands.
- `workspaceVerificationPlan(target, rootDir, reason): VerificationPlan` — workspace-scope fallback plan.
- `createOperationContext(index, id, rootDir): OperationContext | undefined` — bounded 8 KiB artifact with excerpts and omissions ledger.
- `createOperationDetail(index, id, rootDir): OperationDetail | undefined` — unbounded per-operation detail.
- `checkArchitecture({rootDir, ...}): CompilerDiagnostic[]` — architecture + query-purity diagnostics only.
- `discoverSourceFiles(rootDir)`, `createSourceManifest(...)`, `stableJson(value, {compact?}?)`, `toPosixPath(path)`, `repositoryPath(rootDir, path)`, `featureSegmentOf(path)`.
- `INDEX_SCHEMA_VERSION` (`"2"`), `COMPILER_VERSION`, `OPERATION_CONTEXT_BYTE_LIMIT` (8192).
- Types (all of `types.ts` plus `StableJsonOptions`): `AgentIndex`,
  `AnalyzeOptions`, `GenerateOptions`, `GeneratedIndex`, `IndexedFeature`,
  `IndexedOperation`, `IndexedOperationError`, `IndexedHttp`, `IndexedEffect`,
  `IndexedPort`, `IndexedPortOperation`, `IndexedEvent`, `IndexedTest`,
  `SchemaExcerpt`, `GraphEdge`, `CompilerDiagnostic`, `DiagnosticSeverity`,
  `DeclarationKind`, `SourceLocation`, `SourceManifest`, `ManifestEntry`,
  `AffectedResult`, `AffectedItem`, `AffectedReason`, `VerificationPlan`,
  `OperationContext`, `OperationContextAnalysis`, `OperationContextAffected`,
  `OperationContextAffectedItem`, `OperationContextExcerpts`,
  `OperationContextOmission`, `OperationContextProjection`,
  `OperationContextVerification`, `OperationDetail`.

## `@agentixdev/cli`

- `runCli(argv, {cwd?, io?, runProcess?}?): Promise<number>` — the `agentix` binary's contract, programmable.
- `ExitCode` — `{success: 0, verificationFailure: 1, invalidInvocation: 2, internalFailure: 3}`.
- Types: `CliDependencies`, `CliIO`, `ProcessResult`, `ProcessRunner`.

Commands and artifact shapes: [CLI.md](CLI.md).
