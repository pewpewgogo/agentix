# Benchmark evaluator

This package owns strict schemas and loaders for the ten-task corpus, verifies
all cross-file SHA-256 references, materializes isolated arm workspaces, and
builds and executes evaluator plans. It does not run an agent or infer
telemetry. `createEvaluatorLifecycleHooks` is structurally compatible with the
benchmark harness lifecycle interface.

Every plan uses the frozen check names expected by the harness:

- `acceptance`
- `hidden-regression`
- `typecheck`
- `architecture`
- `prohibited-shortcuts`
- `task-specific`

Architecture is required for the framework arm and explicitly
`not_applicable` for the plain arm. Hidden checks, answer rubrics, and shortcut
policies remain evaluator-only. Materialization rejects any target under the
task, fixture, evaluator, harness, result, or report trees, and it never copies
the counterpart application.

The executor runs manifest commands as argument arrays through an injected
process runner—never through a shell string. It requires the runner to attest
OS-backed disabled networking and workspace-only filesystem access, confines
workspaces to the configured runs root, bounds commands and drivers, and fails
closed when a required black-box or answer driver is absent. Its shortcut check
compares a pre-agent baseline to the candidate workspace before evaluator
commands can mutate it.

Injected drivers are deliberately **smoke-only**. The returned hooks advertise
`confirmatoryReady: false`, every smoke summary carries
`production_hidden_evaluator_unavailable`, and requesting confirmatory hooks
throws `ConfirmatoryHiddenEvaluatorUnavailableError`. This prevents a caller
from turning an arbitrary always-pass injected driver into confirmatory
evidence. A full run remains blocked until production black-box and answer
driver implementations, their source hashes, and their evaluator revision are
frozen and bound here.

The integration smoke materializes a real frozen arm, lets the benchmark
harness copy it into a second fresh workspace, runs only the local
`ScriptedAgentAdapter`, and re-reads the immutable result. Its confined process
runner and black-box driver are named smoke doubles and spawn nothing; the test
requires the resulting record to remain ineligible with `finalSuccess: false`
and `production_hidden_evaluator_unavailable`.

## Commands

```sh
npm --workspace @agentix/benchmark-evaluator run typecheck
npm --workspace @agentix/benchmark-evaluator test
npm --workspace @agentix/benchmark-evaluator run freeze:check
```

`freeze:check` is read-only. It validates the corpus lock, task-to-fixture and
task-to-hidden-manifest hashes, every base source hash, paired-equivalence
metadata, and arm isolation. V1 source bytes come from its recorded Git commit;
live product changes do not refresh that inventory. Create a new corpus version
for a new product baseline or intervention. After intentionally changing a new
version's overlays/specification, regenerate its references and corpus lock as a
reviewable experiment patch, run the three commands above, and materialize both
arms. Never move an existing source pin or update hashes only to hide a mismatch.
