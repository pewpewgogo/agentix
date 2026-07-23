# Agentix

Agentix is an agent-oriented TypeScript application framework. This repository
tests whether explicit feature capsules and machine-readable
dependency metadata reduce the context coding agents need for TypeScript
maintenance without reducing correctness.

The research contract is fixed in:

- [`docs/HYPOTHESIS.md`](docs/HYPOTHESIS.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/BENCHMARK_PROTOCOL.md`](docs/BENCHMARK_PROTOCOL.md)
- [`docs/DECISIONS.md`](docs/DECISIONS.md)
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)
- [`docs/PHASE5_READINESS.md`](docs/PHASE5_READINESS.md)

Phases 2–5 are implemented: framework packages and two independently implemented
commerce applications pass strict builds, architecture checks, property tests,
and the same black-box acceptance suite. The repository also contains a frozen
paired ten-task corpus, isolated runner, raw telemetry/accounting boundary,
evaluator, runtime benchmark, and integrity-bound report generator. Nothing is
published or deployed.

The 100-run confirmatory experiment has not been run. It remains gated on an
initial clean Git commit, production hidden-evaluator drivers, an approved
external-provider adapter, exact immutable model/version and pricing,
runtime-verifiable fresh-session sandboxing, and the explicit cost authorization
required by the protocol. Scripted smoke outcomes are permanently ineligible
for a framework verdict; the current verdict is `INCONCLUSIVE`.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:phase5
npm run benchmark:corpus:check
npm run benchmark:harness:smoke
```

Exact tool versions are pinned in `package-lock.json`. Generated agent indexes
are projections of TypeScript source and are never authoritative.
