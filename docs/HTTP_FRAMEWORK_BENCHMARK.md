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

## Methodology v2 run (2026-07-26)

This section records the v2 rerun after the framework's v2 redesign. It
supersedes the v1 observations above for current-code questions; the v1 record
stays frozen and unedited. Classification remains **exploratory**; nothing here
is confirmatory evidence for the agent-maintenance hypothesis.

Method changes from v1, all recorded in each report's `methodology` block:

- The Agentix target uses the v2 API served by the raw `serveNode` host, and
  the v1 target's redundant response re-validation was removed.
- A second measured condition `validated` gives the Express and NestJS targets
  zod input+output validation, matching the work Agentix always performs. The
  `default` condition keeps the v1 minimal-check targets.
- A new `--isolated` mode runs every target in its own child process with the
  client in the parent over real loopback sockets. The v1 in-process method
  (all three servers plus the client on one event loop) inflated cross-stack
  gaps roughly tenfold; the in-process mode is retained only for continuity.
- Workloads: echo POST valid/invalid (as v1), plus `param-get`
  (`GET /items/:id`) and `echo-batch` (8 in-flight keep-alive requests).
- New seed `agentix-http-frameworks-exploratory-v2-2026-07-26`; report
  `schemaVersion` 2 with per-sample workload/condition labels.

Both records were produced from clean committed tree
`65ac5375baf2930805253ba7ab3b3b1f9ec5f3e2` (`dirty: false`), Node v24.16.0,
Apple M4 Max, express 5.2.1, @nestjs/core 11.1.28, zod 4.4.3; 10 warmups,
300 measured iterations per workload.

Isolated-mode medians (microseconds; agentix / express / nestjs):

| Workload | default | validated |
| --- | --- | --- |
| echo-valid | 113.0 / 126.8 / 139.4 | 100.8 / 117.9 / 127.7 |
| echo-invalid | 84.9 / 95.5 / 111.7 | 83.5 / 106.3 / 120.3 |
| param-get | 63.8 / 67.1 / 78.5 | 61.2 / 67.4 / 80.4 |
| echo-batch (8 in-flight) | 269.1 / 318.7 / 346.3 | 261.2 / 311.3 / 348.7 |

Process metrics (isolated mode, default condition): cold-ready median
36.6 ms / 71.1 ms / 146.2 ms; ready RSS median 61.4 MiB / 79.6 MiB / 97.0 MiB.

In-process-mode medians follow the same ordering in every cell (for example
echo-valid default 77.2 / 82.8 / 91.6). Under equal validation work
(`validated`), Agentix's echo-valid median is 14.5% below Express and 21.1%
below NestJS in isolated mode.

Observations, subject to the same interpretation limits as v1: Agentix's
median latency was the lowest of the three stacks in every workload, in both
conditions and both modes, with the lowest cold-ready time and ready RSS.
These remain microbenchmarks of small handlers on one machine, not a general
framework ranking.

Raw evidence (append-only; the v1 files above are unchanged):

- [`http-frameworks-exploratory-v2-isolated-2026-07-26.json`](../benchmarks/results/http-frameworks-exploratory-v2-isolated-2026-07-26.json)
  — SHA-256 `aa3fabd63b9c886cf5486c0901baaf750905505a3205e0a66283c79acfdef30b`
- [`http-frameworks-exploratory-v2-inprocess-2026-07-26.json`](../benchmarks/results/http-frameworks-exploratory-v2-inprocess-2026-07-26.json)
  — SHA-256 `26b8e9a0d1bb3905299d4e377d5c2f6c950dbd9c2ad4fbda09c5ac5c721ed9a5`
  (fresh-process probes skipped via `--no-process`, recorded as unavailable)
- measurement-plan SHA-256
  `9d293e9015be4258984fe27e8e03ed19b7e004a9ce41672846d0e84fdbf45e71`
- comparison-source SHA-256
  `03d2a073c02cf342d261fb63913fe336af4add47d728b9312935292269df5332`
- package-lock SHA-256
  `896eccaf998cc6efc6bede7177c142ea4287d3cc1cca451e603804050bd963eb`
