import {
  defineCommand,
  defineQuery,
  domainError,
  err,
  ok,
  schema,
} from "@agentix/core";

import {
  CustomerStorage,
  customersContract,
} from "../customers/contract.js";
import { Payments } from "../payments/contract.js";
import {
  PositiveSafeInteger,
  ProductStorage,
  productsContract,
} from "../products/contract.js";
import {
  Order,
  OrderClock,
  OrderCreated,
  OrderCreatedEvent,
  OrderEvents,
  OrderId,
  OrderIds,
  OrderStorage,
  Payment,
} from "./contract.js";
import { paidOrderHasPayment } from "./invariants.js";

export const createOrder = defineCommand({
  id: "orders.create",
  input: schema.object({
    customerId: schema.refine(schema.id("customer"), (id) => id.trim().length > 0, {
      id: "order-customer-id",
      message: "Customer ID must not be blank",
    }),
    productId: schema.refine(schema.id("product"), (id) => id.trim().length > 0, {
      id: "order-product-id",
      message: "Product ID must not be blank",
    }),
    quantity: PositiveSafeInteger,
  }),
  output: Order,
  errors: {
    CUSTOMER_NOT_FOUND: schema.object({ id: schema.id("customer") }),
    PRODUCT_NOT_FOUND: schema.object({ id: schema.id("product") }),
    CUSTOMER_SUSPENDED: schema.object({ id: schema.id("customer") }),
    OUT_OF_STOCK: schema.object({
      productId: schema.id("product"),
      requested: PositiveSafeInteger,
      available: schema.number(),
    }),
    PAYMENT_DECLINED: schema.object({}),
    DUPLICATE_ORDER: schema.object({ id: OrderId }),
  },
  permissions: ["orders:create"],
  effects: {
    loadCustomer: CustomerStorage.operations.get,
    reserveProduct: ProductStorage.operations.reserve,
    releaseProduct: ProductStorage.operations.release,
    chargePayment: Payments.operations.charge,
    nextId: OrderIds.operations.next,
    now: OrderClock.operations.now,
    commitPaid: OrderEvents.operations.commitPaid,
  },
  emits: { orderCreated: OrderCreated },
  invariants: [paidOrderHasPayment],
  async execute({ input, effects, emit }) {
    const customerId = customersContract.exports.CustomerId.parse(
      input.customerId.trim(),
    );
    const productId = productsContract.exports.ProductId.parse(
      input.productId.trim(),
    );

    const loadedCustomer = await effects.loadCustomer({ id: customerId });
    if (!loadedCustomer.ok) return loadedCustomer;
    if (loadedCustomer.value === undefined) {
      return err(domainError("CUSTOMER_NOT_FOUND", { id: customerId }));
    }
    if (loadedCustomer.value.status === "suspended") {
      return err(domainError("CUSTOMER_SUSPENDED", { id: customerId }));
    }

    const reservedProduct = await effects.reserveProduct({
      productId,
      quantity: input.quantity,
    });
    if (!reservedProduct.ok) {
      return reservedProduct.error.code === "PRODUCT_NOT_FOUND"
        ? err(domainError("PRODUCT_NOT_FOUND", reservedProduct.error.details))
        : err(domainError("OUT_OF_STOCK", reservedProduct.error.details));
    }

    let committed = false;
    try {
      const totalCents = reservedProduct.value.unitPriceCents * input.quantity;
      if (!Number.isSafeInteger(totalCents)) {
        throw new RangeError("The order total exceeds the safe integer range.");
      }
      const charge = await effects.chargePayment({
        customerId,
        productId,
        quantity: input.quantity,
        amountCents: totalCents,
      });
      if (!charge.ok) {
        return err(domainError("PAYMENT_DECLINED", {}));
      }

      const nextId = await effects.nextId({});
      if (!nextId.ok) return nextId;
      const parsedId = OrderId.safeParse(nextId.value.trim());
      if (!parsedId.success) {
        throw new TypeError("The order ID generator returned a blank ID.");
      }
      const instant = await effects.now({});
      if (!instant.ok) return instant;

      const order = Order.parse({
        id: parsedId.data,
        customerId,
        productId,
        quantity: input.quantity,
        totalCents,
        status: "paid",
        createdAt: instant.value,
      });
      const payment = Payment.parse({
        id: `payment:${order.id}`,
        orderId: order.id,
        amountCents: totalCents,
        status: "approved",
        processedAt: instant.value,
      });
      if (!paidOrderHasPayment.check({ order, payment })) {
        throw new Error(`Invariant ${paidOrderHasPayment.id} failed`);
      }
      const event = OrderCreatedEvent.parse({
        id: `event:order.created:${order.id}`,
        type: "order.created",
        occurredAt: instant.value,
        data: {
          orderId: order.id,
          customerId,
          productId,
          quantity: order.quantity,
          totalCents,
        },
      });

      const commitResult = await effects.commitPaid({
        order,
        payment,
        event,
      });
      if (!commitResult.ok) return commitResult;
      committed = true;
      emit.orderCreated(event);
      return ok(order);
    } finally {
      if (!committed) {
        const released = await effects.releaseProduct({
          productId,
          quantity: input.quantity,
        });
        if (!released.ok) {
          throw new Error("Reserved product could not be released");
        }
      }
    }
  },
});

export const getOrder = defineQuery({
  id: "orders.get",
  input: schema.object({ id: OrderId }),
  output: Order,
  errors: { ORDER_NOT_FOUND: schema.object({ id: OrderId }) },
  permissions: ["orders:read"],
  effects: { load: OrderStorage.operations.get },
  async execute({ input, effects }) {
    const loaded = await effects.load(input);
    if (!loaded.ok) return loaded;
    return loaded.value === undefined
      ? err(domainError("ORDER_NOT_FOUND", { id: input.id }))
      : ok(loaded.value);
  },
});

export const listEvents = defineQuery({
  id: "orders.list-events",
  input: schema.object({}),
  output: schema.array(OrderCreatedEvent),
  errors: {},
  permissions: ["events:read"],
  effects: { list: OrderEvents.operations.list },
  async execute({ effects }) {
    return effects.list({});
  },
});
