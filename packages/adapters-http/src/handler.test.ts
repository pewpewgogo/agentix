import { describe, expect, it } from "vitest";
import {
  createApplication,
  defineCommand,
  defineFeature,
  defineFeatureContract,
  domainError,
  err,
  ok,
  schema,
} from "@agentix/core";

import { createBearerPrincipalExtractor } from "./auth.js";
import { createHttpHandler } from "./handler.js";
import { defineHttpRoute, readJsonBody } from "./route.js";

const GreetingInput = schema.object({ name: schema.string() });
const Greeting = schema.object({ message: schema.string() });

const execution = { count: 0 };

const greet = defineCommand({
  id: "greetings.create",
  input: GreetingInput,
  output: Greeting,
  errors: {
    NAME_BLOCKED: schema.object({ name: schema.string() }),
  },
  permissions: ["greetings:create"],
  effects: {},
  emits: {},
  execute: ({ input }) => {
    execution.count += 1;
    return input.name === "blocked"
      ? err(domainError("NAME_BLOCKED", { name: input.name }))
      : ok({ message: `Hello, ${input.name}.` });
  },
});

const greetings = defineFeature({
  id: "greetings",
  contract: defineFeatureContract({ id: "greetings", exports: { greet } }),
  dependencies: [],
  operations: [greet],
  invariants: [],
});

const route = defineHttpRoute({
  method: "post",
  path: "/greetings",
  operation: greet,
  mapRequest: async ({ request }) =>
    (await readJsonBody(request)) as { name: string },
  responses: {
    successStatus: 201,
    domainErrorStatuses: { NAME_BLOCKED: 409 },
  },
});

const createHandler = () => {
  const application = createApplication({
    features: [greetings],
    adapters: [],
    mode: "test",
  });
  return createHttpHandler({
    application,
    routes: [route],
    principal: createBearerPrincipalExtractor({
      resolve: async (token) =>
        token === "allowed"
          ? { id: "user-1", permissions: ["greetings:create"] }
          : { id: "user-2", permissions: [] },
    }),
  });
};

