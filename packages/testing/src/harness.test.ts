import { describe, expect, it } from "vitest";
import { command, createApplication, event, feature, port, query, s } from "@agentix/core";

import { createRecordingAdapter } from "./recording.js";
import { testCommand, testQuery } from "./harness.js";
import {
  assertEffectSequence,
  assertEventSequence,
  assertNoEffects,
} from "./trace.js";

const Clock = port("clock", {
  now: port.time({ input: s.object({}), output: s.string() }),
});

const happened = event("sample.happened", 1, s.object({ at: s.string() }));

const sample = feature("sample", {
  operations: {
    run: command({
      input: s.object({}),
      output: s.object({ at: s.string() }),
      permissions: ["sample:run"],
      effects: { now: Clock.now },
      emits: { happened },
      async execute({ effects, emit }) {
        const at = await effects.now({});
        emit.happened({ at });
        return { at };
      },
    }),
    inspect: query({
      input: s.object({ value: s.string() }),
      output: s.string(),
      permissions: ["sample:read"],
      execute: ({ input }) => input.value,
    }),
  },
});

const createFixture = () => {
  const clock = createRecordingAdapter(Clock, {
    now: () => "2026-07-23T10:00:00.000Z",
  });
  const application = createApplication({
    features: [sample],
    adapters: [clock],
    mode: "test",
  });
  return { application, clock };
};

describe("operation harnesses", () => {
  it("dispatches a command with authorized defaults and a complete trace", async () => {
    const { application, clock } = createFixture();
    const result = await testCommand({
      application,
      operation: sample.operations.run,
      input: {},
    });

    expect(result).toMatchObject({
      kind: "completed",
      operationId: "sample.run",
      outcome: { ok: true, value: { at: "2026-07-23T10:00:00.000Z" } },
    });
    expect(clock.calls()).toHaveLength(1);
    if (result.trace === undefined) {
      throw new Error("Expected test tracing to be enabled.");
    }
    assertEffectSequence(result.trace, ["clock.now"]);
    assertEventSequence(result.trace, ["sample.happened"]);
  });

  it("dispatches queries and supports explicit denied principals", async () => {
    const { application } = createFixture();
    const queryResult = await testQuery({
      application,
      operation: sample.operations.inspect,
      input: { value: "visible" },
    });
    expect(queryResult).toMatchObject({
      kind: "completed",
      outcome: { ok: true, value: "visible" },
    });

    const denied = await testCommand({
      application,
      operation: sample.operations.run,
      input: {},
      principal: { id: "denied", permissions: [] },
    });
    expect(denied).toMatchObject({
      kind: "rejected",
      error: { code: "PERMISSION_DENIED" },
    });
    if (denied.trace === undefined) {
      throw new Error("Expected test tracing to be enabled.");
    }
    assertNoEffects(denied.trace);
  });

  it("rejects harness/operation kind mismatches", async () => {
    const { application } = createFixture();
    await expect(
      testQuery({
        application,
        operation: sample.operations.run as never,
        input: {} as never,
      }),
    ).rejects.toThrow(/not a query/);
    await expect(
      testCommand({
        application,
        operation: sample.operations.inspect as never,
        input: { value: "x" } as never,
      }),
    ).rejects.toThrow(/not a command/);
  });
});
