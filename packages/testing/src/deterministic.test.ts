import { describe, expect, it } from "vitest";

import {
  createDeterministicClock,
  createDeterministicIdGenerator,
} from "./deterministic.js";

describe("createDeterministicClock", () => {
  it("advances only through explicit calls", () => {
    const clock = createDeterministicClock({
      start: "2026-07-23T10:00:00.000Z",
      stepMs: 1_000,
    });

    expect(clock.peek()).toBe("2026-07-23T10:00:00.000Z");
    expect(clock.peek()).toBe("2026-07-23T10:00:00.000Z");
    expect(clock.now()).toBe("2026-07-23T10:00:00.000Z");
    expect(clock.now()).toBe("2026-07-23T10:00:01.000Z");
    expect(clock.calls()).toBe(2);
  });

  it("supports projection, explicit movement, and reset", () => {
    const clock = createDeterministicClock({
      start: 0,
      stepMs: 5,
      project: (instant: Date) => instant.getTime(),
    });

    expect(clock.now()).toBe(0);
    clock.advanceBy(10);
    expect(clock.now()).toBe(15);
    clock.set(40);
    expect(clock.peek()).toBe(40);
    clock.reset();
    expect(clock.peek()).toBe(0);
    expect(clock.calls()).toBe(0);
  });

  it("rejects invalid instants and movements", () => {
    expect(() => createDeterministicClock({ start: "not-a-date" })).toThrow(
      /valid date/,
    );
    const clock = createDeterministicClock();
    expect(() => clock.advanceBy(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("createDeterministicIdGenerator", () => {
  it("generates resettable padded identifiers", () => {
    const ids = createDeterministicIdGenerator({
      prefix: "order-",
      start: 7,
      padding: 3,
    });

    expect(ids.peek()).toBe("order-007");
    expect(ids.next()).toBe("order-007");
    expect(ids.next()).toBe("order-008");
    expect(ids.calls()).toBe(2);
    ids.reset();
    expect(ids.next()).toBe("order-007");
  });

  it("uses exact scripted values before generated values", () => {
    const ids = createDeterministicIdGenerator({
      prefix: "fallback-",
      start: 3,
      values: ["first", "second"],
    });

    expect([ids.next(), ids.next(), ids.next(), ids.next()]).toEqual([
      "first",
      "second",
      "fallback-3",
      "fallback-4",
    ]);
  });
});
