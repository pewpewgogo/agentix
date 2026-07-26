import { s } from "@agentix/core";

export const OrderDraft = s.object({
  id: s.string({ min: 1 }),
  customerId: s.string({ min: 1 }),
  amount: s.number({ min: 0 }),
});
export type OrderDraft = s.Infer<typeof OrderDraft>;
