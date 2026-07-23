# Reproducible benchmark fixtures

Each task has two manifests: one for the framework application and one for the
plain TypeScript application. Both reference `v1/base.repository.json`, an exact
SHA-256 inventory of the shared repository files used to build isolated
workspaces. Inventory entries have an audience, so materialization copies only
shared files and the selected arm. The other implementation is never present.

`materializeFixture` in `@agentix/benchmark-evaluator` performs these steps:

1. Refuse a non-empty destination.
2. Verify the task manifest and base-inventory hashes.
3. Verify every source file before copying its audience into the workspace.
4. Apply exact-count text edits and hashed data-file overlays.
5. Refuse any target under an excluded evaluator, harness, result, or task path.

Task 05 and task 06 use small setup edits to introduce equivalent defects in
the two otherwise-equivalent applications. Task 08 adds input data only. Other
tasks begin from the same clean application snapshot and ask for missing
behavior; none of the overlays contains a completed solution.

## Freeze workflow

Before a corpus freeze, run the inventory refresh utility, review every changed
source hash and overlay, then regenerate cross-reference hashes and
`benchmarks/tasks/corpus.lock.json`. Run the evaluator type-check and tests. A
source change after freezing makes materialization fail; update by creating a
new fixture or corpus version, not by weakening verification.

Dependency installation and all agent activity happen after materialization
with networking disabled. The arm-specific root files keep the application
workspaces runnable without exposing the counterpart source tree.
