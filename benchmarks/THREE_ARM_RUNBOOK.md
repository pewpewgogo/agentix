# Agentix, Express, and NestJS benchmark runbook

This repository separates three questions that are often accidentally mixed:

1. **Context calibration:** how much source or tool output is presented before
   an agent edits anything?
2. **Runtime/toolchain cost:** what do equivalent configured HTTP stacks cost to
   start and execute?
3. **Maintenance outcome:** does an agent finish the same change correctly with
   less context, time, and money?

No single score combines these layers.

## Cheap calibration on every change

```sh
npm ci
npm run sandbox:test
npm run sandbox:token-budget
npm run benchmark:http-frameworks -- --no-process
```

The notes sandbox is intentionally small. It catches declaration overhead and
bad agent-entry guidance early. The context report uses a disclosed
`ceil(characters / 4)` heuristic; it is never reported as real model usage.

The HTTP comparison uses real Agentix, Express, and NestJS servers with matched
echo behavior. It remains exploratory because one loopback route measures
configured stacks, not maintenance quality or framework value.

The manual GitHub Actions workflow **Three-arm benchmark smoke** runs both
layers on a pinned commit and uploads the raw reports. Record the workflow URL
with any numbers you discuss.

## Live-agent maintenance study

The frozen v1 maintenance corpus is a two-arm Agentix/plain study against the
pre-overhaul framework revision. Do not add a NestJS label to its files,
hashes, or 100-slot schedule.

The corpus name `v2` is now taken by `agentix-commerce-maintenance-v2` (below):
the same preregistered two-arm, ten-task, five-repetition, 100-run design
re-frozen against the CURRENT v2 framework (single-file feature modules). This
naming decision was recorded before any confirmatory observation and changes no
outcome or win condition. A future three-arm Agentix/plain/NestJS study is a
further corpus version with new fixtures, evaluators, analysis configuration,
and a blocked 150-slot schedule for ten tasks, three arms, and five
repetitions.

## Corpus v2: the confirmatory study on the current framework

`agentix-commerce-maintenance-v2` is additive. It never modifies a v1 artifact:

- `benchmarks/tasks/v2/` — the ten task specifications, ported verbatim from
  v1 (same user requests, public criteria, categories, time limits).
- `benchmarks/tasks/corpus-v2.lock.json` — the v2 freeze.
- `benchmarks/fixtures/v2/` — 20 arm manifests over a 169-file inventory
  pinned to commit `4745d33c07b2c4a9cefddf1e0ee53b46566af730` (the v2
  framework and both example apps), plus per-arm workspace profiles and one
  shared fixture lockfile.
- `benchmarks/evaluator/hidden/v2/` — hidden evaluator manifests.
- `benchmarks/harness/config/confirmatory-schedule.v2.json` — the committed
  100-slot blocked schedule, seed `agentix-commerce-v2-2026-07-27`, structural
  hash
  `0f0cb613a582033ea6a95e19b3ada2efe4f932511b1a9c12ec3908f33b763003`.

### Verifying and dry-running the v2 corpus

```sh
npm ci
npm run build
npm run benchmark:corpus:check      # v1 frozen record still verifies
npm run benchmark:corpus:v2:check   # v2 corpus verifies
npm run benchmark:corpus:v2:dryrun  # no-provider dry-run; smoke, non-evidence
```

The dry-run invokes no paid model and reads no credentials. Per task/arm it
materializes the frozen fixture, executes the requested behavior in-process
against the unmodified fixture and requires it to FAIL (proving each task
demands a real maintenance change), runs the real regression suites on the
distinct workspace states (one clean pair plus both injected-defect pairs;
every other arm's workspace is byte-identical to the clean pair — they must
pass), and drives the full harness
lifecycle with the scripted adapter, producing immutable records that are
machine-labeled non-evidence
(`invalidRunReason: production_hidden_evaluator_unavailable`). The committed
record of one such run is
`results/corpus-v2-dryrun-smoke-2026-07-27.json` (73 checks: 71 passed, 2
not-applicable for the read-only answer task, 0 failed).

### What a paid confirmatory v2 run still requires

The repository intentionally contains no provider adapter and the harness reads
no API-key environment variables. Before executing the 100-slot schedule:

1. An external `AgentAdapter` (`kind: "external_provider"`) with an immutable
   model identifier, plus a runtime-verifiable killable OS sandbox
   (`ConfirmatorySessionController`). Credentials (for an Anthropic-backed
   adapter, `ANTHROPIC_API_KEY` or an equivalent credential source) are read by
   that adapter process, never by the harness.
