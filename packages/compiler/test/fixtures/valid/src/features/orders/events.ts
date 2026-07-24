import { defineEvent } from "@agentixdev/core";

export const OrderCreated = defineEvent({
  id: "orders.created",
  version: 1,
  payload: undefined,
});
