import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { s } from "../src/index.js";

describe("schema properties", () => {
  it("round-trips generated valid object values", () => {
    const RecordSchema = s.object({
      active: s.boolean(),
      count: s.number(),
      id: s.id("record"),
      note: s.optional(s.string()),
      tags: s.array(s.string()),
    });
    const records = fc.record({
      active: fc.boolean(),
      count: fc.integer(),
      id: fc.string({ minLength: 1 }),
      note: fc.option(fc.string(), { nil: undefined }),
      tags: fc.array(fc.string()),
    });

    fc.assert(
      fc.property(records, (value) => {
        expect(RecordSchema.parse(value)).toEqual(value);
      }),
      { numRuns: 200 },
    );
  });

  it("accepts exactly the positive safe integers selected by a refinement", () => {
    const PositiveSafeInteger = s.refine(
      s.number(),
      (value) => Number.isSafeInteger(value) && value > 0,
      "positive-safe-integer",
    );

    fc.assert(
      fc.property(fc.integer(), (value) => {
        expect(PositiveSafeInteger.safeParse(value).success).toBe(value > 0);
      }),
      { numRuns: 200 },
    );
  });

  it("normalizes every string via trim before validating bounds", () => {
    const Trimmed = s.string({ trim: true, max: 10 });

    fc.assert(
      fc.property(fc.string(), (value) => {
        const result = Trimmed.safeParse(value);
        const trimmed = value.trim();
        expect(result.success).toBe(trimmed.length <= 10);
        if (result.success) expect(result.data).toBe(trimmed);
      }),
      { numRuns: 200 },
    );
  });

  it("accepts exactly the integers inside inclusive number bounds", () => {
    const Bounded = s.number({ min: -5, max: 5, int: true });

    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), (value) => {
        expect(Bounded.safeParse(value).success).toBe(value >= -5 && value <= 5);
      }),
      { numRuns: 200 },
    );
  });
});
