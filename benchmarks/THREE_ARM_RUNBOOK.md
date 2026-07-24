# Agentix, Express, and NestJS benchmark runbook

This repository separates three questions that are often accidentally mixed:

1. **Context calibration:** how much source or tool output is presented before
   an agent edits anything?
2. **Runtime/toolchain cost:** what do equivalent configured HTTP stacks cost to
   start and execute?
3. **Maintenance outcome:** does an agent finish the same change correctly with
   less context, time, and money?

No single score combines these layers.

## Cheap calibration on every change

```sh
npm ci
npm run sandbox:test
npm run sandbox:token-budget
npm run benchmark:http-frameworks -- --no-process
```

The notes sandbox is intentionally small. It catches declaration overhead and
bad agent-entry guidance early. The context report uses a disclosed
`ceil(characters / 4)` heuristic; it is never reported as real model usage.

The HTTP comparison uses real Agentix, Express, and NestJS servers with matched
echo behavior. It remains exploratory because one loopback route measures
configured stacks, not maintenance quality or framework value.

The manual GitHub Actions workflow **Three-arm benchmark smoke** runs both
layers on a pinned commit and uploads the raw reports. Record the workflow URL
with any numbers you discuss.

## Live-agent maintenance study

The frozen v1 maintenance corpus is a two-arm Agentix/plain study. Do not add a
NestJS label to its files, hashes, or 100-slot schedule. A three-arm study is a
new v2 corpus with new fixtures, evaluators, analysis configuration, and a
blocked 150-slot schedule for ten tasks, three arms, and five repetitions.

Before paying for runs:

1. Define ten implementation-neutral maintenance requests and external behavior
   checks. Include local changes, cross-layer changes, misleading symptoms, and
   one architecture question.
2. Give every arm the same behavior, dependencies where possible, test strength,
   starting defects, and allowed tools. Keep framework-specific guidance inside
   that arm's committed `AGENTS.md`.
3. Freeze each starting tree by Git commit and content manifest. Keep hidden
   evaluators outside agent workspaces.
4. Pin provider, exact model/version, reasoning configuration, service tier,
   pricing snapshot, Node/npm versions, dependency cache policy, network policy,
   host class, timeouts, and agent instructions.
5. Randomize complete task/repetition blocks and rotate all three arm orders.
   Each run starts from a fresh isolated workspace and a fresh model session.
6. Require an explicit provider-spend approval before starting the schedule.
   Smoke adapters and pilot runs never enter the confirmatory cohort.

## Metrics and decision order

Correctness is the gate. Derive it from tests and hidden evaluators, not the
agent's final message. Then report:

- provider-reported uncached input, cached input, output, and reasoning tokens;
- successful and failed run token distributions separately;
- wall-clock duration and exact monetary cost;
- files inspected/modified, tool calls, failed commands, retries, and diff size;
- per-task results plus paired differences within each randomized block.

Use medians, IQRs, ranges, and per-task ratios. Preserve raw run records. Do not
replace failures with successful reruns; classify infrastructure-invalid runs
separately and retain their lineage.

## Interpretation

The useful Agentix hypothesis is not “always fewer tokens.” It is:

> Agentix pays fixed declaration cost but keeps maintenance context closer to
> the affected feature than to total repository size.

Test that scaling claim with at least two application sizes. Publish negative
results: small-app ceremony, failed tasks, unavailable telemetry, and cases
where Express or NestJS wins are part of the framework evidence.
