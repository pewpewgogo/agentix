import {
  defineEvent,
  defineFeatureContract,
  definePort,
  portOperation,
  schema,
  type Infer,
} from "@agentixdev/core";

import { PositiveSafeInteger } from "../products/contract.js";

export const OrderId = schema.id("order");

export const Order = schema.object({
  id: OrderId,
  customerId: schema.id("customer"),
  productId: schema.id("product"),
  quantity: PositiveSafeInteger,
  totalCents: PositiveSafeInteger,
  status: schema.literal("paid"),
  createdAt: schema.string(),
});

export const Payment = schema.object({
  id: schema.id("payment"),
  orderId: OrderId,
  amountCents: PositiveSafeInteger,
  status: schema.literal("approved"),
  processedAt: schema.string(),
});

export const OrderCreatedEvent = schema.object({
  id: schema.id("event"),
  type: schema.literal("order.created"),
  occurredAt: schema.string(),
  data: schema.object({
    orderId: OrderId,
    customerId: schema.id("customer"),
    productId: schema.id("product"),
    quantity: PositiveSafeInteger,
    totalCents: PositiveSafeInteger,
  }),
});

export type Order = Infer<typeof Order>;
export type Payment = Infer<typeof Payment>;
export type OrderCreatedEvent = Infer<typeof OrderCreatedEvent>;

export const OrderStorage = definePort({
  id: "order-storage",
  operations: {
    get: portOperation({
      id: "order-storage.get",
      kind: "read",
      input: schema.object({ id: OrderId }),
      output: schema.optional(Order),
      errors: {},
    }),
  },
});

export const OrderClock = definePort({
  id: "order-clock",
  operations: {
    now: portOperation({
      id: "order-clock.now",
      kind: "time",
      input: schema.object({}),
      output: schema.string(),
      errors: {},
    }),
  },
});

export const OrderIds = definePort({
  id: "order-ids",
  operations: {
    next: portOperation({
      id: "order-ids.next",
      kind: "random",
      input: schema.object({}),
      output: schema.string(),
      errors: {},
    }),
  },
});

export const OrderEvents = definePort({
  id: "order-events",
  operations: {
    commitPaid: portOperation({
      id: "order-events.commit-paid",
      kind: "write",
      input: schema.object({
        order: Order,
        payment: Payment,
        event: OrderCreatedEvent,
      }),
      output: Order,
      errors: {
        DUPLICATE_ORDER: schema.object({ id: OrderId }),
      },
    }),
    list: portOperation({
      id: "order-events.list",
      kind: "read",
      input: schema.object({}),
      output: schema.array(OrderCreatedEvent),
      errors: {},
    }),
  },
});

export const OrderCreated = defineEvent({
  id: "orders.created",
  version: 1,
  payload: OrderCreatedEvent,
});

export const ordersContract = defineFeatureContract({
  id: "orders",
  exports: {
    Order,
    Payment,
    OrderCreatedEvent,
    OrderStorage,
    OrderEvents,
  },
});
