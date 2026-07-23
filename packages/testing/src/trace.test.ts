import { describe, expect, it } from "vitest";

import {
  TraceAssertionError,
  assertEffectSequence,
  assertEventSequence,
  assertNoEffects,
  assertNoEvents,
  assertTraceEquals,
} from "./trace.js";

const trace = [
  {
    type: "effect" as const,
    effectId: "customers.get",
    input: "customer-1",
  },
  {
    type: "effect" as const,
    effectId: "payments.charge",
    input: { amount: 10 },
  },
  {
    type: "event" as const,
    eventId: "orders.created",
    payload: { id: "order-1" },
  },
];

describe("trace assertions", () => {
  it("accepts exact effect and event sequences", () => {
    expect(() =>
      assertEffectSequence(trace, ["customers.get", "payments.charge"]),
    ).not.toThrow();
    expect(() => assertEventSequence(trace, ["orders.created"])).not.toThrow();
    expect(() => assertTraceEquals(trace, trace)).not.toThrow();
  });

  it("reports differences with an explicit assertion error", () => {
    expect(() => assertEffectSequence(trace, ["payments.charge"])).toThrow(
      TraceAssertionError,
    );
    expect(() => assertEventSequence(trace, [])).toThrow(/orders.created/);
    expect(() => assertTraceEquals(trace, trace.slice(0, 2))).toThrow(/mismatch/);
  });

  it("asserts empty effect and event traces", () => {
    expect(() => assertNoEffects([])).not.toThrow();
    expect(() => assertNoEvents([])).not.toThrow();
    expect(() => assertNoEffects(trace)).toThrow(/Expected no effects/);
    expect(() => assertNoEvents(trace)).toThrow(/Expected no events/);
  });
});
