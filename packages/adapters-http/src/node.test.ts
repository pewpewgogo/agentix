import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createNodeHttpListener } from "./node.js";

const listen = async (
  handler: (request: Request) => Promise<Response>,
  options: Parameters<typeof createNodeHttpListener>[1] = {},
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> => {
  const server = createServer(createNodeHttpListener(handler, options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
};

describe("Node HTTP host", () => {
  it("adapts request method, URL, headers, body, status, and response body", async () => {
    const host = await listen(async (request) => {
      const body = await request.text();
      return new Response(
        JSON.stringify({
          method: request.method,
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body,
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });

    try {
      const response = await fetch(`${host.origin}/orders`, {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "text/plain",
        },
        body: "payload",
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        method: "POST",
        path: "/orders",
        authorization: "Bearer token",
        body: "payload",
      });
    } finally {
      await host.close();
    }
  });

  it("rejects bodies beyond the configured buffer limit", async () => {
    const host = await listen(async () => new Response("unexpected"), {
      maxBodyBytes: 3,
    });
    try {
      const response = await fetch(`${host.origin}/orders`, {
        method: "POST",
        body: "four",
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "REQUEST_BODY_TOO_LARGE" },
      });
    } finally {
      await host.close();
    }
  });
});
