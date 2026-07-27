import { compareStrings as compare } from "./files.js";
import type {
  AgentIndex,
  IndexedOperation,
  SchemaDescription,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* OpenAPI 3.1 generation from the statically analyzed index.         */
/*                                                                    */
/* The document mirrors the HTTP adapter's ACTUAL behavior:           */
/* - routes come from operations' `http` metadata;                    */
/* - the default request mapper contributes path/query keys ONLY for  */
/*   object-shaped inputs, with string->number/boolean coercion       */
/*   (see adapters-http/src/router.ts buildDefaultMapper);            */
/* - every response is the fixed JSON envelope: `{ok:true,value}` on  */
/*   success, `{ok:false,error:{code,...}}` otherwise.                */
/*                                                                    */
/* Runtime-only configuration (defineHttpRoute overrides, custom      */
/* authenticate hooks) is invisible to static analysis; `--bearer`    */
/* and `--health` exist so the app-level choices can be declared.     */
/* ------------------------------------------------------------------ */

export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  /**
   * Declares the app-level bearer authentication choice: adds the
   * `bearerAuth` security scheme, applies it to permissioned operations,
   * and documents their 401/403 responses.
   */
  readonly bearer?: boolean;
  /** Declares the app-level health path (`GET <path>` -> `200 {"ok":true}`). */
  readonly health?: string;
}

export interface OpenApiResult {
  readonly document: Readonly<Record<string, unknown>>;
  /** Deterministic, sorted; non-fatal gaps in static schema knowledge. */
  readonly warnings: readonly string[];
}

type JsonSchema = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* SchemaDescription -> JSON Schema (draft 2020-12, OpenAPI 3.1)      */
/* ------------------------------------------------------------------ */

const isOptional = (description: SchemaDescription): boolean =>
  description.type === "optional";

const unwrapOptional = (description: SchemaDescription): SchemaDescription =>
  description.type === "optional" ? unwrapOptional(description.inner) : description;

export const schemaDescriptionToJsonSchema = (
  description: SchemaDescription,
): JsonSchema => {
  switch (description.type) {
    case "string":
      return {
        type: "string",
        ...(description.min === undefined ? {} : { minLength: description.min }),
        ...(description.max === undefined ? {} : { maxLength: description.max }),
        ...(description.pattern === undefined ? {} : { pattern: description.pattern }),
      };
    case "number":
      return {
        type: description.int === true ? "integer" : "number",
        ...(description.min === undefined ? {} : { minimum: description.min }),
        ...(description.max === undefined ? {} : { maximum: description.max }),
      };
    case "boolean":
      return { type: "boolean" };
    case "literal":
      return { const: description.value };
    case "array":
      return { type: "array", items: schemaDescriptionToJsonSchema(description.item) };
    case "object": {
      const keys = Object.keys(description.fields).sort(compare);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const key of keys) {
        const field = description.fields[key];
        if (field === undefined) continue;
        properties[key] = schemaDescriptionToJsonSchema(unwrapOptional(field));
        if (!isOptional(field)) required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length === 0 ? {} : { required }),
        // Strict objects reject unknown keys at runtime.
        additionalProperties: false,
      };
    }
    case "record":
      return {
        type: "object",
        additionalProperties: schemaDescriptionToJsonSchema(description.value),
      };
    case "tuple":
      return {
        type: "array",
        prefixItems: description.items.map(schemaDescriptionToJsonSchema),
        items: false,
        minItems: description.items.length,
        maxItems: description.items.length,
      };
    case "optional":
      // Standalone optional position: JSON has no undefined; document inner.
      return schemaDescriptionToJsonSchema(description.inner);
    case "union":
      // Runtime unions are first-match (options may overlap): anyOf, not oneOf.
      return { anyOf: description.options.map(schemaDescriptionToJsonSchema) };
    case "refinement":
      // Predicates cannot be expressed structurally; document the base.
      return schemaDescriptionToJsonSchema(description.base);
    case "id":
      return { type: "string", minLength: 1 };
  }
};

