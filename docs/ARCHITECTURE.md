# Agentix Architecture

Status: Phase 1 design implemented through the Phase 5 engineering gate.

## Design objective

The framework makes the smallest safe maintenance scope explicit and
machine-discoverable while keeping application behavior in ordinary TypeScript.
It should help an agent answer four questions without surveying the repository:

1. Where is the public operation or feature contract?
2. What can the operation read, change, emit, or call?
3. Which consumers, invariants, and tests can this change affect?
4. What is the narrowest verification command that is still safe?

Bounded context is the optimization. Concision that hides control flow,
registration, or external effects is rejected.

## Design principles

- TypeScript source is authoritative. Generated metadata is disposable.
- All registration occurs through explicit values imported by the application.
- Domain execution receives only declared capabilities.
- Source-level checks supplement, but do not overstate, type-level guarantees.
- Public identifiers are stable strings suitable for indexes and telemetry.
- Dependencies form a visible directed graph.
- Narrow verification is allowed only when dependency information proves that it
  is safe; otherwise the CLI widens the scope.
- Framework packages never import an example or benchmark package.
- The plain application shares behavior and tests, not framework internals.

## Repository layout

```text
packages/
  core/                 descriptors, schemas, results, dispatcher, graph model
  testing/              deterministic harnesses and contract-test helpers
  compiler/             source analysis and deterministic index generation
  cli/                  inspect, graph, affected, verify, scaffold
  adapters-http/        explicit request/response adapter

examples/
  shared-contract/      transport-neutral acceptance contract and scenarios
  framework-app/        application built from feature capsules
  plain-app/            fair strict-TypeScript baseline

benchmarks/
  tasks/                frozen versioned task specifications
  fixtures/             immutable starting snapshots or fixture manifests
  evaluator/            public and evaluator-only checks
  harness/              isolated runner and provider telemetry adapters
  results/              append-only raw result records
  reports/              reproducible derived reports

docs/
  HYPOTHESIS.md
  ARCHITECTURE.md
  BENCHMARK_PROTOCOL.md
  LIMITATIONS.md
  DECISIONS.md
```

The workspace will use npm workspaces, a committed lockfile, strict TypeScript
project references, ECMAScript modules, and a pinned Node.js major version. The
exact toolchain versions will be recorded when Phase 2 begins.

## Package dependency direction

```text
testing ----------> core <---------- adapters-http
                      ^
                      |
compiler ------------+
   ^                  |
   |                  |
  cli ----------------+

framework-app ------> core, testing, adapters-http
plain-app ----------> shared behavior contracts only
benchmark evaluator -> both applications through public HTTP/process surfaces
```

`core` has no dependency on the compiler, CLI, adapters, examples, or benchmark.
`compiler` understands the source declaration shapes exported by `core`, but
core execution never requires a generated index. `cli` orchestrates compiler,
test, and TypeScript processes without becoming an application runtime.

## Feature capsules

A feature capsule is a normal directory with a single public entry point and an
explicit descriptor:

```text
src/features/orders/
  contract.ts           public schemas, operation handles, events, port contracts
  feature.ts            explicit feature descriptor and dependencies
  model.ts              private domain types and pure rules
  operations.ts         commands and queries, split only when needed
  invariants.ts         executable local and cross-feature policies
  orders.test.ts        tests associated by descriptor references
```

Small features should stay near this shape so a localized task can be understood
from three to five source files. Large files may be split by operation, but the
machine index must point directly to the relevant declaration and tests.

Cross-feature imports may target only a feature's public `contract.ts` entry
point or its package export. An import from another feature's `model.ts`,
`operations.ts`, `invariants.ts`, or other private path is an architecture error.
The rule applies to static imports, dynamic imports, and type-only imports.

Each feature declares dependencies by stable feature ID. The compiler verifies
that imported public contracts agree with the declared dependency list. A
dependency that is declared but unused is a warning; a cross-feature import that
is not declared is an error.

A proposed declaration shape is:

```ts
export const orders = defineFeature({
  id: "orders",
  contract: ordersContract,
  dependencies: [customersContract, productsContract],
  operations: [createOrder, getOrder],
  invariants: [paidOrderHasPayment],
});
```

This value has no global side effect. The application imports it and passes it
to `createApplication` explicitly.

## Schemas and nominal identifiers

`core` provides a deliberately small schema interface and constructors for the
types needed by the example application:

```ts
export interface Schema<T> {
  readonly description: SchemaDescription;
  parse(value: unknown): T;
  safeParse(value: unknown): ParseResult<T>;
}

export type Infer<S extends Schema<unknown>> =
  S extends Schema<infer T> ? T : never;
```

