import { defineFeature } from "@agentixdev/core";

import { customersContract } from "../customers/contract.js";
import { paymentsContract } from "../payments/contract.js";
import { productsContract } from "../products/contract.js";
import {
  OrderClock,
  OrderCreated,
  OrderEvents,
  OrderIds,
  OrderStorage,
  ordersContract,
} from "./contract.js";
import { paidOrderHasPayment } from "./invariants.js";
import { createOrder, getOrder, listEvents } from "./operations.js";

export const orders = defineFeature({
  id: "orders",
  contract: ordersContract,
  dependencies: [customersContract, productsContract, paymentsContract],
  operations: [createOrder, getOrder, listEvents],
  invariants: [paidOrderHasPayment],
  events: [OrderCreated],
  ports: [OrderStorage, OrderClock, OrderIds, OrderEvents],
});
