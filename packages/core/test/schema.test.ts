import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SchemaValidationError,
  type BrandedId,
  type Infer,
  schema,
} from "../src/index.js";

describe("schema primitives", () => {
  it("parses primitive, literal, and array values", () => {
    expect(schema.string().parse("value")).toBe("value");
    expect(schema.number().parse(1.5)).toBe(1.5);
    expect(schema.boolean().parse(false)).toBe(false);
    expect(schema.literal("open").parse("open")).toBe("open");
    expect(schema.array(schema.number()).parse([1, 2])).toEqual([1, 2]);

    expect(schema.number().safeParse(Number.NaN)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", path: [] }],
    });
    expect(schema.number().safeParse(Number.POSITIVE_INFINITY)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", path: [] }],
    });
  });

  it("parses exact objects with correctly typed optional fields", () => {
    const User = schema.object({
      age: schema.optional(schema.number()),
      name: schema.string(),
    });
    type User = Infer<typeof User>;

    expectTypeOf<User>().toEqualTypeOf<{ name: string; age?: number }>();
    expect(User.parse({ name: "Ada" })).toEqual({ name: "Ada" });
    expect(User.parse({ age: 36, name: "Ada" })).toEqual({
      age: 36,
      name: "Ada",
    });
    expect(User.safeParse({ name: "Ada", role: "admin" })).toMatchObject({
      success: false,
      issues: [{ code: "unexpected_key", path: ["role"] }],
    });
  });

  it("snapshots composition inputs instead of retaining mutable schema maps", () => {
    const shape: Record<string, ReturnType<typeof schema.string>> = {
      original: schema.string(),
    };
    const Snapshot = schema.object(shape);
    shape["late"] = schema.string();

    expect(Snapshot.parse({ original: "kept" })).toEqual({ original: "kept" });
    expect(Snapshot.safeParse({ original: "kept", late: "rejected" })).toMatchObject({
      success: false,
      issues: [{ code: "unexpected_key", path: ["late"] }],
    });
  });

  it("returns deterministic, stable issue paths", () => {
    const Line = schema.object({
      items: schema.array(
        schema.object({
          quantity: schema.number(),
          sku: schema.string(),
        }),
      ),
    });

    const result = Line.safeParse({
      items: [{ quantity: "many" }, { quantity: 2, sku: 7 }],
    });
    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: "invalid_type",
          path: ["items", 0, "quantity"],
          message: "Expected number, received string",
        },
        {
          code: "required",
          path: ["items", 0, "sku"],
          message: "Required field is missing",
        },
        {
          code: "invalid_type",
          path: ["items", 1, "sku"],
          message: "Expected string, received number",
        },
      ],
    });
  });

  it("supports unions and named refinements without hiding failures", () => {
    const Positive = schema.refine(
      schema.number(),
      (value) => value > 0,
      { id: "positive", message: "Expected a positive number" },
    );
    const Value = schema.union([Positive, schema.literal("unbounded")]);

    expect(Value.parse(2)).toBe(2);
    expect(Value.parse("unbounded")).toBe("unbounded");
    expect(Value.safeParse(-1)).toMatchObject({
      success: false,
      issues: [
        {
          code: "invalid_union",
          path: [],
          causes: [
            { code: "refinement_failed", message: "Expected a positive number" },
            { code: "invalid_literal" },
          ],
        },
      ],
    });
  });

  it("brands non-empty IDs nominally and publishes plain descriptions", () => {
    const CustomerId = schema.id("customer");
    type CustomerId = Infer<typeof CustomerId>;

    expectTypeOf<CustomerId>().toEqualTypeOf<BrandedId<"customer">>();
    expect(CustomerId.parse("customer-1")).toBe("customer-1");
    expect(CustomerId.safeParse("")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_id", path: [] }],
    });

    const description = schema.object({
      active: schema.boolean(),
      id: CustomerId,
      label: schema.optional(schema.string()),
    }).description;
    expect(description).toEqual({
      type: "object",
      fields: {
        active: { type: "boolean" },
        id: { type: "id", brand: "customer" },
        label: { type: "optional", inner: { type: "string" } },
      },
    });
    expect(Object.isFrozen(description)).toBe(true);
    if (description.type === "object") {
      expect(Object.isFrozen(description.fields)).toBe(true);
    }
  });

  it("throws a structured error from parse", () => {
    const parsed = schema.object({ value: schema.boolean() });
    expect(() => parsed.parse({ value: "yes" })).toThrow(SchemaValidationError);
    try {
      parsed.parse({ value: "yes" });
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).issues).toEqual([
        {
          code: "invalid_type",
          path: ["value"],
          message: "Expected boolean, received string",
        },
      ]);
    }
  });
});
