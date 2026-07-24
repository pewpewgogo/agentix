import {
  defineFeatureContract,
  definePort,
  portOperation,
  schema,
  type Infer,
} from "@agentixdev/core";

export const ProductId = schema.id("product");

export const NonNegativeSafeInteger = schema.refine(
  schema.number(),
  (value) => Number.isSafeInteger(value) && value >= 0,
  {
    id: "non-negative-safe-integer",
    message: "Expected a non-negative safe integer",
  },
);

export const PositiveSafeInteger = schema.refine(
  schema.number(),
  (value) => Number.isSafeInteger(value) && value > 0,
  {
    id: "positive-safe-integer",
    message: "Expected a positive safe integer",
  },
);

export const Product = schema.object({
  id: ProductId,
  name: schema.refine(schema.string(), (value) => value.trim().length > 0, {
    id: "product-name",
    message: "Product name must not be empty",
  }),
  unitPriceCents: PositiveSafeInteger,
  stock: NonNegativeSafeInteger,
  createdAt: schema.string(),
});

export type Product = Infer<typeof Product>;

export const ProductStorage = definePort({
  id: "product-storage",
  operations: {
    claim: portOperation({
      id: "product-storage.claim",
      kind: "write",
      input: schema.object({ id: ProductId }),
      output: schema.literal(true),
      errors: {
        PRODUCT_ALREADY_EXISTS: schema.object({ id: ProductId }),
      },
    }),
    releaseClaim: portOperation({
      id: "product-storage.release-claim",
      kind: "write",
      input: schema.object({ id: ProductId }),
      output: schema.literal(true),
      errors: {},
    }),
    get: portOperation({
      id: "product-storage.get",
      kind: "read",
      input: schema.object({ id: ProductId }),
      output: schema.optional(Product),
      errors: {},
    }),
    save: portOperation({
      id: "product-storage.save",
      kind: "write",
      input: Product,
      output: Product,
      errors: {
        PRODUCT_ALREADY_EXISTS: schema.object({ id: ProductId }),
      },
    }),
    reserve: portOperation({
      id: "product-storage.reserve",
      kind: "write",
      input: schema.object({
        productId: ProductId,
        quantity: PositiveSafeInteger,
      }),
      output: Product,
      errors: {
        PRODUCT_NOT_FOUND: schema.object({ id: ProductId }),
        OUT_OF_STOCK: schema.object({
          productId: ProductId,
          requested: PositiveSafeInteger,
          available: NonNegativeSafeInteger,
        }),
      },
    }),
    release: portOperation({
      id: "product-storage.release",
      kind: "write",
      input: schema.object({
        productId: ProductId,
        quantity: PositiveSafeInteger,
      }),
      output: Product,
      errors: {},
    }),
  },
});

export const ProductClock = definePort({
  id: "product-clock",
  operations: {
    now: portOperation({
      id: "product-clock.now",
      kind: "time",
      input: schema.object({}),
      output: schema.string(),
      errors: {},
    }),
  },
});

export const productsContract = defineFeatureContract({
  id: "products",
  exports: {
    Product,
    ProductId,
    ProductStorage,
    ProductClock,
  },
});
