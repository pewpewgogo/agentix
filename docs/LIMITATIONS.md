# Limitations and Threats to Validity

Status: updated through the Phase 5 engineering smoke boundary on 2026-07-23.
Items are retained even if later mitigated; mitigations and remaining risk are
added rather than erasing the original concern.

## Current project limitations

- Mitigated in Phase 2: the repository originally contained design documents
  only. Core behavior, compile-time restrictions, deterministic index generation,
  CLI behavior, testing helpers, and HTTP adapter behavior now have automated
  coverage. Phase 4 adds automated black-box application equivalence, and Phase
  5 adds smoke-only runtime/toolchain measurement. Confirmatory maintenance
  outcomes and human ergonomics remain unmeasured.
- Provider token telemetry for this Phase 1 authoring session is not available
  inside the repository. Construction token cost is therefore `unavailable` and
  will not be estimated.
- The repository currently has no Git `HEAD`, and every project file is
  untracked. Recorded SHA-256 values bind file snapshots, but they are not a
  substitute for the clean immutable source revision required by Phase 6.
- The provisional pre-Agentix corpus was superseded in place because no Git
  revision or confirmatory observation existed. D-027 preserves its old hashes
  and gives the Agentix corpus a distinct identity, but version control cannot
  yet reconstruct the earlier bytes; this is another reason Phase 6 remains
  blocked on an initial clean commit.
- There are zero confirmatory observations. No provider/model/service-tier
  configuration, pricing snapshot, retention policy, budget, or spend approval
  has been supplied, so the current framework verdict is `INCONCLUSIVE`.
- Production hidden evaluator drivers and runtime-verifiable fresh-session OS
  sandbox evidence do not exist yet. The fail-closed evaluator and scripted
  smoke adapters demonstrate rejection paths, not confirmatory readiness.
- Mitigated in Phase 5: runtime and automated developer-experience budgets were
  frozen in D-024 from explicit smoke-mode measurements before any agent-task
  result was observed. Human comprehension and editor ergonomics remain
  unmeasured, and calibration on one dirty, uncommitted host snapshot is not a
  confirmatory runtime result.
- Partially mitigated in Phase 2: the API shapes now pass strict source checks,
  negative compile-time fixtures, declaration builds, and cross-package tests.
  Editor latency and human comprehension remain unmeasured.
- Static association of tests, consumers, and schema metadata may be incomplete.
  The verifier must widen scope when it cannot prove a narrow set safe.
- The compiler depends on TypeScript 7's explicitly unstable sync and AST entry
  points. Exact pinning and fixture tests detect breakage locally, but upgrades
  may require non-trivial scanner changes.
- Production mode validates the adapter `Outcome` envelope but currently skips
  effect success/error payload schema revalidation. This is an explicit runtime
  tradeoff awaiting benchmarks, not proof that adapter implementations are safe.
- Mitigated in Phase 4: both example applications now pass the same black-box
  suite, including concurrent stock and duplicate-write cases. This demonstrates
  equivalence only for the frozen contract and tests, not for all possible input
  schedules or failures.
- Both examples use in-memory persistence and a scripted payment service. They do
  not demonstrate database migrations, process restarts, network partitions,
  durable outboxes, or real external-service idempotency.
- The two arms use different concurrency mechanisms: a serialized critical
  section in the control and explicit reserve/release effects in the framework.
  Their tested observable behavior matches, but failure timing outside the
  contract can still differ.
- Mitigated after the Phase 4 audit: both transports now authorize before body
  parsing, normalize malformed URI encoding identically, use the same public
  transport constants, and reject blank generated order IDs without local state
  changes. These tests do not prove equivalence for every malformed request.
- Customer/product create claims are process-local in-memory primitives in both
  examples. A production database needs a unique constraint or durable
  transaction; the example claim is not evidence of cross-process safety.
