import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { schema } from "../src/index.js";

describe("schema properties", () => {
  it("round-trips generated valid object values", () => {
    const RecordSchema = schema.object({
      active: schema.boolean(),
      count: schema.number(),
      id: schema.id("record"),
      note: schema.optional(schema.string()),
      tags: schema.array(schema.string()),
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
    const PositiveSafeInteger = schema.refine(
      schema.number(),
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
});
