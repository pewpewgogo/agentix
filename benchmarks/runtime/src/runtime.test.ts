import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  runRuntimeBenchmark,
  validateRuntimeBenchmarkReport,
} from "./benchmark.js";
import type { RuntimeCommandExecutor } from "./execution.js";
import { interleavedArmSchedule } from "./schedule.js";
import { quantile, summarize } from "./statistics.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("runtime benchmark statistics", () => {
  it("uses deterministic R-7 summaries without discarding raw samples", () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(summarize([4, 1, 3, 2])).toEqual({
      count: 4,
      min: 1,
      q1: 1.75,
      median: 2.5,
      q3: 3.25,
      p95: 3.8499999999999996,
      max: 4,
      iqr: 1.5,
      samples: [1, 2, 3, 4],
    });
  });

  it("randomizes arm order reproducibly within balanced blocks", () => {
    const first = interleavedArmSchedule(20, "fixed-seed");
    expect(first).toEqual(interleavedArmSchedule(20, "fixed-seed"));
    expect(first).not.toEqual(interleavedArmSchedule(20, "other-seed"));
    for (let index = 0; index < first.length; index += 2) {
      expect(new Set(first.slice(index, index + 2))).toEqual(
        new Set(["framework", "plain"]),
      );
    }
  });

  it("runs an inexpensive in-process smoke without claiming omitted metrics", async () => {
    const report = await runRuntimeBenchmark({
      repositoryRoot,
      mode: "smoke",
      seed: "test-seed",
      warmupIterations: 1,
      measuredIterations: 2,
      includeProcessMetrics: false,
      includeToolchainMetrics: false,
      now: () => "2040-01-01T00:00:00.000Z",
    });
    expect(report.generatedAt).toBe("2040-01-01T00:00:00.000Z");
    expect(report.schemaVersion).toBe(2);
    expect(report.mode).toBe("smoke");
    expect(report.eligibility).toEqual({
      confirmatory: false,
      reasons: ["mode-is-smoke"],
    });
    expect(report.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "command-dispatch", implementation: "framework" }),
      expect.objectContaining({ metric: "command-dispatch", implementation: "plain" }),
      expect.objectContaining({ metric: "index-generation", implementation: "framework-only" }),
    ]));
    expect(report.unavailable.map(({ metric }) => metric)).toEqual(
      expect.arrayContaining([
        "cold-start",
        "retained-rss-delta-100-systems",
        "process-max-rss-100-systems",
        "clean-build",
      ]),
    );
    expect(report.unavailable.every(({ stage }) => stage === "configuration"))
      .toBe(true);
    expect(report.repository.packageLockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.repository.runtimeSourceManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.evidence.measurementPlanSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => validateRuntimeBenchmarkReport(report)).not.toThrow();
  });

  it("refuses to label an undersampled or partial run confirmatory", async () => {
    await expect(runRuntimeBenchmark({
      repositoryRoot,
      mode: "confirmatory",
      warmupIterations: 1,
      measuredIterations: 2,
      toolchainIterations: 1,
      includeProcessMetrics: false,
      includeToolchainMetrics: false,
    })).rejects.toThrow(/Confirmatory runtime measurement/u);
  });

  it("forbids test doubles before any confirmatory repository work", async () => {
    const executor: RuntimeCommandExecutor = {
      kind: "test-double",
      async run() {
        throw new Error("must not execute");
      },
    };
    await expect(runRuntimeBenchmark({
      repositoryRoot: "/path-that-must-not-be-read",
      mode: "confirmatory",
      warmupIterations: 10,
      measuredIterations: 30,
      toolchainIterations: 10,
      includeProcessMetrics: true,
      includeToolchainMetrics: true,
      executor,
    })).rejects.toThrow(/forbids test-double/u);
  });

  it("does not turn failed process commands into timing or memory samples", async () => {
    const executor: RuntimeCommandExecutor = {
      kind: "test-double",
      async run() {
        return {
          exitCode: 23,
          stdout: "",
          stderr: "synthetic build failure",
          nanoseconds: 123,
        };
      },
    };
    const report = await runRuntimeBenchmark({
      repositoryRoot,
      mode: "smoke",
      seed: "failed-process-build",
      warmupIterations: 0,
      measuredIterations: 1,
      toolchainIterations: 1,
      includeProcessMetrics: true,
      includeToolchainMetrics: false,
      executor,
    });
    expect(report.evidence.processBuilds).toEqual([]);
    expect(report.samples.some(({ metric }) => [
      "cold-start",
      "retained-rss-delta-100-systems",
      "process-max-rss-100-systems",
    ].includes(metric))).toBe(false);
    expect(report.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "cold-start",
        implementation: "framework",
        stage: "prerequisite",
      }),
      expect.objectContaining({
        metric: "cold-start",
        implementation: "plain",
        stage: "prerequisite",
      }),
    ]));
  }, 15_000);

  it("rejects forged confirmatory eligibility", async () => {
    const report = await runRuntimeBenchmark({
      repositoryRoot,
      mode: "smoke",
      seed: "eligibility-forgery",
      warmupIterations: 0,
      measuredIterations: 1,
      includeProcessMetrics: false,
      includeToolchainMetrics: false,
    });
    const forged = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    forged["eligibility"] = { confirmatory: true, reasons: [] };
    expect(() => validateRuntimeBenchmarkReport(forged)).toThrow(
      /eligibility does not match/u,
    );
  });
});
