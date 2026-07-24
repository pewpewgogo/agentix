# API Reference

This reference covers the public exports of each Agentix workspace package. All
packages are private, version `0.0.0`, ESM-only workspaces. Only documented
package roots and the HTTP `/web` and `/node` subpaths are supported. The API is
pre-release and may change without compatibility shims.

## `@agentix/core`

### Schemas

| Export | Purpose |
| --- | --- |
| `schema` | Frozen namespace containing all schema constructors |
| `string()` | String schema |
| `number()` | Finite-number schema |
| `boolean()` | Boolean schema |
| `literal(value)` | Exact string, number, boolean, or null literal |
| `array(item)` | Readonly array of values parsed by `item` |
| `object(shape)` | Strict object; rejects missing required and unknown keys |
| `optional(inner)` | Optional object field or explicit `undefined` |
| `union(options)` | Ordered union of two or more schemas |
| `refine(base, predicate, options)` | Schema with a named application predicate |
| `id(brand)` | Non-empty branded string ID |

Key types are `Schema<T>`, `Infer<S>`, `ObjectOutput<S>`, `BrandedId<Brand>`,
`ParseResult<T>`, `ParseSuccess<T>`, `ParseFailure`, `SchemaIssue`,
`SchemaDescription`, and `SchemaPathSegment`.

`SchemaValidationError` is thrown by `parse`; `safeParse` does not throw for a
normal validation failure. Custom schema implementations and hostile values can
still throw while validation executes. Runtime dispatch converts those
exceptions into boundary faults rather than allowing operation code to recover
them as success. `ID_BRAND` is the unique-symbol basis of branded ID types.

### Outcomes

| Export | Purpose |
| --- | --- |
| `ok(value)` | Create a successful `Outcome` |
| `err(error)` | Create a failed `Outcome` for an expected error |
| `isOutcome(value)` | Runtime check for the outcome envelope |
| `matchOutcome(outcome, branches)` | Exhaustive success/error mapping |

Types: `Outcome<T, E>`, `Success<T>`, and `Failure<E>`.

### Descriptors

| Export | Purpose |
| --- | --- |
| `portOperation(definition)` | Declare one read/write/time/random/external capability |
| `definePort(definition)` | Group named port operations |
| `bindPort(port, implementation)` | Bind a complete implementation to a port |
| `defineAdapter` | Alias of `bindPort` |
| `defineEvent(definition)` | Declare a versioned event payload |
| `defineFeatureContract(definition)` | Declare one feature's public export surface |
| `defineContract` | Alias of `defineFeatureContract` |
| `defineInvariant(definition)` | Declare a pure invariant over evidence |
| `defineCommand(definition)` | Declare a command |
| `defineQuery(definition)` | Declare a query that cannot use `write` effects or emit events |
| `defineFeature(definition)` | Assemble a feature descriptor |
| `domainError(code, details)` | Construct a typed declared-error value |

`command`, `query`, `event`, `invariant`, and `feature` are short aliases. Prefer
the `define*` names in indexed application source because the compiler recognizes
those direct declaration forms most reliably.

Important types include `PortDescriptor`, `PortOperationDescriptor`,
`PortImplementation`, `BoundPortAdapter`, `EventDescriptor`,
`FeatureContractDescriptor`, `InvariantDescriptor`, `CommandDescriptor`,
`QueryDescriptor`, `FeatureDescriptor`, `DeclaredError`, `EffectKind`,
`EffectContext`, `EventEmitter`, and `OperationExecutionContext`.

### Application runtime

| Export | Purpose |
| --- | --- |
| `principal(id, permissions)` | Create an immutable principal value |
| `createApplication(definition)` | Validate and assemble features/adapters |
| `ApplicationDefinitionError` | Aggregated construction-time definition errors |

The returned `Application` exposes:

```ts
interface Application {
  readonly features: readonly FeatureDescriptor[];
  readonly operations: readonly AnyOperationDescriptor[];
  readonly mode: "production" | "development" | "test";
  getOperation(id: string): AnyOperationDescriptor | undefined;
  dispatch(operationOrId, options): Promise<DispatchResult>;
}
```

Key runtime types are `Principal`, `DispatchOptions`, `DispatchResult`,
`CompletedDispatch`, `RejectedDispatch`, `FaultedDispatch`,
`DispatchRejectionError`, `DispatchFaultError`, `ExecutionTrace`, `TraceEntry`,
`EmittedEvent`, `ApplicationDefinition`, and `ApplicationDefinitionIssue`.

Every `CompletedDispatch` has an immutable `events` array containing validated
events emitted by that execution. Payload graphs made of arrays and plain
objects are detached and deeply frozen at emission; non-plain values returned
by custom `Schema` implementations are opaque. The array is dispatch data, not
a publication, delivery, persistence, or transaction guarantee.

An ordinary operation-input validation failure is an `INVALID_INPUT` rejection.
If operation-input schema execution itself throws, dispatch returns a fault with
code `INPUT_VALIDATION_FAILED`. Thrown effect-input and event-payload validation
remain faults under `INVALID_EFFECT_INPUT` and `INVALID_EVENT_PAYLOAD`.

See [core concepts](CORE_CONCEPTS.md) for dispatch order, always-on boundary
validation, and behavior Agentix intentionally does not provide.

## `@agentix/adapters-http`

### Authentication

| Export | Purpose |
| --- | --- |
| `createBearerPrincipalExtractor(options)` | Parse bearer auth and delegate token resolution |
| `createTrustedHeaderPrincipalExtractor(options?)` | Read identity inserted by a trusted proxy |
| `AuthenticationError` | Signal a sanitized 401 authentication failure |

