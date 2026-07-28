import type {
  AnyBoundOperation,
  HttpMethod,
  Schema,
  SchemaDescription,
} from "@agentixdev/core";

export type Awaitable<T> = T | Promise<T>;

/** Shared empty params record (null prototype, frozen). */
export const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze(
  Object.create(null),
) as Readonly<Record<string, string>>;

/** Context handed to custom `mapRequest` overrides. Body is already parsed JSON. */
export interface HttpRequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly headers: (name: string) => string | undefined;
}

/** Route override created by defineHttpRoute (the custom-mapping escape hatch). */
export interface HttpRouteOverride<
  Operation extends AnyBoundOperation = AnyBoundOperation,
> {
  readonly kind: "http-route";
  readonly method: HttpMethod;
  readonly path: string;
  readonly operation: Operation;
  /** Success status; defaults to the operation's http.status, then 200. */
  readonly status?: number;
  /** Per-error status overrides merged over the descriptor's derived errorStatus. */
  readonly errorStatus?: Readonly<Record<string, number>>;
  readonly mapRequest?: (context: HttpRequestContext) => Awaitable<unknown>;
}

export type RouteSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

/** Precompiled default input builder: merge body + query + params per input shape. */
export type BuildInput = (
  params: Readonly<Record<string, string>>,
  query: string,
  body: unknown,
) => unknown;

export interface CompiledRoute {
  readonly method: HttpMethod;
  /** Normalized authored path (trailing slash stripped). */
  readonly path: string;
  readonly operation: AnyBoundOperation;
  readonly operationId: string;
  readonly successStatus: number;
  /** Per-error-code HTTP status (derived from unified error declarations). */
  readonly errorStatus: Readonly<Record<string, number>>;
  readonly segments: readonly RouteSegment[];
  readonly paramCount: number;
  readonly staticSegmentCount: number;
  readonly buildInput: BuildInput;
  /** Present only for override routes with a custom mapRequest. */
  readonly mapRequest?: (context: HttpRequestContext) => Awaitable<unknown>;
}

export interface RouteBucket {
  readonly staticRoutes: ReadonlyMap<string, CompiledRoute>;
  /** Sorted: more static segments first, fewer params next, then path order. */
  readonly paramRoutes: readonly CompiledRoute[];
}

export interface CompiledRouteTable {
  readonly routes: readonly CompiledRoute[];
  readonly buckets: ReadonlyMap<string, RouteBucket>;
}

export type MatchResult =
  | {
      readonly kind: "matched";
      readonly route: CompiledRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: "method_not_allowed"; readonly allow: string }
  | { readonly kind: "not_found" };

/* ------------------------------------------------------------------ */
/* Path helpers                                                       */
/* ------------------------------------------------------------------ */

/** Validates a route path and strips the trailing slash (except for "/"). */
export const normalizeRoutePath = (path: string): string => {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`HTTP route path ${JSON.stringify(path)} must start with "/"`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new TypeError("An HTTP route path cannot include a query or fragment");
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
};

const normalizeRequestPath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

const splitPath = (path: string): readonly string[] =>
  path === "/" ? [] : path.slice(1).split("/");

/* ------------------------------------------------------------------ */
/* Schema-aware coercion for path params and query values             */
/* ------------------------------------------------------------------ */

const identity = (value: string): unknown => value;

const coerceNumber = (value: string): unknown => {
  if (value === "") return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
};

const coerceBoolean = (value: string): unknown =>
  value === "true" ? true : value === "false" ? false : value;

const coercerFor = (description: SchemaDescription): ((value: string) => unknown) => {
  let unwrapped = description;
  for (;;) {
    if (unwrapped.type === "optional") unwrapped = unwrapped.inner;
    else if (unwrapped.type === "refinement") unwrapped = unwrapped.base;
    else break;
  }
  if (unwrapped.type === "number") return coerceNumber;
  if (unwrapped.type === "boolean") return coerceBoolean;
  if (unwrapped.type === "literal" && typeof unwrapped.value === "number") {
    return coerceNumber;
  }
  if (unwrapped.type === "literal" && typeof unwrapped.value === "boolean") {
    return coerceBoolean;
  }
  return identity;
};

const shapeOf = (
  schema: Schema<unknown>,
): Readonly<Record<string, Schema<unknown>>> | null => {
  if (schema.description.type !== "object") return null;
  const shape = (schema as { readonly shape?: unknown }).shape;
  return typeof shape === "object" && shape !== null
    ? (shape as Readonly<Record<string, Schema<unknown>>>)
    : null;
};

interface ShapeField {
  readonly key: string;
  readonly coerce: (value: string) => unknown;
}

const isPlainObjectBody = (body: unknown): body is Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

