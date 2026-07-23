import { describe, expect, it } from "vitest";

import { runHttpFrameworkComparison } from "./benchmark.js";
import { interleavedHttpStackSchedule } from "./schedule.js";
import { agentixTarget } from "./targets/agentix.js";
import { expressTarget } from "./targets/express.js";
import { nestjsTarget } from "./targets/nestjs.js";
import { invalidResponse, validResponse } from "./targets/shared.js";
import { HTTP_STACKS } from "./types.js";

const repositoryRoot = new URL("../../../../", import.meta.url).pathname;
const targets = [agentixTarget, expressTarget, nestjsTarget] as const;

const post = (origin: string, path: string, body: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("exploratory HTTP framework comparison", () => {
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

  it("serves one semantic contract from every real loopback stack", async () => {
    for (const target of targets) {
      const started = await target.start();
      try {
        const valid = await post(
          started.origin,
          "/echo",
          JSON.stringify({ value: 7 }),
        );
        expect(valid.status).toBe(200);
        await expect(valid.json()).resolves.toEqual(validResponse(7));

        for (const body of [
          JSON.stringify({ value: "invalid" }),
          JSON.stringify({ value: 7, extra: true }),
          "{malformed-json",
        ]) {
          const invalid = await post(started.origin, "/echo", body);
          expect(invalid.status).toBe(400);
          await expect(invalid.json()).resolves.toEqual(invalidResponse());
        }
      } finally {
        await started.close();
      }
    }
  });

  it("retains raw interleaved samples and never claims confirmation", async () => {
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
      schemaVersion: 1,
      kind: "agentix-http-framework-comparison",
      classification: "exploratory",
      eligibleForConfirmatoryUse: false,
      generatedAt: "2040-01-01T00:00:00.000Z",
    });
    expect(report.samples).toHaveLength(18);
    expect(report.samples.filter(({ phase }) => phase === "measured"))
      .toHaveLength(12);
    expect(report.summaries).toHaveLength(6);
    expect(report.unavailable).toHaveLength(9);
    expect(report.unavailable.every(({ reason }) =>
      reason === "Fresh-process metrics were disabled by configuration."
    )).toBe(true);
    expect(report.dependencies).toEqual({
      agentix: "0.0.0",
      express: "5.2.1",
      nestjsCore: "11.1.28",
      nestjsPlatformExpress: "11.1.28",
    });
  }, 20_000);
});
