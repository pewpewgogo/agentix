# Benchmark Protocol

Status: preregistered design for Phase 1 on 2026-07-23. This protocol governs
confirmatory runs. Material changes after results are observed require a dated
decision record and make earlier and later cohorts separate experiments.

D-027 records the pre-observation Agentix naming and corpus/schedule amendment.
No outcome or win condition was changed.

## Purpose

This protocol compares agent maintenance of two behaviorally equivalent strict
TypeScript applications:

- the treatment application built with the agent-oriented framework; and
- a well-engineered plain TypeScript control application.

It is designed to support a negative result. Correctness is a gate. Efficiency
results are not reported as wins when correctness, telemetry, isolation, or
behavioral equivalence is inadequate.

## Phase gates

### Gate 1: design complete

Before core implementation:

- `HYPOTHESIS.md`, `ARCHITECTURE.md`, and this protocol exist;
- the provisional win condition is fixed;
- known limitations and decisions are recorded; and
- no benchmark outcome has been observed.

### Gate 2: framework primitives reliable

Before example applications:

- strict type-check and framework unit tests pass;
- compile-time negative tests pass;
- effect and authorization rejection tests pass;
- architecture checks have positive and negative fixtures;
- index generation is byte-for-byte deterministic; and
- all required CLI commands have selection tests.

### Gate 3: behavioral equivalence

Before benchmark harness validation:

- the two applications pass the same black-box acceptance suite;
- deterministic scenarios produce equivalent observable results;
- port/adapter contract tests pass;
- the framework application passes architecture checks;
- task fixtures have equivalent initial behavior and defects; and
- evaluator-only checks can run without importing framework-private code.

### Gate 4: measurement reliability

Before the full repeated experiment:

- inexpensive smoke runs prove workspace isolation;
- the telemetry adapter captures raw provider usage without estimates;
- file/tool instrumentation is tested against known scripted sessions;
- raw result validation catches truncation and duplicate run IDs;
- randomized scheduling is generated from a committed seed;
- exact model version, reasoning configuration, tools, limits, and instructions
  are pinned; and
- the task corpus and evaluator commit are frozen.

Smoke runs are engineering validation only. Their outcomes are excluded from the
confirmatory report.

### Gate 5: analysis

The report generator runs only over immutable valid records and a frozen analysis
version. It emits integrity errors rather than silently dropping malformed data.

## Task corpus

There are exactly ten initial task categories:

1. simple feature addition;
2. field propagation through storage, API, and tests;
3. cross-feature rule;
4. external service adapter;
5. localized defect;
6. misleading symptom with a non-local cause;
7. authorization change;
8. data/schema migration;
9. public operation rename with compatible consumers; and
10. read-only architecture question.

Every task has a stable ID and version. The framework and plain arms may use
different implementation-specific fixture commits and evaluator wiring, but
must share one user-facing request and equivalent observable acceptance criteria.

A task specification is data, not executable agent guidance. Its schema includes:

```json
{
  "schemaVersion": 1,
  "id": "task-03-cross-feature-rule",
  "version": 1,
  "userRequest": "...",
  "publicAcceptanceCriteria": ["..."],
  "fixture": {
    "framework": { "commit": "...", "subdirectory": "..." },
    "plain": { "commit": "...", "subdirectory": "..." }
  },
  "evaluator": {
    "publicCommand": ["..."],
    "hiddenManifest": "..."
  },
  "maximumSeconds": 1800,
  "prohibitedShortcuts": ["..."],
  "networkPolicy": "disabled"
}
```

The eventual schema also records expected public surfaces and migration input
fixtures where relevant. It never embeds the solution. Evaluator-only tests are
not copied into the agent workspace and must exercise public application or
documented test surfaces.

## Task construction rules

- Build tasks from natural maintenance operations, not from capabilities only
  the framework can express.
- Preserve equal externally observable starting state and desired behavior.
- Give the control application idiomatic organization, naming, validation,
  dependency injection, and tests.
- Do not add gratuitous files to the control or collapse treatment behavior into
  benchmark-specific helpers.
- Include both local tasks and tasks requiring dependency traversal.
- Include at least one plausible but wrong local diagnosis in category 6.
- Keep public task wording implementation-neutral. Do not tell one arm where to
  edit unless the same information is provided to both.
- Prohibit hard-coded evaluator outputs, test deletion, acceptance-test bypass,
  network lookup of prior solutions, and modification of harness records.
- Review paired fixtures manually and with black-box checks before freezing them.

