import { describe, expect, it } from "vitest";
import {
  bindPort,
  createApplication,
  defineCommand,
  defineEvent,
  defineFeature,
  defineFeatureContract,
  definePort,
  defineQuery,
  ok,
  portOperation,
  schema,
} from "@agentix/core";

import { createRecordingAdapter } from "./recording.js";
import { testCommand, testQuery } from "./harness.js";
import {
  assertEffectSequence,
  assertEventSequence,
  assertNoEffects,
} from "./trace.js";

const Clock = definePort({
  id: "clock",
  operations: {
    now: portOperation({
      id: "clock.now",
      kind: "time",
      input: schema.object({}),
      output: schema.string(),
    }),
  },
});

const happened = defineEvent({
  id: "sample.happened",
  version: 1,
  payload: schema.object({ at: schema.string() }),
});

const runSample = defineCommand({
  id: "sample.run",
  input: schema.object({}),
  output: schema.object({ at: schema.string() }),
  errors: {},
  permissions: ["sample:run"],
  effects: { now: Clock.operations.now },
  emits: { happened },
  async execute({ effects, emit }) {
    const instant = await effects.now({});
    if (!instant.ok) {
      throw new Error("The no-error clock contract returned an error.");
    }
    emit.happened({ at: instant.value });
    return ok({ at: instant.value });
  },
});

const inspectSample = defineQuery({
  id: "sample.inspect",
  input: schema.object({ value: schema.string() }),
  output: schema.string(),
  errors: {},
  permissions: ["sample:read"],
  effects: {},
  execute: ({ input }) => ok(input.value),
});

const sample = defineFeature({
  id: "sample",
  contract: defineFeatureContract({
    id: "sample",
    exports: { runSample, inspectSample, happened, Clock },
  }),
  dependencies: [],
  operations: [runSample, inspectSample],
  invariants: [],
  events: [happened],
  ports: [Clock],
});

const createFixture = () => {
  const clock = createRecordingAdapter(Clock, {
    now: async () => ok("2026-07-23T10:00:00.000Z"),
  });
  const application = createApplication({
    features: [sample],
    adapters: [bindPort(Clock, clock.operations)],
    mode: "test",
  });
  return { application, clock };
};

describe("operation harnesses", () => {
  it("dispatches a command with authorized defaults and a complete trace", async () => {
    const { application, clock } = createFixture();
    const result = await testCommand({
      application,
      operation: runSample,
      input: {},
    });

    expect(result).toMatchObject({
      kind: "completed",
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
      operation: inspectSample,
      input: { value: "visible" },
    });
    expect(queryResult).toMatchObject({
      kind: "completed",
      outcome: { ok: true, value: "visible" },
    });

    const denied = await testCommand({
      application,
      operation: runSample,
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
});
