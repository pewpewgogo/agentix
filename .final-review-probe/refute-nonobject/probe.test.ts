import { describe, expect, it } from "vitest";
import { command, createApplication, feature, s } from "@agentix/core";
import { createHttpHandler } from "@agentix/adapters-http";

const patchFeature = feature("docs", {
  operations: {
    patch: command({
      input: s.object({
        title: s.optional(s.string({ min: 1 })),
        count: s.optional(s.number()),
      }),
      output: s.object({ received: s.string() }),
      http: { method: "PATCH", path: "/opt" },
      async execute({ input }) {
        return { received: JSON.stringify(input) };
      },
    }),
    create: command({
      input: s.object({ id: s.string({ min: 1 }), title: s.string({ min: 1 }) }),
      output: s.object({ id: s.string() }),
      http: { method: "POST", path: "/notes" },
      async execute({ input }) {
        return { id: input.id };
      },
    }),
  },
});

const app = createApplication({ features: [patchFeature], adapters: [], mode: "test" });
const handler = createHttpHandler(app, {});

const req = (path: string, method: string, rawBody: string): Request =>
  new Request(`https://api.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: rawBody,
  });

describe("non-object JSON bodies on object-schema routes", () => {
  for (const raw of ["[1,2]", '"a string"', "42", "true", "null"]) {
    it(`PATCH /opt body=${raw} (all-optional schema)`, async () => {
      const response = await handler.fetch(req("/opt", "PATCH", raw));
      const body = await response.json();
      console.log(`PATCH /opt body=${raw} -> ${response.status} ${JSON.stringify(body)}`);
      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, value: { received: "{}" } });
    });
  }

  it("POST /notes body=[1,2] (required fields) -> issues say fields missing", async () => {
    const response = await handler.fetch(req("/notes", "POST", "[1,2]"));
    const body = await response.json();
    console.log(`POST /notes body=[1,2] -> ${response.status} ${JSON.stringify(body)}`);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("direct dispatch of the same raw value: what does the schema say?", async () => {
    const result = await app.dispatch("docs.patch", { input: [1, 2] as never });
    console.log("dispatch docs.patch input=[1,2] ->", JSON.stringify(result));
  });
});