Task authors must not participate as agents in confirmatory runs unless their
prior knowledge is irrelevant because the coding agent session is demonstrably
fresh and has only the standardized inputs. Task-author identity is still
recorded as a possible source of bias.

## Execution environment

Each run uses:

- a new isolated workspace created from the recorded fixture commit;
- a new agent session with no prior task conversation or memory;
- the same model provider, exact model version, service tier, and reasoning
  configuration;
- the same system/developer instructions except unavoidable randomized paths;
- the same tools and permissions;
- the same CPU/memory class and operating-system image;
- the same wall-clock limit;
- the same network policy; and
- the same initial user request and public acceptance information.

No run may access another run's workspace, transcript, result, generated patch,
cache keyed by task content, or solution. Dependency caches may be shared only
if they contain published packages and no application source or test output.

The runner records environment details, tool versions, commit hashes, dirty
state, and a hash of every supplied instruction. If a provider silently changes
the model behind an unchanged alias and no immutable model version is available,
the affected cohort is flagged and cannot establish reproducibility across the
boundary.

## Starting information and framework context

Both arms receive the repository, root README, normal package scripts, public
task criteria, and the same list of available tools. The framework arm may use
`agentix` because the CLI is part of the treatment. The plain arm may use its
normal repository search, TypeScript, and test commands.

Any framework guide, generated index excerpt, CLI output, or scaffold output
that enters model context is counted by provider telemetry like all other input.
Nothing is deducted as "framework overhead." Repository files that the agent
never reads are not artificially charged, because the research question concerns
context actually consumed rather than bytes present on disk.

The control gets an accurate concise architecture README and discoverable test
scripts. It does not get a generated dependency index in the primary bundle
comparison, because the index is one part of the treatment. A later preregistered
ablation may provide matched machine indexes to both arms to isolate capsules
from discovery tooling.

## Repetitions and randomized order

The confirmatory target is at least five valid independent repetitions for every
task and implementation, for at least 100 valid runs:

```text
10 tasks * 2 implementations * 5 repetitions = 100 runs
```

Before launch, the scheduler uses a committed random seed to permute arm order
within each task/repetition block and to interleave tasks. Blocking prevents a
time trend or provider drift from consistently favoring one implementation.

If budget cannot support five valid repetitions per cell, the full experiment
does not claim `SUPPORTED` or `NOT SUPPORTED`; available runs are labeled a pilot
and the verdict is `INCONCLUSIVE`. Replacement runs are allowed only for invalid
infrastructure runs under the rules below, never because an agent failed.

## Run lifecycle

For each scheduled run, the harness:

1. Creates a fresh workspace at the exact fixture commit.
2. Verifies the workspace and evaluator hashes.
3. Installs dependencies from the lockfile using the recorded cache policy.
4. Runs a recorded preflight proving the fixture has the intended initial
   failing/passing state.
5. Starts a fresh agent session with the standardized instructions.
6. Records every provider response and tool event allowed by provider policy.
7. Stops at agent completion, time limit, infrastructure failure, or policy
   violation.
8. Snapshots the final patch and repository status.
9. Runs public acceptance, evaluator-only regression, type-check, architecture,
   and prohibited-shortcut checks outside the agent session.
10. Writes one immutable raw result record and hashes all associated artifacts.

The agent may run tests during the session. Final evaluation always starts from
the agent's resulting workspace and is independent of the agent's claims.

## Success definition

A framework run succeeds only when all of these are true:

- the public acceptance suite passes;
- evaluator-only regression checks pass;
- the application type-check passes;
- the framework architecture check passes;
- prohibited-shortcut checks pass;
- the requested migration or read-only answer, when applicable, passes its
  task-specific evaluator; and
- no critical security or data-integrity regression is detected.

A plain run uses the same rule, with architecture status `not_applicable` unless
the control has its own preregistered architecture check. `not_applicable` is not
counted as a failure or a pass.

Warnings do not fail a run unless the task or frozen repository policy treats
them as errors. Exact warning counts are retained.

## Invalid runs versus failed runs

A run is invalid and may be replaced only for causes outside the implementation
and agent outcome:

- provider or harness outage before a usable agent response;
- corrupted or incomplete raw telemetry artifact;
- failure to create the specified fixture;
- evaluator infrastructure failure reproduced on the untouched fixture/control;
- accidental access to another run's solution;
- wrong model, instructions, permissions, time limit, or fixture; or
- host failure that prevents final evaluation.

The following are valid failures and must not be replaced:

