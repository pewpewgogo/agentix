# Three-arm notes sandbox

These deliberately small applications expose the same create/get notes behavior:

| Arm | Path | Stack |
| --- | --- | --- |
| Agentix | `notes-app` | feature capsule, declared operations/effects, Agentix CLI |
| Express | `plain-notes-app` | ordinary TypeScript, Zod, Express wiring |
| NestJS | `nestjs-notes-app` | Nest module, controller, service, Zod |

Run the behavior tests and deterministic context calibration:

```sh
npm run sandbox:test
npm run sandbox:token-budget
```

The token report is a cheap design instrument, not model evidence. Its
`ceil(characters / 4)` estimate helps find obvious context waste before live
runs. Provider comparisons must use actual provider counters and the process in
[`../benchmarks/THREE_ARM_RUNBOOK.md`](../benchmarks/THREE_ARM_RUNBOOK.md).

`token-budget/run.mjs` measures three scenarios per arm, all derived from a
declarative per-arm model in the script (no hand-entered numbers):

- **full-src (like-for-like):** every non-test TypeScript file under `src`
  plus ONE comparable test per arm. Agentix counts its call-level
  `notes.dispatch.test.ts` (the same layer the Express/NestJS suites test);
  its extra HTTP end-to-end test is reported separately as an informational
  line, outside the headline number.
- **affected:** what it costs to answer "what is affected by `notes.create`".
  Agentix charges the `agentix affected` output. Conventional arms are modeled
  as the realistic grep strategy: the `src` file inventory, a grep for the
  operation symbol, and the full content of every matched file (a grep hit
  still requires opening the file to confirm relevance).
- **change-cost:** the scripted task "add a `notes.delete` endpoint".
  READ (direct) = the files each arm's conventions require opening (Agentix:
  feature file + dispatch test — the app assembly is auto-wired and stays
  unread; Express: `note.ts` + `notes-service.ts` + `app.ts` + test; NestJS:
  `note.ts` + service + controller + test). READ (inspect-assisted, Agentix
  only) = the direct reads plus the compact `inspect` output — the discovery
  tool whose fixed cost substitutes for reading wiring in larger apps; on this
  deliberately tiny app it exceeds the direct strategy.
  WRITE = the count of files the task modifies, derived from the same model
  (Agentix: feature file + test; Express/NestJS: service + wiring + test).

Results land in `token-budget/results/token-budget-latest.{json,md}`
(gitignored; the committed `results/README.md` explains the policy) and are
stamped with the git commit, Node version, and estimator version. Generated
outputs (`.agentix/`, `dist/`, `node_modules/`) never enter any measurement.
