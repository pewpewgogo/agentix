import { describe, expect, it } from "vitest";

import { runHttpFrameworkComparison } from "./benchmark.js";
import { interleavedHttpStackSchedule } from "./schedule.js";
import {
  BATCH_CONCURRENCY,
  HTTP_CONDITIONS,
  HTTP_STACKS,
  HTTP_WORKLOADS,
} from "./types.js";

const repositoryRoot = new URL("../../../../", import.meta.url).pathname;

describe("exploratory HTTP framework comparison (methodology v2)", () => {
  it("creates deterministic balanced three-stack blocks", () => {
    const schedule = interleavedHttpStackSchedule(12, "comparison-seed");
    expect(schedule).toEqual(
      interleavedHttpStackSchedule(12, "comparison-seed"),
    );
    expect(schedule).not.toEqual(
      interleavedHttpStackSchedule(12, "other-seed"),
    );
    for (let index = 0; index < schedule.length; index += HTTP_STACKS.length) {
      expect(new Set(schedule.slice(index, index + HTTP_STACKS.length)))
        .toEqual(new Set(HTTP_STACKS));
    }
  });

  it("labels every sample and never claims confirmation", async () => {
    const report = await runHttpFrameworkComparison({
      repositoryRoot,
      seed: "comparison-test-seed",
      warmupIterations: 1,
      measuredIterations: 2,
      processIterations: 1,
      includeProcessMetrics: false,
      now: () => "2040-01-01T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      schemaVersion: 2,
      kind: "agentix-http-framework-comparison",
      classification: "exploratory",
      eligibleForConfirmatoryUse: false,
      generatedAt: "2040-01-01T00:00:00.000Z",
      seed: "comparison-test-seed",
    });
    expect(report.methodology).toMatchObject({
      version: "v2",
      processIsolation: "in-process-shared-event-loop",
      recommendedProcessIsolation: "per-target-child-process",
    });
    expect(report.methodology.supersedes).toContain(
      "http-frameworks-exploratory-v1-2026-07-23.json",
    );
    expect(report.configuration).toMatchObject({
      isolatedProcesses: false,
      batchConcurrency: BATCH_CONCURRENCY,
      conditions: [...HTTP_CONDITIONS],
    });

    // 2 conditions x 4 workloads x 3 stacks x (1 warmup + 2 measured).
    expect(report.samples).toHaveLength(72);
    expect(report.samples.filter(({ phase }) => phase === "measured"))
      .toHaveLength(48);
    for (const sample of report.samples) {
      expect(HTTP_CONDITIONS).toContain(sample.condition);
      expect(HTTP_WORKLOADS).toContain(sample.workload);
      expect([1, BATCH_CONCURRENCY]).toContain(sample.concurrency);
    }
    const batchSamples = report.samples.filter(
      ({ workload }) => workload === "echo-batch",
    );
    expect(batchSamples).toHaveLength(18);
    expect(batchSamples.every(
      ({ concurrency }) => concurrency === BATCH_CONCURRENCY,
    )).toBe(true);

    // 4 metrics x 3 stacks x 2 conditions.
    expect(report.summaries).toHaveLength(24);
    const batchSummaries = report.summaries.filter(
      ({ metric }) => metric === "http-batch",
    );
    expect(batchSummaries).toHaveLength(6);
    for (const summary of batchSummaries) {
      expect(summary.requestsPerSecond).toBeGreaterThan(0);
      expect(summary.requestsPerSecond).toBeCloseTo(
        (BATCH_CONCURRENCY * 1_000_000_000) / summary.distribution.median,
        6,
      );
    }
    expect(report.summaries.every((summary) =>
      summary.metric === "http-batch" || summary.requestsPerSecond === undefined
    )).toBe(true);

    expect(report.unavailable).toHaveLength(9);
    expect(report.unavailable.every(({ reason }) =>
      reason === "Fresh-process metrics were disabled by configuration."
    )).toBe(true);
    expect(report.dependencies).toEqual({
      agentix: "0.0.0",
      express: "5.2.1",
      nestjsCore: "11.1.28",
      nestjsPlatformExpress: "11.1.28",
      zod: "4.4.3",
    });
    expect(report.limitations.some((line) =>
      line.includes("IN-PROCESS METHOD")
    )).toBe(true);
  }, 60_000);
});