Types: `PrincipalExtractor`, `BearerPrincipalExtractorOptions`, and
`TrustedHeaderPrincipalOptions`.

### Routes and responses

| Export | Purpose |
| --- | --- |
| `defineHttpRoute(options)` | Create an immutable explicit route |
| `readJsonBody(request)` | Parse JSON or throw `HttpInputError` with `INVALID_JSON` |
| `jsonResponse(value, status, headers?)` | Produce a JSON `Response` |
| `mapDispatchResult(result, options?)` | Apply the default safe HTTP mapping |
| `HttpInputError` | Transport-input error with status and code |

Types: `HttpMethod`, `HttpRoute`, `DefineHttpRouteOptions`, `HttpRouteContext`,
`HttpResponseContext`, and `HttpOutcomeResponseOptions`.

### Handler and Node host

| Export | Purpose |
| --- | --- |
| `createHttpHandler(options)` | Build `(Request) => Promise<Response>` from routes |
| `createNodeHttpListener(handler, options?)` | Adapt the Web handler to a Node request listener |

Types: `HttpHandler`, `CreateHttpHandlerOptions`, and
`NodeHttpListenerOptions`. Read [HTTP adapter](HTTP.md) for status mapping,
authentication safety, body limits, buffering, and proxy trust.

Use `@agentix/adapters-http/web` for the Web-standard auth/route/handler surface
without importing the Node host. Use `@agentix/adapters-http/node` for
`createNodeHttpListener`. The package root retains both for compatibility.

## `@agentix/testing`

| Area | Exports |
| --- | --- |
| Operation harness | `testCommand`, `testQuery` |
| Test association | `defineOperationTest`, `associateOperationTest` |
| Traces | `assertEffectSequence`, `assertEventSequence`, `assertTraceEquals`, `assertNoEffects`, `assertNoEvents`, `TraceAssertionError` |
| Determinism | `createDeterministicClock`, `createDeterministicIdGenerator` |
| Port recording | `createRecordingAdapter`, `createScriptedEffect` |
| Adapter contracts | `defineAdapterContract`, `runAdapterContract` |
| Invariants | `checkInvariant`, `assertInvariant`, `checkInvariantProperty`, `InvariantViolationError` |
| Replay | `defineReplayRecord`, `parseReplayRecord`, `replay`, `ReplayEffectError`, `ReplayMismatchError` |

The package also exports the corresponding option, result, call-record, JSON,
replay, and trace types. It is Node-oriented and depends on `fast-check`.
Read [testing](TESTING.md) for lifecycle and ordering details.

## `@agentix/compiler`

| Export | Purpose |
| --- | --- |
| `INDEX_SCHEMA_VERSION` | Current generated-index schema (`"1"`) |
| `COMPILER_VERSION` | Current compiler projection version (`"0.1.0"`) |
| `OPERATION_CONTEXT_BYTE_LIMIT` | Hard serialized operation-context limit (`8192`) |
| `analyzeProject(options)` | Analyze source and return an in-memory `AgentIndex` |
| `checkArchitecture(options)` | Return architecture and query-rule diagnostics |
| `generateIndex(options)` | Analyze, deterministically serialize, and optionally write an index |
| `createOperationContext(index, target, rootDir)` | Project bounded, source-bound context for one operation |
| `createOperationDetail(index, target, rootDir)` | Expand exact, unbounded detail for one operation |
| `computeAffected(index, target, rootDir)` | Compute conservative affected closure |
| `planVerification(index, target, rootDir)` | Produce typecheck/test command plan |
| `checkIndexStaleness(index, rootDir)` | Check schema/compiler compatibility and compare the source manifest |
| `readIndex(rootDir, path?)` | Read `.agentix/index.json` or another path |
| `discoverSourceFiles(rootDir, files?)` | Deterministically discover TypeScript sources |
| `createSourceManifest(rootDir, files)` | Hash source/config inputs |
| `repositoryPath`, `toPosixPath` | Normalize repository-relative paths |
| `stableJson(value, options?)` | Deterministic sorted JSON serialization; `{ compact: true }` removes indentation |

All interfaces in `packages/compiler/src/types.ts` are public, including
`AgentIndex`, `OperationContext`, `OperationContextAnalysis`,
`OperationContextAffected`, `OperationContextProjection`,
`OperationContextOmission`, `OperationContextVerification`, `OperationDetail`,
indexed entity types, diagnostics, graph edges, source-manifest types,
`AnalyzeOptions`, `GenerateOptions`, `GeneratedIndex`, `StableJsonOptions`, `AffectedResult`, and
`VerificationPlan`.

The compiler uses TypeScript's unstable API packages and convention-based
static analysis. Treat this package as especially pre-release. Generation may
return/write an index containing diagnostics; it does not itself promise a clean
architecture result.

## `@agentix/cli`

The package installs the repository-local `agentix` binary and exposes a small
programmatic surface:

| Export | Purpose |
| --- | --- |
| `runCli(argv, dependencies?)` | Execute one command synchronously and return an exit code |
| `ExitCode` | Named exit-code constants |

Types: `CliDependencies`, `CliIO`, `ProcessResult`, and `ProcessRunner`.

Every JSON-producing command accepts `--compact` together with `--json` for the
same stable schema without indentation overhead.

See [CLI and generated index](CLI.md) for commands and static-analysis
conventions.

## Import and module rules

- Import package roots such as `@agentix/core`. The HTTP package additionally
  exports the documented `/web` and `/node` subpaths; other deep imports are not
  supported.
- Application packages use ESM/NodeNext. Relative TypeScript imports include a
  `.js` suffix so emitted JavaScript resolves correctly.
- Framework package engines are inherited from the repository contract today;
  consuming outside this monorepo is not a supported installation mode.
