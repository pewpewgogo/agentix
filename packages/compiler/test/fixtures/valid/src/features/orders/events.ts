import { defineEvent } from "@agentix/core";

export const OrderCreated = defineEvent({
  id: "orders.created",
  version: 1,
  payload: undefined,
});
