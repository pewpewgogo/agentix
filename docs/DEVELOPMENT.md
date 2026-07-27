# Developing Agentix

This guide covers framework, example-application, documentation, and benchmark
changes in the Agentix monorepo.

## Toolchain and setup

The repository supports Node.js `>=22.12.0 <25` (Node.js 22.12+ or 24) with
npm 11. The root package declares the accepted ranges and pins the npm release
used to create the lockfile. CI verifies every change on both Node.js 22 and
24; releases are built and published on Node.js 24.

```sh
git clone git@github.com:pewpewgogo/agentix.git
cd agentix
npm ci
npm run build
npm run verify
```

The workspace uses strict TypeScript project references, NodeNext ESM, and
Vitest. Relative TypeScript imports use `.js` suffixes.

## Repository map

```text
packages/
  core/                 schemas, descriptors, outcomes, dispatch
  adapters-http/        Web Request/Response routes and Node host
  testing/              deterministic application-testing helpers
  compiler/             architecture analysis and index generation
  cli/                  repository-local agentix binary

examples/
  shared-contract/      common black-box commerce behavior
  framework-app/        Agentix commerce application
  plain-app/            equivalent strict TypeScript control

benchmarks/
  tasks/                versioned maintenance-task specifications
  fixtures/             frozen application snapshots
  evaluator/            public and hidden-check infrastructure
  harness/              isolated agent runner and telemetry boundary
  runtime/              runtime and exploratory HTTP measurements
  results/              immutable raw evidence
  reports/              derived report generation
```

Framework packages must not import examples or benchmark code. Core must not
depend on the compiler, CLI, HTTP adapter, or testing package.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build every project reference and mark CLI binaries executable |
| `npm run clean` | Remove TypeScript and generated build output |
| `npm run typecheck` | Strict workspace project-reference check |
| `npm test` | Complete Vitest suite |
| `npm run test:unit` | Framework package tests |
| `npm run test:acceptance` | Shared black-box behavior for both applications |
| `npm run test:phase5` | Benchmark evaluator/harness/report/runtime checks |
| `npm run benchmark:corpus:check` | Verify the frozen two-arm fixture corpus |
| `npm run benchmark:harness:smoke` | Validate harness mechanics without a provider study |
| `npm run benchmark:runtime:smoke` | Run the small preregistered runtime smoke |
| `npm run benchmark:http-frameworks` | Run the exploratory three-framework HTTP smoke |

Use workspace commands for a fast edit loop:

```sh
npm run typecheck --workspace @agentix/core
npm test --workspace @agentix/core
npm test --workspace @agentix/framework-app
```

Before handing off a framework change, run at least:

```sh
npm run typecheck
npm test
git diff --check
```

Add the acceptance and corpus checks whenever application behavior, compiler
selection, fixtures, or benchmark inputs could change.

## Framework change rules

- Keep TypeScript source authoritative; generated indexes are projections.
- Preserve explicit registration and dependency injection. Do not introduce a
  global registry, decorator scan, or hidden lifecycle.
- Return declared `Outcome` values for expected failures. Preserve the separate
  rejection and fault paths.
- Treat ambient time, randomness, filesystem, databases, environment variables,
  and external calls as explicit ports in domain code.
- Keep queries free of write effects and emitted events.
- Validate new behavior with runtime tests and compile-time misuse tests where
  types are part of the contract.
- Update [API reference](API_REFERENCE.md), [core concepts](CORE_CONCEPTS.md), or
  the relevant guide when a public export or default changes.

## Application feature checklist

When adding a feature to an Agentix application:

1. Put its public schemas and port/event descriptors in `contract.ts`.
2. Use literal, application-wide stable IDs.
3. Declare commands and queries directly with `defineCommand`/`defineQuery`.
4. Import other features only through public contracts and list them in the
   feature descriptor's `dependencies`.
5. Bind every required port exactly once at application construction.
6. Associate focused tests with operations using `defineOperationTest`.
7. Run `agentix inspect`, `affected`, and `verify` against the application root.
8. Run shared black-box tests for externally visible behavior.

The compiler recognizes conventional descriptors under
`src/features/<feature>`. Dynamic or highly indirect declaration construction
can become unresolved and widen verification.

## Documentation changes

- Put user workflow first; keep research protocol and benchmark claims in their
  dedicated documents.
- State pre-1.0 status, and never claim a version is on npm until the registry
  confirms that exact version.
- Make default HTTP envelopes distinct from application-specific mappings.
- Explain whether a code block is complete or illustrative.
- Run the documented command against the current repository before merging.
- Check relative Markdown links and use source-backed numbers for benchmark
  results.

## Generated and evidence files

`.agentix/index.json`, build output, and TypeScript build-info files are
generated and ignored. Do not hand-edit them.

Benchmark evidence has a stricter boundary:

- the v1 fixture source pin and entry hashes are immutable; a new product
  baseline requires a new corpus version, whose references are changed only
  through the documented workflow and reviewed as an experiment change;
- raw result files are create-only evidence, not scratch output;
- smoke runs cannot be relabeled as confirmatory evidence;
- runtime results stay separate from agent-maintenance results; and
- unavailable provider telemetry remains unavailable—it is never estimated.

Read the subsystem README before changing files under `benchmarks/` and record
protocol changes in [DECISIONS.md](DECISIONS.md) before observing new results.

## Publishing boundary

Do not run `npm publish` directly or edit package versions by hand. Add a
changeset for a user-visible framework change; the fixed package group then
calculates one coordinated version for all five public packages. The main-branch
release workflow runs the complete build, test, and frozen-corpus gate before it
updates the release pull request or publishes with npm provenance.

The API is pre-1.0: semantic versioning applies, but a coordinated minor release
may contain breaking changes until 1.0. Examples, sandboxes, benchmarks, and the
repository root stay private and are never published. See
[RELEASING.md](RELEASING.md) for the operational runbook and npm trust setup.

## Known minor findings (v2 final review, 2026-07-27)

The v2 overhaul's final adversarial review fixed every reproduced major
finding; these reproduced minors remain open by choice:

- The three sandbox arms diverge on paths outside the compared request matrix
  (for example 405 handling); the sandbox README scopes the claim and the arms
  stay minimal by design.
- `createTestApplication` offers no reset for auto-bound store state
  (`calls.reset()` clears only the log) — create a fresh application per test.
- Store-port detection in `createTestApplication` is structural (get/save/
  delete/list keys plus kinds) and can false-positive on a hand-built
  lookalike port; a preset tag on `port.store` descriptors is the clean fix.
- `ensures` checks receive the validated output object itself in dev/test, so
  a mutating check could alter the returned value — keep checks pure.
- `emit` called after a dispatch settles throws `EVENT_OUTSIDE_EXECUTION` into
  the caller's context (timer or floating promise) rather than latching a
  dispatch fault.
