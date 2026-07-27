import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeProject,
  createOpenApiDocument,
  stableJson,
  type AgentIndex,
} from "./index.js";

const fixture = (name: "valid" | "invalid"): string =>
  fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** One analysis of the valid fixture, shared by every test in this file. */
let validIndexCache: AgentIndex | undefined;
const validIndex = (): AgentIndex => {
  validIndexCache ??= analyzeProject({ rootDir: fixture("valid") });
  return validIndexCache;
};

interface JsonObject {
  readonly [key: string]: unknown;
}

const asObject = (value: unknown): JsonObject => {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as JsonObject;
};

/**
 * Cheap structural OpenAPI 3.1 assertions (no external validator): version
 * marker, path shapes, declared path parameters, response statuses and
 * descriptions, resolvable local $refs, and strict-object schemas.
 */
const assertStructurallyValidOpenApi = (documentValue: unknown): void => {
  const document = asObject(documentValue);
  expect(document["openapi"]).toBe("3.1.0");
  const info = asObject(document["info"]);
  expect(typeof info["title"]).toBe("string");
  expect(typeof info["version"]).toBe("string");

  const components = asObject(document["components"]);
  const responses = asObject(components["responses"]);

  // Every object schema must pin additionalProperties (strict objects are
  // the runtime default; records carry a schema-valued additionalProperties).
  const assertSchemas = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) assertSchemas(entry);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as JsonObject;
    if (node["type"] === "object" && node["properties"] !== undefined) {
      expect(node["additionalProperties"]).toBe(false);
    }
    for (const key of Object.keys(node)) assertSchemas(node[key]);
  };

  const paths = asObject(document["paths"]);
  for (const [path, itemValue] of Object.entries(paths)) {
    expect(path.startsWith("/")).toBe(true);
    const templateParameters = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
    const item = asObject(itemValue);
    for (const [method, operationValue] of Object.entries(item)) {
      expect(["get", "post", "put", "patch", "delete"]).toContain(method);
      const operation = asObject(operationValue);
      const parameters = (operation["parameters"] ?? []) as readonly JsonObject[];
      for (const name of templateParameters) {
        const declared = parameters.find(
          (parameter) => parameter["in"] === "path" && parameter["name"] === name,
        );
        expect(declared, `path parameter ${name} of ${path}`).toBeDefined();
        expect(declared?.["required"]).toBe(true);
      }
      for (const parameter of parameters) {
        expect(parameter["schema"]).toBeDefined();
        expect(typeof parameter["name"]).toBe("string");
      }
      const operationResponses = asObject(operation["responses"]);
      expect(Object.keys(operationResponses).length).toBeGreaterThan(0);
      for (const [status, responseValue] of Object.entries(operationResponses)) {
        expect(status).toMatch(/^[1-5]\d\d$/u);
        const response = asObject(responseValue);
        const reference = response["$ref"];
        if (typeof reference === "string") {
          expect(reference).toMatch(/^#\/components\/responses\//u);
          const name = reference.split("/").at(-1) as string;
          expect(responses[name], `unresolved $ref ${reference}`).toBeDefined();
        } else {
          expect(typeof response["description"]).toBe("string");
        }
      }
      assertSchemas(operation);
    }
  }
  assertSchemas(responses);
};

