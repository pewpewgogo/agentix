import { defineOperationTest } from "@agentix/testing";
import { createOrder } from "./operations.js";

export const createOrderTest = defineOperationTest({
  id: "orders.create.test",
  operation: createOrder,
});
