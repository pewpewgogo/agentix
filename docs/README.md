# Agentix Documentation

This is the entry point for using, extending, and evaluating Agentix. If you are
new to the framework, follow the learning path in order. The research documents
are kept separate so experimental claims do not leak into product guidance.

## Learn Agentix

1. [Getting started](GETTING_STARTED.md) — set up the repository, inspect the
   sample application, declare a feature, dispatch a command, and add HTTP.
2. [Core concepts](CORE_CONCEPTS.md) — schemas, operations, ports, outcomes,
   events, invariants, application assembly, and the dispatch lifecycle.
3. [HTTP adapter](HTTP.md) — routes, authentication, response mapping, and the
   Node listener.
4. [Testing](TESTING.md) — deterministic operation tests, traces, port contracts,
   invariant checks, and replay.
5. [CLI and generated index](CLI.md) — inspect, graph, affected analysis,
   verification, scaffolding, and index semantics.
6. [API reference](API_REFERENCE.md) — public package exports and behavioral
   contracts.

The complete runnable reference application is
[`examples/framework-app`](../examples/framework-app/src). Its plain TypeScript
counterpart is [`examples/plain-app`](../examples/plain-app/src); both share the
same black-box acceptance contract.

## Design and development

- [Architecture](ARCHITECTURE.md) is the frozen experiment-design record. Some
  implementation-status wording is historical; use [core concepts](CORE_CONCEPTS.md)
  and [API reference](API_REFERENCE.md) for current behavior.
- [Development guide](DEVELOPMENT.md) covers setup, repository commands, change
  checklists, and evidence hygiene.
- [Decision log](DECISIONS.md) records accepted tradeoffs and rejected
  alternatives.
- [Limitations](LIMITATIONS.md) preserves the frozen threats-to-validity record;
  later mitigations remain documented separately rather than rewriting the
  intervention context.

## Empirical study

These documents define the research intervention and must not be silently
changed in response to results:

- [Hypothesis and evaluation contract](HYPOTHESIS.md)
- [Agent-maintenance benchmark protocol](BENCHMARK_PROTOCOL.md)
- [Phase 5 readiness and Phase 6 blockers](PHASE5_READINESS.md) — historical
  gate snapshot
- [Exploratory HTTP framework benchmark](HTTP_FRAMEWORK_BENCHMARK.md)
- [Benchmark subsystem](../benchmarks/README.md)

Runtime measurements and coding-agent maintenance measurements are separate.
The exploratory HTTP result cannot establish that Agentix saves coding-agent
tokens, files, or tool calls.

## Current release boundary

All `@agentix/*` packages are private workspace packages at version `0.0.0`.
There is no npm release, compatibility promise, deployment, or published API
stability policy. The supported way to evaluate Agentix today is to clone this
repository and use its pinned Node.js 24/npm 11 toolchain.
