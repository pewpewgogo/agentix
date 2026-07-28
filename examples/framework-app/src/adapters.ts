import type { BoundPortAdapter } from "@agentixdev/core";
import type {
  CommerceSnapshot,
  CommerceSystemOptions,
} from "@agentixdev/shared-contract";

import {
  CustomerClock,
  CustomerStorage,
  type Customer,
} from "./features/customers.js";
import {
  OrderClock,
  OrderEvents,
  OrderIds,
  OrderStorage,
  type Order,
  type OrderCreatedEvent,
  type Payment,
} from "./features/orders.js";
import { Payments } from "./features/payments.js";
import {
  ProductClock,
  ProductStorage,
  type Product,
} from "./features/products.js";

export interface CommerceState {
  readonly customers: Map<string, Customer>;
  readonly customerClaims: Set<string>;
  readonly products: Map<string, Product>;
  readonly productClaims: Set<string>;
  readonly orders: Map<string, Order>;
  readonly payments: Map<string, Payment>;
  readonly events: OrderCreatedEvent[];
}

export const createState = (): CommerceState => ({
  customers: new Map(),
  customerClaims: new Set(),
  products: new Map(),
  productClaims: new Set(),
  orders: new Map(),
  payments: new Map(),
  events: [],
});

const defaultNow = (): string => "2030-01-01T00:00:00.000Z";

const defaultOrderIds = (): (() => string) => {
  let next = 0;
  return () => `order-${++next}`;
};

/** In-memory adapters wired to the shared-contract determinism seams. */
export const commerceAdapters = (
  state: CommerceState,
  options: CommerceSystemOptions,
): readonly BoundPortAdapter[] => {
  const now = options.now ?? defaultNow;
  const nextOrderId = options.orderIds ?? defaultOrderIds();
  const paymentOutcomes = [...(options.paymentOutcomes ?? [])];

  return [
    CustomerStorage.adapter({
      claim: (id) => {
        if (state.customers.has(id) || state.customerClaims.has(id)) return false;
        state.customerClaims.add(id);
        return true;
      },
      releaseClaim: (id) => {
        state.customerClaims.delete(id);
        return true;
      },
      get: (id) => state.customers.get(id),
      save: (customer) => {
        state.customers.set(customer.id, customer);
        state.customerClaims.delete(customer.id);
        return customer;
      },
    }),
    CustomerClock.adapter({ now: () => now() }),
    ProductStorage.adapter({
      claim: (id) => {
        if (state.products.has(id) || state.productClaims.has(id)) return false;
        state.productClaims.add(id);
        return true;
      },
      releaseClaim: (id) => {
        state.productClaims.delete(id);
        return true;
      },
      get: (id) => state.products.get(id),
      save: (product) => {
        state.products.set(product.id, product);
        state.productClaims.delete(product.id);
        return product;
      },
      reserve: ({ productId, quantity }) => {
        const product = state.products.get(productId);
        if (product === undefined) {
          return { reserved: false, reason: "PRODUCT_NOT_FOUND", available: 0 } as const;
        }
        if (product.stock < quantity) {
          return {
            reserved: false,
            reason: "OUT_OF_STOCK",
            available: product.stock,
          } as const;
        }
        const reserved = { ...product, stock: product.stock - quantity };
        state.products.set(productId, reserved);
        return { reserved: true, product: reserved } as const;
      },
      release: ({ productId, quantity }) => {
        const product = state.products.get(productId);
        if (product === undefined) {
          throw new Error(`Cannot release missing product ${productId}`);
        }
        const released = { ...product, stock: product.stock + quantity };
        state.products.set(productId, released);
        return released;
      },
    }),
    ProductClock.adapter({ now: () => now() }),
    Payments.adapter({
      charge: () => ({ status: paymentOutcomes.shift() ?? "approved" }),
    }),
    OrderIds.adapter({ next: () => nextOrderId() }),
    OrderClock.adapter({ now: () => now() }),
    OrderStorage.adapter({ get: (id) => state.orders.get(id) }),
    OrderEvents.adapter({
      commitPaid: ({ order, payment, event }) => {
        if (state.orders.has(order.id)) {
          throw new Error(`Order ${order.id} already exists.`);
        }
        state.orders.set(order.id, order);
        state.payments.set(payment.id, payment);
        state.events.push(event);
        return order;
      },
      list: () => [...state.events],
    }),
  ];
};

export const cloneSnapshot = (state: CommerceState): CommerceSnapshot => ({
  customers: [...state.customers.values()].map((customer) => ({ ...customer })),
  products: [...state.products.values()].map((product) => ({ ...product })),
  orders: [...state.orders.values()].map((order) => ({ ...order })),
  payments: [...state.payments.values()].map((payment) => ({ ...payment })),
  events: state.events.map((event) => ({ ...event, data: { ...event.data } })),
});
