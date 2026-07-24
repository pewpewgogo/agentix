# Benchmark harness

This package is the provider-neutral runner and raw telemetry boundary for the
agent-maintenance experiment. It uses Node built-ins and does not contain or
invoke an external model provider. The bundled `ScriptedAgentAdapter` is only
for inexpensive engineering smoke validation.

## Safety and experiment boundary

Smoke runs prove that scheduling, workspace isolation, instrumentation,
timeouts, evaluators, and immutable records work. Their results are excluded
from the confirmatory data set and cannot support a framework verdict.

A confirmatory run requires a separately implemented provider adapter with an
exact model/version mapping. The runner rejects every external-provider adapter
unless the caller supplies an explicit `ExternalProviderGate` approval
reference. It also rejects scripted adapters in confirmatory mode and requires
an exact validated schedule slot, frozen ten-task cohort manifest, bounded
provisioning/preflight/evaluator hooks, and a runtime sandbox attestation with a
killable session controller. Supplying an adapter and approving provider spend
are external gates; this repository performs neither by itself.

## Recorded surfaces

- Schema-versioned task and run identities pin fixture, evaluator, analysis, and
  schedule revisions. The frozen cohort pins an agent wall-clock timeout for
  every exact task key; a run is rejected unless its selected schedule slot
  uses that task's timeout.
- A seeded blocked scheduler shuffles task/repetition blocks and independently
  randomizes framework/plain order within every block. The committed schedule
  writer is no-overwrite and includes a deterministic schedule hash.
- Every run receives a fresh fixture copy. The initial fixture hash is captured
  before a separately bounded, cohort-pinned provisioning phase. Dependency and
  generated directories use a fixed safe allowlist; callers cannot whitelist
  source/configuration paths. The measured baseline is captured after preflight.
  Dependency/cache trees are excluded from snapshots under a recorded fixed
  policy, while generated application output remains retained.
- System, developer, user, tool, permission, and limit instructions are hashed
  independently after Unicode NFC and line-ending normalization, then bound by
  a bundle hash.
- Provider counters remain raw. Unexposed counters are `null` with a reason;
  they are never estimated from text. Monetary cost is unavailable unless the
  exact provider/model/tier pricing snapshot and every non-overlapping required
  counter are present.
- `accountedTokens` sums uncached input, cached input, and output only when both
  the cached/uncached input relation and reasoning overlap semantics are
  explicit, adding reasoning only when declared
  additional. Ambiguous or missing component splits may fall back only to a
  provider total declared authoritative and non-overlapping; otherwise the
  derived value is unavailable.
- Raw events retain assistant turns, tool calls, command invocations, explicit
  test classification, failures/retries, file-content observations, and writes.
  Final modified files and normalized line changes are derived independently by
  comparing pre-agent and post-agent workspace snapshots. Exact baseline/final
  manifests and a reconstructable normalized patch containing the changed bytes
  are retained as hash-bound artifacts.
- Environment data includes host/runtime facts plus caller-pinned package
  manager, cache/network policy, container/host class, and tool versions.
- Agent, evaluator, and finalization outcomes are independent. On agent timeout,
  the runner aborts, invokes the killable session, and waits for confirmed
  settlement before evaluation or snapshotting. Unconfirmed shutdown produces a
  sealed unavailable-evidence result rather than a misleading snapshot.
- Result directories are atomically staged and append-only. A completion marker
  binds the raw result envelope and artifact manifest. Corrections use a new run
  ID and record the exact superseded envelope hash, a nonempty reason, and a
  canonical timestamp. The correction API derives that link from an already
  retained record; readers verify the full lineage, reject cycles, and require
  the scheduled identity and any frozen confirmatory schedule/cohort binding to
  remain unchanged. Readers also reject missing/truncated markers,
  malformed or cross-field-inconsistent records, hash mismatches, evidence
  artifact disagreement, artifact tampering, and duplicate IDs.

If an agent creates a prohibited symbolic link or unsupported workspace entry,
the runner seals the available forensic evidence and marks a workspace-policy
failure. That is agent-caused failure evidence and must not be replaced as an
infrastructure run.

File observations count only when content or a semantic representation enters
agent context. Filenames from a directory listing alone must not be emitted as
observations. Test commands must be classified by the adapter from frozen exact
runner/script configuration, not by a substring heuristic.

## Local verification

```sh
npm run typecheck --workspace @agentixdev/benchmark-harness
npm test --workspace @agentixdev/benchmark-harness
```

No test invokes a paid or external model. The scripted end-to-end test writes a
known patch, emits a known event stream, runs local lifecycle hooks, and verifies
the resulting immutable record.

The filesystem confinement in this package protects fixture materialization,
scripted writes, and result/artifact paths. Confirmatory adapters must prove at
runtime that shell/file tools run in an OS-level sandbox rooted at the supplied
fresh workspace and expose a termination operation that resolves only after the
session can no longer mutate it; passing a workspace path alone is not a
security boundary.
