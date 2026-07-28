import { command, event, feature, port, query, s } from "@agentixdev/core";

import { CustomerStorage } from "./customers.js";
import { Payments } from "./payments.js";
import { PositiveSafeInteger, ProductStorage } from "./products.js";

export const Order = s.object({
  id: s.string({ min: 1 }),
  customerId: s.string({ min: 1 }),
  productId: s.string({ min: 1 }),
  quantity: PositiveSafeInteger,
  totalCents: PositiveSafeInteger,
  status: s.literal("paid"),
  createdAt: s.string({ min: 1 }),
});
export type Order = s.Infer<typeof Order>;

export const Payment = s.object({
  id: s.string({ min: 1 }),
  orderId: s.string({ min: 1 }),
  amountCents: PositiveSafeInteger,
  status: s.literal("approved"),
  processedAt: s.string({ min: 1 }),
});
export type Payment = s.Infer<typeof Payment>;

export const OrderCreatedEvent = s.object({
  id: s.string({ min: 1 }),
  type: s.literal("order.created"),
  occurredAt: s.string({ min: 1 }),
  data: s.object({
    orderId: s.string({ min: 1 }),
    customerId: s.string({ min: 1 }),
    productId: s.string({ min: 1 }),
    quantity: PositiveSafeInteger,
    totalCents: PositiveSafeInteger,
  }),
});
export type OrderCreatedEvent = s.Infer<typeof OrderCreatedEvent>;

export const OrderStorage = port("orderStorage", {
  get: port.read({ input: s.string({ min: 1 }), output: s.optional(Order) }),
});

export const OrderClock = port("orderClock", {
  now: port.time({ input: s.object({}), output: s.string({ min: 1 }) }),
});

export const OrderIds = port("orderIds", {
  /** Deliberately unconstrained: the execute guard owns the blank-ID contract. */
  next: port.random({ input: s.object({}), output: s.string() }),
});

export const OrderEvents = port("orderEvents", {
  /** Atomically persists order + payment + event; throws on duplicate ids. */
  commitPaid: port.write({
    input: s.object({ order: Order, payment: Payment, event: OrderCreatedEvent }),
    output: Order,
  }),
  list: port.read({ input: s.object({}), output: s.array(OrderCreatedEvent) }),
});

export const OrderCreated = event("orders.created", 1, OrderCreatedEvent);

/** Every paid order must carry its exactly-matching approved payment. */
export const paidOrderHasPayment = (order: Order, payment?: Payment): boolean =>
  order.status !== "paid" ||
  (payment !== undefined &&
    payment.orderId === order.id &&
    payment.status === "approved" &&
    payment.amountCents === order.totalCents);

export const orders = feature("orders", {
  events: [OrderCreated],
  operations: {
    create: command({
      input: s.object({
        customerId: s.string({ min: 1, trim: true }),
        productId: s.string({ min: 1, trim: true }),
        quantity: PositiveSafeInteger,
      }),
      output: Order,
      errors: {
        CUSTOMER_NOT_FOUND: { http: 404, details: { id: s.string() } },
        PRODUCT_NOT_FOUND: { http: 404, details: { id: s.string() } },
        CUSTOMER_SUSPENDED: { http: 409, details: { id: s.string() } },
        OUT_OF_STOCK: {
          http: 409,
          details: {
            productId: s.string(),
            requested: s.number(),
            available: s.number(),
          },
        },
        PAYMENT_DECLINED: { http: 402 },
      },
      permissions: ["orders:create"],
      http: { method: "POST", path: "/orders", status: 201 },
      effects: {
        loadCustomer: CustomerStorage.get,
        reserveProduct: ProductStorage.reserve,
        releaseProduct: ProductStorage.release,
        chargePayment: Payments.charge,
        nextId: OrderIds.next,
        now: OrderClock.now,
        commitPaid: OrderEvents.commitPaid,
      },
      emits: { orderCreated: OrderCreated },
      ensures: {
        paidOrderMatchesRequest: {
          check: ({ input, output }) =>
            output.status === "paid" &&
            output.customerId === input.customerId &&
            output.productId === input.productId &&
            output.quantity === input.quantity,
        },
      },
      async execute({ input, effects, emit, fail }) {
        const { customerId, productId, quantity } = input;

        const customer = await effects.loadCustomer(customerId);
        if (customer === undefined) {
          return fail("CUSTOMER_NOT_FOUND", { id: customerId });
        }
        if (customer.status === "suspended") {
          return fail("CUSTOMER_SUSPENDED", { id: customerId });
        }

        const reservation = await effects.reserveProduct({ productId, quantity });
        if (!reservation.reserved) {
          return reservation.reason === "PRODUCT_NOT_FOUND"
            ? fail("PRODUCT_NOT_FOUND", { id: productId })
            : fail("OUT_OF_STOCK", {
                productId,
                requested: quantity,
                available: reservation.available,
              });
        }

        let committed = false;
        try {
          const totalCents = reservation.product.unitPriceCents * quantity;
          if (!Number.isSafeInteger(totalCents)) {
            throw new RangeError("The order total exceeds the safe integer range.");
          }
          const charge = await effects.chargePayment({
            customerId,
            productId,
            quantity,
            amountCents: totalCents,
          });
          if (charge.status !== "approved") return fail("PAYMENT_DECLINED");

          // Load-bearing guard: production mode skips effect-output re-parse,
          // so the generated-ID contract is enforced here, before any commit.
          const id = (await effects.nextId({})).trim();
          if (id.length === 0) {
            throw new TypeError("The order ID generator returned a blank ID.");
          }
          const createdAt = await effects.now({});

          const order: Order = {
            id,
            customerId,
            productId,
            quantity,
            totalCents,
            status: "paid",
            createdAt,
          };
          const payment: Payment = {
            id: `payment:${id}`,
            orderId: id,
            amountCents: totalCents,
            status: "approved",
            processedAt: createdAt,
          };
          if (!paidOrderHasPayment(order, payment)) {
            throw new Error("A paid order must have its approved payment.");
          }
          const created: OrderCreatedEvent = {
            id: `event:order.created:${id}`,
            type: "order.created",
            occurredAt: createdAt,
            data: { orderId: id, customerId, productId, quantity, totalCents },
          };

          await effects.commitPaid({ order, payment, event: created });
          committed = true;
          emit.orderCreated(created);
          return order;
        } finally {
          // Compensation: the reserved stock is returned on every non-commit
          // exit (declined payment, blank generated ID, clock/commit faults).
          if (!committed) {
            await effects.releaseProduct({ productId, quantity });
          }
        }
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1, trim: true }) }),
      output: Order,
      errors: {
        ORDER_NOT_FOUND: { http: 404, details: { id: s.string() } },
      },
      permissions: ["orders:read"],
      http: { method: "GET", path: "/orders/:id" },
      effects: { load: OrderStorage.get },
      async execute({ input, effects, fail }) {
        return (
          (await effects.load(input.id)) ??
          fail("ORDER_NOT_FOUND", { id: input.id })
        );
      },
    }),
    listEvents: query({
      input: s.object({}),
      output: s.array(OrderCreatedEvent),
      permissions: ["events:read"],
      http: { method: "GET", path: "/events" },
      effects: { list: OrderEvents.list },
      async execute({ effects }) {
        return effects.list({});
      },
    }),
  },
});