2. An explicit `ExternalProviderGate` spend approval reference.
3. Production hidden black-box drivers (`commerce-http`, `migration-cli`) and
   the answer driver, implemented, hash-frozen, and bound to an evaluator
   revision — `createEvaluatorLifecycleHooks` still throws in confirmatory
   mode until then.
4. A frozen cohort manifest binding the v2 schedule, per-task fixture hashes,
   instructions, environment, timeouts, and a versioned pricing snapshot.
5. A primed offline npm cache so fixture preflight
   (`npm install --offline --ignore-scripts`) succeeds under the disabled
   network policy.

### Cost estimate for the 100-run v2 study

The harness derives `accountedTokens` from non-overlapping provider counters
(uncached input + cached input + output, plus reasoning only when declared
additional) and prices runs from a frozen snapshot
(`uncached*P_in + cache_read*P_cache + output*P_out`). Using the current
Anthropic API list prices for `claude-opus-5` (2026-07: $5/MTok input,
$25/MTok output, cache reads at 0.1x input = $0.50/MTok, 5-minute cache writes
at 1.25x = $6.25/MTok) and these stated planning assumptions per run —
roughly 40 assistant turns within the 30-minute task limit, ~2k uncached input
tokens per turn (~80k/run, all also written to cache once), ~60k average
context re-read from cache per turn (~2.4M cache-read tokens/run), and ~700
output tokens per turn (~28k/run):

```text
per run  ~ 80k*$5 + 80k*$6.25 + 2.4M*$0.50 + 28k*$25 per MTok  ~ $2.80
100 runs ~ $280
```

Shallow runs (~15 turns) drop toward ~$1/run; runs that exhaust the 30-minute
limit (~80 turns, larger contexts) reach ~$8-9/run, giving a plausible
$100-$900 band for the cohort. Budget ~$350-$700 with a hard cap, plus up to
20% margin for preregistered infrastructure-invalid replacements and any
pre-freeze pilot runs (which never enter the confirmatory cohort). These are
planning assumptions, not measurements: the binding numbers are the frozen
pricing snapshot and the raw provider telemetry of the actual cohort, and no
estimate here may substitute for either.

### Preregistration constraints that still apply

`docs/BENCHMARK_PROTOCOL.md` and `docs/HYPOTHESIS.md` govern v2 unchanged:
correctness is a gate; at least five valid fresh repetitions per task/arm cell;
randomized blocked ordering from the committed seed; fresh isolated workspace
and fresh model session per run; disabled network; raw provider telemetry only
(never estimated tokens); smoke and dry-run outputs are permanently excluded
from the confirmatory cohort; invalid-run replacement only for the
preregistered infrastructure causes; and the verdict conditions in
`HYPOTHESIS.md` are fixed. Material changes after observing results require a
dated decision record and split the cohorts into separate experiments.

Before paying for runs:

1. Define ten implementation-neutral maintenance requests and external behavior
   checks. Include local changes, cross-layer changes, misleading symptoms, and
   one architecture question.
2. Give every arm the same behavior, dependencies where possible, test strength,
   starting defects, and allowed tools. Keep framework-specific guidance inside
   that arm's committed `AGENTS.md`.
3. Freeze each starting tree by Git commit and content manifest. Keep hidden
   evaluators outside agent workspaces.
4. Pin provider, exact model/version, reasoning configuration, service tier,
   pricing snapshot, Node/npm versions, dependency cache policy, network policy,
   host class, timeouts, and agent instructions.
5. Randomize complete task/repetition blocks and rotate all three arm orders.
   Each run starts from a fresh isolated workspace and a fresh model session.
6. Require an explicit provider-spend approval before starting the schedule.
   Smoke adapters and pilot runs never enter the confirmatory cohort.

## Metrics and decision order

Correctness is the gate. Derive it from tests and hidden evaluators, not the
agent's final message. Then report:

- provider-reported uncached input, cached input, output, and reasoning tokens;
- successful and failed run token distributions separately;
- wall-clock duration and exact monetary cost;
- files inspected/modified, tool calls, failed commands, retries, and diff size;
- per-task results plus paired differences within each randomized block.

Use medians, IQRs, ranges, and per-task ratios. Preserve raw run records. Do not
replace failures with successful reruns; classify infrastructure-invalid runs
separately and retain their lineage.

## Interpretation

The useful Agentix hypothesis is not “always fewer tokens.” It is:

> Agentix pays fixed declaration cost but keeps maintenance context closer to
> the affected feature than to total repository size.

Test that scaling claim with at least two application sizes. Publish negative
results: small-app ceremony, failed tasks, unavailable telemetry, and cases
where Express or NestJS wins are part of the framework evidence.
