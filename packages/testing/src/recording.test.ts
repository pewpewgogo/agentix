import { describe, expect, it } from "vitest";
import { port, s } from "@agentix/core";

import { createRecordingAdapter, createScriptedEffect } from "./recording.js";

const Payments = port("payments", {
  charge: port.external({
    input: s.object({ amount: s.number() }),
    output: s.object({ approved: s.boolean() }),
  }),
  refund: port.external({
    input: s.object({ paymentId: s.string() }),
    output: s.object({ refunded: s.boolean() }),
  }),
});

describe("createRecordingAdapter", () => {
  it("records returned and thrown plain-value calls in completion order", async () => {
    const failure = new Error("refund unavailable");
    const adapter = createRecordingAdapter(Payments, {
      charge: (input) => ({ approved: input.amount < 100 }),
      refund: (_input: { paymentId: string }) => {
        throw failure;
      },
    });

    expect(adapter.descriptorType).toBe("port-adapter");
    expect(adapter.portId).toBe("payments");

    await expect(adapter.operations.charge({ amount: 10 })).resolves.toEqual({
      approved: true,
    });
    await expect(
      adapter.operations.refund({ paymentId: "payment-1" }),
    ).rejects.toBe(failure);

    expect(adapter.calls()).toEqual([
      {
        sequence: 0,
        effectId: "payments.charge",
        input: { amount: 10 },
        status: "returned",
        output: { approved: true },
      },
      {
        sequence: 1,
        effectId: "payments.refund",
        input: { paymentId: "payment-1" },
        status: "threw",
        error: failure,
      },
    ]);

    adapter.reset();
    expect(adapter.calls()).toEqual([]);
  });

  it("fails construction when a runtime implementation is missing", () => {
    expect(() =>
      createRecordingAdapter(Payments, {
        charge: () => ({ approved: true }),
      } as never),
    ).toThrow(/Missing fake implementation/);
  });
});

describe("createScriptedEffect", () => {
  it("replays returned and thrown responses and can reset", async () => {
    const failure = new Error("declined");
    const effect = createScriptedEffect<{ amount: number }, string>([
      { status: "returned", output: "payment-1" },
      { status: "threw", error: failure },
    ]);

    await expect(effect.handler({ amount: 1 })).resolves.toBe("payment-1");
    await expect(effect.handler({ amount: 2 })).rejects.toBe(failure);
    expect(effect.remaining()).toBe(0);
    await expect(effect.handler({ amount: 3 })).rejects.toThrow(/remaining/);
    effect.reset();
    expect(effect.remaining()).toBe(2);
  });
});
