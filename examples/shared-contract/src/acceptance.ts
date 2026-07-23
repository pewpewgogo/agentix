import { describe, expect, it } from "vitest";

import {
  COMMERCE_ERRORS,
  COMMERCE_PERMISSIONS,
  type CommerceSnapshot,
  type CommerceSystem,
  type CommerceSystemFactory,
  type Customer,
  type Order,
  type OrderCreatedEvent,
  type Payment,
  type Product,
} from "./index.js";

const TEST_ORIGIN = "https://commerce.test";
const PRINCIPAL_ID = "acceptance-user";

interface RequestOptions {
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly principalId?: string | null;
  readonly permissions?: readonly string[];
}

interface ExpectedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function makeRequest(
  method: string,
  path: string,
  options: RequestOptions = {},
): Request {
  const headers = new Headers();
  const principalId =
    options.principalId === undefined ? PRINCIPAL_ID : options.principalId;
  if (principalId !== null) {
    headers.set("x-principal-id", principalId);
  }
  if (options.permissions !== undefined) {
    headers.set("x-permissions", options.permissions.join(", "));
  }

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    headers.set("content-type", "application/json");
    body = options.rawBody;
  } else if (Object.hasOwn(options, "body")) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  const requestInit: RequestInit =
    body === undefined ? { method, headers } : { method, headers, body };
  return new Request(`${TEST_ORIGIN}${path}`, requestInit);
}

async function send(
  system: CommerceSystem,
  method: string,
  path: string,
  permission: string,
  body?: unknown,
): Promise<Response> {
  return system.handle(
    makeRequest(method, path, {
      ...(body === undefined ? {} : { body }),
      permissions: [permission],
    }),
  );
}

async function expectJson(
  response: Response,
  status: number,
  body: unknown,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  await expect(response.json()).resolves.toEqual(body);
}

async function expectError(
  response: Response,
  expected: ExpectedError,
): Promise<void> {
  await expectJson(response, expected.status, {
    ok: false,
    error: { code: expected.code, message: expected.message },
  });
}

async function createCustomer(
  system: CommerceSystem,
  input: {
    readonly id: string;
    readonly name: string;
    readonly status?: "active" | "suspended";
  },
): Promise<Response> {
  return send(
    system,
    "POST",
    "/customers",
    COMMERCE_PERMISSIONS.createCustomer,
    input,
  );
}

async function createProduct(
  system: CommerceSystem,
  input: {
    readonly id: string;
    readonly name: string;
    readonly unitPriceCents: number;
    readonly stock: number;
  },
): Promise<Response> {
  return send(
    system,
    "POST",
    "/products",
    COMMERCE_PERMISSIONS.createProduct,
    input,
  );
}

async function seedActiveCustomerAndProduct(
  system: CommerceSystem,
  stock = 3,
): Promise<void> {
  expect(
    (await createCustomer(system, {
      id: "customer-1",
      name: "Ada Lovelace",
    })).status,
  ).toBe(201);
  expect(
    (await createProduct(system, {
      id: "product-1",
      name: "Analytical Engine",
      unitPriceCents: 2_500,
      stock,
    })).status,
  ).toBe(201);
}

function success<T>(data: T): { readonly ok: true; readonly data: T } {
  return { ok: true, data };
}

/**
 * Registers the same black-box acceptance scenarios for either commerce app.
 * The suite deliberately imports neither implementation nor framework code.
 */
