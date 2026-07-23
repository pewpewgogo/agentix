# Decision Log

This file records choices that materially affect framework behavior or the
experiment. Superseded decisions remain in version control and are linked from
their replacements.

## D-001: Treat the complete framework as the primary intervention

- Date: 2026-07-23
- Status: accepted

The primary comparison evaluates capsules, declarations, indexes, and CLI tools
as one treatment. The hypothesis concerns their combined maintenance workflow.

Rejected: claim a causal effect for each primitive from the two-arm comparison.
That would require ablations and substantially more runs. Ablations remain
optional follow-up experiments with separate preregistration.

## D-002: Use a strong plain-TypeScript control

- Date: 2026-07-23
- Status: accepted

The control will use strict TypeScript, idiomatic explicit dependency injection,
a mature runtime-validation library, feature or layered organization, concise
documentation, and good tests. It will not use this framework's generated index
or CLI in the primary comparison.

Rejected: force both arms to use the framework's schema code or fragment the
control into excessive files. Either would contaminate the control or make it
artificially weak.

## D-003: TypeScript values are authoritative; indexes are projections

- Date: 2026-07-23
- Status: accepted

Operations, features, ports, events, and invariants are declared as imported
TypeScript values. The compiler derives a deterministic JSON index from source.
The runtime does not depend on this generated file.

Rejected: YAML manifests as the source of truth, decorator metadata, filesystem
auto-discovery, and generated operation source. These add a second authority or
hidden registration behavior.

## D-004: No global registry or implicit lifecycle

- Date: 2026-07-23
- Status: accepted

Applications explicitly pass features and adapter bindings to
`createApplication`. Events, invariants, and transactions have explicit call or
adapter boundaries.

Rejected: module-import side effects, service locators, automatic event-bus
subscription, and invisible post-command invariant execution. They reduce local
reasonability even when convenient.

## D-005: Declare capability-picked port operations

- Date: 2026-07-23
- Status: accepted for Phase 2 experiment

An operation maps local effect names to individual typed port operations. Its
execution context exposes only those capabilities. Effect IDs and categories are
derived from the port-operation descriptors, avoiding a second string list that
can drift.

Rejected: inject every application port into every command, or declare effect
strings separately from injected functions. The first makes undeclared access
easy; the second duplicates authority.

This API remains subject to usability and compile-time experiments before the
example application is frozen. A change must preserve explicitness and be logged.

## D-006: Expected domain failures use typed outcomes

- Date: 2026-07-23
- Status: accepted for Phase 2 experiment

Commands return a discriminated `Outcome` whose error variants are inferred from
the declared error-schema map. Unexpected exceptions represent defects.

Rejected: unchecked thrown strings/classes for expected failures. They do not
make the complete error contract visible to callers or the index.

## D-007: Effect control uses types, runtime guards, and source checks

- Date: 2026-07-23
- Status: accepted

The execution context limits typed access; dispatcher wrappers validate active
operation declarations; an architecture checker rejects known ambient I/O and
nondeterminism in domain files.

Rejected: describe those checks as a security sandbox. Ordinary JavaScript and
dependencies can evade static policy. The framework promises architectural
enforcement for cooperative application code, not hostile-code isolation.

## D-008: Invariants are executable but explicitly invoked

- Date: 2026-07-23
- Status: accepted for initial implementation

Invariants are named pure predicates over validated evidence. Operations declare
which invariants they preserve, and tests or explicit application code execute
them. `verify` follows these links.

Rejected: automatically execute all related invariants after every command.
Evidence acquisition could hide I/O and produce unpredictable runtime cost.

## D-009: Conservative verification widens on uncertainty

- Date: 2026-07-23
- Status: accepted

`affected` explains its dependency closure. `verify` uses narrow type and test
scopes only when project and dependency information prove them safe. Shared
configuration, core types, dynamic imports, stale metadata, and unresolved edges
widen verification to the application or workspace.

Rejected: always run only directly named tests. A fast but unsound verifier would
improve benchmark efficiency by hiding regressions.

## D-010: Use static source analysis for index generation

