import { defineFeature } from "@agentix/core";
import { customersContract } from "../customers/contract.js";
import { ordersContract } from "./contract.js";
import { orderCustomerExists } from "./invariants.js";
import { createOrder } from "./operations.js";

export const orders = defineFeature({
  id: "orders",
  contract: ordersContract,
  dependencies: [customersContract],
  operations: [createOrder],
  invariants: [orderCustomerExists],
});
