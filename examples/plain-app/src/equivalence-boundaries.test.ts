import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
} from "@agentix/shared-contract";
import { describe, expect, it, vi } from "vitest";

import { createPlainSystem } from "./system.js";

interface RequestOptions {
  readonly method?: string;
  readonly permission?: string;
  readonly body?: unknown;
}

const request = (
  path: string,
  options: RequestOptions = {},
): Request => {
  const headers = new Headers({
    [COMMERCE_HTTP_CONTRACT.authentication.principalHeader]: "test-user",
    [COMMERCE_HTTP_CONTRACT.authentication.permissionsHeader]:
      options.permission ?? "",
  });
  if (Object.hasOwn(options, "body")) {
    headers.set("content-type", "application/json");
  }
  return new Request(`http://plain.test${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(Object.hasOwn(options, "body")
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
};

const opaqueEnvelope = (error: { readonly code: string }) => ({
  ok: false,
  error: { code: error.code },
});

const createCustomer = (id: string): Request =>
  request(COMMERCE_HTTP_CONTRACT.routes.createCustomer.path, {
    method: COMMERCE_HTTP_CONTRACT.routes.createCustomer.method,
    permission: COMMERCE_HTTP_CONTRACT.routes.createCustomer.permission,
    body: { id, name: "Ada" },
  });

const createProduct = (id: string): Request =>
  request(COMMERCE_HTTP_CONTRACT.routes.createProduct.path, {
    method: COMMERCE_HTTP_CONTRACT.routes.createProduct.method,
    permission: COMMERCE_HTTP_CONTRACT.routes.createProduct.permission,
    body: { id, name: "Engine", unitPriceCents: 2_500, stock: 2 },
  });

describe("plain-app equivalence boundaries", () => {
  it("atomically rejects concurrent duplicate creates before reading the clock", async () => {
    const now = vi.fn(() => "2040-01-01T00:00:00.000Z");
    const system = createPlainSystem({ now });

    const customerResponses = await Promise.all([
      system.handle(createCustomer("customer-1")),
      system.handle(createCustomer("customer-1")),
    ]);
    expect(customerResponses.map(({ status }) => status).sort()).toEqual([
      COMMERCE_HTTP_CONTRACT.routes.createCustomer.successStatus,
      COMMERCE_ERRORS.customerExists.status,
    ]);
    expect(now).toHaveBeenCalledTimes(1);

    const productResponses = await Promise.all([
      system.handle(createProduct("product-1")),
      system.handle(createProduct("product-1")),
    ]);
    expect(productResponses.map(({ status }) => status).sort()).toEqual([
      COMMERCE_HTTP_CONTRACT.routes.createProduct.successStatus,
      COMMERCE_ERRORS.productExists.status,
    ]);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("releases an entity claim when constructing the record throws", async () => {
    const now = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error("clock failed");
      })
      .mockReturnValue("2040-01-01T00:00:00.000Z");
    const system = createPlainSystem({ now });

    expect((await system.handle(createCustomer("customer-1"))).status).toBe(500);
    expect((await system.handle(createCustomer("customer-1"))).status).toBe(
      COMMERCE_HTTP_CONTRACT.routes.createCustomer.successStatus,
    );
  });

  it("rejects an empty generated order ID without changing local state", async () => {
    const now = vi.fn(() => "2040-01-01T00:00:00.000Z");
    const system = createPlainSystem({
      now,
      orderIds: () => "   ",
      paymentOutcomes: ["approved"],
    });
    await system.handle(createCustomer("customer-1"));
    await system.handle(createProduct("product-1"));
    const before = await system.snapshot();

    const response = await system.handle(
      request(COMMERCE_HTTP_CONTRACT.routes.createOrder.path, {
        method: COMMERCE_HTTP_CONTRACT.routes.createOrder.method,
        permission: COMMERCE_HTTP_CONTRACT.routes.createOrder.permission,
        body: {
          customerId: "customer-1",
          productId: "product-1",
          quantity: 1,
        },
      }),
    );

    expect(response.status).toBe(COMMERCE_ERRORS.internal.status);
    await expect(response.json()).resolves.toEqual(
      opaqueEnvelope(COMMERCE_ERRORS.internal),
    );
    expect(await system.snapshot()).toEqual(before);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("trims a valid generated order ID before persistence", async () => {
    const system = createPlainSystem({
      orderIds: () => "  order-1  ",
      paymentOutcomes: ["approved"],
    });
    await system.handle(createCustomer("customer-1"));
    await system.handle(createProduct("product-1"));

    const response = await system.handle(
      request(COMMERCE_HTTP_CONTRACT.routes.createOrder.path, {
        method: COMMERCE_HTTP_CONTRACT.routes.createOrder.method,
        permission: COMMERCE_HTTP_CONTRACT.routes.createOrder.permission,
        body: {
          customerId: "customer-1",
          productId: "product-1",
          quantity: 1,
        },
      }),
    );

    expect(response.status).toBe(
      COMMERCE_HTTP_CONTRACT.routes.createOrder.successStatus,
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      value: { id: "order-1" },
    });
    await expect(system.snapshot()).resolves.toMatchObject({
      orders: [{ id: "order-1" }],
      payments: [{ id: "payment:order-1", orderId: "order-1" }],
      events: [{ id: "event:order.created:order-1" }],
    });
  });

  it("never matches a param route on malformed percent-encoding", async () => {
    const system = createPlainSystem();
    const response = await system.handle(
      request("/customers/%E0%A4%A", {
        permission: COMMERCE_HTTP_CONTRACT.routes.getCustomer.permission,
      }),
    );

    expect(response.status).toBe(COMMERCE_ERRORS.routeNotFound.status);
    await expect(response.json()).resolves.toEqual(
      opaqueEnvelope(COMMERCE_ERRORS.routeNotFound),
    );
  });
});