- timeout while the agent is reasoning or editing;
- build, type, test, architecture, or regression failure caused by its patch;
- agent tool misuse;
- an agent giving up or returning an incorrect answer;
- excessive context use;
- a stale index produced by normal treatment behavior; or
- an agent modifying or bypassing tests in violation of the task.

Every exclusion and replacement is listed in the report with its preregistered
reason code. No statistical outlier is removed merely for being extreme.

## Raw telemetry schema

Every run record contains at least:

```text
identity
  schema version, run ID, task ID/version, implementation, repetition
  fixture/evaluator/analysis commits and schedule seed

agent configuration
  provider, exact model identifier, reasoning configuration, service tier
  hashes of system/developer/user instructions, tools, permissions, limits

environment
  host class, OS/container image, Node/package-manager versions
  dependency cache policy, network policy, start/end timestamps

provider usage
  uncached input, cached input, output, reasoning, provider total tokens
  request/response IDs, raw response artifact reference, usage semantics
  pricing snapshot ID and derived monetary cost or unavailable

interaction
  wall-clock duration, assistant turns, tool calls by type
  failed tool calls, retries, test commands and exit status
  file-content observations and file modifications

patch
  files modified, lines added/deleted, final diff hash, repository status

evaluation
  acceptance, hidden regression, type-check, architecture check
  prohibited shortcuts, task-specific evaluator, final success
  failure category, invalid-run reason if any
```

Raw provider payloads or normalized lossless telemetry are stored when policy
permits. Secrets and credentials are removed by a documented field-based
redaction step; free-form content is not silently rewritten.

## Metric definitions

### Tokens

Token fields are copied from provider telemetry. `accounted_tokens` uses only
non-overlapping reported counters as described in `HYPOTHESIS.md`. Reasoning
tokens are recorded when exposed but not double-counted when they are already a
subset of output tokens. Missing token fields are `null` with an availability
reason, never zero and never estimated from characters.

### Monetary cost

Cost is calculated from the run's raw non-overlapping token counts and a
versioned pricing snapshot recording provider, model, service tier, currency,
effective date, cache pricing, and units. If a required usage field or price is
unknown, cost is `unavailable`. Historical prices are not replaced with current
prices.

### Tool calls and retries

A tool call is one agent-issued tool invocation, including failed invocations.
One invocation containing multiple subcommands remains one tool call, while the
subcommands are retained separately when the adapter exposes them. A retry is a
subsequent attempt at the same intended action after an observed failure. The
harness applies deterministic classification rules and preserves raw events for
audit.

### Files inspected

A file is inspected when its contents, diff, rendered form, metadata-derived
source excerpt, or tool-produced semantic representation enter agent context.
Directory listings and filenames alone do not count as content inspection.

The harness records:

- all unique inspected paths;
- unique inspected source paths (`.ts`, `.tsx`, `.mts`, `.cts`, and declared
  generated source equivalents);
- repeat inspections;
- bytes/lines surfaced when the tool exposes them; and
- whether content came through a direct file read, search result, compiler
  diagnostic, generated index, or another tool.

If one shell call returns content from several files, every identifiable file
counts. Content with no reliably identifiable source path is marked
`unattributed`; it is not assigned a guessed filename. Generated index content
counts as the generated index file and token use, while its mere references to
source paths do not count those source files as opened.

### Files modified and lines changed

Files modified are paths whose final content differs from the fixture, excluding
harness artifacts outside the agent workspace. Lines added and deleted come from
the final normalized diff. Generated files are reported separately and included
in total modifications; they are never silently removed to favor the framework.

### Tests and failed attempts

A test command is a process invocation recognized by exact configured runners or
scripts, not every command containing the word `test`. Exit code, duration, and
selected scope are recorded. Failed attempts include failed tool calls, edits
later reverted because they failed checks, and distinct diagnosis/implementation
cycles followed by a failing verification. The automated count is accompanied by
raw events because intent classification is imperfect.

### Duration

Agent wall time runs from delivery of standardized task context to final answer
or limit. Environment provisioning and final external evaluation are recorded
separately. Runtime benchmark timings are never mixed with agent wall time.

## Runtime benchmark protocol

Runtime overhead is a separate experiment using frozen application states,
hardware, Node version, dependency graph, and benchmark scripts. It measures:

- cold start in a new process;
- warm command dispatch;
- valid and invalid schema validation;
- deterministic index generation;
- resident and peak memory where the platform exposes them;
- clean build time;
- full type-check time; and
- incremental verification after a representative localized edit.

