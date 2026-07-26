# `@agentix/testing` API

Every public export, one line each. Full guide: the repository's
`docs/TESTING.md`.

## Test application

- `createTestApplication({features, adapters?, overrides?, mode?, authorize?}): {app, calls, clock, ids}` — auto-binds uncovered port ops to recording fakes (store→memory, time→clock, random→ids, other→throwing stub); `mode` defaults to `"test"`.
- `TestCallLog` — `all()`, `of(effectId)`, `reset()`; entries are `RecordedEffectCall`s of auto-bound/overridden ops only.
- Types: `TestApplicationDefinition`, `TestApplication`, `TestOverrideHandler`.

## HTTP driver

- `testHttp(handler): TestHttpClient` — drives any `{fetch(request)}` object; no socket.
- Client: `get/delete(path, opts?)`, `post/put/patch(path, body?, opts?)`, `request({method, path, body?, headers?, principal?, token?})`.
- Response: `{status, body (JSON-parsed or undefined), headers, text}`.
- `TEST_PRINCIPAL_HEADER` — `"x-agentix-test-principal"`; carries the JSON `principal` option for a test authenticate hook.
- Types: `TestHttpHandler`, `TestHttpClient`, `TestHttpRequest`, `TestHttpRequestOptions`, `TestHttpResponse`.

## Harnesses

- `testCommand({application, operation, input, principal?, trace?}): Promise<DispatchResult>` — trace defaults on; default principal grants exactly the operation's permissions.
- `testQuery({...})` — same for queries; both reject descriptors of the wrong kind.
- Types: `HarnessApplication`, `OperationHarnessOptions`, `OperationHarnessResult`.

## Deterministic capabilities

- `createDeterministicClock({start?, stepMs?, project?}?): DeterministicClock` — `now()` advances by `stepMs`; `peek/advanceBy/set/reset/calls`.
- `createDeterministicIdGenerator({prefix?, start?, padding?, values?}?): DeterministicIdGenerator` — `next/peek/reset/calls`; `"id-1"` by default.
- Types: `DeterministicClock`, `DeterministicClockOptions`, `DeterministicIdGenerator`, `DeterministicIdGeneratorOptions`.

## Recording and scripting

- `createRecordingAdapter(port, handlers): RecordingAdapter` — a passable `BoundPortAdapter` plus `calls()`/`reset()`.
- `createScriptedEffect<Input, Output>(steps): ScriptedEffect` — `{handler, remaining, reset}`; steps are `{status:"returned", output}` or `{status:"threw", error}`.
- Types: `RecordingAdapter`, `RecordingPortImplementation`, `RecordedEffectCall`, `ReturnedEffectCall`, `ThrownEffectCall`, `EffectHandler`, `ScriptedEffect`, `ScriptedEffectStep`, `Awaitable`.

## Adapter contracts

- `defineAdapterContract<Adapter>({id, cases}): AdapterContract` — typed cases (`{id, operation, input, assert}`) per adapter function.
- `runAdapterContract(contract, adapter): Promise<AdapterContractResult>` — `{contractId, passedCases}`.
- Types: `AdapterContract`, `AdapterContractResult`, `ContractAdapter`.

## Ensures

- `checkEnsures(operation, {input, output}): readonly string[]` — violated ensure names.
- `assertEnsures(operation, context): void` — throws `EnsureViolationError`.
- `checkEnsuresProperty({operation, contexts, parameters?}): void` — seeded fast-check property (reproducible defaults).
- Types: `EnsureContextOf`, `CheckEnsuresPropertyOptions`; class `EnsureViolationError`.

## Traces and association

- `assertEffectSequence(trace, effectIds)` / `assertEventSequence(trace, eventIds)` — exact ordered ids.
- `assertTraceEquals(actual, expected)`; `assertNoEffects(trace)`; `assertNoEvents(trace)`; class `TraceAssertionError`.
- `defineOperationTest({id, operation})` / `associateOperationTest(operation, id?)` — compiler-readable operation↔test markers.
- Types: `ExecutionTraceLike`, `EffectTraceLike`, `EventTraceLike`, `AssociableOperation`, `OperationTestAssociation`, `DefineOperationTestOptions`.
