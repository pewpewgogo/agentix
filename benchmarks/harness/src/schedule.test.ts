import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "./hash.js";
import {
  createConfirmatorySchedule,
  validateScheduleDocument,
  writeCommittedSchedule,
} from "./schedule.js";
import { HARNESS_SCHEMA_VERSION, type TaskReference } from "./types.js";

const tasks: readonly TaskReference[] = Array.from(
  { length: 10 },
  (_, index) => ({
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: `task-${String(index + 1).padStart(2, "0")}`,
    version: 1,
  }),
);

describe("confirmatory scheduler", () => {
  it("reproducibly randomizes blocked arm order across ten tasks", () => {
    const first = createConfirmatorySchedule({
      tasks,
      repetitions: 5,
      seed: "committed-seed-v1",
    });
    const repeated = createConfirmatorySchedule({
      tasks,
      repetitions: 5,
      seed: "committed-seed-v1",
    });
    const different = createConfirmatorySchedule({
      tasks,
      repetitions: 5,
      seed: "committed-seed-v2",
    });

    expect(first).toEqual(repeated);
    expect(first.runs).toHaveLength(100);
    expect(first.runs).not.toEqual(different.runs);
    expect(first.scheduleHash).toMatch(/^[a-f0-9]{64}$/u);

    const blocks = Map.groupBy(first.runs, (run) => run.blockId);
    expect(blocks.size).toBe(50);
    for (const runs of blocks.values()) {
      expect(runs.map(({ arm }) => arm)).toHaveLength(2);
      expect(new Set(runs.map(({ arm }) => arm))).toEqual(
        new Set(["framework", "plain"]),
      );
    }
    expect(
      [...blocks.values()].some(([firstRun]) => firstRun?.arm === "framework"),
    ).toBe(true);
    expect(
      [...blocks.values()].some(([firstRun]) => firstRun?.arm === "plain"),
    ).toBe(true);
  });

  it("requires the fixed task count and writes a no-overwrite schedule artifact", async () => {
    expect(() =>
      createConfirmatorySchedule({
        tasks: tasks.slice(0, 9),
        repetitions: 1,
        seed: "seed",
      }),
    ).toThrow(/exactly 10 tasks/u);

    const directory = await mkdtemp(join(tmpdir(), "agentix-schedule-"));
    const output = join(directory, "schedule.json");
    const schedule = createConfirmatorySchedule({
      tasks,
      repetitions: 5,
      seed: "seed",
    });
    await writeCommittedSchedule(output, schedule);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(schedule);
    await expect(writeCommittedSchedule(output, schedule)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("reproduces the committed 100-run confirmatory schedule", async () => {
    const suffixes = [
      "simple-feature",
      "field-propagation",
      "cross-feature-rule",
      "external-adapter",
      "localized-defect",
      "misleading-symptom",
      "authorization-change",
      "schema-migration",
      "compatible-rename",
      "architecture-question",
    ] as const;
    const frozenTasks: readonly TaskReference[] = suffixes.map(
      (suffix, index) => ({
        schemaVersion: HARNESS_SCHEMA_VERSION,
        id: `task-${String(index + 1).padStart(2, "0")}-${suffix}`,
        version: 1,
      }),
    );
    const committed = JSON.parse(
      await readFile(
        new URL("../config/confirmatory-schedule.v1.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;

    expect(committed).toEqual(
      createConfirmatorySchedule({
        tasks: frozenTasks,
        repetitions: 5,
        seed: "agentix-commerce-v1-2026-07-23",
      }),
    );
  });

  it("rejects stale hashes and structurally invalid blocked slots", () => {
    const schedule = createConfirmatorySchedule({
      tasks,
      repetitions: 5,
      seed: "validation-seed",
    });
    expect(() => validateScheduleDocument({
      ...schedule,
      scheduleHash: "0".repeat(64),
    })).toThrow(/hash does not match/u);

    const first = schedule.runs[0];
    const second = schedule.runs[1];
    if (first === undefined || second === undefined) throw new Error("Missing test runs.");
    const runs = [
      { ...first, ordinal: second.ordinal },
      ...schedule.runs.slice(1),
    ];
    const hashInput = {
      schemaVersion: schedule.schemaVersion,
      seed: schedule.seed,
      repetitions: schedule.repetitions,
      taskCount: schedule.taskCount,
      runs,
    };
    expect(() => validateScheduleDocument({
      ...hashInput,
      scheduleHash: sha256(canonicalJson(hashInput)),
    })).toThrow(/Duplicate schedule ordinal/u);
  });
});
