# Agentix Documentation

This is the entry point for using, extending, and evaluating Agentix. If you
are new to the framework, follow the learning path in order. The research
documents are kept separate so experimental claims do not leak into product
guidance.

## Learn Agentix

1. [Getting started](GETTING_STARTED.md) — one feature from install to
   verified HTTP endpoint: feature file, app shell, `serveNode`, HTTP-level
   test, `agentix inspect`.
2. [Authoring cheat sheet](AUTHORING.md) — the canonical single-file feature
   and the 2-file change recipe. Read before your first change.
3. [Core concepts](CORE_CONCEPTS.md) — operations, ports and adapters,
   effects, outcomes vs rejections vs faults, events, ensures, modes,
   authorization.
4. [HTTP adapter](HTTP.md) — auto-derived routes, the fixed envelope,
   authentication, overrides, Node and edge hosts.
5. [Persistence](PERSISTENCE.md) — database adapters, lifecycle hooks, the
   transaction/unit-of-work recipe, outbox sketch, testing strategy;
   canonical reference: [`examples/pg-notes`](../examples/pg-notes).
6. [Testing](TESTING.md) — `createTestApplication`, `testHttp`, harnesses,
   deterministic capabilities, contracts.
7. [CLI and generated index](CLI.md) — inspect artifacts, one-shot change
   context packs (`agentix context`), graph, affected scope, narrow
   verification, OpenAPI 3.1 export (`agentix openapi`), scaffolding, cache
   semantics.
8. [API reference](API_REFERENCE.md) — every public export of the five
   packages (each package also ships its own `API.md`).
9. [Releasing](RELEASING.md) — coordinated versions, release pull requests,
   npm publishing, provenance.

The complete runnable reference application is
[`examples/framework-app`](../examples/framework-app/src). Its plain
TypeScript counterpart is [`examples/plain-app`](../examples/plain-app/src);
both share the same black-box acceptance contract. The three-arm comparison
apps live in [`sandbox/`](../sandbox).

## Design and development

- [Architecture](ARCHITECTURE.md) is the frozen v1 experiment-design record
  with an appended, dated v2 revision section listing superseded principles.
  Use [core concepts](CORE_CONCEPTS.md) and the [API reference](API_REFERENCE.md)
  for current behavior.
- [Development guide](DEVELOPMENT.md) covers setup, repository commands,
  change checklists, and evidence hygiene.
- [Decision log](DECISIONS.md) records accepted tradeoffs and rejected
  alternatives.
- [Limitations](LIMITATIONS.md) preserves the frozen threats-to-validity
  record; later mitigations remain documented separately.

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

## Release boundary

The five framework packages are public, ESM-only, pre-1.0 packages under the
`@agentixdev/*` npm scope. They share one coordinated version and follow semantic
versioning, but minor releases may contain breaking API changes until 1.0.
Release automation publishes only built package artifacts plus each package's
`README.md`/`API.md`; benchmark fixtures, results, examples, and sandboxes
remain repository-only.