- An approved external payment precedes generated order-ID validation. The
  scripted gateway has no durable side effect, and local state is compensated,
  but a real gateway would require an idempotency/refund design for this failure
  window.

## Construct validity

### Tokens are an imperfect proxy for context burden

Provider token counters measure model traffic, not comprehension or cognitive
load. Cache semantics and reasoning-token reporting differ by provider. The
protocol records raw categories and adapter semantics and refuses to estimate
missing data, but cross-provider comparisons would still be unsafe.

### Files inspected can be gamed or misclassified

One generated index can summarize many files, while shell tools can concatenate
many sources in one call. Counting both tool calls and identifiable files reduces
but does not remove this problem. Unattributed content and semantic tool output
remain difficult to classify.

### Correctness tests are incomplete specifications

Shared and hidden tests cannot prove absence of every regression. Security,
maintainability, and migration quality require targeted checks and review. A
framework could overfit known acceptance surfaces even without an intentional
shortcut.

### The three-to-five-file target is task-dependent

Cross-cutting migrations and public-operation renames may legitimately require
more files. Reporting the distribution by task is more honest than treating the
target as a universal invariant.

### Developer experience needs human evidence

Agent metrics do not establish that humans find declarations, generics, errors,
or generated metadata usable. Editor diagnostics, compile times, qualitative
review, and preferably blinded human tasks are needed before a broad DX claim.

## Internal validity

### Framework-author and task-author bias

The same project may design the framework, baseline, and tasks. Task shapes or
naming could unintentionally favor the framework. Equivalent black-box behavior,
a strong control, frozen task specs, evaluator-only checks, and external review
mitigate but do not eliminate this bias.

### Unequal maturity and optimization effort

The framework will be new, while plain TypeScript and its validation library are
mature. Conversely, framework authors may spend more time optimizing the
treatment. Construction cost and per-arm effort must be reported.

### Learning and contamination

Repeated sessions may share provider caches, hidden memory, fixtures, or prior
solutions. Fresh sessions and workspaces, randomized scheduling, instruction
hashes, cache policy, and isolation checks reduce risk. Provider-side state that
is not observable remains a limitation.

### Model or service drift

Provider aliases, routing, load, safety policy, and tool implementations can
change during a 100-run experiment. Exact identifiers, interleaved randomized
blocks, timestamps, and environment records help identify drift but cannot fully
control a remote service.

### Index quality is coupled to compiler correctness

A stale or incomplete index can make agents confidently wrong. Staleness checks,
deterministic manifests, negative fixtures, and conservative widening are
required. Normal index failures count against the treatment; they are not
discarded as harness failures.

### Narrow verification may hide regressions

Affected-set selection is itself part of the treatment and could improve speed
by omitting necessary tests. Hidden full regression evaluation after every run
and explicit selection fixtures are mandatory.

### Instrumentation may change behavior

Telemetry wrappers can add latency, alter tool output, or fail to observe file
content surfaced indirectly by diagnostics. Both arms use the same wrappers, and
instrumentation is validated with scripted smoke sessions, but observer effects
remain possible.

### Small samples have wide uncertainty

Five repetitions per cell are expensive but statistically small, especially for
binary success. Medians may be unstable and Wilson intervals wide. The report
must show distributions and may conclude `INCONCLUSIVE` even when point estimates
meet thresholds.

## External validity

- The example is one back-end commerce domain. Results may not transfer to UI,
  mobile, data-science, embedded, real-time, or infrastructure repositories.
- Fixture repositories are likely smaller and cleaner than long-lived production
  monorepos with legacy boundaries and ownership constraints.
- Ten maintenance tasks cannot represent all debugging, refactoring, security,
  performance, or operations work.
- Results for one model version and tool harness may not generalize to different
  agents, context windows, search tools, or future models.
- TypeScript's structural type system and compiler API make this design language-
  specific. The findings do not directly apply to other ecosystems.
