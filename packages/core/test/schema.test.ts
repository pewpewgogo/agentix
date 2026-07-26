import { describe, expect, expectTypeOf, it } from "vitest";

import {
  s,
  SchemaValidationError,
  type BrandedId,
  type Infer,
} from "../src/index.js";

describe("schema primitives", () => {
  it("parses primitive, literal, and array values", () => {
    expect(s.string().parse("value")).toBe("value");
    expect(s.number().parse(1.5)).toBe(1.5);
    expect(s.boolean().parse(false)).toBe(false);
    expect(s.literal("open").parse("open")).toBe("open");
    expect(s.literal(3).parse(3)).toBe(3);
    expect(s.literal(null).parse(null)).toBe(null);
    expect(s.array(s.number()).parse([1, 2])).toEqual([1, 2]);

    expect(s.string().safeParse(7)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_type", path: [] }],
    });
    expect(s.number().safeParse(Number.NaN)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", path: [] }],
    });
    expect(s.number().safeParse(Number.POSITIVE_INFINITY)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", path: [] }],
    });
    expect(s.boolean().safeParse("true")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_type", path: [] }],
    });
    expect(s.literal("open").safeParse("closed")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_literal", path: [] }],
    });
    expect(s.array(s.number()).safeParse("nope")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_type", path: [] }],
    });
  });

  it("validates string min/max/pattern with trim running first", () => {
    const Bounded = s.string({ min: 2, max: 4 });
    expect(Bounded.parse("ab")).toBe("ab");
    expect(Bounded.parse("abcd")).toBe("abcd");
    expect(Bounded.safeParse("a")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_string" }],
    });
    expect(Bounded.safeParse("abcde")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_string" }],
    });

    const Trimmed = s.string({ trim: true, min: 1 });
    expect(Trimmed.parse("  padded  ")).toBe("padded");
    // trim runs BEFORE the length check: whitespace-only fails min.
    expect(Trimmed.safeParse("   ")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_string" }],
    });

    const Slug = s.string({ pattern: /^[a-z]+$/, trim: true });
    expect(Slug.parse("  abc  ")).toBe("abc");
    expect(Slug.safeParse("ABC")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_string", message: "Expected string matching /^[a-z]+$/" }],
    });
  });

  it("copies patterns without sticky/global state", () => {
    const Sticky = s.string({ pattern: /ab/gy });
    // A retained lastIndex would make the second parse fail.
    expect(Sticky.parse("ab")).toBe("ab");
    expect(Sticky.parse("ab")).toBe("ab");
    expect(Sticky.description).toMatchObject({ type: "string", pattern: "ab" });
  });

  it("rejects malformed string and number bounds at creation", () => {
    expect(() => s.string({ min: -1 })).toThrow(TypeError);
    expect(() => s.string({ max: 1.5 })).toThrow(TypeError);
    expect(() => s.string({ min: 3, max: 2 })).toThrow(TypeError);
    expect(() => s.number({ min: Number.NaN })).toThrow(TypeError);
    expect(() => s.number({ max: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => s.number({ min: 3, max: 2 })).toThrow(TypeError);
  });

  it("validates number min/max/int", () => {
    const Port = s.number({ min: 1, max: 65535, int: true });
    expect(Port.parse(8080)).toBe(8080);
    expect(Port.safeParse(0)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", message: "Expected a number >= 1" }],
    });
    expect(Port.safeParse(70000)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", message: "Expected a number <= 65535" }],
    });
    expect(Port.safeParse(1.5)).toMatchObject({
      success: false,
      issues: [{ code: "invalid_number", message: "Expected an integer" }],
    });
    expect(s.number({ min: 0 }).parse(0.25)).toBe(0.25);
  });

  it("parses exact objects with correctly typed optional fields", () => {
    const User = s.object({
      age: s.optional(s.number()),
      name: s.string(),
    });
    type User = Infer<typeof User>;

    expectTypeOf<User>().toEqualTypeOf<{ name: string; age?: number }>();
    expect(User.parse({ name: "Ada" })).toEqual({ name: "Ada" });
    expect(User.parse({ age: 36, name: "Ada" })).toEqual({ age: 36, name: "Ada" });
    expect(User.safeParse({ name: "Ada", role: "admin" })).toMatchObject({
      success: false,
      issues: [{ code: "unexpected_key", path: ["role"] }],
    });
    expect(User.safeParse({ age: 36 })).toMatchObject({
      success: false,
      issues: [{ code: "required", path: ["name"] }],
    });
    expect(User.safeParse([])).toMatchObject({
      success: false,
      issues: [{ code: "invalid_type", path: [] }],
    });
  });

  it("exposes the object shape for reuse in derived schemas", () => {
    const Title = s.string({ min: 1 });
    const Note = s.object({ id: s.string(), title: Title });
    expect(Note.shape.title).toBe(Title);
    expect(Object.isFrozen(Note.shape)).toBe(true);

    const Derived = s.object({ title: Note.shape.title });
    expect(Derived.parse({ title: "x" })).toEqual({ title: "x" });
    expect(Derived.safeParse({ title: "" })).toMatchObject({ success: false });
  });

  it("snapshots composition inputs instead of retaining mutable schema maps", () => {
    const shape: Record<string, ReturnType<typeof s.string>> = {
      original: s.string(),
    };
    const Snapshot = s.object(shape);
    shape["late"] = s.string();

    expect(Snapshot.parse({ original: "kept" })).toEqual({ original: "kept" });
    expect(Snapshot.safeParse({ original: "kept", late: "rejected" })).toMatchObject({
      success: false,
      issues: [{ code: "unexpected_key", path: ["late"] }],
    });
  });

  it("returns deterministic, stable issue paths", () => {
    const Line = s.object({
      items: s.array(
        s.object({
          quantity: s.number(),
          sku: s.string(),
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
    const Positive = s.refine(
      s.number(),
      (value) => value > 0,
      { id: "positive", message: "Expected a positive number" },
    );
    const Value = s.union([Positive, s.literal("unbounded")]);

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

  it("treats throwing refinement predicates as failed refinements", () => {
    const Hostile = s.refine(
      s.string(),
      () => {
        throw new Error("predicate exploded");
      },
      "hostile-refinement",
    );
    expect(Hostile.safeParse("value")).toMatchObject({
      success: false,
      issues: [{ code: "refinement_failed", message: "hostile-refinement" }],
    });
    expect(() => s.refine(s.string(), () => true, { id: "", message: "m" })).toThrow(
      TypeError,
    );
  });

  it("brands non-empty IDs nominally and publishes plain descriptions", () => {
    const CustomerId = s.id("customer");
    type CustomerId = Infer<typeof CustomerId>;

    expectTypeOf<CustomerId>().toEqualTypeOf<BrandedId<"customer">>();
    expect(CustomerId.parse("customer-1")).toBe("customer-1");
    expect(CustomerId.safeParse("")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_id", path: [] }],
    });
    expect(() => s.id("")).toThrow(TypeError);

    const description = s.object({
      active: s.boolean(),
      id: CustomerId,
      label: s.optional(s.string()),
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

  it("describes string and number constraints", () => {
    expect(s.string({ min: 1, max: 5, trim: true }).description).toEqual({
      type: "string",
      min: 1,
      max: 5,
      trim: true,
    });
    expect(s.number({ min: 0, max: 10, int: true }).description).toEqual({
      type: "number",
      min: 0,
      max: 10,
      int: true,
    });
    expect(s.string().description).toEqual({ type: "string" });
  });

  it("keeps optional a transparent wrapper", () => {
    const MaybeCount = s.optional(s.number());
    expect(MaybeCount.optional).toBe(true);
    expect(MaybeCount.parse(undefined)).toBeUndefined();
    expect(MaybeCount.parse(4)).toBe(4);
    expect(MaybeCount.safeParse("x")).toMatchObject({
      success: false,
      issues: [{ code: "invalid_type" }],
    });
  });

  it("throws a structured error from parse", () => {
    const parsed = s.object({ value: s.boolean() });
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
      expect((error as SchemaValidationError).message).toContain("value:");
    }
  });
});
