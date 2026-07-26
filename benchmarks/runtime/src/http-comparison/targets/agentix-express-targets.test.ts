import { describe, expect, it } from "vitest";

import { startTarget } from "./registry.js";
import {
  PARAM_ID,
  agentixParamResponse,
  agentixValidResponse,
  invalidResponse,
  paramResponse,
  validResponse,
} from "./shared.js";
import { HTTP_CONDITIONS, HTTP_STACKS } from "../types.js";

const post = (
  origin: string,
  path: string,
  body: string,
): Promise<Response> => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

describe.each(HTTP_CONDITIONS.map((condition) => [condition] as const))(
  "HTTP comparison targets (%s condition)",
  (condition) => {
    it.each(HTTP_STACKS.map((stack) => [stack] as const))(
      "%s serves its per-stack contract from a real loopback server",
      async (stack) => {
        const agentix = stack === "agentix-node";
        const started = await startTarget(stack, condition);
        try {
          expect(started.stack).toBe(stack);
          expect(started.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

          const valid = await post(started.origin, "/echo", JSON.stringify({ value: 7 }));
          expect(valid.status).toBe(200);
          await expect(valid.json()).resolves.toEqual(
            agentix ? agentixValidResponse(7) : validResponse(7),
          );

          for (const body of [
            JSON.stringify({ value: "invalid" }),
            JSON.stringify({ value: 7, extra: true }),
          ]) {
            const invalid = await post(started.origin, "/echo", body);
            expect(invalid.status).toBe(400);
            const parsed = await invalid.json() as {
              ok: boolean;
              error: { code: string };
            };
            if (agentix) {
              expect(parsed.ok).toBe(false);
              expect(parsed.error.code).toBe("INVALID_INPUT");
            } else {
              expect(parsed).toEqual(invalidResponse());
            }
          }

          const malformed = await post(started.origin, "/echo", "{not-json");
          expect(malformed.status).toBe(400);
          const malformedBody = await malformed.json() as {
            ok: boolean;
            error: { code: string };
          };
          if (agentix) {
            expect(malformedBody).toEqual({ ok: false, error: { code: "INVALID_JSON" } });
          } else {
            expect(malformedBody).toEqual(invalidResponse());
          }

          const param = await fetch(`${started.origin}/items/${PARAM_ID}`);
          expect(param.status).toBe(200);
          await expect(param.json()).resolves.toEqual(
            agentix ? agentixParamResponse(PARAM_ID) : paramResponse(PARAM_ID),
          );

          const missing = await post(started.origin, "/missing", "{}");
          expect(missing.status).toBe(404);
        } finally {
          await started.close();
        }
      },
      20_000,
    );
  },
);
