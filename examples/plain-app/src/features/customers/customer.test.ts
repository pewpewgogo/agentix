import { describe, expect, it, vi } from "vitest";

import { createPlainSystem } from "../../system.js";

const request = (
  path: string,
  options: {
    readonly method?: string;
    readonly permissions?: string;
    readonly body?: unknown;
  } = {},
): Request =>
  new Request(`http://plain.test${path}`, {
    method: options.method ?? "GET",
    headers: {
      "x-principal-id": "test-user",
      "x-permissions": options.permissions ?? "",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });

describe("customers", () => {
  it("creates and reads a validated customer", async () => {
    const system = createPlainSystem({ now: () => "2040-01-02T03:04:05.000Z" });

    const created = await system.handle(
      request("/customers", {
        method: "POST",
        permissions: "customers:create",
        body: { id: " customer-1 ", name: " Ada ", status: "active" },
      }),
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({
      ok: true,
      value: {
        id: "customer-1",
        name: "Ada",
        status: "active",
        createdAt: "2040-01-02T03:04:05.000Z",
      },
    });

    const found = await system.handle(
      request("/customers/customer-1", { permissions: "customers:read" }),
    );
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({
      ok: true,
      value: { id: "customer-1", status: "active" },
    });
  });

  it("authorizes and validates before touching time or storage", async () => {
    const now = vi.fn(() => "2040-01-02T03:04:05.000Z");
    const system = createPlainSystem({ now });

    const forbidden = await system.handle(
      request("/customers", {
        method: "POST",
        body: { id: "customer-1", name: "Ada" },
      }),
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });

    const invalid = await system.handle(
      request("/customers", {
        method: "POST",
        permissions: "customers:create",
        body: { id: "customer-1", name: " " },
      }),
    );
    expect(invalid.status).toBe(400);
    expect(now).not.toHaveBeenCalled();
    await expect(system.snapshot()).resolves.toMatchObject({ customers: [] });
  });

  it("does not consume time when a customer already exists", async () => {
    const now = vi
      .fn<() => string>()
      .mockReturnValueOnce("2040-01-01T00:00:00.000Z")
      .mockReturnValue("should-not-be-used");
    const system = createPlainSystem({ now });
    const body = { id: "customer-1", name: "Ada" };

    await system.handle(
      request("/customers", {
        method: "POST",
        permissions: "customers:create",
        body,
      }),
    );
    const duplicate = await system.handle(
      request("/customers", {
        method: "POST",
        permissions: "customers:create",
        body,
      }),
    );

    expect(duplicate.status).toBe(409);
    expect(now).toHaveBeenCalledTimes(1);
  });
});