The first implementation supports strings, numbers, booleans, literals,
arrays, objects, optional fields, unions, refinements, and branded IDs. Schema
descriptions are plain immutable data so the compiler can project them without
runtime reflection. Parsers produce structured issues with stable paths and
codes.

The schema API is intentionally not a general replacement for mature validation
libraries. The plain baseline may use an established validation library rather
than an artificially weak clone. Shared black-box tests, not shared validators,
establish equivalence.

## Operations

Commands and queries are immutable descriptors. A command declaration is
expected to converge on this shape during Phase 2:

```ts
export const createOrder = defineCommand({
  id: "orders.create",
  input: CreateOrderInput,
  output: Order,
  errors: {
    CUSTOMER_NOT_FOUND: CustomerNotFound,
    PAYMENT_FAILED: PaymentFailed,
  },
  permissions: ["orders:create"],
  effects: {
    loadCustomer: CustomerReader.get,
    loadProduct: ProductReader.get,
    chargePayment: Payments.charge,
    saveOrder: OrderStore.save,
    now: Clock.now,
    nextId: IdGenerator.next,
  },
  emits: {
    orderCreated: OrderCreated,
  },
  invariants: [paidOrderHasPayment],
  async execute({ input, effects, emit }) {
    // Ordinary TypeScript. Only the capabilities above are in this context.
  },
});
```

The field called `effects` includes reads, writes, time, randomness, and remote
calls. Its purpose is capability disclosure rather than a claim that every call
mutates state. Each referenced port operation carries metadata such as
`kind: "read" | "write" | "time" | "random" | "external"`.

Command execution returns a typed `Outcome<Output, DeclaredError>` rather than
throwing expected domain errors. Unexpected exceptions are defects and are
reported separately. Queries use the same declaration model but must not declare
write effects or emitted domain events; the compiler rejects either.

Stable IDs are unique across an application. Input and output are validated at
the dispatch boundary. The execution context is constructed from the exact
declared effect map and event map, which prevents accidental access to another
injected capability at the type and runtime levels.

## Ports and explicit effects

A port is a named collection of independently referenceable operations:

```ts
export const Payments = definePort({
  id: "payments",
  operations: {
    charge: portOperation({
      id: "payments.charge",
      kind: "external",
      input: ChargeInput,
      output: ChargeResult,
      errors: { DECLINED: PaymentDeclined },
    }),
  },
});
```

Adapters implement complete port contracts and are bound explicitly at
application construction. The runtime validates adapter results in every mode.
The testing package supplies deterministic fakes for clocks, ID generation,
storage, and service calls and records effect traces for replay.

Three layers enforce effect declarations:

1. The operation's generic execution context contains only its declared port
   operations.
2. The dispatcher wraps bound port operations and rejects any invocation whose
   stable ID is not declared for the active operation.
3. The architecture checker rejects forbidden ambient capabilities in domain
   files, including direct `fetch`, `process.env`, Node filesystem and database
   imports, direct clock construction, and ambient randomness.

Static checks cannot secure hostile JavaScript or dependencies. They are
application architecture checks, not a sandbox. This boundary is stated in
`LIMITATIONS.md` and must be represented accurately in reports.

## Authorization

Operations declare required permission strings. A trusted inbound adapter
constructs a request principal with granted permissions; the dispatcher checks
the declaration before validating effects or running execution. Denial produces
a stable framework result and no command effect is invoked.

Role-to-permission resolution belongs to an explicit application port or inbound
adapter, not to global framework state. Tests cover both denied dispatch and
application-specific authorization rules. The generated index lists permissions
and reverse-maps them to operations.

## Events

Events are schema-backed public descriptors with stable IDs and versions.
Commands receive an emitter limited to their declared event map. Emitted payloads
are validated, returned as completed-dispatch data, and appended to the execution
trace when tracing is enabled. Persistence or publication is an explicit adapter
decision; the core does not install a hidden event bus.

The initial application will use an explicit unit-of-work boundary supplied by a
storage port. It will define when state and an event outbox commit together. A
command cannot claim atomicity across an arbitrary payment service and local
storage; compensation or idempotency behavior must be modeled in application
code and tested.

## Executable invariants

An invariant is a pure, named predicate over schema-validated evidence:

```ts
export const paidOrderHasPayment = defineInvariant({
  id: "orders.paid-has-payment",
  dependsOn: [ordersContract, paymentsContract],
  evidence: PaidOrderEvidence,
  check(evidence) {
    return evidence.order.status !== "paid" || evidence.payment !== undefined;
  },
});
```