/* ------------------------------------------------------------------ */
/* Envelope schemas                                                   */
/* ------------------------------------------------------------------ */

const PERMISSIVE: JsonSchema = {};

const successEnvelope = (value: JsonSchema): JsonSchema => ({
  type: "object",
  required: ["ok", "value"],
  properties: { ok: { const: true }, value },
  additionalProperties: false,
});

const errorEnvelope = (error: JsonSchema): JsonSchema => ({
  type: "object",
  required: ["ok", "error"],
  properties: { ok: { const: false }, error },
  additionalProperties: false,
});

const declaredError = (code: string, details: JsonSchema): JsonSchema => ({
  type: "object",
  required: ["code"],
  properties: { code: { const: code }, details },
  additionalProperties: false,
});

const codeOnlyError = (code: string): JsonSchema => ({
  type: "object",
  required: ["code"],
  properties: { code: { const: code } },
  additionalProperties: false,
});

const jsonResponse = (description: string, schema: JsonSchema): JsonSchema => ({
  description,
  content: { "application/json": { schema } },
});

/* ------------------------------------------------------------------ */
/* Standard response components                                       */
/* ------------------------------------------------------------------ */

const STANDARD_RESPONSES: Readonly<Record<string, JsonSchema>> = {
  BadRequest: jsonResponse(
    "The request body is not valid JSON, or the mapped input failed schema validation.",
    errorEnvelope({
      oneOf: [
        {
          type: "object",
          required: ["code", "issues"],
          properties: {
            code: { const: "INVALID_INPUT" },
            issues: { type: "array", items: { type: "object" } },
          },
          additionalProperties: false,
        },
        codeOnlyError("INVALID_JSON"),
      ],
    }),
  ),
  Internal: jsonResponse(
    "An unexpected fault; the envelope is intentionally opaque.",
    errorEnvelope(codeOnlyError("INTERNAL")),
  ),
  MethodNotAllowed: {
    ...jsonResponse(
      "The path exists but not for this method; `allow` lists the valid methods.",
      errorEnvelope(codeOnlyError("METHOD_NOT_ALLOWED")),
    ),
    headers: { allow: { schema: { type: "string" } } },
  },
  NotFound: jsonResponse(
    "No route matches the request path.",
    errorEnvelope(codeOnlyError("NOT_FOUND")),
  ),
  PermissionDenied: jsonResponse(
    "The principal lacks a required permission (evaluated before the body is read).",
    errorEnvelope(codeOnlyError("PERMISSION_DENIED")),
  ),
  Unauthorized: jsonResponse(
    'Authentication failed (default code "UNAUTHENTICATED").',
    errorEnvelope({
      type: "object",
      required: ["code"],
      properties: { code: { type: "string" } },
      additionalProperties: false,
    }),
  ),
};

const responseRef = (name: string): JsonSchema => ({
  $ref: `#/components/responses/${name}`,
});

/* ------------------------------------------------------------------ */
/* Route helpers                                                      */
/* ------------------------------------------------------------------ */

const normalizePath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

const pathSegments = (path: string): readonly string[] =>
  normalizePath(path) === "/" ? [] : normalizePath(path).slice(1).split("/");

