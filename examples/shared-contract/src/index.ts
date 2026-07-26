export const COMMERCE_PERMISSIONS = {
  createCustomer: "customers:create",
  readCustomer: "customers:read",
  createProduct: "products:create",
  readProduct: "products:read",
  createOrder: "orders:create",
  readOrder: "orders:read",
  readEvents: "events:read",
} as const;

/**
 * Frozen HTTP error contract shared by both arms (v2 envelope).
 *
 * Transport-level errors (permission, routing, parsing, faults) are OPAQUE:
 * their bodies carry only `error.code`. `INVALID_INPUT` additionally carries a
 * non-empty `error.issues` array whose entries are implementation-defined.
 * Domain errors carry `error.details` objects described per scenario in the
 * acceptance suite.
 */
export const COMMERCE_ERRORS = {
  internal: { status: 500, code: "INTERNAL" },
  forbidden: { status: 403, code: "PERMISSION_DENIED" },
  invalidInput: { status: 400, code: "INVALID_INPUT" },
  invalidJson: { status: 400, code: "INVALID_JSON" },
  routeNotFound: { status: 404, code: "NOT_FOUND" },
  methodNotAllowed: { status: 405, code: "METHOD_NOT_ALLOWED" },
  customerNotFound: { status: 404, code: "CUSTOMER_NOT_FOUND" },
  productNotFound: { status: 404, code: "PRODUCT_NOT_FOUND" },
  orderNotFound: { status: 404, code: "ORDER_NOT_FOUND" },
  customerExists: { status: 409, code: "CUSTOMER_ALREADY_EXISTS" },
  productExists: { status: 409, code: "PRODUCT_ALREADY_EXISTS" },
  customerSuspended: { status: 409, code: "CUSTOMER_SUSPENDED" },
  outOfStock: { status: 409, code: "OUT_OF_STOCK" },
  paymentDeclined: { status: 402, code: "PAYMENT_DECLINED" },
} as const;

export const COMMERCE_HTTP_CONTRACT = {
  authentication: {
    principalHeader: "x-principal-id",
    permissionsHeader: "x-permissions",
    permissionsSeparator: ",",
  },
  routes: {
    createCustomer: {
      method: "POST",
      path: "/customers",
      permission: COMMERCE_PERMISSIONS.createCustomer,
      successStatus: 201,
    },
    getCustomer: {
      method: "GET",
      path: "/customers/:id",
      permission: COMMERCE_PERMISSIONS.readCustomer,
      successStatus: 200,
    },
    createProduct: {
      method: "POST",
      path: "/products",
      permission: COMMERCE_PERMISSIONS.createProduct,
      successStatus: 201,
    },
    getProduct: {
      method: "GET",
      path: "/products/:id",
      permission: COMMERCE_PERMISSIONS.readProduct,
      successStatus: 200,
    },
    createOrder: {
      method: "POST",
      path: "/orders",
      permission: COMMERCE_PERMISSIONS.createOrder,
      successStatus: 201,
    },
    getOrder: {
      method: "GET",
      path: "/orders/:id",
      permission: COMMERCE_PERMISSIONS.readOrder,
      successStatus: 200,
    },
    listEvents: {
      method: "GET",
      path: "/events",
      permission: COMMERCE_PERMISSIONS.readEvents,
      successStatus: 200,
    },
  },
} as const;

export type CustomerStatus = "active" | "suspended";
export type PaymentOutcome = "approved" | "declined";

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly status: CustomerStatus;
  readonly createdAt: string;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly stock: number;
  readonly createdAt: string;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly totalCents: number;
  readonly status: "paid";
  readonly createdAt: string;
}

export interface Payment {
  readonly id: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly status: "approved";
  readonly processedAt: string;
}

export interface OrderCreatedEvent {
  readonly id: string;
  readonly type: "order.created";
  readonly occurredAt: string;
  readonly data: {
    readonly orderId: string;
    readonly customerId: string;
    readonly productId: string;
    readonly quantity: number;
    readonly totalCents: number;
  };
}

export type CommerceEvent = OrderCreatedEvent;

export interface CreateCustomerInput {
  readonly id: string;
  readonly name: string;
  readonly status?: CustomerStatus;
}

export interface CreateProductInput {
  readonly id: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly stock: number;
}

export interface CreateOrderInput {
  readonly customerId: string;
  readonly productId: string;
  readonly quantity: number;
}

/** v2 success envelope: `{ ok: true, value }`. */
export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * v2 error envelope: `{ ok: false, error: { code, ... } }`. Domain errors add
 * `details`; INVALID_INPUT adds `issues`; opaque transport errors add nothing.
 */
export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly details?: unknown;
    readonly issues?: readonly unknown[];
  };
}

export type CommerceEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface CommerceSnapshot {
  readonly customers: readonly Customer[];
  readonly products: readonly Product[];
  readonly orders: readonly Order[];
  readonly payments: readonly Payment[];
  readonly events: readonly CommerceEvent[];
}

export interface CommerceSystemOptions {
  /** Called for successful customer/product creation and successful orders. Defaults to a fixed 2030 instant. */
  readonly now?: () => string;
  /** Called only after an order's payment is approved. Blank IDs are rejected as internal failures. */
  readonly orderIds?: () => string;
  /** Consumed by authorized, valid orders that reach the payment port. */
  readonly paymentOutcomes?: readonly PaymentOutcome[];
}

export interface CommerceSystem {
  handle(request: Request): Promise<Response>;
  snapshot(): Promise<CommerceSnapshot>;
}

export type CommerceSystemFactory = (
  options?: CommerceSystemOptions,
) => CommerceSystem | Promise<CommerceSystem>;
