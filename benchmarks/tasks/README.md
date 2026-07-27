# Versioned maintenance tasks

`v1/` and `v2/` each contain exactly ten implementation-neutral task
specifications. Each specification points to one framework fixture, one plain
TypeScript fixture, and one evaluator-only manifest by SHA-256. The user
request and public criteria are the only task-specific text supplied to an
agent.

The files are data. They must not contain edit hints, source paths, hidden
assertions, or implementation-specific wording. Change a task by adding a new
task version; never rewrite a frozen version after observing benchmark results.

`corpus.lock.json` freezes the v1 corpus and `corpus-v2.lock.json` freezes the
v2 corpus: every task, fixture, overlay input, base inventory, and hidden
evaluator definition. Run the evaluator tests before a freeze or run. A hash
mismatch is an integrity error, not a reason to skip a file.

## v2 port notes

The `v2/` specifications were ported from `v1/` before any confirmatory
observation. Every user request, public acceptance criterion, expected public
surface, category, prohibited-shortcut policy, and time limit is byte-identical
to v1 — the v1 wording was already implementation-neutral, so nothing needed
rewording for the v2 single-file feature layout. The intentional differences
live outside the task text:

- fixture references point at `benchmarks/fixtures/v2/` and hidden manifests at
  `benchmarks/evaluator/hidden/v2/`;
- the paired-equivalence contract is `commerce-http-v2` (the v2
  `{ok, value|error}` envelope) with `-v2` scenario labels;
- the task-05 framework defect is expressed as a `max: 79` bound on the
  products feature-module input schema (v1 used a `refine` in
  `operations.ts`, a file that no longer exists) — same observable defect;
- the task-06 framework defect guards the event append inside the in-memory
  adapter commit (`adapters.ts`) instead of the v1 `application.ts` state
  commit — same misleading symptom at the same transactional boundary;
- workspace root profiles (README/package/tsconfig/lockfile) enter v2
  workspaces as hash-locked overlay files rather than inventory entries,
  because the v2 inventory pins the already-frozen commit
  `4745d33c07b2c4a9cefddf1e0ee53b46566af730`, which predates those profile
  files. Fold them into the inventory at the next freeze commit.
