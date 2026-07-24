import { defineFeature } from "@agentixdev/core";

import {
  ProductClock,
  ProductStorage,
  productsContract,
} from "./contract.js";
import { createProduct, getProduct } from "./operations.js";

export const products = defineFeature({
  id: "products",
  contract: productsContract,
  dependencies: [],
  operations: [createProduct, getProduct],
  invariants: [],
  ports: [ProductStorage, ProductClock],
});