Invariants do not run through a hidden lifecycle. An operation explicitly lists
the invariants it promises to preserve. Its tests or application service provide
the required evidence and execute the check. `agentix verify` includes linked
invariant tests and all operations listed as preservers. Cross-feature invariants
are owned by the feature whose policy they express and may depend only on public
contracts.

The initial implementation favors explicit postcondition calls in command code
or test harnesses over automatic production checks. This keeps timing and I/O
visible. Whether optional production assertions are valuable is an experiment,
not a Phase 2 assumption.

## Application assembly and dispatch

Application construction is explicit:

```ts
const app = createApplication({
  features: [customers, products, orders],
  adapters: {
    customerStore,
    orderStore,
    payments,
    clock,
    ids,
  },
});
```

Construction validates unique IDs, feature dependencies, complete adapter
bindings, and descriptor consistency. There is no global registry, module scan,
decorator, service locator, or implicit lifecycle hook.

Dispatch follows a fixed visible sequence:

1. Resolve the operation by stable ID.
2. Check the principal's required permissions.
3. Parse input.
4. Build the exact effect and emitter contexts.
5. Call `execute` and drain every effect it started.
6. Fail on any latched effect/event boundary fault.
7. Validate declared success or error output.
8. Return the outcome and emitted events, plus an optional trace.

Application code may call a descriptor directly through the same dispatcher in
tests; HTTP is only one inbound adapter.

## HTTP adapter

`adapters-http` maps explicit route descriptors to Web-standard `Request` and
`Response` values. A route names an operation, maps request data to its input,
and maps its typed outcome to a response. Route registration is a normal array.
The adapter owns authentication extraction and transport concerns, while the
operation owns permissions and domain behavior.

The first implementation will use Node's HTTP server only as a thin host. No
router discovery, controller decorators, or framework-specific lifecycle is
introduced.

## Compiler and generated index

The compiler uses the TypeScript compiler API to inspect source declarations,
imports, and inferred descriptor types. It never treats the index as input to
application execution. Unresolved or non-literal metadata is recorded as
diagnostics/unresolved state in the generated projection; `verify` fails or
widens rather than allowing a narrow correctness claim.

The canonical projection is `.agentix/index.json`, with a versioned JSON schema
and normalized, repository-relative POSIX paths. Arrays are sorted by stable ID,
object keys are emitted deterministically, and no timestamp or machine-specific
absolute path appears in the payload. Re-running generation without source
changes must produce identical bytes.

The index includes:

- compiler and index schema versions;
- features and source spans;
- public contract exports;
- operations and their kind, schemas, errors, permissions, effects, events, and
  linked invariants;
- ports and known adapters;
- dependencies and reverse consumers;
- tests associated through typed testing-helper references and naming fallback;
- architecture violations;
- direct and transitive likely-affected operations; and
- reasons for every affected edge.

Source locations are hints and include file plus declaration line. Programmatic
staleness checks compare schema/compiler versions and a deterministic source
manifest. The CLI takes the stronger trust boundary: it reanalyzes TypeScript
for every answer and treats the on-disk index only as disposable output.

## Affected-set algorithm

The compiler builds a directed graph over source files, public contracts,
features, operations, ports, events, invariants, adapters, and tests. An item is
directly affected when it owns or imports the changed declaration. Transitive
closure follows public-contract consumers, event consumers, invariant
dependencies, adapter implementations, and associated tests.

Every selected node carries a reason such as:

```text
orders.create -> orders.create.test [declared operation test]
orders.contract -> shipping.quote [public contract consumer]
payments.charge -> stripe-adapter [port implementation]
```

Ambiguity widens scope. Changes to workspace configuration, core framework
types, shared schema utilities, compiler rules, or an unresolved dynamic import
select the whole application. Safety is favored over a falsely narrow result.

## CLI contract

The binary is `agentix`. Human output is concise and deterministic; `--json`
uses versioned schemas and stable ordering.

```text
agentix inspect <feature-or-operation> [--json [--compact]]
agentix inspect <operation> --full [--json [--compact]]
agentix graph [<feature>] [--format text|json|dot] [--json [--compact]]
agentix affected <feature-or-file> [--json [--compact]]
agentix verify <feature-or-operation> [--json [--compact]]
agentix scaffold feature <name> [--dry-run] [--json [--compact]]
```

`--compact` preserves the stable JSON schema and key ordering while removing
indentation for agent and machine transport. It requires `--json`.

