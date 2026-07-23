import {
  COMMERCE_HTTP_CONTRACT,
  type CommerceSystem,
  type CommerceSystemOptions,
} from "@agentix/shared-contract";

import type { Clock } from "./features/customers/customer.js";
import { CustomerService } from "./features/customers/customer.js";
import { customerRoutes } from "./features/customers/routes.js";
import type { OrderIdGenerator } from "./features/orders/order.js";
import { OrderService } from "./features/orders/order.js";
import { orderRoutes } from "./features/orders/routes.js";
import { ProductService } from "./features/products/product.js";
import { productRoutes } from "./features/products/routes.js";
import { createRouter } from "./http/router.js";
import { InMemoryCommerceStore } from "./infrastructure/memory.js";
import { ScriptedPaymentGateway } from "./infrastructure/scripted-payment.js";

export type PlainSystemOptions = CommerceSystemOptions;
export type PlainCommerceSystem = CommerceSystem;

const systemClock = (): string => "2030-01-01T00:00:00.000Z";

const authenticate = (request: Request) => {
  const principalId = request.headers.get(
    COMMERCE_HTTP_CONTRACT.authentication.principalHeader,
  );
  const authenticated =
    principalId !== null && principalId.trim().length > 0;
  const permissions = new Set<string>(
    !authenticated
      ? []
      : (request.headers.get(
            COMMERCE_HTTP_CONTRACT.authentication.permissionsHeader,
          ) ?? "")
          .split(COMMERCE_HTTP_CONTRACT.authentication.permissionsSeparator)
          .map((permission) => permission.trim())
          .filter((permission) => permission.length > 0),
  );
  return { id: authenticated ? principalId : "anonymous", permissions };
};

export const createPlainSystem = (
  options: PlainSystemOptions = {},
): PlainCommerceSystem => {
  const store = new InMemoryCommerceStore();
  const clock: Clock = { now: options.now ?? systemClock };
  let nextOrderNumber = 0;
  const ids: OrderIdGenerator = {
    next:
      options.orderIds ??
      (() => {
        nextOrderNumber += 1;
        return `order-${nextOrderNumber}`;
      }),
  };
  const customers = new CustomerService(store, clock);
  const products = new ProductService(store, clock);
  const orders = new OrderService(
    store,
    store,
    store,
    new ScriptedPaymentGateway(options.paymentOutcomes),
    clock,
    ids,
  );
  const handle = createRouter({
    routes: [
      ...customerRoutes(customers),
      ...productRoutes(products),
      ...orderRoutes(orders),
    ],
    authenticate,
  });

  return {
    handle,
    async snapshot() {
      return {
        customers: await store.listCustomers(),
        products: await store.listProducts(),
        orders: await store.listOrders(),
        payments: await store.listPayments(),
        events: await store.listEvents(),
      };
    },
  };
};
