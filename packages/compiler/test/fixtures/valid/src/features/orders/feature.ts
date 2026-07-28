import { command, event, feature, port, s } from "@agentixdev/core";
import { CustomerStore } from "../customers.js";
import { OrderDraft } from "./model.js";

export const Payments = port("payments", {
  charge: port.external({
    input: s.object({ orderId: s.string({ min: 1 }), amount: s.number({ min: 0 }) }),
    output: s.object({ receipt: s.string() }),
  }),
});

export const OrderCreated = event("orders.created", 1, s.object({ id: s.string() }));

export const orders = feature("orders", {
  events: [OrderCreated],
  operations: {
    create: command({
      input: OrderDraft,
      output: OrderDraft,
      errors: {
        PAYMENT_FAILED: { http: 402, details: { reason: s.string() } },
        CUSTOMER_NOT_FOUND: { details: { id: s.string() } },
        ORDER_INVALID: s.object({ reason: s.string() }),
      },
      permissions: ["orders:create"],
      http: { method: "POST", path: "/orders", status: 201 },
      effects: {
        chargePayment: Payments.charge,
        loadCustomer: CustomerStore.get,
      },
      emits: { orderCreated: OrderCreated },
      ensures: {
        chargedOnce: { check: ({ output }) => output !== undefined },
      },
      async execute({ input, effects, emit, fail }) {
        const customer = await effects.loadCustomer(input.customerId);
        if (!customer) return fail("CUSTOMER_NOT_FOUND", { id: input.customerId });
        const charge = await effects.chargePayment({ orderId: input.id, amount: input.amount });
        if (!charge.receipt) return fail("PAYMENT_FAILED", { reason: "declined" });
        emit.orderCreated({ id: input.id });
        return input;
      },
    }),
  },
});