const buildDefaultMapper = (input: Schema<unknown>): BuildInput => {
  const shape = shapeOf(input);
  if (shape === null) {
    return (_params, _query, body) => body;
  }
  const fields: readonly ShapeField[] = Object.keys(shape).map((key) => {
    const field = shape[key];
    return {
      key,
      coerce: field === undefined ? identity : coercerFor(field.description),
    };
  });
  return (params, query, body) => {
    // A present non-object JSON body ([1,2], "str", 42, true, null) must not
    // be silently discarded: hand it to the object schema verbatim so the
    // request rejects with a proper invalid-type INVALID_INPUT (400).
    if (body !== undefined && !isPlainObjectBody(body)) return body;
    const merged = Object.create(null) as Record<string, unknown>;
    if (isPlainObjectBody(body)) {
      for (const key of Object.keys(body)) merged[key] = body[key];
    }
    if (query !== "") {
      const search = new URLSearchParams(query);
      for (const field of fields) {
        const value = search.get(field.key);
        if (value !== null) merged[field.key] = field.coerce(value);
      }
    }
    if (params !== EMPTY_PARAMS) {
      for (const field of fields) {
        const value = params[field.key];
        if (value !== undefined) merged[field.key] = field.coerce(value);
      }
    }
    return merged;
  };
};

/** Parses a raw query string into a first-value-wins record. */
export const queryRecord = (query: string): Readonly<Record<string, string>> => {
  if (query === "") return EMPTY_PARAMS;
  const record = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URLSearchParams(query)) {
    if (record[key] === undefined) record[key] = value;
  }
  return record;
};

/* ------------------------------------------------------------------ */
/* Compilation                                                        */
/* ------------------------------------------------------------------ */

interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operation: AnyBoundOperation;
  readonly status?: number | undefined;
  readonly errorStatus?: Readonly<Record<string, number>> | undefined;
  readonly mapRequest?: ((context: HttpRequestContext) => Awaitable<unknown>) | undefined;
}

const EMPTY_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze(
  Object.create(null),
) as Readonly<Record<string, number>>;

const compileRoute = (definition: RouteDefinition): CompiledRoute => {
  const path = normalizeRoutePath(definition.path);
  const parts = splitPath(path);
  const segments: RouteSegment[] = [];
  const paramNames = new Set<string>();
  let staticSegmentCount = 0;
  for (const part of parts) {
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (name.length === 0) {
        throw new TypeError(`HTTP route ${path} has an unnamed parameter`);
      }
      if (paramNames.has(name)) {
        throw new TypeError(`HTTP route ${path} repeats parameter ${JSON.stringify(name)}`);
      }
      paramNames.add(name);
      segments.push({ kind: "param", name });
    } else {
      staticSegmentCount += 1;
      segments.push({ kind: "literal", value: part });
    }
  }
  const mapRequest = definition.mapRequest;
  return Object.freeze({
    method: definition.method,
    path,
    operation: definition.operation,
    operationId: definition.operation.id,
    successStatus: definition.status ?? 200,
    errorStatus: definition.errorStatus ?? EMPTY_ERROR_STATUS,
    segments: Object.freeze(segments),
    paramCount: paramNames.size,
    staticSegmentCount,
    buildInput: buildDefaultMapper(definition.operation.input),
    ...(mapRequest === undefined ? {} : { mapRequest }),
  });
};

const routeShapeIdentity = (route: CompiledRoute): string => {
  const shape = route.segments
    .map((segment) => (segment.kind === "param" ? ":" : segment.value))
    .join("/");
  return `${route.method} /${shape}`;
};

const byPrecedence = (a: CompiledRoute, b: CompiledRoute): number =>
  b.staticSegmentCount - a.staticSegmentCount ||
  a.paramCount - b.paramCount ||
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Builds the method-bucketed route table. Routes are auto-derived from
 * operations' `http` metadata; overrides replace ALL auto routes of the
 * operations they reference and are added on top.
 */
export const compileRouteTable = (
  operations: Iterable<AnyBoundOperation>,
  overrides: readonly HttpRouteOverride[] = [],
): CompiledRouteTable => {
  const overriddenOperations = new Set<AnyBoundOperation>();
  for (const override of overrides) overriddenOperations.add(override.operation);

  const routes: CompiledRoute[] = [];
  for (const operation of operations) {
    const http = operation.http;
    if (http === undefined || overriddenOperations.has(operation)) continue;
    routes.push(
      compileRoute({
        method: http.method,
        path: http.path,
        operation,
        status: http.status,
        errorStatus: http.errorStatus,
      }),
    );
  }
  for (const override of overrides) {
    const base = override.operation.http?.errorStatus;
    const merged =
      override.errorStatus === undefined
        ? base
        : Object.freeze({ ...(base ?? {}), ...override.errorStatus });
    routes.push(
      compileRoute({
        method: override.method,
        path: override.path,
        operation: override.operation,
        status: override.status ?? override.operation.http?.status,
        errorStatus: merged,
        mapRequest: override.mapRequest,
      }),
    );
  }

  const identities = new Set<string>();
  const buckets = new Map<string, { staticRoutes: Map<string, CompiledRoute>; paramRoutes: CompiledRoute[] }>();
  for (const route of routes) {
    const identity = routeShapeIdentity(route);
    if (identities.has(identity)) {
      throw new TypeError(`Duplicate HTTP route ${route.method} ${route.path}`);
    }
    identities.add(identity);
    let bucket = buckets.get(route.method);
    if (bucket === undefined) {
      bucket = { staticRoutes: new Map(), paramRoutes: [] };
      buckets.set(route.method, bucket);
    }
    if (route.paramCount === 0) bucket.staticRoutes.set(route.path, route);
    else bucket.paramRoutes.push(route);
  }
  for (const bucket of buckets.values()) bucket.paramRoutes.sort(byPrecedence);

  return Object.freeze({ routes: Object.freeze(routes), buckets });
};

