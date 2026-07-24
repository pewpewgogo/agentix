import {
  defineCommand,
  defineQuery,
  domainError,
  err,
  ok,
  schema,
} from "@agentixdev/core";

import {
  NonNegativeSafeInteger,
  PositiveSafeInteger,
  Product,
  ProductClock,
  ProductId,
  ProductStorage,
} from "./contract.js";

export const createProduct = defineCommand({
  id: "products.create",
  input: schema.object({
    id: schema.refine(ProductId, (value) => value.trim().length > 0, {
      id: "product-input-id",
      message: "Product ID must not be blank",
    }),
    name: schema.refine(schema.string(), (value) => value.trim().length > 0, {
      id: "product-input-name",
      message: "Product name must not be blank",
    }),
    unitPriceCents: PositiveSafeInteger,
    stock: NonNegativeSafeInteger,
  }),
  output: Product,
  errors: {
    PRODUCT_ALREADY_EXISTS: schema.object({ id: ProductId }),
  },
  permissions: ["products:create"],
  effects: {
    claim: ProductStorage.operations.claim,
    releaseClaim: ProductStorage.operations.releaseClaim,
    now: ProductClock.operations.now,
    save: ProductStorage.operations.save,
  },
  emits: {},
  async execute({ input, effects }) {
    const id = ProductId.parse(input.id.trim());
    const claimed = await effects.claim({ id });
    if (!claimed.ok) {
      return err(domainError("PRODUCT_ALREADY_EXISTS", { id }));
    }
    try {
      const instant = await effects.now({});
      if (!instant.ok) {
        const released = await effects.releaseClaim({ id });
        return released.ok ? instant : released;
      }
      const product = Product.parse({
        id,
        name: input.name.trim(),
        unitPriceCents: input.unitPriceCents,
        stock: input.stock,
        createdAt: instant.value,
      });
      const saved = await effects.save(product);
      if (!saved.ok) {
        const released = await effects.releaseClaim({ id });
        return released.ok ? saved : released;
      }
      return ok(saved.value);
    } catch (cause: unknown) {
      await effects.releaseClaim({ id });
      throw cause;
    }
  },
});

export const getProduct = defineQuery({
  id: "products.get",
  input: schema.object({ id: ProductId }),
  output: Product,
  errors: {
    PRODUCT_NOT_FOUND: schema.object({ id: ProductId }),
  },
  permissions: ["products:read"],
  effects: { load: ProductStorage.operations.get },
  async execute({ input, effects }) {
    const loaded = await effects.load(input);
    if (!loaded.ok) return loaded;
    return loaded.value === undefined
      ? err(domainError("PRODUCT_NOT_FOUND", { id: input.id }))
      : ok(loaded.value);
  },
});