- Date: 2026-07-23
- Status: accepted for initial implementation

The compiler will use the TypeScript compiler API, accepting only statically
resolvable stable metadata. Application code is not executed to build the index.

Rejected: import compiled application modules to inspect descriptors. Imports
could perform arbitrary side effects and make generation depend on runtime
environment.

If compiler-API complexity makes the declaration API unreadable, the design must
be reconsidered rather than adding custom syntax.

## D-011: Start with two applications, not three

- Date: 2026-07-23
- Status: accepted

The framework and plain implementations are sufficient for the first valid
comparison. A conventional established-framework arm may be added only after
behavioral equivalence and reliable telemetry exist.

Rejected: add the third arm during initial construction. It increases fixture,
task, and repetition cost and could delay or weaken the primary experiment.

## D-012: Lock primary result rules before implementation

- Date: 2026-07-23
- Status: accepted

The provisional win condition, token missingness rules, category-improvement
definition, invalid-run rules, and repetitions are fixed in Phase 1. Any later
change is a protocol amendment and separates cohorts when results may have been
observed.

Rejected: tune thresholds or remove outliers after seeing favorable or
unfavorable results.

## D-013: Count all model context and keep correctness as a gate

- Date: 2026-07-23
- Status: accepted

Provider telemetry includes framework documentation, index output, and tool
results supplied to the model. Cached input remains part of accounted token use.
Failed runs retain their actual telemetry but are not assigned invented token
penalties. Efficiency is analyzed among successes only after checking success
non-inferiority.

Rejected: subtract framework context as a one-time cost, treat cached tokens as
zero context, or combine correctness and tokens into a compensatory score.

## D-014: Use npm workspaces and a small dependency surface

- Date: 2026-07-23
- Status: accepted

The workspace uses npm 11.13.0 workspaces, TypeScript 7.0.2 project references,
ES modules, Node 24, and exact dependency versions in the lockfile. Runtime
framework packages have no third-party runtime dependencies. Test/build-only
dependencies include Vitest 4.1.10 and fast-check 4.9.0.

Rejected: a custom build system, monorepo orchestrator, or package manager
requirement that does not materially serve the experiment. The installed
toolchain was checked before implementation and through a clean rebuild.

## D-015: Phase 1 produces design evidence only

- Date: 2026-07-23
- Status: accepted

No core framework code is written until the Phase 1 architecture, experimental
protocol, confounders, and implementation plan have been presented. Phase 1 is
validated through document consistency and explicit gate review rather than
invented implementation tests.

## D-016: Use TypeScript 7's explicit unstable compiler API exports

- Date: 2026-07-23
- Status: accepted with compatibility risk

TypeScript 7.0.2 no longer exposes program and AST APIs from the package root.
The compiler therefore imports the official `typescript/unstable/sync` and
`typescript/unstable/ast` entry points. The dependency is pinned exactly and the
scanner has fixture tests.

Rejected: execute compiled application modules to recover metadata, or pin an
older compiler only to retain a familiar API. Executing application source would
violate the source-analysis design and introduce environment-dependent effects.
The unstable entry-point risk is tracked in `LIMITATIONS.md`.

## D-017: Validate effect response schemas outside production hot paths

- Date: 2026-07-23
- Status: accepted for initial runtime measurement

Adapter calls must always return the structural `Outcome` shape. Development and
test modes additionally validate effect success/error payloads against their
schemas. Production skips that second payload parse while operation input,
output, domain errors, permissions, and emitted events remain validated.

Rejected: silently trust arbitrary non-`Outcome` adapter values in production.
The runtime benchmark will measure whether always-on effect payload validation
is affordable; this decision may be revisited before fixtures are frozen.

## D-018: Share only the black-box commerce contract between study arms

- Date: 2026-07-23
- Status: accepted

The two example applications share public request/response types, route and
error constants, and a reusable acceptance-suite factory. They do not share
business services, validation schemas, repositories, ports, routing code, or
domain implementations. The shared production entry point has no Vitest or
framework dependency; test registration is a separate subpath export.