export function defineCommerceAcceptance(
  name: string,
  factory: CommerceSystemFactory,
): void {
  describe(name, () => {
    it("creates, normalizes, persists, and retrieves customers and products", async () => {
      const timestamps = [
        "2040-01-02T03:04:05.000Z",
        "2040-01-02T03:04:06.000Z",
      ] as const;
      let timestampIndex = 0;
      const system = await factory({
        now: () => timestamps[timestampIndex++] ?? "unexpected-time",
      });

      const customer: Customer = {
        id: "customer-1",
        name: "Ada Lovelace",
        status: "active",
        createdAt: timestamps[0],
      };
      const product: Product = {
        id: "product-1",
        name: "Analytical Engine",
        unitPriceCents: 2_500,
        stock: 0,
        createdAt: timestamps[1],
      };

      await expectJson(
        await createCustomer(system, {
          id: "  customer-1  ",
          name: "  Ada Lovelace  ",
        }),
        201,
        success(customer),
      );
      await expectJson(
        await createProduct(system, {
          id: "  product-1 ",
          name: " Analytical Engine ",
          unitPriceCents: 2_500,
          stock: 0,
        }),
        201,
        success(product),
      );
      await expectJson(
        await send(
          system,
          "GET",
          "/customers/customer-1",
          COMMERCE_PERMISSIONS.readCustomer,
        ),
        200,
        success(customer),
      );
      await expectJson(
        await send(
          system,
          "GET",
          "/customers/%20customer-1%20",
          COMMERCE_PERMISSIONS.readCustomer,
        ),
        200,
        success(customer),
      );
      await expectError(
        await send(
          system,
          "GET",
          "/customers/%20",
          COMMERCE_PERMISSIONS.readCustomer,
        ),
        COMMERCE_ERRORS.validation,
      );
      await expectJson(
        await send(
          system,
          "GET",
          "/products/product-1",
          COMMERCE_PERMISSIONS.readProduct,
        ),
        200,
        success(product),
      );

      expect(await system.snapshot()).toEqual({
        customers: [customer],
        products: [product],
        orders: [],
        payments: [],
        events: [],
      });
    });

    it("enforces runtime validation before state or scripted effects", async () => {
      let nowCalls = 0;
      let orderIdCalls = 0;
      const system = await factory({
        now: () => {
          nowCalls += 1;
          return "2040-02-01T00:00:00.000Z";
        },
        orderIds: () => {
          orderIdCalls += 1;
          return "order-first";
        },
        paymentOutcomes: ["declined"],
      });

      await expectError(
        await createCustomer(system, { id: " ", name: "Ada" }),
        COMMERCE_ERRORS.validation,
      );
      await expectError(
        await system.handle(
          makeRequest("POST", "/products", {
            rawBody: "{not-json",
            permissions: [COMMERCE_PERMISSIONS.createProduct],
          }),
        ),
        COMMERCE_ERRORS.validation,
      );
      await expectError(
        await createProduct(system, {
          id: "product-1",
          name: "Engine",
          unitPriceCents: 0,
          stock: -1,
        }),
        COMMERCE_ERRORS.validation,
      );
      await expectError(
        await send(
          system,
          "POST",
          "/customers",
          COMMERCE_PERMISSIONS.createCustomer,
          { id: "customer-1", name: "Ada", unexpected: true },
        ),
        COMMERCE_ERRORS.validation,
      );
      expect(nowCalls).toBe(0);
      expect(await system.snapshot()).toEqual({
        customers: [],
        products: [],
        orders: [],
        payments: [],
        events: [],
      });

      await seedActiveCustomerAndProduct(system);
      const beforeInvalidOrder = await system.snapshot();
      const nowCallsBeforeOrder = nowCalls;
      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: "customer-1", productId: "product-1", quantity: 1.5 },
        ),
        COMMERCE_ERRORS.validation,
      );
      expect(await system.snapshot()).toEqual(beforeInvalidOrder);
      expect(nowCalls).toBe(nowCallsBeforeOrder);
      expect(orderIdCalls).toBe(0);

      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: "customer-1", productId: "product-1", quantity: 1 },
        ),
        COMMERCE_ERRORS.paymentDeclined,
      );
    });

    it("denies missing principals or permissions before every observable effect", async () => {
      let nowCalls = 0;
      let orderIdCalls = 0;
      const system = await factory({
        now: () => {
          nowCalls += 1;
          return "2040-03-01T00:00:00.000Z";
        },
        orderIds: () => {
          orderIdCalls += 1;
          return "order-first";
        },
        paymentOutcomes: ["declined", "approved"],
      });
      await seedActiveCustomerAndProduct(system);
      const before = await system.snapshot();
      const callsBefore = nowCalls;

      await expectError(
        await system.handle(
          makeRequest("POST", "/orders", {
            body: {
              customerId: "customer-1",
              productId: "product-1",
              quantity: 1,
            },
            principalId: null,
            permissions: [COMMERCE_PERMISSIONS.createOrder],
          }),
        ),
        COMMERCE_ERRORS.forbidden,
      );
      await expectError(
        await system.handle(
          makeRequest("POST", "/orders", {
            body: {
              customerId: "customer-1",
              productId: "product-1",
              quantity: 1,
            },
            permissions: [COMMERCE_PERMISSIONS.readOrder],
          }),
        ),
        COMMERCE_ERRORS.forbidden,
      );
      await expectError(
        await system.handle(
          makeRequest("POST", "/orders", {
            rawBody: "{malformed-json",
            permissions: [COMMERCE_PERMISSIONS.readOrder],
          }),
        ),
        COMMERCE_ERRORS.forbidden,
      );
      await expectError(
        await system.handle(
          makeRequest("POST", "/orders", {
            permissions: [COMMERCE_PERMISSIONS.readOrder],
          }),
        ),
        COMMERCE_ERRORS.forbidden,
      );
      expect(await system.snapshot()).toEqual(before);
      expect(nowCalls).toBe(callsBefore);
      expect(orderIdCalls).toBe(0);

      // If either denied request consumed the payment script, this would approve.
      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: "customer-1", productId: "product-1", quantity: 1 },
        ),
        COMMERCE_ERRORS.paymentDeclined,
      );
      expect(nowCalls).toBe(callsBefore);
      expect(orderIdCalls).toBe(0);
    });

    it("creates a paid order, payment, event, and preserves the cross-feature invariant", async () => {
      const orderTime = "2040-04-05T06:07:08.000Z";
      const system = await factory({
        now: () => orderTime,
        orderIds: () => "order-100",
        paymentOutcomes: ["approved"],
      });
      await seedActiveCustomerAndProduct(system, 3);

      const order: Order = {
        id: "order-100",
        customerId: "customer-1",
        productId: "product-1",
        quantity: 2,
        totalCents: 5_000,
        status: "paid",
        createdAt: orderTime,
      };
      const payment: Payment = {
        id: "payment:order-100",
        orderId: "order-100",
        amountCents: 5_000,
        status: "approved",
        processedAt: orderTime,
      };
      const event: OrderCreatedEvent = {
        id: "event:order.created:order-100",
        type: "order.created",
        occurredAt: orderTime,
        data: {
          orderId: "order-100",
          customerId: "customer-1",
          productId: "product-1",
          quantity: 2,
          totalCents: 5_000,
        },
      };

      await expectJson(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: " customer-1 ", productId: " product-1 ", quantity: 2 },
        ),
        201,
        success(order),
      );
      await expectJson(
        await send(
          system,
          "GET",
          "/orders/order-100",
          COMMERCE_PERMISSIONS.readOrder,
        ),
        200,
        success(order),
      );
      await expectJson(
        await send(
          system,
          "GET",
          "/events",
          COMMERCE_PERMISSIONS.readEvents,
        ),
        200,
        success([event]),
      );

      const snapshot = await system.snapshot();
      expect(snapshot.orders).toEqual([order]);
      expect(snapshot.payments).toEqual([payment]);
      expect(snapshot.events).toEqual([event]);
      expect(snapshot.products).toEqual([
        expect.objectContaining({ id: "product-1", stock: 1 }),
      ]);
      for (const paidOrder of snapshot.orders) {
        expect(
          snapshot.payments.some(
            (candidate) => candidate.orderId === paidOrder.id,
          ),
        ).toBe(true);
      }
    });

    it("rolls back local order effects when payment declines and consumes outcomes in order", async () => {
      let idNumber = 0;
      const system = await factory({
        now: () => "2040-05-01T00:00:00.000Z",
        orderIds: () => `order-${++idNumber}`,
        paymentOutcomes: ["declined", "approved"],
      });
      await seedActiveCustomerAndProduct(system, 2);
      const before = await system.snapshot();

      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: "customer-1", productId: "product-1", quantity: 1 },
        ),
        COMMERCE_ERRORS.paymentDeclined,
      );
      expect(await system.snapshot()).toEqual(before);
      expect(idNumber).toBe(0);

      const approved = await send(
        system,
        "POST",
        "/orders",
        COMMERCE_PERMISSIONS.createOrder,
        { customerId: "customer-1", productId: "product-1", quantity: 1 },
      );
      expect(approved.status).toBe(201);
      expect(await approved.json()).toMatchObject({
        ok: true,
        data: { id: "order-1", status: "paid" },
      });
      expect((await system.snapshot()).products[0]?.stock).toBe(1);
    });

    it("rejects invalid generated order IDs without committing local state", async () => {
      const system = await factory({
        now: () => "2040-05-02T00:00:00.000Z",
        orderIds: () => "   ",
        paymentOutcomes: ["approved"],
      });
      await seedActiveCustomerAndProduct(system, 1);
      const before = await system.snapshot();

      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: "customer-1", productId: "product-1", quantity: 1 },
        ),
        COMMERCE_ERRORS.internal,
      );

      expect(await system.snapshot()).toEqual(before);
    });

    it("rejects suspended customers and insufficient stock before payment", async () => {
      let orderIdCalls = 0;
      const system = await factory({
        now: () => "2040-06-01T00:00:00.000Z",
        orderIds: () => {
          orderIdCalls += 1;
          return "order-1";
        },
        paymentOutcomes: ["declined"],
      });
      await expectJson(
        await createCustomer(system, {
          id: "customer-suspended",
          name: "Grace Hopper",
          status: "suspended",
        }),
        201,
        expect.anything(),
      );
      await expectJson(
        await createCustomer(system, {
          id: "customer-active",
          name: "Ada Lovelace",
          status: "active",
        }),
        201,
        expect.anything(),
      );
      await expectJson(
        await createProduct(system, {
          id: "product-1",
          name: "Engine",
          unitPriceCents: 1_000,
          stock: 1,
        }),
        201,
        expect.anything(),
      );

      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          {
            customerId: "customer-suspended",
            productId: "product-1",
            quantity: 1,
          },
        ),
        COMMERCE_ERRORS.customerSuspended,
      );
      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          {
            customerId: "customer-active",
            productId: "product-1",
            quantity: 2,
          },
        ),
        COMMERCE_ERRORS.outOfStock,
      );
      expect(orderIdCalls).toBe(0);
      expect((await system.snapshot()).products[0]?.stock).toBe(1);

      // The first payment outcome remains unused after both business failures.
      await expectError(
        await send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          {
            customerId: "customer-active",
            productId: "product-1",
            quantity: 1,
          },
        ),
        COMMERCE_ERRORS.paymentDeclined,
      );
    });

    it("returns stable duplicate, missing-resource, route, and event authorization errors", async () => {
      const system = await factory({
        now: () => "2040-07-01T00:00:00.000Z",
      });
      await createCustomer(system, { id: "customer-1", name: "Ada" });
      await createProduct(system, {
        id: "product-1",
        name: "Engine",
        unitPriceCents: 1_000,
        stock: 1,
      });

      await expectError(
        await createCustomer(system, { id: "customer-1", name: "Other" }),
        COMMERCE_ERRORS.customerExists,
      );
      await expectError(
        await createProduct(system, {
          id: "product-1",
          name: "Other",
          unitPriceCents: 1,
          stock: 0,
        }),
        COMMERCE_ERRORS.productExists,
      );
      await expectError(
        await send(
          system,
          "GET",
          "/customers/missing",
          COMMERCE_PERMISSIONS.readCustomer,
        ),
        COMMERCE_ERRORS.customerNotFound,
      );
      await expectError(
        await send(
          system,
          "GET",
          "/products/missing",
          COMMERCE_PERMISSIONS.readProduct,
        ),
        COMMERCE_ERRORS.productNotFound,
      );
      await expectError(
        await send(
          system,
          "GET",
          "/orders/missing",
          COMMERCE_PERMISSIONS.readOrder,
        ),
        COMMERCE_ERRORS.orderNotFound,
      );
      await expectError(
        await system.handle(
          makeRequest("GET", "/events", {
            permissions: [COMMERCE_PERMISSIONS.readOrder],
          }),
        ),
        COMMERCE_ERRORS.forbidden,
      );
      await expectError(
        await system.handle(
          makeRequest("GET", "/unknown", { principalId: null }),
        ),
        COMMERCE_ERRORS.routeNotFound,
      );
      await expectError(
        await system.handle(
          makeRequest("GET", "/customers/%E0%A4%A", {
            permissions: [COMMERCE_PERMISSIONS.readCustomer],
          }),
        ),
        COMMERCE_ERRORS.validation,
      );
    });

    it("does not oversell or create an unmatched payment under concurrent orders", async () => {
      let nextOrder = 0;
      const system = await factory({
        now: () => "2040-07-02T00:00:00.000Z",
        orderIds: () => `order-${++nextOrder}`,
        paymentOutcomes: ["approved", "approved"],
      });
      await seedActiveCustomerAndProduct(system, 1);

      const requests = [1, 2].map(() =>
        send(
          system,
          "POST",
          "/orders",
          COMMERCE_PERMISSIONS.createOrder,
          { customerId: "customer-1", productId: "product-1", quantity: 1 },
        ),
      );
      const responses = await Promise.all(requests);
      expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(bodies).toContainEqual(success(expect.objectContaining({ status: "paid" })));
      expect(bodies).toContainEqual({
        ok: false,
        error: {
          code: COMMERCE_ERRORS.outOfStock.code,
          message: COMMERCE_ERRORS.outOfStock.message,
        },
      });

      const snapshot = await system.snapshot();
      expect(snapshot.products).toEqual([
        expect.objectContaining({ id: "product-1", stock: 0 }),
      ]);
      expect(snapshot.orders).toHaveLength(1);
      expect(snapshot.payments).toHaveLength(1);
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.payments[0]?.orderId).toBe(snapshot.orders[0]?.id);
      expect(nextOrder).toBe(1);
    });

    it("atomically rejects concurrent duplicate customer and product creation", async () => {
      let nowCalls = 0;
      const system = await factory({
        now: () => {
          nowCalls += 1;
          return "2040-07-03T00:00:00.000Z";
        },
      });

      const customerResponses = await Promise.all([
        createCustomer(system, { id: "customer-1", name: "Ada" }),
        createCustomer(system, { id: "customer-1", name: "Ada" }),
      ]);
      expect(customerResponses.map(({ status }) => status).sort()).toEqual([
        201,
        COMMERCE_ERRORS.customerExists.status,
      ]);
      const customerBodies = await Promise.all(
        customerResponses.map((response) => response.json()),
      );
      expect(customerBodies).toContainEqual({
        ok: false,
        error: {
          code: COMMERCE_ERRORS.customerExists.code,
          message: COMMERCE_ERRORS.customerExists.message,
        },
      });

      const productInput = {
        id: "product-1",
        name: "Engine",
        unitPriceCents: 1_000,
        stock: 1,
      } as const;
      const productResponses = await Promise.all([
        createProduct(system, productInput),
        createProduct(system, productInput),
      ]);
      expect(productResponses.map(({ status }) => status).sort()).toEqual([
        201,
        COMMERCE_ERRORS.productExists.status,
      ]);
      const productBodies = await Promise.all(
        productResponses.map((response) => response.json()),
      );
      expect(productBodies).toContainEqual({
        ok: false,
        error: {
          code: COMMERCE_ERRORS.productExists.code,
          message: COMMERCE_ERRORS.productExists.message,
        },
      });

      const snapshot = await system.snapshot();
      expect(snapshot.customers).toHaveLength(1);
      expect(snapshot.products).toHaveLength(1);
      expect(nowCalls).toBe(2);
    });

    it("keeps factories isolated and accepts trimmed comma-separated permissions", async () => {
      const first = await factory({ now: () => "2040-08-01T00:00:00.000Z" });
      const second = await factory({ now: () => "2040-08-01T00:00:00.000Z" });
      await createCustomer(first, { id: "customer-1", name: "Ada" });

      await expectJson(
        await first.handle(
          makeRequest("GET", "/customers/customer-1", {
            permissions: [
              COMMERCE_PERMISSIONS.createProduct,
              COMMERCE_PERMISSIONS.readCustomer,
            ],
          }),
        ),
        200,
        expect.objectContaining({ ok: true }),
      );
      expect((await first.snapshot()).customers).toHaveLength(1);
      expect((await second.snapshot()).customers).toHaveLength(0);
    });

    it("returns detached snapshots whose records cannot mutate system state", async () => {
      const system = await factory({ now: () => "2040-09-01T00:00:00.000Z" });
      await createCustomer(system, { id: "customer-1", name: "Ada" });
      const snapshot = (await system.snapshot()) as {
        customers: Array<{ name: string }>;
      } & CommerceSnapshot;
      snapshot.customers[0]!.name = "Mutated outside";
      snapshot.customers.length = 0;

      expect((await system.snapshot()).customers).toEqual([
        expect.objectContaining({ id: "customer-1", name: "Ada" }),
      ]);
    });
  });
}
