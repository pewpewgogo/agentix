import { describe, expect, it } from "vitest";

import { TEST_PRINCIPAL_HEADER, testHttp } from "./http.js";

const json = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

/** Tiny inline fake handler exposing the structural `{ fetch }` entry. */
const handler = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    if (key === "GET /ping") {
      return json({
        ok: true,
        auth: request.headers.get("authorization"),
      });
    }
    if (key === "POST /echo") {
      const body: unknown = await request.json();
      return json(
        {
          received: body,
          contentType: request.headers.get("content-type"),
          principal: request.headers.get(TEST_PRINCIPAL_HEADER),
        },
        { status: 201, headers: { "x-test": "yes" } },
      );
    }
    if (key === "DELETE /gone") {
      return new Response(null, { status: 204 });
    }
    if (key === "GET /plain") {
      return new Response("not json", { status: 200 });
    }
    return json({ error: "not found" }, { status: 404 });
  },
};

describe("testHttp", () => {
  it("drives GET requests and applies bearer tokens", async () => {
    const client = testHttp(handler);
    const response = await client.get("/ping", { token: "t-1" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, auth: "Bearer t-1" });
  });

  it("keeps explicit authorization headers over token sugar", async () => {
    const client = testHttp(handler);
    const response = await client.get("/ping", {
      headers: { authorization: "custom-scheme abc" },
      token: "ignored",
    });
    expect(response.body).toEqual({ ok: true, auth: "custom-scheme abc" });
  });

  it("posts JSON bodies and serializes principals into the test header", async () => {
    const client = testHttp(handler);
    const principal = { id: "u1", permissions: ["notes:write"] };
    const response = await client.post("/echo", { hello: "world" }, { principal });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(response.body).toEqual({
      received: { hello: "world" },
      contentType: "application/json",
      principal: JSON.stringify(principal),
    });
  });

  it("returns undefined bodies for empty and non-JSON responses", async () => {
    const client = testHttp(handler);
    const gone = await client.delete("/gone");
    expect(gone.status).toBe(204);
    expect(gone.body).toBeUndefined();
    expect(gone.text).toBe("");

    const plain = await client.get("/plain");
    expect(plain.body).toBeUndefined();
    expect(plain.text).toBe("not json");
  });

  it("supports raw requests with method normalization and 404 routes", async () => {
    const client = testHttp(handler);
    const response = await client.request({ method: "put", path: "/missing" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not found" });

    const patched = await client.patch("/missing", { any: true });
    expect(patched.status).toBe(404);
  });
});