Rejected: share domain services to make equivalence easy. That would measure two
wrappers around one implementation instead of framework versus plain TypeScript.

## D-019: Make concurrent stock and duplicate handling observable correctness

- Date: 2026-07-23
- Status: accepted

The plain control serializes the payment-and-commit order section and commits
state atomically. The framework application uses an explicit product reservation
effect, releases on payment decline or failed commit, and atomically rejects
duplicate storage writes. The shared suite requires one success for two
concurrent orders against one stock unit and one success for concurrent duplicate
customer/product creation.

Rejected: omit concurrency because the initial sequential suite passed. A
framework efficiency result built on overselling or duplicate-success behavior
would fail the correctness gate.

## D-020: Use deterministic default example infrastructure

- Date: 2026-07-23
- Status: accepted

Both example factories default to a fixed `2030-01-01T00:00:00.000Z` clock and
monotonic order IDs. Tests inject their own clocks and IDs. Real time remains an
adapter concern, but a deterministic default makes fixtures and differential
diagnostics reproducible.

Rejected: let the plain control default to ambient time while the framework
defaults to a constant. That produced an avoidable behavioral difference.

## D-021: Authorize HTTP operations before transport input mapping

- Date: 2026-07-23
- Status: accepted after independent equivalence audit

The HTTP adapter resolves the route and principal, then checks the operation's
declared permissions before invoking route-specific path/body mapping. A denied
request is represented as the same core-compatible `RejectedDispatch` shape
used by normal dispatch and flows through the route's response mapper. Core
dispatch repeats authorization as defense in depth.

Rejected: rely only on core authorization after parsing the HTTP body. That made
unauthorized malformed requests return validation details and differed from the
plain control.

## D-022: Keep shared production code symmetric and transport-only

- Date: 2026-07-23
- Status: accepted after independent equivalence audit

Both application arms import the same pure route, permission, status, envelope,
and standard-error constants from `shared-contract`. Neither imports shared
business services, repositories, schemas, commands, or domain logic. The
acceptance runner remains a test-only subpath.

Rejected: allow only the framework arm to reuse shared transport constants.
That could favor it in route, authorization, or error maintenance tasks for a
reason unrelated to feature capsules or generated metadata.

## D-023: Make creation claims and generated-ID compensation explicit

- Date: 2026-07-23
- Status: accepted after independent equivalence audit

Customer and product creation acquire an atomic per-ID claim before reading the
clock, so a concurrent duplicate loser consumes no time. Both arms release a
claim after construction failure. Order ID generators return an untrusted
string; both arms trim and reject blank IDs, and the framework releases its
stock reservation before returning the common internal-error response.

Rejected: rely on a final atomic insert after reading the clock, or encode an
unchecked generator callback as if it could only return a branded ID. Both
approaches hid observable failure behavior from the contract.

## D-024: Freeze initial runtime and automated-DX budgets from smoke data

- Date: 2026-07-23
- Status: accepted before any agent-maintenance result was observed

The runtime executable was calibrated in explicit `smoke` mode on the recorded
Apple M4 Max host (Node 24.16.0, npm 11.13.0, TypeScript 7.0.2). Thirty measured
samples per fast/process metric produced framework medians of 28.4 ms cold
start, 2.0 microseconds synthetic dispatch, 0.7/1.8 microseconds valid/invalid
schema parsing, 46.4 ms index generation, and a 4.1 MB retained-RSS delta for
100 live systems. One-sample fresh-workspace engineering probes measured 0.51 s
clean application build, 0.72 s full application type-check, and 0.96 s
incremental framework verification. These are calibration observations, not
hypothesis evidence.

Before confirmatory agent data, the following budgets are fixed for the frozen
host class and repository scale:

- framework cold-start median at most 100 ms and at most 2x the plain median;
- framework dispatch p95 at most 100 microseconds and median at most 5x plain;
- valid and invalid schema-validation p95 at most 100 microseconds and median at
  most 5x plain;
