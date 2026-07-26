import { feature, port, s } from "@agentix/core";

/** Declines are expected outcomes, so they live in the output schema. */
export const ChargeResult = s.object({
  status: s.union([s.literal("approved"), s.literal("declined")]),
});
export type ChargeResult = s.Infer<typeof ChargeResult>;

export const Payments = port("paymentGateway", {
  charge: port.external({
    input: s.object({
      customerId: s.string({ min: 1 }),
      productId: s.string({ min: 1 }),
      quantity: s.number({ int: true, min: 1 }),
      amountCents: s.number({ int: true, min: 1 }),
    }),
    output: ChargeResult,
  }),
});

/** Port-only feature: the gateway contract other features charge through. */
export const payments = feature("payments", { operations: {} });