const templatedPath = (path: string): string => {
  const segments = pathSegments(path).map((segment) =>
    segment.startsWith(":") ? `{${segment.slice(1)}}` : segment,
  );
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

const pathParameterNames = (path: string): readonly string[] =>
  pathSegments(path)
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/* ------------------------------------------------------------------ */
/* Per-operation assembly                                             */
/* ------------------------------------------------------------------ */

interface OperationAssembly {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly permissioned: boolean;
}

const assembleOperation = (
  operation: IndexedOperation,
  options: OpenApiOptions,
  warn: (message: string) => void,
): OperationAssembly => {
  const http = operation.http as NonNullable<IndexedOperation["http"]>;
  const inputDescription = operation.input?.description;
  const outputDescription = operation.output?.description;
  const shape = inputDescription?.type === "object" ? inputDescription.fields : undefined;
  if (inputDescription === undefined) {
    warn(`operation ${operation.id}: input schema is not statically evaluable; requestBody/parameters are permissive.`);
  }
  if (outputDescription === undefined) {
    warn(`operation ${operation.id}: output schema is not statically evaluable; the success value is permissive.`);
  }

  // Parameters mirror buildDefaultMapper: only object-shape keys are read
  // from path params and the query string (with number/boolean coercion).
  const parameters: JsonSchema[] = [];
  const pathNames = pathParameterNames(http.path);
  for (const name of pathNames) {
    const field = shape?.[name];
    if (field === undefined && shape !== undefined) {
      warn(`operation ${operation.id}: path parameter ':${name}' is not a key of the input object shape, so the default mapper never maps it.`);
    }
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: field === undefined
        ? { type: "string" }
        : schemaDescriptionToJsonSchema(unwrapOptional(field)),
    });
  }
  const useBody = BODY_METHODS.has(http.method);
  if (!useBody && shape !== undefined) {
    for (const key of Object.keys(shape).sort(compare)) {
      if (pathNames.includes(key)) continue;
      const field = shape[key];
      if (field === undefined) continue;
      parameters.push({
        name: key,
        in: "query",
        required: !isOptional(field),
        schema: schemaDescriptionToJsonSchema(unwrapOptional(field)),
      });
    }
  }

  let requestBody: JsonSchema | undefined;
  if (useBody) {
    const schema = inputDescription === undefined
      ? PERMISSIVE
      : schemaDescriptionToJsonSchema(inputDescription);
    const required = shape === undefined
      ? inputDescription !== undefined
      : Object.entries(shape).some(
          ([key, field]) => !isOptional(field) && !pathNames.includes(key),
        );
    requestBody = {
      required,
      content: { "application/json": { schema } },
    };
  }

  // Responses: declared unified errors first (grouped by status, 422 when a
  // declaration carries no `http`), then the standard envelope shapes for
  // every status the operation did not claim.
  const responses: Record<string, unknown> = {};
  const successStatus = String(http.status ?? 200);
  responses[successStatus] = jsonResponse(
    "The operation completed; `value` is the declared output.",
    successEnvelope(
      outputDescription === undefined
        ? PERMISSIVE
        : outputDescription.type === "optional"
          ? {
              anyOf: [
                schemaDescriptionToJsonSchema(outputDescription.inner),
                { type: "null" },
              ],
            }
          : schemaDescriptionToJsonSchema(outputDescription),
    ),
  );

  const byStatus = new Map<string, { code: string; details?: SchemaDescription; hasDetails: boolean }[]>();
  for (const error of operation.errors) {
    const status = String(error.http ?? 422);
    const group = byStatus.get(status) ?? [];
    if (error.detailsDescription === undefined && error.details !== undefined) {
      warn(`operation ${operation.id}: details schema of error ${error.code} is not statically evaluable; it is documented permissively.`);
    }
    group.push({
      code: error.code,
      ...(error.detailsDescription === undefined ? {} : { details: error.detailsDescription }),
      hasDetails: error.details !== undefined || error.detailsDescription !== undefined,
    });
    byStatus.set(status, group);
  }
  for (const [status, group] of [...byStatus].sort((left, right) => compare(left[0], right[0]))) {
    const members = group
      .sort((left, right) => compare(left.code, right.code))
      .map((entry) =>
        declaredError(
          entry.code,
          entry.details === undefined
            ? entry.hasDetails
              ? PERMISSIVE
              : { type: "object", additionalProperties: false }
            : schemaDescriptionToJsonSchema(entry.details),
        ),
      );
    const schema = members.length === 1 ? members[0] as JsonSchema : { oneOf: members };
    responses[status] = jsonResponse(
      `Declared failure${group.length > 1 ? "s" : ""}: ${group.map(({ code }) => code).sort(compare).join(", ")}.`,
      errorEnvelope(schema),
    );
  }

  const permissioned = operation.permissions.length > 0;
  const standard: [string, string][] = [["400", "BadRequest"]];
  if (options.bearer === true && permissioned) standard.push(["401", "Unauthorized"]);
  if (permissioned) standard.push(["403", "PermissionDenied"]);
  standard.push(["404", "NotFound"], ["405", "MethodNotAllowed"], ["500", "Internal"]);
  for (const [status, name] of standard) {
    if (responses[status] === undefined) responses[status] = responseRef(name);
  }

  const descriptionParts = [
    `Agentix ${operation.kind} \`${operation.id}\`.`,
    ...(permissioned
      ? [`Requires permissions: ${[...operation.permissions].sort(compare).join(", ")}.`]
      : []),
  ];

  return {
    permissioned,
    entry: {
      operationId: operation.id,
      summary: operation.id,
      description: descriptionParts.join(" "),
      ...(operation.feature === undefined ? {} : { tags: [operation.feature] }),
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(requestBody === undefined ? {} : { requestBody }),
      responses,
      ...(options.bearer === true && permissioned
        ? { security: [{ bearerAuth: [] }] }
        : {}),
    },
  };
};

