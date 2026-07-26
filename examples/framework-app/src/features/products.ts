import { command, feature, port, query, s } from "@agentix/core";

export const PositiveSafeInteger = s.number({
  int: true,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});

export const NonNegativeSafeInteger = s.number({
  int: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
});

export const Product = s.object({
  id: s.string({ min: 1 }),
  name: s.string({ min: 1 }),
  unitPriceCents: PositiveSafeInteger,
  stock: NonNegativeSafeInteger,
  createdAt: s.string({ min: 1 }),
});
export type Product = s.Infer<typeof Product>;

/** Expected reservation outcomes are values in the output union (v2 ports have no error channel). */
export const ProductReservation = s.union([
  s.object({ reserved: s.literal(true), product: Product }),
  s.object({
    reserved: s.literal(false),
    reason: s.union([s.literal("PRODUCT_NOT_FOUND"), s.literal("OUT_OF_STOCK")]),
    available: NonNegativeSafeInteger,
  }),
]);
export type ProductReservation = s.Infer<typeof ProductReservation>;

export const ProductStorage = port("productStorage", {
  /** Atomically reserves an unused product id; false when it already exists. */
  claim: port.write({ input: s.string({ min: 1 }), output: s.boolean() }),
  releaseClaim: port.write({ input: s.string({ min: 1 }), output: s.literal(true) }),
  get: port.read({ input: s.string({ min: 1 }), output: s.optional(Product) }),
  save: port.write({ input: Product, output: Product }),
  /** Atomic check-and-decrement so concurrent orders can never oversell. */
  reserve: port.write({
    input: s.object({
      productId: s.string({ min: 1 }),
      quantity: PositiveSafeInteger,
    }),
    output: ProductReservation,
  }),
  release: port.write({
    input: s.object({
      productId: s.string({ min: 1 }),
      quantity: PositiveSafeInteger,
    }),
    output: Product,
  }),
});

export const ProductClock = port("productClock", {
  now: port.time({ input: s.object({}), output: s.string({ min: 1 }) }),
});

export const products = feature("products", {
  operations: {
    create: command({
      input: s.object({
        id: s.string({ min: 1, trim: true }),
        name: s.string({ min: 1, trim: true }),
        unitPriceCents: PositiveSafeInteger,
        stock: NonNegativeSafeInteger,
      }),
      output: Product,
      errors: {
        PRODUCT_ALREADY_EXISTS: { http: 409, details: { id: s.string() } },
      },
      permissions: ["products:create"],
      http: { method: "POST", path: "/products", status: 201 },
      effects: {
        claim: ProductStorage.claim,
        releaseClaim: ProductStorage.releaseClaim,
        now: ProductClock.now,
        save: ProductStorage.save,
      },
      async execute({ input, effects, fail }) {
        if (!(await effects.claim(input.id))) {
          return fail("PRODUCT_ALREADY_EXISTS", { id: input.id });
        }
        try {
          return await effects.save({
            id: input.id,
            name: input.name,
            unitPriceCents: input.unitPriceCents,
            stock: input.stock,
            createdAt: await effects.now({}),
          });
        } catch (cause: unknown) {
          // Compensation: never leave a claim behind when clock/save fault.
          await effects.releaseClaim(input.id);
          throw cause;
        }
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1, trim: true }) }),
      output: Product,
      errors: {
        PRODUCT_NOT_FOUND: { http: 404, details: { id: s.string() } },
      },
      permissions: ["products:read"],
      http: { method: "GET", path: "/products/:id" },
      effects: { load: ProductStorage.get },
      async execute({ input, effects, fail }) {
        return (
          (await effects.load(input.id)) ??
          fail("PRODUCT_NOT_FOUND", { id: input.id })
        );
      },
    }),
  },
});
