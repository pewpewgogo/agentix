import { describe, expect, it } from "vitest";

import {
  ReplayEffectError,
  ReplayMismatchError,
  defineReplayRecord,
  parseReplayRecord,
  replay,
} from "./replay.js";

const record = defineReplayRecord({
  operationId: "orders.create",
  operationKind: "command",
  input: { customerId: "customer-1" },
  principal: { id: "user-1", permissions: ["orders:create"] },
  effects: [
    {
      effectId: "customers.get",
      input: { id: "customer-1" },
      result: {
        status: "returned",
        output: { id: "customer-1", active: true },
      },
    },
  ],
  expected: {
    outcome: { ok: true, value: { id: "order-1" } },
    events: [
      { eventId: "orders.created", payload: { orderId: "order-1" } },
    ],
  },
});

describe("replay", () => {
  it("replays serialized inputs, effect responses, outcome, and events", async () => {
    const result = await replay(record, async ({ input, invokeEffect }) => {
      expect(input).toEqual({ customerId: "customer-1" });
      const customer = await invokeEffect("customers.get", {
        id: "customer-1",
      });
      expect(customer).toEqual({ id: "customer-1", active: true });
      return record.expected;
    });

    expect(result.consumedEffects).toBe(1);
    expect(result.observation).toEqual(record.expected);
  });

  it("rejects a mismatching or partially consumed effect script", async () => {
    await expect(
      replay(record, async ({ invokeEffect }) => {
        await invokeEffect("customers.get", { id: "wrong" });
        return record.expected;
      }),
    ).rejects.toBeInstanceOf(ReplayMismatchError);

    await expect(
      replay(record, async () => record.expected),
    ).rejects.toThrow(/consumed 0 of 1/);
  });

  it("replays thrown effect data without serializing Error objects", async () => {
    const thrown = defineReplayRecord({
      ...record,
      effects: [
        {
          effectId: "payments.charge",
          input: { amount: 10 },
          result: {
            status: "threw",
            error: { code: "SERVICE_UNAVAILABLE" },
          },
        },
      ],
    });

    await replay(thrown, async ({ invokeEffect }) => {
      await expect(
        invokeEffect("payments.charge", { amount: 10 }),
      ).rejects.toMatchObject({
        detail: { code: "SERVICE_UNAVAILABLE" },
      });
      return thrown.expected;
    });
  });

  it("rejects values that are not losslessly JSON serializable", () => {
    expect(() =>
      defineReplayRecord({
        ...record,
        input: { missing: undefined } as never,
      }),
    ).toThrow(/JSON-serializable/);
    expect(() =>
      defineReplayRecord({ ...record, input: { value: Number.NaN } }),
    ).toThrow(/non-finite/);
  });

  it("validates deserialized schema versions and freezes nested data", () => {
    expect(() =>
      parseReplayRecord({ ...record, schemaVersion: 2 }),
    ).toThrow(/schemaVersion/);
    const parsed = parseReplayRecord(JSON.parse(JSON.stringify(record)));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.effects)).toBe(true);
    expect(Object.isFrozen(parsed.expected.events[0]?.payload)).toBe(true);
  });
});
