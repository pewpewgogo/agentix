import { createServer, type RequestListener, type Server } from "node:http";

import { z } from "zod";

import type { HttpStack, StartedHttpTarget } from "../types.js";

export const VALID_REQUEST = Object.freeze({ value: 7 });
export const INVALID_REQUEST = Object.freeze({ value: "invalid" });
/** Path parameter exercised by the GET /items/:id workload. */
export const PARAM_ID = "42";

/** Conventional-stack (Express/NestJS) envelopes — byte-identical to v1. */
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

export const paramResponse = (id: string): unknown => ({
  ok: true,
  data: { id },
});

/**
 * Agentix v2 envelopes are fixed by the adapter (`{ok:true,value}` /
 * `{ok:false,error:{code,...}}`), so the cross-stack contract is asserted per
 * stack rather than shared byte-for-byte.
 */
export const agentixValidResponse = (value: number): unknown => ({
  ok: true,
  value: { value },
});

export const agentixParamResponse = (id: string): unknown => ({
  ok: true,
  value: { id },
});

export const isEchoInput = (value: unknown): value is { readonly value: number } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  "value" in value &&
  typeof value.value === "number" &&
  Number.isFinite(value.value);

/**
 * "validated"-condition schemas for the conventional stacks: zod input AND
 * output validation, matching the boundary work Agentix always performs.
 */
export const EchoInputZod = z.strictObject({ value: z.number() });
export const EchoOutputZod = z.strictObject({ value: z.number() });
export const ParamInputZod = z.strictObject({ id: z.string().min(1) });
export const ParamOutputZod = z.strictObject({ id: z.string().min(1) });

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
