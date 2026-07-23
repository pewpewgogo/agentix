import { defineInvariant, schema } from "@agentix/core";

import { paymentsContract } from "../payments/contract.js";
import { Order, Payment, ordersContract } from "./contract.js";

export const paidOrderHasPayment = defineInvariant({
  id: "orders.paid-order-has-payment",
  dependsOn: [ordersContract, paymentsContract],
  evidence: schema.object({
    order: Order,
    payment: schema.optional(Payment),
  }),
  check: ({ order, payment }) =>
    order.status !== "paid" ||
    (payment !== undefined &&
      payment.orderId === order.id &&
      payment.status === "approved" &&
      payment.amountCents === order.totalCents),
});
