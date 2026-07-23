import type { Order, Payment } from "./order.js";

/** Every persisted paid order must have one matching approved payment. */
export const paidOrderHasApprovedPayment = (
  order: Order,
  payment: Payment | undefined,
): boolean =>
  order.status !== "paid" ||
  (payment?.status === "approved" &&
    payment.orderId === order.id &&
    payment.amountCents === order.totalCents);