- index-generation median at most 500 ms and p95 at most 1 second;
- retained-RSS delta for 100 live framework systems at most 16 MiB;
- clean build and full type-check medians at most 5 seconds and at most 2x plain;
- localized incremental verification median at most 5 seconds and at most 2x
  the equivalent plain type-check-plus-test workflow; and
- zero failed benchmark commands or critical architecture/security findings.

Automated-DX acceptability additionally requires all documented CLI commands to
remain deterministic, no-overwrite scaffold behavior, strict type-checks, and a
successful full hidden regression run. Human comprehension/editor ergonomics
remain unmeasured and must be reported separately; these automated budgets do
not establish that humans prefer the framework.

Rejected: tune budgets after seeing maintenance-run outcomes, use relative-only
budgets where the plain operation is extremely small, or treat smoke timings as
evidence for the primary hypothesis.

## D-025: Freeze scheduling, analysis, and task time limits

- Date: 2026-07-23
- Status: superseded by D-027 before any confirmatory observation

The confirmatory run order is frozen in
`benchmarks/harness/config/confirmatory-schedule.v1.json`. It contains 100 slots
covering ten tasks, two arms, and five repetitions. The blocked-randomization
seed was `agentfw-commerce-v1-2026-07-23`, the schedule structural hash was
`63512f0c3cec1de88768ef813405485af948c2f74f9bc91b2e9cf947ae720199`, and
the schedule file hash was
`08439ce6e6f756452a79eb1bcf5e4006554f5ee2133587f429f7b903f4305c1d`.

Version-1 deterministic analysis does not bootstrap or otherwise sample, so it
does not consume a random seed. `agentfw-analysis-v1-2026-07-23` was reserved for
a separately preregistered stochastic supplement; introducing such a supplement
after viewing outcomes would be a protocol amendment, not part of the primary
analysis.

Tasks 01 through 09 have a 1,800-second agent wall-clock limit. Task 10 is a
narrow architecture-answer task and has a 900-second limit. Provisioning and
hidden evaluation remain outside the agent limit as defined in the protocol.

Rejected: regenerate a convenient schedule, change time limits after observing
which arm times out, or add bootstrap output opportunistically after inspecting
the primary result.

## D-026: Require operational proof before Phase 6

- Date: 2026-07-23
- Status: accepted

Phase 6 may start only from a clean immutable Git revision with production
hidden-evaluator drivers and their hashes, an approved provider adapter with an
immutable model/configuration identity, a frozen pricing and retention record,
and explicit budget authorization. Every run must use a fresh model session in
a runtime-verifiable killable OS sandbox under frozen network, host/container,
dependency-cache, fixture-cohort, and provisioning policies.

The harness's scripted and injected drivers validate mechanics only. They are
permanently ineligible for confirmatory success. File-copy isolation or a
declared sandbox label without runtime evidence does not satisfy this gate.

Rejected: treat an uncommitted snapshot, smoke adapter, caller assertion, or
best-effort process timeout as sufficient evidence for the confirmatory study.

## D-027: Name the framework Agentix and supersede the provisional freeze

- Date: 2026-07-23
- Status: accepted before any confirmatory observation

The framework's public name is **Agentix**. The active package scope is
`@agentix/*`, the CLI binary is `agentix`, the generated projection is
`.agentix/index.json`, and benchmark/runtime protocol identifiers use the
`agentix` prefix. The local Git `origin` is
`git@github.com:pewpewgogo/agentix.git`. Scientific arm values and paths remain
the generic `framework` and `plain` labels so branding does not alter analysis.

The rename changed 71 of the 140 provisional inventory sources and added one
shared build helper, yielding a 141-file Agentix inventory. Because the
repository had no Git `HEAD` and zero confirmatory observations, the provisional
D-025 corpus and schedule were superseded in place rather than pooled with the
Agentix study. The active identities are `agentix-commerce-app-base` and
`agentix-commerce-maintenance-v1`; their refreshed base-inventory and
corpus-lock SHA-256 values are respectively
`f2cc4306e5e29849b4f1f00230057b0a114b4b53a68653b8945ea63747d0e87c` and
`48deddc989e7dab69eeab9fa88759484531a3b424e771d6d2ec5560a40aef08e`.

