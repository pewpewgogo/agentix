# Hypothesis and Evaluation Contract

Status: preregistered for Phase 1 on 2026-07-23. This document must not be
silently changed after benchmark results are observed. Any later change must be
dated, justified in `DECISIONS.md`, and preserve the previous rule in version
control.

The treatment was named Agentix in D-027 before any confirmatory observation;
the hypothesis and win conditions were not changed.

## Research question

Can an ordinary, strict-TypeScript application framework optimize application
maintenance for coding agents by bounding the source context needed for a
change, without making correctness, runtime behavior, or human development
unacceptably worse?

The proposed treatment is a framework that combines:

- feature capsules with enforced public boundaries;
- typed commands, queries, events, ports, and error outcomes;
- declared permissions and external effects;
- deterministic, executable invariants;
- deterministic machine-readable indexes; and
- commands for inspecting and verifying the smallest safe scope.

The primary comparison is the complete treatment, not one isolated mechanism.
Ablations may later investigate which mechanisms matter, but they cannot replace
the primary framework-versus-plain comparison.

## Experimental units

An experimental unit is one independent coding-agent session attempting one
versioned maintenance task against one implementation fixture. A run starts from
a fresh worktree, has no access to another run, and ends when the agent declares
completion or reaches the time limit.

The initial comparison has two implementations of the same application:

1. `framework-app`, using this framework and its generated index and CLI.
2. `plain-app`, using well-organized strict TypeScript, runtime validation, a
   small HTTP server, and normal tests without the new framework.

The plain implementation is an active control, not a deliberately weak
baseline. Both applications must expose identical black-box behavior and begin
each corresponding task with equivalent defects or missing behavior.

## Hypotheses

### Correctness non-inferiority

The framework success rate is no more than five percentage points lower than
the plain application's success rate. Success is a gate defined by the protocol,
not a subjective code-quality score.

Null condition: the framework is more than five percentage points worse, or the
available repetitions are insufficient to make the comparison credible.

### Context-efficiency superiority

Among successful runs, the framework reduces median accounted token use by at
least 20 percent relative to the plain application. Accounted tokens use raw
provider telemetry and include all context supplied to the agent, including any
framework documentation or generated index content. Cached tokens are not
treated as free.

Null condition: the reduction is less than 20 percent, zero, negative, or cannot
be measured with raw telemetry.

### Breadth of benefit

At least seven of the ten preregistered task categories have a lower framework
median for accounted token use among successful runs. A category with no
successful run in either arm, missing token telemetry, or tied medians is not an
improvement.

### Secondary hypotheses

At equal or better correctness, framework runs should have lower medians for:

- total tool calls;
- files whose contents are inspected;
- unique source files whose contents are inspected;
- failed attempts and retries; and
- wall-clock duration.

The framework should not cause a critical correctness, security, or
maintainability regression, and its separately measured runtime and developer
experience costs should remain within the budgets preregistered before the full
benchmark.

The design target that one localized feature change normally requires reading
no more than three to five source files is a reported secondary outcome, not a
substitute for token telemetry or correctness.

## Fixed task categories

The full experiment will include these categories, with versioned task texts and
fixtures:

1. Add a simple feature.
2. Add a field across storage, API, and tests.
3. Add a cross-feature business rule.
4. Add a new external-service adapter.
5. Diagnose and fix a localized defect.
6. Diagnose a misleading symptom whose cause is elsewhere.
7. Change an authorization rule.
8. Perform a data or schema migration.
9. Rename a public operation without breaking consumers.
10. Answer an architecture question without changing code.

The task corpus will be frozen before full runs begin. Smoke-run findings may
change tasks only before the freeze and must be documented without using smoke
outcomes as confirmatory evidence.

## Provisional win condition

The verdict is `SUPPORTED` only if all of the following hold:

- the observed framework success rate is not worse by more than five percentage
  points;
- the median accounted-token reduction over successful runs is at least 20
  percent;
- at least seven of the ten task categories improve on accounted tokens;
- there is no critical correctness, security, or maintainability regression;
- the result reproduces across repeated fresh sessions; and
- the full-run data pass the integrity checks in `BENCHMARK_PROTOCOL.md`.

The verdict is `NOT SUPPORTED` if reliable measurements violate one or more of
the fixed win conditions. The verdict is `INCONCLUSIVE` if telemetry is missing,
there are too few valid repetitions, equivalence has not been established, the
protocol is materially compromised, or confidence is otherwise inadequate.

No weighted score may trade correctness for efficiency. Secondary metrics may
explain a verdict but cannot rescue failure of a primary condition.

## Measurements and derivations

The harness records provider fields as reported, without estimation:

- uncached input tokens;
- cached input tokens;
- output tokens;
- reasoning tokens, when exposed;
- provider-reported total tokens;
- provider identity and exact model version;
- provider request and response identifiers where permitted; and
- the pricing snapshot used for monetary calculations.

Because providers differ in whether cached and reasoning tokens are subsets of
other counters, every telemetry adapter must declare its accounting semantics.
The primary `accounted_tokens` value is derived only when the adapter can sum
non-overlapping reported fields. It must never double-count reasoning tokens.
When that cannot be established, the provider-reported total is used if its
meaning is documented. Otherwise `accounted_tokens` is `unavailable`, and the
run is excluded from token claims but retained for correctness analysis.

For plain median `P` and framework median `F`, token reduction is:

```text
(P - F) / P
```

It is defined only when `P > 0` and both medians are available.

## Construction cost and break-even

Framework construction cost is reported separately from task-run cost. It
includes framework design and implementation, its documentation and tests,
compiler and CLI work, benchmark-specific framework integration, and maintenance
needed to keep those pieces working. Business-application work required equally
by both arms is reported separately.

Construction tokens, tool calls, wall time, and monetary cost are recorded only
from available raw telemetry. Missing historical telemetry remains
`unavailable`; it is never reconstructed from prose or line counts.

For compatible cost units, approximate break-even is:

```text
framework_build_cost /
(plain_median_task_cost - framework_median_task_cost)
```

The report says `no break-even` when per-task savings are zero or negative. It
says `unavailable` when construction or task cost is unavailable. Token and
monetary break-even are separate calculations; they must not mix units.

## Falsifying observations

The proposed approach should be rejected or materially redesigned if reliable
results show any of the following:

- lower token use is explained by lower correctness;
- generated indexes are stale often enough to misdirect agents;
- framework tasks merely move context into large generated or documentation
  payloads;
- cross-feature changes routinely escape the claimed three-to-five-file bound;
- agents spend more calls learning framework-specific indirection than the index
  saves;
- effect or architecture enforcement creates false confidence or is readily
  bypassed in ordinary domain code;
- runtime or type-check costs exceed the preregistered budgets;
- human maintenance becomes materially more difficult; or
- benefits appear only in tasks written around framework primitives and do not
  survive adversarial or misleading-symptom tasks.

## Claims explicitly out of scope

This study will not initially claim:

- generalization beyond TypeScript back-end applications;
- superiority to every established application framework;
- improved greenfield generation rather than maintenance;
- security isolation from hostile application code;
- lower token usage when provider telemetry is unavailable;
- causal attribution to any one framework feature; or
- benefits at repository scales not represented by the fixtures.

## Related documents

- `ARCHITECTURE.md` specifies the treatment being evaluated.
- `BENCHMARK_PROTOCOL.md` fixes run, telemetry, analysis, and reporting rules.
- `DECISIONS.md` records material choices and rejected alternatives.
- `LIMITATIONS.md` lists known threats to validity and current gaps.
