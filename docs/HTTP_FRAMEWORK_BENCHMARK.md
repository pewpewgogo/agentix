# Exploratory HTTP Framework Benchmark

Date: 2026-07-23

## Scope

This benchmark compares Agentix, Express, and NestJS-on-Express only at an
identical HTTP boundary. It does not measure the preregistered coding-agent
maintenance hypothesis and does not replace the Agentix-versus-plain corpus.

Each target starts a real loopback server and exposes `POST /echo`:

- `{ "value": 7 }` returns HTTP 200 and the same success envelope;
- malformed JSON or any other shape returns HTTP 400 and the same validation
  envelope.

The runner starts all three targets outside hot-request timers, assigns one
keep-alive client to each target, consumes each complete response, and rotates
order using seeded blocks that contain all three stacks. Cold-ready and memory
observations run in fresh child processes that dynamically import only the
selected target.

## Frozen exploratory run

```text
seed: agentix-http-frameworks-exploratory-v1-2026-07-23
warmups per HTTP metric and stack: 10
measured observations per HTTP metric and stack: 100
fresh child-process observations per stack: 5
```

Metrics:

- valid loopback request latency;
- invalid loopback request latency;
- fresh-child dynamic-import-to-listening readiness;
- ready-process RSS;
- ready-process maximum RSS.

Raw measurements, failures, environment identity, dependency versions, Git
state, lockfile hash, and source hash are retained. Summaries use R-7 quartiles,
median, IQR, p95, and range.

## Interpretation limits

This measures configured stacks, not abstract framework cores. NestJS uses
Express underneath. Network loopback and JSON costs can dominate small
differences, and a one-route microbenchmark cannot predict a non-trivial
application's performance or an AI agent's maintenance efficiency. All results
are exploratory and confirmatory-ineligible.

## Results

The frozen exploratory run completed with 705 raw samples and zero unavailable
measurements on Node 24.16.0, macOS arm64, an Apple M4 Max (16 logical CPUs),
and 48 GiB of memory.

| Median (p95) | Agentix + Node | Express 5.2.1 | NestJS 11.1.28 + Express |
| --- | ---: | ---: | ---: |
| Valid request | 207.4 µs (352.1 µs) | 133.0 µs (242.2 µs) | 155.6 µs (293.6 µs) |
| Invalid request | 153.6 µs (277.3 µs) | 101.5 µs (183.7 µs) | 125.6 µs (209.2 µs) |
| Cold import-to-ready | 38.4 ms (42.5 ms) | 59.7 ms (63.5 ms) | 136.0 ms (137.6 ms) |
| Ready RSS | 61.4 MiB (61.5 MiB) | 71.8 MiB (72.7 MiB) | 91.7 MiB (92.7 MiB) |
| Process maximum RSS | 61.4 MiB (61.5 MiB) | 71.8 MiB (72.7 MiB) | 92.1 MiB (93.0 MiB) |

Express had the lowest median hot-request latency. Agentix's median valid and
invalid latency was respectively about 56% and 51% higher than Express, while
NestJS-on-Express was between them. Agentix had the lowest cold-ready time and
ready memory: Express used about 17% more ready RSS and NestJS about 49% more;
NestJS cold readiness was about 3.5 times Agentix's.

These are observations for this echo configuration, not a general framework
ranking. In particular, the Agentix target performs its declared command
dispatch and schema validation, while the Express and Nest targets use the
minimal finite-number check required by the endpoint contract. The host was not
dedicated or process-isolated, so unrelated background activity may have added
noise despite the balanced request order.

Raw evidence:

- [`http-frameworks-exploratory-v1-2026-07-23.json`](../benchmarks/results/http-frameworks-exploratory-v1-2026-07-23.json)
- raw file SHA-256:
  `d6ea63a0a57100a62ce810ed4c828d2c19e0e4f546e2a7e32e6f541d26d56ca4`
- measurement-plan SHA-256:
  `c90319d39da34a8872e986a66c632718a52278da883e7acfb22abecaf94c1664`
- comparison-source SHA-256:
  `efcb6db8dfb4221f071488fc17adb80e3ba5bc594a79d3367f5b3bcf00a09d08`
- package-lock SHA-256:
  `855bc97725ce43b3dbbfae4b7fa63f4ebd12c8365783a8654e86742769f46085`

The report records Git commit
`9ab2948002193426d9f0b0eb6d4d0ba8b87ed60a` with a dirty worktree because the
new comparison source had not been committed. The comparison-source and lock
hashes bind the exact measured implementation and dependencies, but a clean
committed rerun would be stronger evidence.