The active 100-slot schedule seed is `agentix-commerce-v1-2026-07-23`, its
structural hash is
`f2141cd81018d3720b8783547274cac4e291a88bfd35cfbc6497149287258ba4`, and
its exact pretty-JSON file SHA-256 is
`d3b488cd9e600c7c083f04116bb4b7c576d945b6e297e0ebe50df922794448a6`.
The deterministic primary analysis remains seedless;
`agentix-analysis-v1-2026-07-23` is reserved only for the same separately
preregistered stochastic supplement described in D-025. Task limits and all
win conditions are unchanged.

Rejected: silently relabel old hashes as current, mix the provisional and
Agentix corpus identities, rename the scientific arm values, or retain the old
binary as an undocumented compatibility alias.

## Remaining decisions required before the full benchmark

Exact tool versions are fixed in D-014, runtime and automated-DX budgets in
D-024, and the current scheduling, analysis-seed policy, and task limits in
D-025 as superseded by D-027. The
following choices remain unresolved and must be frozen before any confirmatory
run:

- exact provider, immutable model version, reasoning configuration, and service
  tier;
- host/container image and dependency-cache policy;
- raw provider-payload retention/redaction policy; and
- whether a separately preregistered ablation is affordable.

## Phase 1 verification record

- Date: 2026-07-23
- Result: passed the documentation gate; implementation has not started

The relevant checks and exact results were:

```text
for doc in docs/HYPOTHESIS.md docs/ARCHITECTURE.md docs/BENCHMARK_PROTOCOL.md docs/LIMITATIONS.md docs/DECISIONS.md; do test -s "$doc" || exit 1; done
exit 0; no output

git diff --check
exit 0; no output

rg -q 'five percentage points' docs/HYPOTHESIS.md && rg -q '20 percent' docs/HYPOTHESIS.md && rg -q 'seven of the ten' docs/HYPOTHESIS.md && rg -q '100 valid runs' docs/BENCHMARK_PROTOCOL.md
exit 0; no output

test -z "$(find . -path './.git' -prune -o -path './docs' -prune -o -type f -print)"
exit 0; no output
```

A separate in-memory Node check also confirmed all five required documents were
non-empty, their fenced code blocks were balanced, and the fixed verdict and
telemetry phrases were present. It reported:

```text
phase-1-doc-check: PASS (5 required documents)
```

One combined-check attempt used `path` as the zsh loop variable. In zsh that
special variable is tied to `PATH`, so subsequent `git`, `rg`, and `find`
commands were not found. That attempt was discarded, the variable was corrected
to `doc`, fail-fast mode was enabled, and all commands above were rerun.

There is no package manifest or executable source yet, so build, type-check, and
runtime tests are not applicable in Phase 1. Their absence is a phase boundary,
not evidence of implementation correctness.

## Phase 2 verification record

- Date: 2026-07-23
- Result: passed the framework-primitives gate

The final clean integration check and exact result were:

```text
npm install --ignore-scripts
changed 1 package; audited 66 packages; 0 vulnerabilities

npm run clean
exit 0

npm run build
exit 0

npm run typecheck
exit 0

npm test
17 test files passed; 77 tests passed

git diff --check
exit 0; no output
```

Manual CLI smoke checks ran the built binary against the compiler's valid
fixture:

```text
node packages/cli/dist/bin.js inspect orders.create --root packages/compiler/test/fixtures/valid --json
exit 0; returned operation, effects, events, invariant, test, affected set, and verification plan

node packages/cli/dist/bin.js graph orders --root packages/compiler/test/fixtures/valid --format text
exit 0; returned dependency, operation, effect, event, invariant, and test edges

node packages/cli/dist/bin.js affected customers --root packages/compiler/test/fixtures/valid --json
exit 0; selected customers plus the dependent orders closure with reasons

node packages/cli/dist/bin.js scaffold feature audit-log --root packages/compiler/test/fixtures/valid --dry-run --json
exit 0; reported six files and performed no writes
```

Failures encountered and retained during the phase:

