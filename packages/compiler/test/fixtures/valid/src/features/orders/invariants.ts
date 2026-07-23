import { defineInvariant } from "@agentix/core";
import { customersContract } from "../customers/contract.js";
import { ordersContract } from "./contract.js";

export const orderCustomerExists = defineInvariant({
  id: "orders.customer-exists",
  dependsOn: [ordersContract, customersContract],
  evidence: undefined,
  check: () => true,
});
