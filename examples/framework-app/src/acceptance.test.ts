import { defineCommerceAcceptance } from "@agentix/shared-contract/acceptance";
import { associateOperationTest } from "@agentix/testing";

import { createFrameworkSystem } from "./application.js";
import { createOrder } from "./features/orders/operations.js";

export const createOrderAcceptanceTest = associateOperationTest(
  createOrder,
  "orders.create.acceptance",
);

defineCommerceAcceptance("framework commerce app", createFrameworkSystem);