- the first testing-package smoke could not load its project because the core
  project reference had not yet been created; the unchanged test path passed
  after the core skeleton landed;
- one core test expected application assembly to reject a hostile query, but
  `defineQuery` correctly rejected it earlier; the test was corrected to assert
  the appropriate enforcement layer; and
- root Vitest initially collected a scanner-only fixture named `orders.test.ts`;
  fixture discovery was isolated and the full suite was rerun cleanly.

## Phase 3 and Phase 4 verification record

- Date: 2026-07-23
- Result: paired applications and behavioral-equivalence gate passed

The original clean verification was:

```text
npm run clean
exit 0

npm run build
exit 0

npm run typecheck
exit 0

npm test
29 test files passed; 115 tests passed

npm run test:acceptance
10 test files passed; 33 tests passed across framework and plain applications

node packages/cli/dist/bin.js verify orders.create --root examples/framework-app --json
passed: true; typecheck status 0; test status 0; architecture diagnostics 0

node packages/cli/dist/bin.js inspect orders.create --root examples/framework-app --json
exit 0; all seven declared effects resolved to stable operation IDs and kinds

git diff --check
exit 0; no output
```

The generated framework-application index hash at this source state was:

```text
sha256 7af0aba71ee1e923400cd0e871738063627c2d492a2935abfecc3a979b02980b
```

The suite includes reusable black-box scenarios, focused unit/invariant tests,
compile-time tests, architecture checks, deterministic replay helpers, schema
and invariant property tests, concurrent-order tests, and detached-state checks.

Failures found and corrected before the gate passed:

- a Vitest alias matched the shared package root before its `/acceptance`
  subpath;
- `agentfw verify` ran repository-root include globs from an application root and
  found no tests, so verification now prefers declared package scripts;
- the compiler fixture used an impossible shorthand and the scanner did not
  resolve the real `Port.operations.<key>` API; both fixture and scanner were
  corrected;
- differential probes found mismatched path-ID normalization, ambient versus
  fixed default time, concurrent duplicate successes, and framework overselling;
  these became shared regression checks or explicit fixes; and
- order overflow and duplicate-ID paths now release framework reservations
  before returning an internal failure.

An independent equivalence audit then found authorization-before-body,
generated-ID, shared-constant asymmetry, duplicate-clock, and malformed-path
gaps. All five were converted to code fixes and shared or focused regression
tests. The post-audit gate was:

```text
npm install
up to date; audited 72 packages; 0 vulnerabilities

npm run typecheck
exit 0

npm run test:acceptance
11 test files passed; 40 tests passed across framework and plain applications

npm test --workspace @agentfw/adapters-http
3 test files passed; 16 tests passed

git diff --check
exit 0; no output
```

The expanded oracle checks unauthorized malformed and absent request bodies,
blank generated order IDs with unchanged local state, malformed URI encoding,
and exactly one clock read for each winning concurrent customer/product create.
The earlier index hash and full-suite counts above describe the pre-audit source
state and will be superseded by the final Phase 5 clean record.

## Phase 5 verification record

- Date: 2026-07-23
- Result: engineering gate passed; confirmatory experiment not started

This record preserves the provisional pre-Agentix source state and hashes. It
was superseded by the D-027 naming amendment before any confirmatory run.

The final local verification was:

```text
npm install --ignore-scripts
up to date; audited 80 packages; 0 vulnerabilities

npm run clean
exit 0

npm run build
exit 0

npm run typecheck
exit 0

npm test
46 test files passed; 222 tests passed

npm run test:acceptance
11 test files passed; 41 tests passed

npm run test:phase5
16 test files passed; 97 tests passed

npm run benchmark:corpus:check
10 tasks; 20 arms; 140 inventory files; verified

npm run benchmark:harness:smoke
1 test file passed; 3 tests passed
```

All 20 task-arm fixtures materialized. An offline install, type-check, and
application test run also passed for both task-05 arms. Repeated index generation
was byte-identical with SHA-256
`e9ca2a263a84b22f07e194bd914b457a8f27cfa136325584fc6640eb67fe45a2`.
The CLI inspection, graph, affected-set, verify, and no-write scaffold paths were
exercised against the framework application.

