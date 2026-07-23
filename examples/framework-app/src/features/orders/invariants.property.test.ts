import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Order, Payment } from "./contract.js";
import { paidOrderHasPayment } from "./invariants.js";

describe("paidOrderHasPayment properties", () => {
  it("accepts every matching approved payment and rejects a mismatched amount", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (suffix, totalCents) => {
          const order = Order.parse({
            id: `order-${suffix}`,
            customerId: `customer-${suffix}`,
            productId: `product-${suffix}`,
            quantity: 1,
            totalCents,
            status: "paid",
            createdAt: "2040-01-01T00:00:00.000Z",
          });
          const payment = Payment.parse({
            id: `payment:${order.id}`,
            orderId: order.id,
            amountCents: totalCents,
            status: "approved",
            processedAt: order.createdAt,
          });

          expect(paidOrderHasPayment.check({ order, payment })).toBe(true);
          expect(
            paidOrderHasPayment.check({
              order,
              payment: { ...payment, amountCents: totalCents + 1 },
            }),
          ).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