/* ------------------------------------------------------------------ */
/* Matching                                                           */
/* ------------------------------------------------------------------ */

/**
 * Matches a param route against pre-split request segments. Param segments
 * are percent-decoded; malformed encoding skips THIS candidate (returns
 * null) instead of aborting the request. Literal segments compare raw first
 * and fall back to their decoded form.
 */
const matchParamRoute = (
  route: CompiledRoute,
  segments: readonly string[],
): Readonly<Record<string, string>> | null => {
  const pattern = route.segments;
  if (pattern.length !== segments.length) return null;
  let params: Record<string, string> | null = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    const actual = segments[index];
    if (part === undefined || actual === undefined) return null;
    const encoded = actual.indexOf("%") !== -1;
    if (part.kind === "literal") {
      if (part.value === actual) continue;
      if (!encoded) return null;
      try {
        if (part.value !== decodeURIComponent(actual)) return null;
      } catch {
        return null; // malformed encoding: skip this candidate
      }
    } else {
      let decoded = actual;
      if (encoded) {
        try {
          decoded = decodeURIComponent(actual);
        } catch {
          return null; // malformed encoding: skip this candidate
        }
      }
      (params ??= Object.create(null) as Record<string, string>)[part.name] = decoded;
    }
  }
  return params ?? EMPTY_PARAMS;
};

/** Decodes each raw segment for a second-chance static lookup. */
const decodedStaticKey = (segments: readonly string[]): string | null => {
  let key = "";
  for (const segment of segments) {
    let decoded = segment;
    if (segment.indexOf("%") !== -1) {
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (decoded.includes("/")) return null; // would alter path boundaries
    }
    key += `/${decoded}`;
  }
  return key === "" ? "/" : key;
};

const bucketMatches = (
  bucket: RouteBucket,
  path: string,
  segments: readonly string[],
): boolean => {
  if (bucket.staticRoutes.has(path)) return true;
  // Mirror the primary matcher: percent-encoded static paths get a
  // decoded-segment second chance so wrong-method requests still get 405.
  if (path.indexOf("%") !== -1 && bucket.staticRoutes.size > 0) {
    const decodedKey = decodedStaticKey(segments);
    if (decodedKey !== null && bucket.staticRoutes.has(decodedKey)) return true;
  }
  for (const route of bucket.paramRoutes) {
    if (matchParamRoute(route, segments) !== null) return true;
  }
  return false;
};

/**
 * Deterministic precedence: static routes first (raw lookup, then a
 * decoded-segment second chance), then param routes in compiled order.
 * The 405 Allow set is computed lazily, only when nothing matched.
 */
export const matchRoute = (
  table: CompiledRouteTable,
  method: string,
  rawPath: string,
): MatchResult => {
  const path = normalizeRequestPath(rawPath);
  const bucket = table.buckets.get(method);
  let segments: readonly string[] | null = null;

  if (bucket !== undefined) {
    const staticRoute = bucket.staticRoutes.get(path);
    if (staticRoute !== undefined) {
      return { kind: "matched", route: staticRoute, params: EMPTY_PARAMS };
    }
    if (path.indexOf("%") !== -1 && bucket.staticRoutes.size > 0) {
      segments = splitPath(path);
      const decodedKey = decodedStaticKey(segments);
      if (decodedKey !== null) {
        const decodedRoute = bucket.staticRoutes.get(decodedKey);
        if (decodedRoute !== undefined) {
          return { kind: "matched", route: decodedRoute, params: EMPTY_PARAMS };
        }
      }
    }
    if (bucket.paramRoutes.length > 0) {
      segments ??= splitPath(path);
      for (const route of bucket.paramRoutes) {
        const params = matchParamRoute(route, segments);
        if (params !== null) return { kind: "matched", route, params };
      }
    }
  }

  // Lazy 405: check whether any OTHER method has a route for this path.
  let allow: string[] | null = null;
  for (const [name, other] of table.buckets) {
    if (name === method) continue;
    segments ??= splitPath(path);
    if (bucketMatches(other, path, segments)) (allow ??= []).push(name);
  }
  if (allow === null) return { kind: "not_found" };
  return { kind: "method_not_allowed", allow: allow.sort().join(", ") };
};
