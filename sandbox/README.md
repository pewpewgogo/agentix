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
`characters / 4` estimate helps find obvious context waste before live runs.
Provider comparisons must use actual provider counters and the process in
[`../benchmarks/THREE_ARM_RUNBOOK.md`](../benchmarks/THREE_ARM_RUNBOOK.md).