Each microbenchmark includes warm-up where appropriate, enough iterations to
exceed timer resolution, raw samples, median, interquartile range, and tail
percentiles. Process startup benchmarks do not reuse a warm process. Framework
and plain measurements run interleaved in randomized order. Background load and
thermal state are monitored when possible.

Absolute developer-experience and runtime budgets will be fixed in
`DECISIONS.md` after executable smoke measurements and before any full agent
benchmark result is observed. Until those budgets are fixed, runtime acceptability
cannot contribute to a `SUPPORTED` verdict.

## Statistical analysis

The report includes per task and aggregate:

- valid run count and invalid/excluded run count;
- success count and rate;
- framework-minus-plain success-rate difference;
- 95 percent Wilson intervals for each success rate;
- medians, interquartile ranges, full ranges, and empirical distributions;
- median accounted tokens among successful runs;
- median tool calls, inspected files, modified files, retries, and duration;
- paired block differences shown descriptively without pretending repeated
  stochastic runs are deterministic pairs;
- failure categories;
- all outliers; and
- missingness by telemetry field.

Bootstrap confidence intervals for medians or median differences may be shown
when sample size supports them, using a committed deterministic analysis seed.
With five repetitions, intervals are expected to be wide and conclusions must
say so. Averages may be supplementary but are never the sole summary.

Aggregate token medians pool successful runs across the fixed balanced task
corpus. The report also shows task-normalized ratios so one large task cannot
silently dominate interpretation. Failed runs are not assigned artificial token
penalties; their actual tokens are reported separately and correctness remains a
gate.

A task category counts toward the seven-of-ten condition only when both arms
have at least one successful run with available accounted tokens and the
framework median is strictly lower. The report additionally shows whether its
success rate is worse; a token improvement paired with a critical category-level
correctness issue is called out and cannot satisfy the overall correctness gate.

## Failure taxonomy

Failures receive one primary category and any number of secondary tags:

- incorrect diagnosis;
- incomplete implementation;
- acceptance failure;
- hidden regression;
- type error;
- architecture violation;
- authorization/security regression;
- data/migration error;
- prohibited shortcut;
- test or build configuration damage;
- time limit;
- agent/tool operational error; or
- framework/index/CLI defect.

Classification is based on evaluator evidence. Ambiguous classifications are
marked as such and reviewed without changing success status.

## Framework construction cost

Construction effort is logged per development session when telemetry is
available: commits, changed lines, tests, wall time, tool calls, token counters,
and monetary cost. Manual human time is logged prospectively with start/stop
timestamps. Missing Phase 1 provider telemetry remains unavailable.

Costs are partitioned into framework, plain application, framework application,
shared acceptance, and benchmark infrastructure. The main break-even numerator
uses framework-specific construction and integration cost, with alternative
inclusive totals shown transparently. It is never inferred from repository size.

Break-even is computed separately for tokens and money using compatible units:

```text
construction_cost / (plain_median_task_cost - framework_median_task_cost)
```

Zero or negative savings produce `no break-even`; missing inputs produce
`unavailable`.

## Reproducibility artifacts

The repository will retain:

- exact fixture and evaluator commits;
- frozen task specs and instruction hashes;
- schedule seed and generated order;
- toolchain and model configuration;
- raw run JSON and allowed provider payloads;
- final patches and evaluation logs;
- pricing snapshots;
- runtime samples;
- analysis source and versioned report data; and
- a manifest of hashes connecting every derived result to raw inputs.

Raw results are append-only. Corrections create a new result with a new run ID;
its provenance records the superseded run ID, exact raw-envelope hash, reason,
and correction timestamp. The old directory is never overwritten. A correction
must retain the same scheduled identity and, for confirmatory evidence, the same
frozen schedule and cohort binding. Readers validate the retained correction
lineage and reject missing links, hash disagreement, or cycles. Generated
reports are disposable and must be reproducible from the manifest.

## Report and verdict

The final report states one verdict: `SUPPORTED`, `NOT SUPPORTED`, or
`INCONCLUSIVE`, using the fixed conditions in `HYPOTHESIS.md`. It includes:

- an executive result with sample size and telemetry availability;
- behavioral-equivalence evidence;
- per-task and aggregate distributions;
- failures, invalid runs, and outliers;
- runtime and developer-experience results kept separate from agent efficiency;
- framework construction cost and break-even;
- protocol deviations;
- limitations and threats to validity; and
- direct links or manifest references to raw evidence.

No conclusion uses unrecorded observations or estimated tokens. A favorable
smoke run, screenshot, anecdote, or selected transcript is not evidence for the
confirmatory verdict.