- `inspect` shows contract, dependencies, consumers, permissions, effects,
  events, invariants, source locations, tests, and suggested verification.
  Operation JSON is hard-limited to 8 KiB and reports every summarized
  collection through projection omissions.
- `graph` shows dependency and reverse-consumer edges and can emit DOT without
  needing a graph-rendering dependency.
- `affected` prints the conservative closure and reasons for inclusion.
- `verify` regenerates/validates the index, runs architecture checks, runs a
  narrow TypeScript project check only where project references make that safe,
  and runs selected tests. It widens to full checks when safety is uncertain.
- `scaffold` creates a conventional capsule skeleton using public templates. It
  refuses to overwrite existing paths and supports a no-write preview.

Exit codes distinguish success, verification failure, invalid invocation, and
internal tool failure. JSON output never mixes diagnostics on stdout; human
diagnostics go to stderr.

## Testing package

`testing` provides:

- `testCommand` and `testQuery` harnesses with deterministic port fakes;
- effect and event trace assertions;
- reusable adapter contract suites;
- deterministic replay from recorded inputs and fake-effect responses;
- invariant generators and checks integrated with a property-testing library;
- helpers whose operation references let the compiler associate tests; and
- compile-time fixtures run with `tsc` and explicit expected errors.

Replay records are schema-versioned data, contain no functions, and verify that
the same command plus the same declared effect responses yields the same outcome
and event/effect sequence.

## Example application behavior

Both applications implement the same customer, product, order, and payment
flows. The shared acceptance contract will include:

- customer and product creation and lookup;
- order creation with deterministic IDs and time;
- product availability and customer status checks;
- authorization denial before effects;
- payment approval and decline behavior;
- persistent storage through an explicit port or baseline repository interface;
- an order-created domain event;
- at least one invariant spanning orders and payments; and
- identical HTTP status, response bodies, and externally observable state.

The framework implementation uses feature capsules. The plain implementation
uses a conventional layered or feature-oriented strict-TypeScript organization,
an established runtime validator, explicit dependency injection, and good tests.
It receives a clear README and normal scripts. It does not receive misleading
names, excessive file fragmentation, or intentionally missing documentation.

The evaluator launches each application behind the same black-box driver. Shared
scenario data controls time, identifiers, and payment results. Implementation-
specific architecture tests are supplementary and never replace behavior tests.

## Verification layers

The planned test matrix is:

| Layer | Purpose |
| --- | --- |
| Core unit tests | schemas, results, dispatch, authorization, traces |
| Compile-time tests | inferred input/output/error/effect types and rejected misuse |
| Architecture tests | feature boundaries and ambient-effect rules |
| Port contract tests | adapter conformance and structured errors |
| Replay tests | deterministic command behavior and traces |
| Index snapshots | deterministic complete projections |
| Property tests | schema round trips, invalid data, invariants |
| Shared end-to-end tests | black-box equivalence of both applications |
| Negative effect tests | unauthorized and undeclared calls fail before effects escape |
| Selection tests | `affected` and `verify` choose safe expected scopes |

## Incremental implementation plan

Phase 2 is split into runnable vertical increments:

1. Create the workspace, strict build, package boundaries, and CI-equivalent
   local scripts.
2. Implement schemas, typed outcomes, port descriptors, one command, and focused
   unit/type tests.
3. Add explicit application assembly, authorization, dispatch, effect tracing,
   deterministic test capabilities, and negative-effect tests.
4. Add feature and invariant descriptors plus architecture-boundary analysis.
5. Generate a minimal deterministic index for one fixture and snapshot it.
6. Add `inspect`, `graph`, `affected`, and conservative selection tests.
7. Add `verify` and scaffold dry-run/write behavior.
8. Add the minimal HTTP adapter and adapter contract tests.

Phase 3 builds one complete vertical order flow in both applications before
expanding customers and products. Phase 4 freezes shared behavior after all
black-box and deterministic tests pass. Phase 5 builds telemetry adapters and
uses inexpensive smoke runs to validate measurement, not the hypothesis. Phase
6 is allowed only after the protocol gates pass. Phase 7 derives reports solely
from immutable raw results.

Each increment must leave `build`, `typecheck`, and relevant tests runnable.
Failures are fixed before scope expands.

## Deferred alternatives

The first study does not add a conventional third framework. It also defers
automatic production invariant hooks, remote/distributed command transport,
event replay as an application persistence model, code generation that replaces
source declarations, and a plugin system. These may be useful, but each would
increase framework construction and learning cost before the two-arm comparison
is valid.
