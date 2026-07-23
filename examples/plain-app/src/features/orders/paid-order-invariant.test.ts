import { describe, expect, it } from "vitest";

import { paidOrderHasApprovedPayment } from "./paid-order-invariant.js";
import type { Order, Payment } from "./order.js";

const order: Order = {
  id: "order-1",
  customerId: "customer-1",
  productId: "product-1",
  quantity: 2,
  totalCents: 5000,
  status: "paid",
  createdAt: "2040-01-01T00:00:00.000Z",
};

const payment: Payment = {
  id: "payment:order-1",
  orderId: "order-1",
  amountCents: 5000,
  status: "approved",
  processedAt: "2040-01-01T00:00:00.000Z",
};

describe("paid order invariant", () => {
  it("requires a matching approved payment with the exact total", () => {
    expect(paidOrderHasApprovedPayment(order, payment)).toBe(true);
    expect(paidOrderHasApprovedPayment(order, undefined)).toBe(false);
    expect(
      paidOrderHasApprovedPayment(order, { ...payment, amountCents: 4999 }),
    ).toBe(false);
    expect(
      paidOrderHasApprovedPayment(order, { ...payment, orderId: "other" }),
    ).toBe(false);
  });
});
