import {
  defineFeatureContract,
  definePort,
  portOperation,
  schema,
} from "@agentix/core";

export const Payments = definePort({
  id: "payment-gateway",
  operations: {
    charge: portOperation({
      id: "payment-gateway.charge",
      kind: "external",
      input: schema.object({
        customerId: schema.id("customer"),
        productId: schema.id("product"),
        quantity: schema.number(),
        amountCents: schema.number(),
      }),
      output: schema.object({ status: schema.literal("approved") }),
      errors: {
        PAYMENT_DECLINED: schema.object({}),
      },
    }),
  },
});

export const paymentsContract = defineFeatureContract({
  id: "payments",
  exports: { Payments },
});