- The initial experiment compares only plain TypeScript. It cannot establish
  superiority to NestJS, Fastify plugins, Effect, domain-driven modular
  monoliths, or other established patterns.

## Framework enforcement limits

- Compile-time and AST checks are not a security sandbox. Hostile code can use
  dynamic evaluation, transitive dependencies, native modules, or obscure global
  access to evade architecture rules.
- TypeScript types are erased. Runtime boundary validation is still required and
  can itself contain defects.
- An explicitly declared effect can still be semantically wrong, non-idempotent,
  or used in an unsafe order.
- External transactions cannot generally be made atomic with local storage. The
  example must model idempotency, outbox, or compensation behavior explicitly.
- Pure invariant predicates are only as good as the evidence passed to them.
  Explicit invocation avoids hidden work but permits a developer to forget a
  check; declaration and verification tests mitigate this.
- Stable string IDs make dependencies visible but introduce rename and versioning
  obligations. Task 9 deliberately tests this cost.

## Benchmark operational limitations

- Four retained runtime JSON files predate the sealed schema-version-2 runtime
  pipeline. They are labeled legacy, unsealed smoke artifacts and cannot enter
  confirmatory analysis; the hardened final-source smoke was exercised in
  temporary storage rather than published as hypothesis evidence.
- Process maximum resident set size is an operating-system-reported child
  lifetime high-water mark, not a clean marginal-memory estimate. It can include
  toolchain startup and allocator behavior unrelated to the framework.
- Isolated toolchain workspaces copy lockfile-bound third-party dependencies and
  remove write bits only from those temporary copies. This prevents accidental
  writes from reaching the source installation, but it is not a security
  boundary: code running as the same operating-system user can restore write
  permissions on its private copy. Dependency contents are not recursively
  hash-bound, so a frozen installation/cache policy and container identity
  remain necessary before confirmatory measurement.
- Runtime publication fsyncs files and attempts to fsync their parent directory,
  but directory durability is best-effort on filesystems that reject directory
  handles. Its content hashes and no-overwrite semantics detect corruption;
  they do not make every host filesystem crash-proof.
- Raw provider responses may be unavailable or require redaction under provider
  policy. Normalized telemetry must record what was lost.
- Monetary cost depends on historical pricing and service tier. Missing prices
  make cost and monetary break-even unavailable.
- Network-disabled tasks improve isolation but do not represent maintenance that
  legitimately requires documentation or service access.
- Dependency installation and cold caches can dominate wall time. Provisioning
  time is separated from agent time, while agent-initiated installs remain part
  of the run.
- Evaluator-only tests reduce gaming but make independent audit harder unless
  they are released after the experiment.
- Architecture-answer tasks require deterministic scoring. The evaluator must
  use a frozen fact rubric and allow semantically equivalent answers; keyword
  matching alone is inadequate.
- Migration tasks require durable fixture data and rollback/idempotency checks;
  checking only a clean database would understate risk.

## Planned mitigations

Before a confirmatory run, the project must:

1. demonstrate black-box equivalence on shared deterministic scenarios;
2. obtain independent review of paired fixtures for obvious treatment bias;
3. validate telemetry and file accounting with scripted known traces;
4. freeze exact model, environment, task, evaluator, and analysis versions;
5. exercise stale-index, false-negative affected-set, and forbidden-effect
   fixtures;
6. precommit randomization and analysis seeds;
7. set runtime and developer-experience budgets without viewing full-run results;
8. retain all failures, exclusions, and outliers in the report; and
9. label missing values as unavailable rather than filling them.

## Interpretation boundary

A `SUPPORTED` verdict would mean only that this framework bundle met the fixed
criteria for this application, task corpus, model, tooling, and environment. It
would justify replication and ablation, not a universal claim. A `NOT SUPPORTED`
verdict is useful evidence against the current design. An `INCONCLUSIVE` verdict
must not be rewritten as a directional win.
