# Integrity-bound benchmark reports

This package analyzes immutable `@agentix/benchmark-harness` `RunRecord` values
against one hashed `ScheduleDocument` and one frozen cohort configuration. It
does not accept a normalized JSON array with caller-supplied success or token
fields.

The decision constants are compiled into analysis version `analysis-v1` and the
configuration must repeat them exactly:

- correctness margin: `0.05`;
- minimum successful-run median token reduction: `0.20`; and
- improved task categories: `7` of `10`.

Correctness noninferiority uses the preregistered observed framework-minus-plain
success-rate difference. Per-arm 95% Wilson intervals are descriptive; the
analyzer does not invent a post-hoc confidence-interval decision threshold.

## Integrity gates

Before a verdict can be conclusive, the analyzer verifies:

- exactly ten versioned tasks and at least five repetitions in a structurally
  complete blocked schedule;
- the schedule structural hash, committed content hash, seed, and every exact
  `(task, version, arm, repetition)` slot;
- unique run IDs, no unscheduled cells or task-version pooling, and at most one
  valid terminal record per slot;
- all configured immutable records are present; invalid infrastructure attempts
  remain listed as replacement evidence;
- confirmatory-only mode with one provider, exact model, service tier, reasoning
  configuration, toolchain, host constraints, network/cache policy,
  task-keyed agent timeouts, analysis revision, and schedule;
- a self-hashed frozen cohort manifest, exact schedule slot/content binding,
  initial-fixture and provisioning hashes, provider approval reference, unique
  sandbox workspace/attestation and response IDs, and one adapter plus dynamic
  runtime environment across the cohort;
- task-specific instruction bundle hashes and arm-specific fixture/evaluator
  revisions;
- task corpus, evaluator, analysis source, equivalence, runtime/DX,
  construction-cost, and pricing manifest pins;
- success derived from separate agent/evaluator/finalization outcomes,
  nonempty passed provisioning, a nonempty preflight whose checks all have status
  `passed`, and exactly one of every required
  evaluator check: `acceptance`, `hidden-regression`, `typecheck`,
  `architecture`, `prohibited-shortcuts`, and `task-specific`; and
- accounted tokens re-derived from raw provider counters and explicit overlap
  semantics with no estimation or double-counting; and
- monetary costs re-derived from raw usage and the exact canonical, hashed
  `PricingSnapshot`. Without that snapshot, monetary distributions and
  break-even remain unavailable; and
- exact baseline/final workspace manifests, diff hash, and internally
  consistent per-file patch evidence before a terminal record is eligible.

An agent-created prohibited workspace entry is retained as a valid failed run,
not an infrastructure replacement. Its unavailable exact patch is reported as
an agent-caused policy failure. Unconfirmed shutdown or unrelated finalization
loss remains invalid infrastructure evidence.

Stored `evaluation.success`, `finalSuccess`, and `accountedTokens` are only
cross-checks. A disagreement is integrity evidence and makes the cohort
inconclusive. Smoke records, pilot configuration, mixed phases, mixed cohort
pins, missing successful-run telemetry, or material protocol deviations can
never produce `SUPPORTED` or `NOT SUPPORTED`.

## Outputs

JSON and Markdown retain successful and failed token distributions, per-task
ratios, task-normalized ratios, paired block differences, Wilson intervals, all
secondary maintenance metrics, failure categories, telemetry missingness,
within-task/arm outliers, invalid replacements, missing cells, protocol
deviations, construction-cost evidence, and separate token/money break-even.
Unavailable historical construction cost remains unavailable. Markdown exposes
count, range, quartiles, median, and IQR for primary and secondary
distributions; it does not collapse the evidence to averages or medians alone.

`--analysis-source` is not an arbitrary attestation file. It must be the
canonical serialization produced by `serializeAnalysisSourceManifest` for the
exact, ordered set in `ANALYSIS_RUNTIME_FILES`. The CLI hashes every executing
reports and harness `dist/*.js` module and rejects the manifest if any byte
differs. The frozen
configuration pins the canonical manifest hash. A pricing snapshot is optional
only when its cohort ID, currency, and manifest hash are all null.

The canonical CLI loads each run through `readImmutableRunResult`; it never casts
arbitrary run JSON:

```sh
agentix-benchmark-report \
  --results-root=/absolute/immutable-results \
  --schedule=/absolute/schedule.json \
  --config=/absolute/analysis-config.json \
  --analysis-source=/absolute/frozen-analysis-source-manifest.json \
  --pricing-snapshot=/absolute/pricing-snapshot.json \
  --output=/absolute/new-report-directory
```

The output directory is exclusively reserved. Files are written beneath a
hidden staging directory, atomically renamed to `published`, and exposed only
after a final `COMPLETE` marker binds the manifest and output hashes. Existing
or incomplete report directories are never overwritten or treated as complete.

## Verification

```sh
npm run typecheck --workspace @agentix/benchmark-reports
npm test --workspace @agentix/benchmark-reports
```
