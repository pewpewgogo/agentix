import { defineFeature } from "@agentixdev/core";
import { ordersContract } from "./contract.js";
import { unsafeQuery } from "./operations.js";

export const orders = defineFeature({
  id: "orders",
  contract: ordersContract,
  dependencies: [],
  operations: [unsafeQuery],
  invariants: [],
});
