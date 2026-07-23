import { describe, expect, it } from "vitest";

import type { HttpTarget } from "../types.js";
import { agentixTarget } from "./agentix.js";
import { expressTarget } from "./express.js";
import { invalidResponse, validResponse } from "./shared.js";

const targets: readonly [string, HttpTarget][] = [
  ["Agentix", agentixTarget],
  ["Express", expressTarget],
];

const post = (
  origin: string,
  path: string,
  body: string,
): Promise<Response> => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

describe.each(targets)("%s HTTP comparison target", (_name, target) => {
  it("serves the identical echo contract from a real loopback server", async () => {
    const started = await target.start();
    try {
      expect(started.stack).toBe(target.stack);
      expect(started.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

      const valid = await post(started.origin, "/echo", JSON.stringify({ value: 7 }));
      expect(valid.status).toBe(200);
      await expect(valid.json()).resolves.toEqual(validResponse(7));

      for (const body of [
        JSON.stringify({ value: "invalid" }),
        JSON.stringify({ value: 7, extra: true }),
        "{not-json",
      ]) {
        const invalid = await post(started.origin, "/echo", body);
        expect(invalid.status).toBe(400);
        await expect(invalid.json()).resolves.toEqual(invalidResponse());
      }

      const missing = await post(started.origin, "/missing", "{}");
      expect(missing.status).toBe(404);
    } finally {
      await started.close();
    }
  });
});
