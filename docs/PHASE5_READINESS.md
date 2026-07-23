# Phase 5 Readiness

Date: 2026-07-23

## Outcome

The Phase 5 engineering gate is **PASS**. The Phase 6 confirmatory experiment is
**NOT READY**, no confirmatory agent-maintenance run has occurred, and the only
valid framework verdict is **INCONCLUSIVE**.

No external model provider, paid API, deployment, or package publication was
invoked. Smoke measurements validate executability and evidence handling only;
they are not observations for the primary hypothesis.

## Completed gates

- Agentix, its strict TypeScript core, compiler, testing helpers, CLI, and HTTP
  adapter are implemented without benchmark-application dependencies.
- The framework and plain commerce applications pass the same black-box suite,
  including authorization, malformed input, deterministic time/IDs, payment
  failure, invariants, duplicate writes, and concurrent stock behavior.
- The Agentix corpus `agentix-commerce-maintenance-v1` contains 10 paired tasks
  and 20 materializable arm fixtures over a 141-file hash-verified inventory.
  It supersedes the provisional pre-name freeze under D-027. All 20 arms materialize;
  task 05 was additionally installed offline, type-checked, and tested in both
  arms.
- The frozen schedule file contains exactly 100 blocked slots: 10 tasks,
  two arms, and five repetitions. Its seed is
  `agentix-commerce-v1-2026-07-23`, structural hash is
  `f2141cd81018d3720b8783547274cac4e291a88bfd35cfbc6497149287258ba4`,
  and file hash is
  `d3b488cd9e600c7c083f04116bb4b7c576d945b6e297e0ebe50df922794448a6`.
- The harness binds each confirmatory record to an exact schedule slot, frozen
  cohort, initial fixture, provisioning plan, instructions, environment,
  provider configuration, sandbox attestation, evaluator, and analysis
  revision. It binds the agent timeout by scheduled task, preserves exact patch
  bytes, rejects ambiguous token overlap, and supports hash-linked append-only
  corrections without overwriting the superseded evidence.
- The evaluator is fail-closed. Its production hidden drivers do not yet exist,
  so requesting confirmatory hooks throws; injected smoke drivers cannot create
  confirmatory success.
- The runtime benchmark performs fresh isolated builds with private
  permission-hardened dependency copies, retains raw samples, separates
  unavailable measurements, and supports create-only sealed evidence.
- The report generator re-derives correctness, tokens, and cost; validates the
  executing analysis bytes; preserves distributions, failures, missingness, and
  outliers; and prevents smoke, pilot, incomplete, or compromised evidence from
  producing a conclusive verdict.

## Final local verification

```text
npm ci --ignore-scripts
added 67 packages; audited 80 packages; 0 vulnerabilities

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

Runtime smoke evidence from the final source state:

- diagnostic/no-process: 28 samples, 7 summaries, with unavailable entries only
  for intentionally disabled metric groups;
- real isolated process: two fresh bound builds, 20 process samples, and no
  process-probe unavailability;
- real toolchain: six samples covering both arms for clean build, full
  type-check, and incremental verification, with no toolchain unavailability;
- sealed smoke publication: written and re-read successfully; correctly marked
  `eligibleForConfirmatoryUse: false`.

The generated framework index was byte-identical across repeated generation:

```text
sha256 e99d9ea8e50b205a2497f1cb08c3d5a5894f377b5b37fe269dbae659289ab8b2
```

The Phase 5 freeze hashes, before D-028 added isolated comparison dependencies,
are:

```text
base inventory f2cc4306e5e29849b4f1f00230057b0a114b4b53a68653b8945ea63747d0e87c
corpus lock    48deddc989e7dab69eeab9fa88759484531a3b424e771d6d2ec5560a40aef08e
package lock   2afb6c7e2c1f635d22f3481dd9ee9961e8acc927a131ac609267e5ad654d8c8e
```

The current root package-lock SHA-256 after adding the D-028 exploratory
Express/NestJS runner is
`855bc97725ce43b3dbbfae4b7fa63f4ebd12c8365783a8654e86742769f46085`.
The frozen fixture profile uses its own unchanged lockfile.

## Phase 6 blockers

1. The repository has no Git `HEAD`; all files are currently untracked. Exact
   fixture, evaluator, analysis, and source revisions therefore cannot yet be
   bound to a clean immutable commit.
2. Production hidden black-box and architecture-answer drivers, with frozen
   source hashes and an evaluator revision, are intentionally absent.
3. No external provider adapter, immutable model identifier, reasoning/service
   tier configuration, historical pricing snapshot, payload-retention policy,
   budget, or spend approval has been supplied.
4. No fresh-session orchestrator has supplied the required runtime-verifiable,
   killable OS sandbox with the frozen network and cache policies.
5. Host/container identity and the final frozen cohort manifest still need to
   be chosen and reviewed after the source commit exists.

Only after all five blockers are closed should the 100-slot schedule be run.
Until then, zero confirmatory observations exist and the verdict remains
`INCONCLUSIVE`.
