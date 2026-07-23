import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createTrustedHeaderPrincipalExtractor,
} from "./auth.js";

describe("bearer principal extraction", () => {
  it("returns null when credentials are absent", async () => {
    const extract = createBearerPrincipalExtractor({
      resolve: async () => ({ id: "unexpected", permissions: [] }),
    });

    await expect(extract(new Request("https://example.test"))).resolves.toBeNull();
  });

  it("delegates token validation to the explicit resolver", async () => {
    const extract = createBearerPrincipalExtractor({
      resolve: async (token, request) => ({
        id: `${request.method}:${token}`,
        permissions: ["orders:create"],
      }),
    });

    await expect(
      extract(
        new Request("https://example.test/orders", {
          method: "POST",
          headers: { authorization: "Bearer signed-token" },
        }),
      ),
    ).resolves.toEqual({
      id: "POST:signed-token",
      permissions: ["orders:create"],
    });
  });

  it("rejects malformed authorization headers", async () => {
    const extract = createBearerPrincipalExtractor({ resolve: async () => null });
    await expect(
      extract(
        new Request("https://example.test", {
          headers: { authorization: "Basic credentials" },
        }),
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("trusted header principal extraction", () => {
  it("extracts an ID and normalized permission list", async () => {
    const extract = createTrustedHeaderPrincipalExtractor();
    const principal = await extract(
      new Request("https://example.test", {
        headers: {
          "x-principal-id": " user-1 ",
          "x-principal-permissions": "orders:create, orders:read, orders:create,",
        },
      }),
    );

    expect(principal).toEqual({
      id: "user-1",
      permissions: ["orders:create", "orders:read"],
    });
  });
});
