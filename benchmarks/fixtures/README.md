# Reproducible benchmark fixtures

Each task has two manifests: one for the framework application and one for the
plain TypeScript application. Both reference their corpus's base inventory —
`v1/base.repository.json` (commit `5fd027e0…`, 141 files) or
`v2/base.repository.json` (commit `4745d33c…`, 169 files) — an exact SHA-256
inventory of the shared repository files used to build isolated workspaces.
Inventory entries have an audience, so materialization copies only shared files
and the selected arm. The other implementation is never present. In v2 the
per-arm workspace root files (README, package.json, tsconfig.json,
package-lock.json) are hash-locked overlay files under `v2/profiles/` because
the pinned commit predates them.

`materializeFixture` in `@agentix/benchmark-evaluator` performs these steps:

1. Refuse a non-empty destination.
2. Verify the task manifest and base-inventory hashes.
3. Read every selected source from the pinned Git commit and verify its hash
   before copying its audience into the workspace.
4. Apply exact-count text edits and hashed data-file overlays.
5. Refuse any target under an excluded evaluator, harness, result, or task path.

Task 05 and task 06 use small setup edits to introduce equivalent defects in
the two otherwise-equivalent applications. Task 08 adds input data only. Other
tasks begin from the same clean application snapshot and ask for missing
behavior; none of the overlays contains a completed solution.

## Freeze workflow

Before a corpus freeze, run the inventory refresh utility
(`scripts/refresh-benchmark-freeze.mjs` for v1,
`scripts/refresh-benchmark-freeze-v2.mjs` for v2), review every changed source
hash and overlay, then regenerate cross-reference hashes and the corpus lock
(`benchmarks/tasks/corpus.lock.json` or
`benchmarks/tasks/corpus-v2.lock.json`). Run the evaluator type-check and
tests.
After freezing, working-tree product changes do not alter v1 materialization:
its source bytes come from the recorded commit. Update the corpus only by
creating a new fixture or corpus version, not by moving the existing pin.
Materialization therefore requires that commit object to exist locally. Fetch
full history in a shallow clone; a source archive without Git objects cannot run
the frozen corpus.

Dependency installation and all agent activity happen after materialization
with networking disabled. The arm-specific root files keep the application
workspaces runnable without exposing the counterpart source tree.
