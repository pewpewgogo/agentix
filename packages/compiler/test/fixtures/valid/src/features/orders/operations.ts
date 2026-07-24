import { defineCommand } from "@agentixdev/core";
import { OrderCreated } from "./events.js";
import { orderCustomerExists } from "./invariants.js";
import { Payments } from "./ports.js";

export const createOrder = defineCommand({
  id: "orders.create",
  input: CreateOrderInput,
  output: OrderOutput,
  errors: { PAYMENT_FAILED: PaymentFailed },
  permissions: ["orders:create"],
  effects: { chargePayment: Payments.operations.charge },
  emits: { orderCreated: OrderCreated },
  invariants: [orderCustomerExists],
  execute: async () => ({ ok: true }),
});
