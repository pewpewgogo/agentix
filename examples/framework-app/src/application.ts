import {
  bindPort,
  createApplication,
  domainError,
  err,
  ok,
  type DispatchResult,
  type Infer,
  type Principal,
} from "@agentix/core";
import {
  createHttpHandler,
  createTrustedHeaderPrincipalExtractor,
  defineHttpRoute,
  HttpInputError,
  jsonResponse,
  readJsonBody,
  type PrincipalExtractor,
} from "@agentix/adapters-http";
import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
  type CommerceSnapshot,
  type CommerceSystem,
  type CommerceSystemFactory,
  type CommerceSystemOptions,
} from "@agentix/shared-contract";

import {
  Customer,
  CustomerClock,
  CustomerId,
  CustomerStorage,
  type Customer as CustomerRecord,
} from "./features/customers/contract.js";
import { customers } from "./features/customers/feature.js";
import {
  createCustomer,
  getCustomer,
} from "./features/customers/operations.js";
import {
  Order,
  OrderClock,
  OrderCreatedEvent,
  OrderEvents,
  OrderId,
  OrderIds,
  OrderStorage,
  Payment,
  type Order as OrderRecord,
  type OrderCreatedEvent as EventRecord,
  type Payment as PaymentRecord,
} from "./features/orders/contract.js";
import { orders } from "./features/orders/feature.js";
import { createOrder, getOrder, listEvents } from "./features/orders/operations.js";
import { Payments } from "./features/payments/contract.js";
import { payments } from "./features/payments/feature.js";
import {
  Product,
  ProductClock,
  ProductId,
  ProductStorage,
  type Product as ProductRecord,
} from "./features/products/contract.js";
import { products } from "./features/products/feature.js";
import { createProduct, getProduct } from "./features/products/operations.js";

interface InMemoryState {
  readonly customers: Map<string, CustomerRecord>;
  readonly customerClaims: Set<string>;
  readonly products: Map<string, ProductRecord>;
  readonly productClaims: Set<string>;
  readonly orders: Map<string, OrderRecord>;
  readonly payments: Map<string, PaymentRecord>;
  readonly events: EventRecord[];
}

