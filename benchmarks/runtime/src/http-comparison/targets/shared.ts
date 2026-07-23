import { createServer, type RequestListener, type Server } from "node:http";

import type { HttpStack, StartedHttpTarget } from "../types.js";

export const VALID_REQUEST = Object.freeze({ value: 7 });
export const INVALID_REQUEST = Object.freeze({ value: "invalid" });

export const validResponse = (value: number): unknown => ({
  ok: true,
  data: { value },
});

export const invalidResponse = (): unknown => ({
  ok: false,
  error: {
    code: "VALIDATION_ERROR",
    message: "Request body is invalid.",
  },
});

export const isEchoInput = (value: unknown): value is { readonly value: number } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  "value" in value &&
  typeof value.value === "number" &&
  Number.isFinite(value.value);

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("HTTP comparison server returned no TCP address."));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error === undefined ? resolve() : reject(error));
  });

export const startNodeTarget = async (
  stack: HttpStack,
  listener: RequestListener,
): Promise<StartedHttpTarget> => {
  const server = createServer(listener);
  const port = await listen(server);
  return Object.freeze({
    stack,
    origin: `http://127.0.0.1:${port}`,
    close: () => close(server),
  });
};