const request = (token: string | undefined, body: unknown): Request =>
  new Request("https://example.test/greetings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

describe("Web HTTP handler", () => {
  it("maps a successful authorized command to an explicit status", async () => {
    const response = await createHandler()(request("allowed", { name: "Ada" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      value: { message: "Hello, Ada." },
    });
  });

  it("maps typed domain outcomes using the route declaration", async () => {
    const response = await createHandler()(
      request("allowed", { name: "blocked" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "NAME_BLOCKED", details: { name: "blocked" } },
    });
  });

  it("authenticates before dispatch and maps authorization denial", async () => {
    const handler = createHandler();
    const before = execution.count;

    const missing = await handler(request(undefined, { name: "Ada" }));
    expect(missing.status).toBe(401);

    const denied = await handler(request("denied", { name: "Ada" }));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
    expect(execution.count).toBe(before);
  });

  it("rejects unauthorized requests before mapping malformed or absent bodies", async () => {
    let mappedRequests = 0;
    const guardedRoute = defineHttpRoute({
      ...route,
      mapRequest: async ({ request: incoming }) => {
        mappedRequests += 1;
        return (await readJsonBody(incoming)) as { name: string };
      },
    });
    const handler = createHttpHandler({
      application: createApplication({
        features: [greetings],
        adapters: [],
        mode: "test",
      }),
      routes: [guardedRoute],
      principal: async () => ({ id: "denied", permissions: [] }),
    });
    const before = execution.count;

    const malformed = await handler(
      new Request("https://example.test/greetings", {
        method: "POST",
        body: "{",
      }),
    );
    expect(malformed.status).toBe(403);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });

    const absent = await handler(
      new Request("https://example.test/greetings", { method: "POST" }),
    );
    expect(absent.status).toBe(403);
    await expect(absent.json()).resolves.toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
    expect(mappedRequests).toBe(0);
    expect(execution.count).toBe(before);
  });

  it("sends preflight rejection through custom mapping and still dispatches authorized input", async () => {
    let mappedRequests = 0;
    const mappedResults: Array<{
      readonly kind: string;
      readonly code: string | undefined;
    }> = [];
    const customRoute = defineHttpRoute({
      ...route,
      mapRequest: async ({ request: incoming }) => {
        mappedRequests += 1;
        return (await readJsonBody(incoming)) as { name: string };
      },
      mapResponse: (result) => {
        mappedResults.push({
          kind: result.kind,
          code: result.kind === "rejected" ? result.error.code : undefined,
        });
        return new Response(null, {
          status: result.kind === "rejected" ? 418 : 202,
        });
      },
    });
    const handler = createHttpHandler({
      application: createApplication({
        features: [greetings],
        adapters: [],
        mode: "test",
      }),
      routes: [customRoute],
      principal: async (incoming) =>
        incoming.headers.get("authorization") === "Bearer allowed"
          ? { id: "allowed", permissions: ["greetings:create"] }
          : { id: "denied", permissions: [] },
    });
    const before = execution.count;

    const denied = await handler(
      new Request("https://example.test/greetings", { method: "POST" }),
    );
    expect(denied.status).toBe(418);
    expect(mappedRequests).toBe(0);
    expect(mappedResults).toEqual([
      { kind: "rejected", code: "PERMISSION_DENIED" },
    ]);

    const allowed = await handler(request("allowed", { name: "Ada" }));
    expect(allowed.status).toBe(202);
    expect(mappedRequests).toBe(1);
    expect(execution.count).toBe(before + 1);
    expect(mappedResults).toEqual([
      { kind: "rejected", code: "PERMISSION_DENIED" },
      { kind: "completed", code: undefined },
    ]);
  });

  it("maps core input rejection without executing the command", async () => {
    const before = execution.count;
    const response = await createHandler()(
      request("allowed", { name: 42 }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(execution.count).toBe(before);
  });

  it("refuses route descriptors that are not registered by identity", () => {
    const impostor = defineCommand({
      id: greet.id,
      input: GreetingInput,
      output: Greeting,
      errors: {},
      permissions: [],
      effects: {},
      emits: {},
      execute: ({ input }) => ok({ message: input.name }),
    });
    const impostorRoute = defineHttpRoute({
      method: "post",
      path: "/impostor",
      operation: impostor,
      mapRequest: () => ({ name: "impostor" }),
    });
    const application = createApplication({
      features: [greetings],
      adapters: [],
    });

    expect(() => createHttpHandler({ application, routes: [impostorRoute] }))
      .toThrow(/does not use the registered descriptor/);
  });

  it("returns route and method errors before authentication", async () => {
    const handler = createHandler();
    const notFound = await handler(new Request("https://example.test/missing"));
    expect(notFound.status).toBe(404);

    const wrongMethod = await handler(
      new Request("https://example.test/greetings", { method: "GET" }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });

  it("maps invalid JSON and malformed bearer headers", async () => {
    const handler = createHandler();
    const invalidJson = await handler(
      new Request("https://example.test/greetings", {
        method: "POST",
        headers: { authorization: "Bearer allowed" },
        body: "{",
      }),
    );
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON" },
    });

    const malformedAuth = await handler(
      new Request("https://example.test/greetings", {
        method: "POST",
        headers: { authorization: "Basic no" },
        body: "{}",
      }),
    );
    expect(malformedAuth.status).toBe(401);
  });

  it("maps decoded route parameters into operation input", async () => {
    const parameterRoute = defineHttpRoute({
      method: "post",
      path: "/greetings/:name",
      operation: greet,
      mapRequest: ({ params }) => ({ name: params["name"] ?? "" }),
    });
    const handler = createHttpHandler({
      application: createApplication({ features: [greetings], adapters: [] }),
      routes: [parameterRoute],
      anonymousPrincipal: {
        id: "trusted-test",
        permissions: ["greetings:create"],
      },
    });

    const response = await handler(
      new Request("https://example.test/greetings/Grace%20Hopper", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      value: { message: "Hello, Grace Hopper." },
    });
  });
});

describe("route declarations", () => {
  it("rejects invalid paths and duplicate registration", () => {
    expect(() => defineHttpRoute({ ...route, path: "relative" })).toThrow(
      /must start/,
    );
    expect(() =>
      createHttpHandler({
        application: createApplication({ features: [greetings], adapters: [] }),
        routes: [route, route],
      }),
    ).toThrow(/Duplicate HTTP route/);

    const firstParameterized = defineHttpRoute({
      ...route,
      path: "/greetings/:name",
    });
    const sameShape = defineHttpRoute({
      ...route,
      path: "/greetings/:alias",
    });
    expect(() =>
      createHttpHandler({
        application: createApplication({ features: [greetings], adapters: [] }),
        routes: [firstParameterized, sameShape],
      }),
    ).toThrow(/Duplicate HTTP route/);
  });
});
