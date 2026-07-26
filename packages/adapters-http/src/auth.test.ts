import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createTrustedHeaderPrincipalExtractor,
} from "./auth.js";
import type { HttpRequestView } from "./auth.js";

const view = (
  headers: Readonly<Record<string, string>>,
  method = "GET",
  path = "/",
): HttpRequestView => ({
  method,
  path,
  headers: (name) => headers[name.toLowerCase()],
});

describe("bearer principal extraction", () => {
  it("returns null (anonymous) when credentials are absent", async () => {
    const extract = createBearerPrincipalExtractor({
      resolve: async () => ({ id: "unexpected", permissions: [] }),
    });

    await expect(extract(view({}))).resolves.toBeNull();
  });

  it("delegates token validation to the explicit resolver with the view", async () => {
    const extract = createBearerPrincipalExtractor({
      resolve: async (token, request) => ({
        id: `${request.method}:${request.path}:${token}`,
        permissions: ["orders:create"],
      }),
    });

    await expect(
      extract(view({ authorization: "Bearer signed-token" }, "POST", "/orders")),
    ).resolves.toEqual({
      id: "POST:/orders:signed-token",
      permissions: ["orders:create"],
    });
  });

  it("rejects malformed authorization headers", async () => {
    const extract = createBearerPrincipalExtractor({ resolve: async () => null });
    await expect(
      extract(view({ authorization: "Basic credentials" })),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("trusted header principal extraction", () => {
  it("extracts an ID and normalized permission list", async () => {
    const extract = createTrustedHeaderPrincipalExtractor();
    const principal = await extract(
      view({
        "x-principal-id": " user-1 ",
        "x-principal-permissions": "orders:create, orders:read, orders:create,",
      }),
    );

    expect(principal).toEqual({
      id: "user-1",
      permissions: ["orders:create", "orders:read"],
    });
  });

  it("returns null when the trusted id header is absent or blank", async () => {
    const extract = createTrustedHeaderPrincipalExtractor();
    expect(await extract(view({}))).toBeNull();
    expect(await extract(view({ "x-principal-id": "  " }))).toBeNull();
  });

  it("supports custom header names and separators", async () => {
    const extract = createTrustedHeaderPrincipalExtractor({
      idHeader: "x-user",
      permissionsHeader: "x-perms",
      separator: ";",
    });
    expect(await extract(view({ "x-user": "u2", "x-perms": "a;b; a" }))).toEqual({
      id: "u2",
      permissions: ["a", "b"],
    });
  });
});
