import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createCookieLookup,
  createTrustedHeaderPrincipalExtractor,
} from "./auth.js";
import type { HttpRequestView } from "./auth.js";

const view = (
  headers: Readonly<Record<string, string>>,
  method = "GET",
  path = "/",
): HttpRequestView => {
  const lookup = (name: string): string | undefined => headers[name.toLowerCase()];
  return { method, path, headers: lookup, cookie: createCookieLookup(lookup) };
};

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

describe("cookie lookup", () => {
  it("parses multiple cookies with quoting and percent-decoding", () => {
    const cookie = createCookieLookup((name) =>
      name === "cookie"
        ? 'session=abc123; theme="dark"; label=hello%20world; empty='
        : undefined,
    );

    expect(cookie("session")).toBe("abc123");
    expect(cookie("theme")).toBe("dark");
    expect(cookie("label")).toBe("hello world");
    expect(cookie("empty")).toBe("");
    expect(cookie("missing")).toBeUndefined();
  });

  it("returns undefined for everything when the header is absent", () => {
    const cookie = createCookieLookup(() => undefined);
    expect(cookie("session")).toBeUndefined();
    expect(cookie("anything")).toBeUndefined();
  });

  it("skips malformed pairs, keeps first occurrences, tolerates bad encoding", () => {
    const cookie = createCookieLookup((name) =>
      name === "cookie"
        ? "malformed; =nameless; a=1; a=2;   b = spaced ; broken=%zz"
        : undefined,
    );

    expect(cookie("malformed")).toBeUndefined(); // no "="
    expect(cookie("")).toBeUndefined(); // empty name
    expect(cookie("a")).toBe("1"); // first occurrence wins
    expect(cookie("b")).toBe("spaced"); // names and values are trimmed
    expect(cookie("broken")).toBe("%zz"); // malformed encoding kept raw
  });

  it("reads and parses the cookie header at most once", () => {
    let reads = 0;
    const cookie = createCookieLookup((name) => {
      if (name === "cookie") {
        reads += 1;
        return "a=1; b=2";
      }
      return undefined;
    });

    expect(cookie("a")).toBe("1");
    expect(cookie("b")).toBe("2");
    expect(cookie("c")).toBeUndefined();
    expect(reads).toBe(1);
  });
});
