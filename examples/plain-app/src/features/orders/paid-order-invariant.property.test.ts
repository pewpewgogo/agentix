import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Order, Payment } from "./order.js";
import { paidOrderHasApprovedPayment } from "./paid-order-invariant.js";

describe("paidOrderHasApprovedPayment properties", () => {
  it("accepts every matching approved payment and rejects a mismatched amount", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (suffix, totalCents) => {
          const order: Order = {
            id: `order-${suffix}`,
            customerId: `customer-${suffix}`,
            productId: `product-${suffix}`,
            quantity: 1,
            totalCents,
            status: "paid",
            createdAt: "2040-01-01T00:00:00.000Z",
          };
          const payment: Payment = {
            id: `payment:${order.id}`,
            orderId: order.id,
            amountCents: totalCents,
            status: "approved",
            processedAt: order.createdAt,
          };

          expect(paidOrderHasApprovedPayment(order, payment)).toBe(true);
          expect(
            paidOrderHasApprovedPayment(order, {
              ...payment,
              amountCents: totalCents + 1,
            }),
          ).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
