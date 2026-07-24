import { defineOperationTest } from "@agentixdev/testing";
import { createOrder } from "./operations.js";

export const createOrderTest = defineOperationTest({
  id: "orders.create.test",
  operation: createOrder,
});
