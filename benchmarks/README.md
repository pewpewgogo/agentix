# Benchmark system

The maintenance study is split into independently auditable layers:

- `tasks/` freezes ten implementation-neutral requests and public criteria.
- `fixtures/` materializes hash-verified, arm-isolated starting repositories.
- `evaluator/` keeps hidden checks outside agent workspaces and produces the
  fixed six-check evaluation plan.
- `harness/` schedules fresh sessions, records raw provider/tool/file telemetry,
  derives non-overlapping token accounting, and writes immutable results.
- `runtime/` measures runtime/toolchain behavior separately from agent work.
- `reports/` validates a frozen confirmatory cohort and derives distributions,
  break-even, and the fixed verdict.
- `results/` stores append-only raw evidence; filenames containing `smoke` are
  engineering validation only.

No bundled component invokes a paid model. Confirmatory execution requires an
external adapter, explicit approval gate, exact model and pricing snapshot, a
committed randomized schedule, evaluator hooks, and at least five valid fresh
repetitions in every task/arm cell.

The frozen 100-slot schedule is
`harness/config/confirmatory-schedule.v1.json`, generated from
`agentix-commerce-v1-2026-07-23`. Current engineering-gate evidence and the
remaining operational blockers are recorded in `../docs/PHASE5_READINESS.md`.

The Agentix/Express/NestJS process is documented in
[`THREE_ARM_RUNBOOK.md`](THREE_ARM_RUNBOOK.md). The notes sandbox and HTTP runner
are calibration/exploratory layers; a confirmatory three-arm maintenance study
requires a new v2 corpus and must not mutate the frozen two-arm v1 evidence.