const createState = (): InMemoryState => ({
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
  let next = 1;
  return () => `order-${next++}`;
};

const adaptersFor = (
  state: InMemoryState,
  options: CommerceSystemOptions,
) => {
  const now = options.now ?? defaultNow;
  const nextOrderId = options.orderIds ?? defaultOrderIds();
  const paymentOutcomes = [...(options.paymentOutcomes ?? [])];
  let paymentIndex = 0;

  return [
    bindPort(CustomerStorage, {
      claim: ({ id }) => {
        if (state.customers.has(id) || state.customerClaims.has(id)) {
          return err(domainError("CUSTOMER_ALREADY_EXISTS", { id }));
        }
        state.customerClaims.add(id);
        return ok(true as const);
      },
      releaseClaim: ({ id }) => {
        state.customerClaims.delete(id);
        return ok(true as const);
      },
      get: ({ id }) => ok(state.customers.get(id)),
      save: (customer) => {
        const stored = Customer.parse(customer);
        if (state.customers.has(stored.id)) {
          return err(domainError("CUSTOMER_ALREADY_EXISTS", { id: stored.id }));
        }
        state.customers.set(stored.id, stored);
        state.customerClaims.delete(stored.id);
        return ok(stored);
      },
    }),
    bindPort(CustomerClock, {
      now: () => ok(now()),
    }),
    bindPort(ProductStorage, {
      claim: ({ id }) => {
        if (state.products.has(id) || state.productClaims.has(id)) {
          return err(domainError("PRODUCT_ALREADY_EXISTS", { id }));
        }
        state.productClaims.add(id);
        return ok(true as const);
      },
      releaseClaim: ({ id }) => {
        state.productClaims.delete(id);
        return ok(true as const);
      },
      get: ({ id }) => ok(state.products.get(id)),
      save: (product) => {
        const stored = Product.parse(product);
        if (state.products.has(stored.id)) {
          return err(domainError("PRODUCT_ALREADY_EXISTS", { id: stored.id }));
        }
        state.products.set(stored.id, stored);
        state.productClaims.delete(stored.id);
        return ok(stored);
      },
      reserve: ({ productId, quantity }) => {
        const product = state.products.get(productId);
        if (product === undefined) {
          return err(domainError("PRODUCT_NOT_FOUND", { id: productId }));
        }
        if (product.stock < quantity) {
          return err(domainError("OUT_OF_STOCK", {
            productId,
            requested: quantity,
            available: product.stock,
          }));
        }
        const reserved = Product.parse({
          ...product,
          stock: product.stock - quantity,
        });
        state.products.set(productId, reserved);
        return ok(reserved);
      },
      release: ({ productId, quantity }) => {
        const product = state.products.get(productId);
        if (product === undefined) {
          throw new Error(`Cannot release missing product ${productId}`);
        }
        const released = Product.parse({
          ...product,
          stock: product.stock + quantity,
        });
        state.products.set(productId, released);
        return ok(released);
      },
    }),
    bindPort(ProductClock, {
      now: () => ok(now()),
    }),
    bindPort(Payments, {
      charge: () => {
        const outcome = paymentOutcomes[paymentIndex] ?? "approved";
        paymentIndex += 1;
        return outcome === "declined"
          ? err(domainError("PAYMENT_DECLINED", {}))
          : ok({ status: "approved" as const });
      },
    }),
    bindPort(OrderIds, {
      next: () => ok(nextOrderId()),
    }),
    bindPort(OrderClock, {
      now: () => ok(now()),
    }),
    bindPort(OrderStorage, {
      get: ({ id }) => ok(state.orders.get(id)),
    }),
    bindPort(OrderEvents, {
      commitPaid: ({ order, payment, event }) => {
        const storedOrder = Order.parse(order);
        const storedPayment = Payment.parse(payment);
        const storedEvent = OrderCreatedEvent.parse(event);

        if (state.orders.has(storedOrder.id)) {
          return err(domainError("DUPLICATE_ORDER", { id: storedOrder.id }));
        }

        state.orders.set(storedOrder.id, storedOrder);
        state.payments.set(storedPayment.id, storedPayment);
        state.events.push(storedEvent);
        return ok(storedOrder);
      },
      list: () => ok([...state.events]),
    }),
  ] as const;
};

const commerceBody = async <T>(request: Request): Promise<T> => {
  try {
    return await readJsonBody(request) as T;
  } catch (error: unknown) {
    if (error instanceof HttpInputError) {
      throw new HttpInputError(COMMERCE_ERRORS.validation.message, {
        status: COMMERCE_ERRORS.validation.status,
        code: COMMERCE_ERRORS.validation.code,
      });
    }
    throw error;
  }
};

const domainErrors = {
  CUSTOMER_NOT_FOUND: COMMERCE_ERRORS.customerNotFound,
  PRODUCT_NOT_FOUND: COMMERCE_ERRORS.productNotFound,
  ORDER_NOT_FOUND: COMMERCE_ERRORS.orderNotFound,
  CUSTOMER_ALREADY_EXISTS: COMMERCE_ERRORS.customerExists,
  PRODUCT_ALREADY_EXISTS: COMMERCE_ERRORS.productExists,
  CUSTOMER_SUSPENDED: COMMERCE_ERRORS.customerSuspended,
  OUT_OF_STOCK: COMMERCE_ERRORS.outOfStock,
  PAYMENT_DECLINED: COMMERCE_ERRORS.paymentDeclined,
} as const;

const errorCode = (value: unknown): string | undefined =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  typeof value.code === "string"
    ? value.code
    : undefined;

const failureResponse = (
  error: { readonly status: number; readonly code: string; readonly message: string },
): Response =>
  jsonResponse(
    { ok: false, error: { code: error.code, message: error.message } },
    error.status,
  );

const internalError = (): Response =>
  failureResponse(COMMERCE_ERRORS.internal);

const commerceResponse = (
  result: DispatchResult,
  successStatus: number,
): Response => {
  if (result.kind === "completed") {
    if (result.outcome.ok) {
      return jsonResponse({ ok: true, data: result.outcome.value }, successStatus);
    }
    const code = errorCode(result.outcome.error);
    const known = code === undefined
      ? undefined
      : domainErrors[code as keyof typeof domainErrors];
    return known === undefined ? internalError() : failureResponse(known);
  }
  if (result.kind === "rejected") {
    return result.error.code === "PERMISSION_DENIED"
      ? failureResponse(COMMERCE_ERRORS.forbidden)
      : result.error.code === "INVALID_INPUT"
        ? failureResponse(COMMERCE_ERRORS.validation)
        : internalError();
  }
  return internalError();
};

const responseMapper = (status: number) =>
  (result: DispatchResult): Response => commerceResponse(result, status);

const trustedHeaders = createTrustedHeaderPrincipalExtractor({
  idHeader: COMMERCE_HTTP_CONTRACT.authentication.principalHeader,
  permissionsHeader: COMMERCE_HTTP_CONTRACT.authentication.permissionsHeader,
  separator: COMMERCE_HTTP_CONTRACT.authentication.permissionsSeparator,
});

const commercePrincipal: PrincipalExtractor = async (request) => {
  const resolved = await trustedHeaders(request);
  return resolved ?? { id: "anonymous", permissions: [] } satisfies Principal;
};

const cloneSnapshot = (state: InMemoryState): CommerceSnapshot => ({
  customers: [...state.customers.values()].map((customer) => ({ ...customer })),
  products: [...state.products.values()].map((product) => ({ ...product })),
  orders: [...state.orders.values()].map((order) => ({ ...order })),
  payments: [...state.payments.values()].map((payment) => ({ ...payment })),
  events: state.events.map((event) => ({
    ...event,
    data: { ...event.data },
  })),
});

export const createFrameworkSystem: CommerceSystemFactory = (
  options: CommerceSystemOptions = {},
): CommerceSystem => {
  const state = createState();
  const application = createApplication({
    features: [customers, products, payments, orders],
    adapters: adaptersFor(state, options),
    mode: "test",
  });

  const handler = createHttpHandler({
    application,
    principal: commercePrincipal,
    routes: [
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.createCustomer,
        operation: createCustomer,
        mapRequest: ({ request }) => commerceBody(request),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.createCustomer.successStatus,
        ),
      }),
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.getCustomer,
        operation: getCustomer,
        mapRequest: ({ params }) => ({
          id: (params["id"] ?? "").trim() as Infer<typeof CustomerId>,
        }),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.getCustomer.successStatus,
        ),
      }),
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.createProduct,
        operation: createProduct,
        mapRequest: ({ request }) => commerceBody(request),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.createProduct.successStatus,
        ),
      }),
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.getProduct,
        operation: getProduct,
        mapRequest: ({ params }) => ({
          id: (params["id"] ?? "").trim() as Infer<typeof ProductId>,
        }),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.getProduct.successStatus,
        ),
      }),
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.createOrder,
        operation: createOrder,
        mapRequest: ({ request }) => commerceBody(request),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.createOrder.successStatus,
        ),
      }),
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.getOrder,
        operation: getOrder,
        mapRequest: ({ params }) => ({
          id: (params["id"] ?? "").trim() as Infer<typeof OrderId>,
        }),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.getOrder.successStatus,
        ),
      }),
      defineHttpRoute({
        ...COMMERCE_HTTP_CONTRACT.routes.listEvents,
        operation: listEvents,
        mapRequest: () => ({}),
        mapResponse: responseMapper(
          COMMERCE_HTTP_CONTRACT.routes.listEvents.successStatus,
        ),
      }),
    ],
  });

  return {
    async handle(request) {
      try {
        decodeURI(new URL(request.url).pathname);
      } catch {
        return failureResponse(COMMERCE_ERRORS.validation);
      }
      const response = await handler(request);
      return response.status === 405
        ? failureResponse(COMMERCE_ERRORS.routeNotFound)
        : response;
    },
    async snapshot() {
      return cloneSnapshot(state);
    },
  };
};
