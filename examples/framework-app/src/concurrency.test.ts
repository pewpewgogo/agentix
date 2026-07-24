import {
  COMMERCE_ERRORS,
  COMMERCE_PERMISSIONS,
} from "@agentixdev/shared-contract";
import { associateOperationTest } from "@agentixdev/testing";
import { describe, expect, it } from "vitest";

import { createFrameworkSystem } from "./application.js";
import { createOrder } from "./features/orders/operations.js";

export const createOrderConcurrencyTest = associateOperationTest(
  createOrder,
  "orders.create.concurrency",
);

const request = (
  method: string,
  path: string,
  permission: string,
  body?: unknown,
): Request => new Request(`https://commerce.test${path}`, {
  method,
  headers: {
    "content-type": "application/json",
    "x-principal-id": "concurrency-test",
    "x-permissions": permission,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("order stock reservation", () => {
  it("allows only one concurrent order to consume the last stock item", async () => {
    let orderNumber = 0;
    const system = await createFrameworkSystem({
      now: () => "2040-10-01T00:00:00.000Z",
      orderIds: () => `order-${++orderNumber}`,
    });
    await system.handle(request(
      "POST",
      "/customers",
      COMMERCE_PERMISSIONS.createCustomer,
      { id: "customer-1", name: "Ada" },
    ));
    await system.handle(request(
      "POST",
      "/products",
      COMMERCE_PERMISSIONS.createProduct,
      { id: "product-1", name: "Engine", unitPriceCents: 1_000, stock: 1 },
    ));

    const orderBody = {
      customerId: "customer-1",
      productId: "product-1",
      quantity: 1,
    };
    const responses = await Promise.all([
      system.handle(request(
        "POST",
        "/orders",
        COMMERCE_PERMISSIONS.createOrder,
        orderBody,
      )),
      system.handle(request(
        "POST",
        "/orders",
        COMMERCE_PERMISSIONS.createOrder,
        orderBody,
      )),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const rejected = responses.find(({ status }) => status === 409);
    await expect(rejected?.json()).resolves.toEqual({
      ok: false,
      error: {
        code: COMMERCE_ERRORS.outOfStock.code,
        message: COMMERCE_ERRORS.outOfStock.message,
      },
    });
    expect(await system.snapshot()).toMatchObject({
      products: [{ stock: 0 }],
      orders: [{}],
      payments: [{}],
      events: [{}],
    });
    expect(orderNumber).toBe(1);
  });

  it("releases reserved stock when a later declared effect faults", async () => {
    let clockCalls = 0;
    const system = await createFrameworkSystem({
      now: () => {
        clockCalls += 1;
        if (clockCalls === 3) throw new Error("order clock failed");
        return "2040-10-01T00:00:00.000Z";
      },
      paymentOutcomes: ["approved"],
    });
    await system.handle(request(
      "POST",
      "/customers",
      COMMERCE_PERMISSIONS.createCustomer,
      { id: "customer-1", name: "Ada" },
    ));
    await system.handle(request(
      "POST",
      "/products",
      COMMERCE_PERMISSIONS.createProduct,
      { id: "product-1", name: "Engine", unitPriceCents: 1_000, stock: 2 },
    ));

    const response = await system.handle(request(
      "POST",
      "/orders",
      COMMERCE_PERMISSIONS.createOrder,
      { customerId: "customer-1", productId: "product-1", quantity: 1 },
    ));

    expect(response.status).toBe(COMMERCE_ERRORS.internal.status);
    expect(await system.snapshot()).toMatchObject({
      products: [{ stock: 2 }],
      orders: [],
      payments: [],
      events: [],
    });
  });
});

describe("entity creation claims", () => {
  it("releases a customer claim when a declared clock adapter throws", async () => {
    let calls = 0;
    const system = await createFrameworkSystem({
      now: () => {
        calls += 1;
        if (calls === 1) throw new Error("clock failed");
        return "2040-10-02T00:00:00.000Z";
      },
    });
    const input = { id: "customer-1", name: "Ada" };

    const failed = await system.handle(request(
      "POST",
      "/customers",
      COMMERCE_PERMISSIONS.createCustomer,
      input,
    ));
    expect(failed.status).toBe(COMMERCE_ERRORS.internal.status);

    const retried = await system.handle(request(
      "POST",
      "/customers",
      COMMERCE_PERMISSIONS.createCustomer,
      input,
    ));
    expect(retried.status).toBe(201);
    expect((await system.snapshot()).customers).toHaveLength(1);
  });
});