describe("openapi generation", () => {
  it("statically evaluates schema descriptions into the index", () => {
    const index = validIndex();
    const create = index.operations.find(({ id }) => id === "orders.create");
    expect(create?.input?.description).toEqual({
      type: "object",
      fields: {
        amount: { type: "number", min: 0 },
        customerId: { type: "string", min: 1 },
        id: { type: "string", min: 1 },
      },
    });
    expect(create?.declarationText).toContain("create: command({");
    expect(create?.declarationText).toContain("async execute({ input, effects, emit, fail })");
    // Standalone `const create = command(...)` bound by shorthand is re-keyed.
    const customersCreate = index.operations.find(({ id }) => id === "customers.create");
    expect(customersCreate?.declarationText).toMatch(/^create: command\(\{/u);
    // Unified errors carry evaluated details trees; `{http}`-only errors
    // default to the runtime strict empty object.
    const payment = create?.errors.find(({ code }) => code === "PAYMENT_FAILED");
    expect(payment?.detailsDescription).toEqual({
      type: "object",
      fields: { reason: { type: "string" } },
    });
  });

  it("emits a structurally valid, deterministic OpenAPI 3.1 document", () => {
    const index = validIndex();
    const first = createOpenApiDocument(index, { title: "fixture", version: "1.2.3" });
    const second = createOpenApiDocument(index, { title: "fixture", version: "1.2.3" });

    expect(first.warnings).toEqual([]);
    expect(stableJson(first.document)).toBe(stableJson(second.document));
    assertStructurallyValidOpenApi(first.document);

    const document = first.document as {
      paths: Record<string, Record<string, {
        operationId: string;
        requestBody?: { required: boolean; content: Record<string, { schema: Record<string, unknown> }> };
        parameters?: readonly Record<string, unknown>[];
        responses: Record<string, unknown>;
        tags?: readonly string[];
      }>>;
    };
    expect(Object.keys(document.paths)).toEqual(["/customers", "/customers/{id}", "/orders"]);

    const ordersCreate = document.paths["/orders"]?.["post"];
    expect(ordersCreate?.operationId).toBe("orders.create");
    expect(ordersCreate?.tags).toEqual(["orders"]);
    expect(ordersCreate?.requestBody?.required).toBe(true);
    expect(ordersCreate?.requestBody?.content["application/json"]?.schema).toEqual({
      type: "object",
      properties: {
        amount: { type: "number", minimum: 0 },
        customerId: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
      required: ["amount", "customerId", "id"],
      additionalProperties: false,
    });
    // 402 is the declared PAYMENT_FAILED status; CUSTOMER_NOT_FOUND and
    // ORDER_INVALID carry no http status and land on the 422 default. 403
    // is present because the operation is permissioned (even without
    // --bearer, the app-level authorize gate can deny).
    expect(Object.keys(ordersCreate?.responses ?? {})).toEqual([
      "201", "400", "402", "403", "404", "405", "422", "500",
    ]);
    const unified = asObject(asObject(asObject(asObject(asObject(
      ordersCreate?.responses["422"],
    )["content"])["application/json"])["schema"])["properties"])["error"] as {
      oneOf: readonly { properties: { code: { const: string } } }[];
    };
    expect(unified.oneOf.map((entry) => entry.properties.code.const)).toEqual([
      "CUSTOMER_NOT_FOUND",
      "ORDER_INVALID",
    ]);

    const customersGet = document.paths["/customers/{id}"]?.["get"];
    expect(customersGet?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string", minLength: 1 } },
    ]);
    // Declared 404 wins over the standard NotFound reference.
    expect(customersGet?.responses["404"]).not.toEqual({
      $ref: "#/components/responses/NotFound",
    });
  });

  it("applies bearer security to permissioned operations only", () => {
    const index = validIndex();
    const { document } = createOpenApiDocument(index, { bearer: true, health: "/healthz" });
    assertStructurallyValidOpenApi(document);
    const typed = document as {
      paths: Record<string, Record<string, {
        security?: unknown;
        description: string;
        responses: Record<string, unknown>;
      }>>;
      components: { securitySchemes?: Record<string, unknown>; responses: Record<string, unknown> };
    };
    expect(typed.components.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
    });
    const ordersCreate = typed.paths["/orders"]?.["post"];
    expect(ordersCreate?.security).toEqual([{ bearerAuth: [] }]);
    expect(ordersCreate?.description).toContain("Requires permissions: orders:create.");
    expect(ordersCreate?.responses["401"]).toEqual({
      $ref: "#/components/responses/Unauthorized",
    });
    expect(ordersCreate?.responses["403"]).toEqual({
      $ref: "#/components/responses/PermissionDenied",
    });
    expect(typed.paths["/customers"]?.["post"]?.security).toBeUndefined();
    expect(typed.paths["/customers"]?.["post"]?.responses["403"]).toBeUndefined();

    const health = typed.paths["/healthz"]?.["get"] as { responses: Record<string, unknown> } | undefined;
    expect(health).toBeDefined();
    expect(health?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { const: true } },
            additionalProperties: false,
          },
        },
      },
    });
  });

  it("converts record, tuple, union, literal, refinement, and id schemas", () => {
    const temporary = mkdtempSync(join(tmpdir(), "agentix-openapi-"));
    temporaryDirectories.push(temporary);
    mkdirSync(join(temporary, "src/features"), { recursive: true });
    writeFileSync(
      join(temporary, "src/features/widgets.ts"),
      `import { feature, query, s } from "@agentix/core";

export const Widget = s.object({
  id: s.id("widget"),
  count: s.number({ int: true, min: 0 }),
  kind: s.union([s.literal("a"), s.literal("b")]),
  labels: s.record(s.string()),
  pair: s.tuple([s.string(), s.number()]),
  size: s.refine(s.number({ min: 1 }), (value) => value > 0, "positive"),
});

export const widgets = feature("widgets", {
  operations: {
    search: query({
      input: s.object({
        id: s.string({ min: 1 }),
        limit: s.optional(s.number({ int: true })),
        active: s.optional(s.boolean()),
      }),
      output: s.array(Widget),
      http: { method: "GET", path: "/widgets/:id" },
      async execute() {
        return [];
      },
    }),
  },
});
`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });
    const { document, warnings } = createOpenApiDocument(index);
    expect(warnings).toEqual([]);
    assertStructurallyValidOpenApi(document);
    const typed = document as {
      paths: Record<string, Record<string, {
        parameters: readonly Record<string, unknown>[];
        requestBody?: unknown;
        responses: Record<string, { content: Record<string, { schema: {
          properties: { value: { items: { properties: Record<string, unknown> } } };
        } }> }>;
      }>>;
    };
    const search = typed.paths["/widgets/{id}"]?.["get"];
    // Query parameters mirror the default mapper: object-shape keys only,
    // optional fields unwrapped, number/boolean coerced from strings.
    expect(search?.requestBody).toBeUndefined();
    expect(search?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string", minLength: 1 } },
      { name: "active", in: "query", required: false, schema: { type: "boolean" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer" } },
    ]);
    const value = search?.responses["200"]?.content["application/json"]?.schema
      .properties.value as { type: string; items: { properties: Record<string, unknown>; required: readonly string[] } };
    expect(value.type).toBe("array");
    expect(value.items.properties).toEqual({
      count: { type: "integer", minimum: 0 },
      id: { type: "string", minLength: 1 },
      kind: { anyOf: [{ const: "a" }, { const: "b" }] },
      labels: { type: "object", additionalProperties: { type: "string" } },
      pair: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
        minItems: 2,
        maxItems: 2,
      },
      size: { type: "number", minimum: 1 },
    });
    expect(value.items.required).toEqual([
      "count", "id", "kind", "labels", "pair", "size",
    ]);
  });

  it("degrades unevaluable schemas to permissive documents with warnings", () => {
    const temporary = mkdtempSync(join(tmpdir(), "agentix-openapi-"));
    temporaryDirectories.push(temporary);
    mkdirSync(join(temporary, "src/features"), { recursive: true });
    writeFileSync(
      join(temporary, "src/features/dyn.ts"),
      `import { command, feature, s } from "@agentix/core";

const shape = { id: s.string() };
export const Dyn = s.object({ ...shape });

export const dyn = feature("dyn", {
  operations: {
    create: command({
      input: Dyn,
      output: Dyn,
      http: { method: "POST", path: "/dyn" },
      async execute({ input }) {
        return input;
      },
    }),
  },
});
`,
      "utf8",
    );
    const index = analyzeProject({ rootDir: temporary });
    expect(index.operations[0]?.input?.description).toBeUndefined();
    const { document, warnings } = createOpenApiDocument(index);
    assertStructurallyValidOpenApi(document);
    expect(warnings.some((warning) => warning.includes("dyn.create") && warning.includes("input"))).toBe(true);
    const typed = document as {
      paths: Record<string, Record<string, { requestBody: { content: Record<string, { schema: unknown }> } }>>;
    };
    expect(typed.paths["/dyn"]?.["post"]?.requestBody.content["application/json"]?.schema).toEqual({});
  });
});
