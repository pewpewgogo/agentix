import { describe, expect, it } from "vitest";
import {
  assertInvariant,
  defineOperationTest,
} from "@agentix/testing";

import { Order, Payment } from "./contract.js";
import { paidOrderHasPayment } from "./invariants.js";
import { createOrder } from "./operations.js";

export const createOrderTest = defineOperationTest({
  id: "orders.create.invariant",
  operation: createOrder,
});

const order = Order.parse({
  id: "order-1",
  customerId: "customer-1",
  productId: "product-1",
  quantity: 2,
  totalCents: 5_000,
  status: "paid",
  createdAt: "2040-01-01T00:00:00.000Z",
});

describe("paidOrderHasPayment", () => {
  it("accepts the matching approved payment", () => {
    const payment = Payment.parse({
      id: "payment:order-1",
      orderId: "order-1",
      amountCents: 5_000,
      status: "approved",
      processedAt: "2040-01-01T00:00:00.000Z",
    });

    expect(() =>
      assertInvariant(paidOrderHasPayment, { order, payment }),
    ).not.toThrow();
  });

  it("rejects missing or mismatched payment evidence", () => {
    expect(paidOrderHasPayment.check({ order })).toBe(false);
    expect(
      paidOrderHasPayment.check({
        order,
        payment: Payment.parse({
          id: "payment:order-2",
          orderId: "order-2",
          amountCents: 5_000,
          status: "approved",
          processedAt: "2040-01-01T00:00:00.000Z",
        }),
      }),
    ).toBe(false);
  });
});