/* ------------------------------------------------------------------ */
/* Document assembly                                                  */
/* ------------------------------------------------------------------ */

export const createOpenApiDocument = (
  index: AgentIndex,
  options: OpenApiOptions = {},
): OpenApiResult => {
  const warnings = new Set<string>();
  const warn = (message: string): void => {
    warnings.add(message);
  };

  const routed = index.operations
    .filter((operation) => operation.http !== undefined)
    .sort(
      (left, right) =>
        compare(templatedPath((left.http as { path: string }).path), templatedPath((right.http as { path: string }).path)) ||
        compare((left.http as { method: string }).method, (right.http as { method: string }).method) ||
        compare(left.id, right.id),
    );

  const paths: Record<string, Record<string, unknown>> = {};
  let anyPermissioned = false;
  for (const operation of routed) {
    const http = operation.http as NonNullable<IndexedOperation["http"]>;
    const pathKey = templatedPath(http.path);
    const methodKey = http.method.toLowerCase();
    const item = paths[pathKey] ?? {};
    if (item[methodKey] !== undefined) {
      warn(`operation ${operation.id}: duplicate route ${http.method} ${pathKey} is omitted from the document.`);
      continue;
    }
    const assembled = assembleOperation(operation, options, warn);
    item[methodKey] = assembled.entry;
    paths[pathKey] = item;
    anyPermissioned ||= assembled.permissioned;
  }

  if (options.health !== undefined) {
    const healthPath = normalizePath(options.health);
    const item = paths[healthPath] ?? {};
    if (item["get"] !== undefined) {
      warn(`health path ${healthPath} conflicts with an existing GET route; the health entry is omitted.`);
    } else {
      item["get"] = {
        summary: "Liveness probe",
        description:
          "Answers without authentication, authorization, or dispatch.",
        responses: {
          "200": jsonResponse("The application is serving requests.", {
            type: "object",
            required: ["ok"],
            properties: { ok: { const: true } },
            additionalProperties: false,
          }),
          "405": responseRef("MethodNotAllowed"),
        },
      };
      paths[healthPath] = item;
    }
  }

  const responseNames = ["BadRequest", "Internal", "MethodNotAllowed", "NotFound"];
  if (anyPermissioned) responseNames.push("PermissionDenied");
  if (options.bearer === true && anyPermissioned) responseNames.push("Unauthorized");
  const responses: Record<string, JsonSchema> = {};
  for (const name of responseNames.sort(compare)) {
    const component = STANDARD_RESPONSES[name];
    if (component !== undefined) responses[name] = component;
  }

  const document = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Agentix application",
      version: options.version ?? "0.0.0",
    },
    paths,
    components: {
      responses,
      ...(options.bearer === true
        ? {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          }
        : {}),
    },
  };
  return { document, warnings: [...warnings].sort(compare) };
};
