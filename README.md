# Agentix

Agentix is an agent-oriented TypeScript application framework for codebases that
need explicit boundaries, effects, and maintenance scope. Application behavior
stays in ordinary TypeScript; descriptors make that behavior inspectable by
people, tools, and coding agents.

[Documentation site](https://pewpewgogo.github.io/agentix/) ·
[Documentation source](docs/README.md) · [Getting started](docs/GETTING_STARTED.md) ·
[Core concepts](docs/CORE_CONCEPTS.md) · [API reference](docs/API_REFERENCE.md) ·
[Example application](examples/framework-app/src)

> **Project status:** Agentix is a research prototype at version `0.0.0`. Its
> packages are private workspaces and are not published to npm. Use the
> repository directly; do not treat the API as stable yet.

## What Agentix makes explicit

An Agentix feature capsule owns its public contract, commands, queries, ports,
events, invariants, and associated tests. Every operation declares:

- a stable ID and runtime input/output schemas;
- typed domain errors and required permissions;
- the exact external effects it may invoke;
- the events and invariants associated with it; and
- an ordinary TypeScript execution function.

The runtime validates these boundaries. The compiler projects them into a
deterministic machine index, and the CLI reanalyzes source into that projection
to answer questions such as “what does this operation touch?” and “what is safe
to verify?” The generated file is never a trusted input; TypeScript source
remains the source of truth.

## Start here

Agentix currently requires Node.js 24 and npm 11.

```sh
git clone git@github.com:pewpewgogo/agentix.git
cd agentix
npm ci
npm run build
npm run verify
```

Inspect the complete commerce example without reading the whole application:

```sh
npm exec -- agentix inspect orders.create --root examples/framework-app
npm exec -- agentix graph orders --root examples/framework-app
npm exec -- agentix affected src/features/orders/operations.ts \
  --root examples/framework-app
```

The first command reports the operation's source, permission, effects, event,
invariant, tests, compiler trust, source digest, and conservative verification
scope in a hard-limited per-operation artifact. Any omitted collection is
reported in `projection.omissions` with a machine-readable next action. Continue
with the [getting-started guide](docs/GETTING_STARTED.md) to define and dispatch
a small feature, then expose it through HTTP.

Compare the same notes behavior across Agentix, Express, and NestJS with:

```sh
npm run sandbox:test
npm run sandbox:token-budget
npm run benchmark:http-frameworks -- --no-process
```

See the [three-arm benchmark runbook](benchmarks/THREE_ARM_RUNBOOK.md) before
interpreting calibration, runtime, or paid live-agent results.

## A command at a glance

```ts
export const createOrder = defineCommand({
  id: "orders.create",
  input: CreateOrderInput,
  output: Order,
  errors: {
    CUSTOMER_NOT_FOUND: CustomerNotFound,
    PAYMENT_DECLINED: PaymentDeclined,
  },
  permissions: ["orders:create"],
  effects: {
    loadCustomer: CustomerStore.operations.get,
    chargePayment: Payments.operations.charge,
    saveOrder: OrderStore.operations.save,
  },
  emits: { orderCreated: OrderCreated },
  async execute({ input, effects, emit }) {
    // Ordinary TypeScript. Only the effects declared above are available.
  },
});
```

There are no decorators, global registries, runtime source scans, or implicit
lifecycle hooks. Expected domain failures are typed `Outcome` values;
authorization or invalid input is a rejected dispatch; unexpected defects are
reported separately as faults. Completed dispatches return validated emitted
events; delivery and persistence remain explicit application concerns.

## Packages

| Package | Responsibility |
| --- | --- |
| `@agentix/core` | Schemas, descriptors, outcomes, application assembly, authorization, and dispatch |
| `@agentix/adapters-http` | Explicit routes over Web `Request`/`Response` plus a thin Node HTTP host |
| `@agentix/testing` | Operation harnesses, deterministic capabilities, traces, contracts, invariants, and replay |
| `@agentix/compiler` | Architecture analysis and deterministic `.agentix/index.json` generation |
| `@agentix/cli` | `inspect`, `graph`, `affected`, `verify`, and `scaffold` |

See the [API reference](docs/API_REFERENCE.md) for the supported public exports.

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Core concepts and execution model](docs/CORE_CONCEPTS.md)
- [HTTP adapter](docs/HTTP.md)
- [Testing](docs/TESTING.md)
- [CLI and generated index](docs/CLI.md)
- [API reference](docs/API_REFERENCE.md)
- [Repository development](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md) — frozen experiment design record; use
  the core-concepts and API guides for current behavior

## Research status

Agentix was built to test a falsifiable hypothesis: explicit feature capsules
and machine-readable dependency metadata may reduce the context coding agents
need for maintenance without reducing correctness. The framework and plain
TypeScript commerce applications pass the same black-box acceptance suite, but
the 100-run confirmatory agent-maintenance experiment has **not** been run. The
current verdict is `INCONCLUSIVE`.

The separate Agentix/Express/NestJS HTTP measurement is an exploratory runtime
microbenchmark, not evidence for agent-maintenance efficiency. Read its methods,
results, and limitations in the
[HTTP framework benchmark report](docs/HTTP_FRAMEWORK_BENCHMARK.md).

The preregistered evidence boundary lives in:

- [Hypothesis](docs/HYPOTHESIS.md)
- [Benchmark protocol](docs/BENCHMARK_PROTOCOL.md)
- [Phase 5 readiness](docs/PHASE5_READINESS.md) — historical gate snapshot
- [Limitations](docs/LIMITATIONS.md) — frozen threats-to-validity record
- [Decision log](docs/DECISIONS.md)

The documentation is published with GitHub Pages. The framework packages are
not published to npm and the benchmark evidence remains repository-local.
