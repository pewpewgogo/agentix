import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { paidOrderHasPayment, type Order, type Payment } from "./orders.js";

const order: Order = {
  id: "order-1",
  customerId: "customer-1",
  productId: "product-1",
  quantity: 2,
  totalCents: 5_000,
  status: "paid",
  createdAt: "2040-01-01T00:00:00.000Z",
};

const payment: Payment = {
  id: "payment:order-1",
  orderId: "order-1",
  amountCents: 5_000,
  status: "approved",
  processedAt: "2040-01-01T00:00:00.000Z",
};

describe("paidOrderHasPayment", () => {
  it("accepts the matching approved payment", () => {
    expect(paidOrderHasPayment(order, payment)).toBe(true);
  });

  it("rejects missing or mismatched payment evidence", () => {
    expect(paidOrderHasPayment(order)).toBe(false);
    expect(
      paidOrderHasPayment(order, { ...payment, id: "payment:order-2", orderId: "order-2" }),
    ).toBe(false);
    expect(paidOrderHasPayment(order, { ...payment, amountCents: 4_999 })).toBe(
      false,
    );
  });

  it("accepts every matching approved payment and rejects a mismatched amount", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (suffix, totalCents) => {
          const generated: Order = {
            id: `order-${suffix}`,
            customerId: `customer-${suffix}`,
            productId: `product-${suffix}`,
            quantity: 1,
            totalCents,
            status: "paid",
            createdAt: "2040-01-01T00:00:00.000Z",
          };
          const matching: Payment = {
            id: `payment:${generated.id}`,
            orderId: generated.id,
            amountCents: totalCents,
            status: "approved",
            processedAt: generated.createdAt,
          };

          expect(paidOrderHasPayment(generated, matching)).toBe(true);
          expect(
            paidOrderHasPayment(generated, {
              ...matching,
              amountCents: totalCents + 1,
            }),
          ).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
