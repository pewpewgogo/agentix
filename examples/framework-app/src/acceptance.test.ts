import { defineCommerceAcceptance } from "@agentixdev/shared-contract/acceptance";
import { associateOperationTest } from "@agentixdev/testing";

import { createFrameworkSystem } from "./application.js";
import { orders } from "./features/orders.js";

export const createOrderAcceptanceTest = associateOperationTest(
  orders.operations.create,
  "orders.create.acceptance",
);

// The parity proof runs the identical black-box suite in BOTH runtime modes:
// "test" keeps every dev check on; "production" exercises the fast path.
defineCommerceAcceptance("framework commerce app (mode: test)", (options) =>
  createFrameworkSystem({ ...options, mode: "test" }),
);
defineCommerceAcceptance("framework commerce app (mode: production)", (options) =>
  createFrameworkSystem({ ...options, mode: "production" }),
);
