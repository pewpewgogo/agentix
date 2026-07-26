import { describe, expect, expectTypeOf, it } from "vitest";

import {
  err,
  isOutcome,
  matchOutcome,
  ok,
  type Outcome,
} from "../src/index.js";

describe("Outcome", () => {
  it("keeps expected failures as discriminated values", () => {
    const result: Outcome<number, "missing"> = ok(3);
    expect(result).toEqual({ ok: true, value: 3 });
    expect(matchOutcome(result, { ok: (value) => value * 2, err: () => 0 })).toBe(6);

    const failed: Outcome<number, "missing"> = err("missing");
    expect(failed).toEqual({ ok: false, error: "missing" });
    expectTypeOf(failed).toEqualTypeOf<Outcome<number, "missing">>();
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(ok("value"))).toBe(true);
  });

  it("recognizes only the stable wire shape", () => {
    expect(isOutcome(ok("yes"))).toBe(true);
    expect(isOutcome(err("no"))).toBe(true);
    expect(isOutcome({ ok: true, value: 1 })).toBe(true);
    expect(isOutcome({ ok: false, error: "e" })).toBe(true);
    expect(isOutcome({ ok: true })).toBe(false);
    expect(isOutcome({ ok: false })).toBe(false);
    expect(isOutcome({ ok: "yes", value: 1 })).toBe(false);
    expect(isOutcome(null)).toBe(false);
    expect(isOutcome("ok")).toBe(false);
  });
});