Runtime smoke exercised diagnostic/no-process collection, two fresh isolated
process builds, both-arm clean-build/full-type-check/incremental toolchain probes,
and sealed create-only evidence publication. Disabled metric groups were
recorded as unavailable rather than synthesized. Every smoke record is marked
ineligible for confirmatory use.

Failures found and fixed during the gate included stale package-local Vitest
discovery, an acceptance assertion that excluded a legitimate internal 500
response, a compiler file-discovery shortcut coupled to benchmark paths, a
report-integrity check that incorrectly compared pre- and post-provisioning
manifests, and harness classification that initially treated an agent-created
prohibited workspace entry as invalid evidence instead of a valid failed run.
The final independent audit additionally found and fixed a scalar cohort timeout
that could not represent task 10's shorter limit, writable source-linked runtime
dependencies, and documented-but-unimplemented correction provenance. A
timing-sensitive synthetic lifecycle test was stabilized without changing any
frozen benchmark limit. Each fix is covered by the final suite or a focused
regression test.

No external provider, paid API, full 100-slot experiment, deployment, package
publication, or confirmatory observation occurred. The repository has no Git
`HEAD`, production hidden drivers and operational sandbox evidence are absent,
and the only valid framework verdict is `INCONCLUSIVE`.

## Agentix naming verification record

- Date: 2026-07-23
- Result: Agentix identity and local engineering gate passed; confirmatory
  experiment not started

D-027 was applied across the public package scope, imports, CLI and benchmark
binaries, generated-index directory, runtime/protocol identifiers, corpus
identities, documentation, and local Git remote. Scientific arms remain the
generic `framework` and `plain` values. The four remaining provisional-name
strings in this document are preserved historical evidence from before D-027.

The final quiescent verification was:

```text
npm ci --ignore-scripts
added 67 packages; audited 80 packages; 0 vulnerabilities

npm run clean
exit 0

npm run build
exit 0; all three declared CLI targets executable

npm run typecheck
exit 0

npm test
46 test files passed; 222 tests passed

npm run test:acceptance
11 test files passed; 41 tests passed

npm run test:phase5
16 test files passed; 97 tests passed

npm run benchmark:corpus:check
10 tasks; 20 arms; 141 inventory files; verified

npm run benchmark:harness:smoke
1 test file passed; 3 tests passed

npm test --workspace @agentix/core
5 test files passed; 28 tests passed

npm test --workspace @agentix/compiler
1 test file passed; 8 tests passed

npm test --workspace @agentix/cli
1 test file passed; 6 tests passed
```

All 20 Agentix task-arm fixtures materialized. Both task-05 arms passed an
offline clean install, type-check, and application suite: 25 files/103 tests for
the framework arm and 6 files/24 tests for the plain arm. Repeated index
generation was byte-identical with SHA-256
`e99d9ea8e50b205a2497f1cb08c3d5a5894f377b5b37fe269dbae659289ab8b2`.

Direct invocation passed for `agentix`, `agentix-benchmark-report`, and
`agentix-runtime-benchmark`. Final runtime smoke produced two bound fresh
builds, 20 process samples, zero process-probe unavailable entries, six
both-arm toolchain samples, and a sealed publication that re-read successfully.
Every smoke result remained ineligible for confirmatory use.

The active schedule structural/file hashes are
`f2141cd81018d3720b8783547274cac4e291a88bfd35cfbc6497149287258ba4` and
`d3b488cd9e600c7c083f04116bb4b7c576d945b6e297e0ebe50df922794448a6`.
The final base-inventory/corpus-lock hashes are
`f2cc4306e5e29849b4f1f00230057b0a114b4b53a68653b8945ea63747d0e87c` and
`48deddc989e7dab69eeab9fa88759484531a3b424e771d6d2ec5560a40aef08e`.

The local `origin` is `git@github.com:pewpewgogo/agentix.git`. No commit, push,
provider call, deployment, publication, or confirmatory observation occurred.
