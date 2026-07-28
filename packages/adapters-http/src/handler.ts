import type {
  AnyBoundOperation,
  Application,
  DispatchResult,
  Principal,
} from "@agentixdev/core";

import { AuthenticationError, createCookieLookup } from "./auth.js";
import type { HttpRequestView, PrincipalExtractor } from "./auth.js";
import {
  compileRouteTable,
  matchRoute,
  normalizeRoutePath,
  queryRecord,
} from "./router.js";
import type {
  CompiledRoute,
  CompiledRouteTable,
  HttpRouteOverride,
} from "./router.js";

/* ------------------------------------------------------------------ */
/* Runtime-neutral request/response model (shared by BOTH entries)    */
/* ------------------------------------------------------------------ */

/**
 * Host-agnostic request consumed by handler.handle(); no undici types.
 * The handler derives the authentication view (with its lazy `cookie`
 * accessor) itself — hosts only supply the raw header lookup.
 */
export interface HandlerRequest {
  readonly method: string;
  /** Percent-encoded pathname (no query string). */
  readonly path: string;
  /** Case-insensitive single-value header lookup. */
  readonly headers: (name: string) => string | undefined;
  /** Raw query string without the leading "?" ("" when absent). */
  readonly query: string;
  /**
   * Deferred body read (UTF-8 text, undefined when absent). Called AFTER
   * authorization so 403 responses never touch the body. May throw
   * RequestBodyLimitError to answer 413.
   */
  readonly readBody: () => Promise<string | undefined>;
  /**
   * Aborts when the client goes away (socket closed, fetch aborted). Passed
   * to dispatch as its cancellation signal; hosts must not write aborted
   * responses.
   */
  readonly signal?: AbortSignal;
}

export interface HandlerResponse {
  readonly status: number;
  /** Serialized JSON envelope. */
  readonly body: string;
  /** Extra headers (e.g. `allow` on 405). Content-type is always JSON. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Thrown by host body readers when the configured byte cap is exceeded. */
export class RequestBodyLimitError extends Error {
  constructor(message = "The request body is too large.") {
    super(message);
    this.name = "RequestBodyLimitError";
  }
}

export interface HttpErrorInfo {
  readonly method: string;
  readonly path: string;
  /** Correlation id of the failing request (also echoed as `x-request-id`). */
  readonly requestId: string;
  readonly operationId?: string;
}

/** Observability hook for faults and unexpected adapter errors (500s + 413s excluded). */
export type HttpErrorObserver = (error: unknown, info: HttpErrorInfo) => void;

/** CORS configuration; presence enables preflight answers + response headers. */
export interface CorsOptions {
  /** Exact origins to allow, or "*" for every origin. */
  readonly origins: readonly string[] | "*";
  /** Preflight `access-control-allow-methods`; defaults to the app's route methods. */
  readonly methods?: readonly string[];
  /** Preflight `access-control-allow-headers`; defaults to echoing the request. */
  readonly headers?: readonly string[];
  /** Sets `access-control-allow-credentials: true` (origin is then echoed, never "*"). */
  readonly credentials?: boolean;
  /** Preflight `access-control-max-age`, in seconds. */
  readonly maxAgeSeconds?: number;
}

export interface ResponseHeadersContext {
  /** Present when a route matched. */
  readonly operationId?: string;
  readonly status: number;
  readonly requestId: string;
}

/**
 * Extra response headers (Set-Cookie etc.) merged onto every envelope
 * response. `content-type`, `content-length`, and `x-request-id` are
 * protected and cannot be overridden.
 */
export type ResponseHeadersHook = (
  context: ResponseHeadersContext,
) => Record<string, string> | undefined;

export interface CreateHttpHandlerOptions {
  /** Opt-in authentication; absent means every request is anonymous. */
  readonly authenticate?: PrincipalExtractor;
  /** Defaults to console.error when app.mode === "development", else no-op. */
  readonly onError?: HttpErrorObserver;
  /** defineHttpRoute overrides: replace auto routes of their operations, add new ones. */
  readonly routes?: readonly HttpRouteOverride[];
  /** GET <path> answers 200 {"ok":true} without auth or dispatch. */
  readonly health?: string;
  /** Answers OPTIONS preflight and adds Access-Control-* on matching origins. */
  readonly cors?: CorsOptions;
  /** Merged onto responses; cannot override content-type/content-length/x-request-id. */
  readonly responseHeaders?: ResponseHeadersHook;
}

export interface HttpHandler<Ops = unknown> {
  /** Web (edge-safe) entry. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Runtime-neutral engine used by hosts (serveNode, benchmarks, tests). */
  readonly handle: (request: HandlerRequest) => Promise<HandlerResponse>;
  /** Compiled method-bucketed route table, exposed for hosts and tooling. */
  readonly routes: CompiledRouteTable;
  /** The application this handler serves (used by hosts, e.g. closeApplication). */
  readonly app: Application<Ops>;
}

/* ------------------------------------------------------------------ */
/* Envelope constants (prestringified)                                */
/* ------------------------------------------------------------------ */

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const NOT_FOUND_BODY = '{"ok":false,"error":{"code":"NOT_FOUND"}}';
const METHOD_NOT_ALLOWED_BODY = '{"ok":false,"error":{"code":"METHOD_NOT_ALLOWED"}}';
const PERMISSION_DENIED_BODY = '{"ok":false,"error":{"code":"PERMISSION_DENIED"}}';
const INVALID_JSON_BODY = '{"ok":false,"error":{"code":"INVALID_JSON"}}';
const PAYLOAD_TOO_LARGE_BODY = '{"ok":false,"error":{"code":"PAYLOAD_TOO_LARGE"}}';
export const INTERNAL_ERROR_BODY = '{"ok":false,"error":{"code":"INTERNAL"}}';
const HEALTH_BODY = '{"ok":true}';

/** Constant bodies hosts may pre-encode once (e.g. into Buffers). */
export const RESPONSE_BODY_CONSTANTS: readonly string[] = Object.freeze([
  NOT_FOUND_BODY,
  METHOD_NOT_ALLOWED_BODY,
  PERMISSION_DENIED_BODY,
  INVALID_JSON_BODY,
  PAYLOAD_TOO_LARGE_BODY,
  INTERNAL_ERROR_BODY,
  HEALTH_BODY,
]);

const NOT_FOUND_RESPONSE: HandlerResponse = Object.freeze({
  status: 404,
  body: NOT_FOUND_BODY,
});
const PERMISSION_DENIED_RESPONSE: HandlerResponse = Object.freeze({
  status: 403,
  body: PERMISSION_DENIED_BODY,
});
const INVALID_JSON_RESPONSE: HandlerResponse = Object.freeze({
  status: 400,
  body: INVALID_JSON_BODY,
});
const PAYLOAD_TOO_LARGE_RESPONSE: HandlerResponse = Object.freeze({
  status: 413,
  body: PAYLOAD_TOO_LARGE_BODY,
});
const INTERNAL_RESPONSE: HandlerResponse = Object.freeze({
  status: 500,
  body: INTERNAL_ERROR_BODY,
});

const successBody = (value: unknown): string => {
  const json = JSON.stringify(value) as string | undefined;
  return `{"ok":true,"value":${json ?? "null"}}`;
};

const errorBody = (error: unknown): string => {
  const json = JSON.stringify(error) as string | undefined;
  return `{"ok":false,"error":${json ?? "null"}}`;
};

/* ------------------------------------------------------------------ */
/* Request id                                                         */
/* ------------------------------------------------------------------ */

/** Inbound x-request-id values outside this shape are replaced (log-safe ids only). */
const REQUEST_ID_PATTERN = /^[\w.-]{1,64}$/;

const resolveRequestId = (inbound: string | undefined): string =>
  inbound !== undefined && REQUEST_ID_PATTERN.test(inbound)
    ? inbound
    : crypto.randomUUID();

/* ------------------------------------------------------------------ */
/* CORS                                                               */
/* ------------------------------------------------------------------ */

interface CompiledCors {
  readonly allowAll: boolean;
  readonly originSet: ReadonlySet<string>;
  readonly credentials: boolean;
  readonly methodsValue: string;
  /** undefined = echo access-control-request-headers on preflight. */
  readonly headersValue: string | undefined;
  readonly maxAgeValue: string | undefined;
}

const compileCors = (cors: CorsOptions, table: CompiledRouteTable): CompiledCors => {
  const allowAll = cors.origins === "*";
  if (!allowAll && (!Array.isArray(cors.origins) || cors.origins.length === 0)) {
    throw new TypeError('cors.origins must be "*" or a non-empty array of origins');
  }
  if (
    cors.maxAgeSeconds !== undefined &&
    (!Number.isSafeInteger(cors.maxAgeSeconds) || cors.maxAgeSeconds < 0)
  ) {
    throw new TypeError("cors.maxAgeSeconds must be a non-negative integer");
  }
  const methods = cors.methods ?? [...table.buckets.keys()].sort();
  return {
    allowAll,
    originSet: new Set(allowAll ? [] : (cors.origins as readonly string[])),
    credentials: cors.credentials === true,
    methodsValue: methods.join(", "),
    headersValue: cors.headers?.join(", "),
    maxAgeValue: cors.maxAgeSeconds === undefined ? undefined : String(cors.maxAgeSeconds),
  };
};

/** Adds the simple-response Access-Control-* set for an already-matched origin. */
const applyCorsHeaders = (
  headers: Record<string, string>,
  cors: CompiledCors,
  origin: string,
): void => {
  if (cors.allowAll && !cors.credentials) {
    headers["access-control-allow-origin"] = "*";
    return;
  }
  // Credentialed responses must echo the origin; origin lists vary by it.
  headers["access-control-allow-origin"] = origin;
  headers["vary"] = "origin";
  if (cors.credentials) headers["access-control-allow-credentials"] = "true";
};

/** Response header names the responseHeaders hook can never override. */
const PROTECTED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "x-request-id",
]);

/* ------------------------------------------------------------------ */
/* Dispatch result -> envelope                                        */
/* ------------------------------------------------------------------ */

const respondDispatch = (
  route: CompiledRoute,
  result: DispatchResult<unknown, unknown>,
  onError: HttpErrorObserver,
  info: HttpErrorInfo,
): HandlerResponse => {
  if (result.kind === "completed") {
    const outcome = result.outcome;
    if (outcome.ok) {
      return { status: route.successStatus, body: successBody(outcome.value) };
    }
    const code = (outcome.error as { readonly code?: unknown }).code;
    const status =
      (typeof code === "string" ? route.errorStatus[code] : undefined) ?? 422;
    return { status, body: errorBody(outcome.error) };
  }
  if (result.kind === "rejected") {
    const error = result.error;
    if (error.code === "INVALID_INPUT") return { status: 400, body: errorBody(error) };
    if (error.code === "PERMISSION_DENIED") return PERMISSION_DENIED_RESPONSE;
    return NOT_FOUND_RESPONSE; // UNKNOWN_OPERATION: defensive, routes are validated
  }
  onError(result.error, info);
  return INTERNAL_RESPONSE;
};

/* ------------------------------------------------------------------ */
/* createHttpHandler                                                  */
/* ------------------------------------------------------------------ */

const noopOnError: HttpErrorObserver = () => {};

const developmentOnError: HttpErrorObserver = (error, info) => {
  console.error(`[agentix:http] ${info.method} ${info.path}`, error);
};

const normalizeRequestPath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * Builds an HTTP handler whose routes are AUTO-derived from the app's
 * operations' `http` metadata. Request flow (both entries): preflight/health
 * -> route match -> authenticate -> app.authorize() 403 BEFORE body read ->
 * body read -> JSON.parse -> input mapping -> dispatch (with `meta:
 * { requestId }` and the request's abort signal) -> JSON envelope.
 * app.authorize is the EFFECTIVE gate: a custom createApplication({authorize})
 * hook is honored here, not just inside dispatch. Every response carries an
 * `x-request-id` header.
 */
export const createHttpHandler = <Ops>(
  app: Application<Ops>,
  options: CreateHttpHandlerOptions = {},
): HttpHandler<Ops> => {
  const overrides = options.routes ?? [];
  for (const override of overrides) {
    const registered = app.getOperation(override.operation.id);
    if (registered === undefined) {
      throw new TypeError(
        `HTTP route ${override.method} ${override.path} references unknown operation ${override.operation.id}`,
      );
    }
    if (registered !== override.operation) {
      throw new TypeError(
        `HTTP route ${override.method} ${override.path} does not use the registered descriptor for ${override.operation.id}`,
      );
    }
  }
  const operations = Object.values(
    app.operations as Readonly<Record<string, AnyBoundOperation>>,
  );
  const table = compileRouteTable(operations, overrides);
  const authenticate = options.authenticate;
  const onError =
    options.onError ?? (app.mode === "development" ? developmentOnError : noopOnError);
  const responseHeaders = options.responseHeaders;
  const cors = options.cors === undefined ? undefined : compileCors(options.cors, table);

  // The health path is registered like a route: normalized and checked for
  // conflicts against the compiled GET table (static and param routes alike).
  const healthPath =
    options.health === undefined ? undefined : normalizeRoutePath(options.health);
  if (healthPath !== undefined && matchRoute(table, "GET", healthPath).kind === "matched") {
    throw new TypeError(
      `health path ${healthPath} conflicts with an existing GET route`,
    );
  }

  /**
   * Applies the responseHeaders hook (protected headers dropped), then the
   * CORS response headers, then `x-request-id` — framework-managed headers
   * always win. A throwing hook degrades the response to an opaque 500.
   */
  const finalize = (
    base: HandlerResponse,
    info: HttpErrorInfo,
    matchedOrigin: string | undefined,
  ): HandlerResponse => {
    let status = base.status;
    let body = base.body;
    const headers: Record<string, string> = { ...base.headers };
    if (responseHeaders !== undefined) {
      let extra: Record<string, string> | undefined;
      try {
        extra = responseHeaders({
          ...(info.operationId === undefined ? {} : { operationId: info.operationId }),
          status,
          requestId: info.requestId,
        });
      } catch (error) {
        onError(error, info);
        status = INTERNAL_RESPONSE.status;
        body = INTERNAL_RESPONSE.body;
        for (const name of Object.keys(headers)) delete headers[name];
        extra = undefined;
      }
      if (extra !== undefined) {
        for (const name of Object.keys(extra)) {
          const lower = name.toLowerCase();
          if (PROTECTED_RESPONSE_HEADERS.has(lower)) continue;
          const value = extra[name];
          if (value !== undefined) headers[lower] = value;
        }
      }
    }
    if (cors !== undefined && matchedOrigin !== undefined) {
      applyCorsHeaders(headers, cors, matchedOrigin);
    }
    headers["x-request-id"] = info.requestId;
    return { status, body, headers };
  };

  /**
   * CORS preflight answer — the ONLY 204 this adapter produces, emitted
   * outside the JSON envelope path (operation statuses still reject 204).
   * Non-matching origins get the bare 204 without Access-Control-* headers.
   */
  const preflight = (
    request: HandlerRequest,
    matchedOrigin: string | undefined,
    requestId: string,
  ): HandlerResponse => {
    const headers: Record<string, string> = {};
    if (cors !== undefined && matchedOrigin !== undefined) {
      applyCorsHeaders(headers, cors, matchedOrigin);
      headers["access-control-allow-methods"] = cors.methodsValue;
      if (cors.headersValue !== undefined) {
        headers["access-control-allow-headers"] = cors.headersValue;
      } else {
        const requested = request.headers("access-control-request-headers");
        if (requested !== undefined && requested.length > 0) {
          headers["access-control-allow-headers"] = requested;
        }
        headers["vary"] =
          headers["vary"] === undefined
            ? "access-control-request-headers"
            : `${headers["vary"]}, access-control-request-headers`;
      }
      if (cors.maxAgeValue !== undefined) {
        headers["access-control-max-age"] = cors.maxAgeValue;
      }
    }
    headers["x-request-id"] = requestId;
    return { status: 204, body: "", headers };
  };

  const handle = async (request: HandlerRequest): Promise<HandlerResponse> => {
    const requestId = resolveRequestId(request.headers("x-request-id"));
    const origin = cors === undefined ? undefined : request.headers("origin");
    const matchedOrigin =
      cors !== undefined &&
      origin !== undefined &&
      (cors.allowAll || cors.originSet.has(origin))
        ? origin
        : undefined;

    if (
      cors !== undefined &&
      request.method === "OPTIONS" &&
      origin !== undefined &&
      request.headers("access-control-request-method") !== undefined
    ) {
      return preflight(request, matchedOrigin, requestId);
    }

    const isHealthRequest =
      healthPath !== undefined && normalizeRequestPath(request.path) === healthPath;
    if (isHealthRequest && request.method === "GET") {
      // Health: no authentication, no authorization, no dispatch.
      return finalize(
        { status: 200, body: HEALTH_BODY },
        { method: request.method, path: request.path, requestId },
        matchedOrigin,
      );
    }

    const match = matchRoute(table, request.method, request.path);
    if (match.kind === "not_found") {
      // A wrong-method hit on the health path is a known path: answer 405.
      const base: HandlerResponse = isHealthRequest
        ? { status: 405, body: METHOD_NOT_ALLOWED_BODY, headers: { allow: "GET" } }
        : NOT_FOUND_RESPONSE;
      return finalize(
        base,
        { method: request.method, path: request.path, requestId },
        matchedOrigin,
      );
    }
    if (match.kind === "method_not_allowed") {
      const allow = isHealthRequest
        ? [...new Set([...match.allow.split(", "), "GET"])].sort().join(", ")
        : match.allow;
      return finalize(
        { status: 405, body: METHOD_NOT_ALLOWED_BODY, headers: { allow } },
        { method: request.method, path: request.path, requestId },
        matchedOrigin,
      );
    }
    const route = match.route;
    const info: HttpErrorInfo = {
      method: request.method,
      path: request.path,
      requestId,
      operationId: route.operationId,
    };
    try {
      let principal: Principal | undefined;
      if (authenticate !== undefined) {
        const view: HttpRequestView = {
          method: request.method,
          path: request.path,
          headers: request.headers,
          cookie: createCookieLookup(request.headers),
        };
        try {
          principal = (await authenticate(view)) ?? undefined;
        } catch (error) {
          if (error instanceof AuthenticationError) {
            return finalize(
              { status: 401, body: errorBody({ code: error.code }) },
              info,
              matchedOrigin,
            );
          }
          onError(error, info);
          return finalize(INTERNAL_RESPONSE, info, matchedOrigin);
        }
      }

      // Single permission gate, BEFORE the body is read (spec requirement).
      // app.authorize applies the custom hook when one was provided; a
      // throwing hook falls through to the outer catch (500 + onError).
      if (!app.authorize(route.operation, principal)) {
        return finalize(PERMISSION_DENIED_RESPONSE, info, matchedOrigin);
      }

      let text: string | undefined;
      try {
        text = await request.readBody();
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          return finalize(PAYLOAD_TOO_LARGE_RESPONSE, info, matchedOrigin);
        }
        onError(error, info);
        return finalize(INTERNAL_RESPONSE, info, matchedOrigin);
      }
      let body: unknown;
      if (text !== undefined && text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          return finalize(INVALID_JSON_RESPONSE, info, matchedOrigin);
        }
      }

      const input =
        route.mapRequest === undefined
          ? route.buildInput(match.params, request.query, body)
          : await route.mapRequest({
              method: request.method,
              path: request.path,
              params: match.params,
              query: queryRecord(request.query),
              body,
              headers: request.headers,
            });

      const dispatchOptions: {
        input: unknown;
        meta: { readonly requestId: string };
        principal?: Principal;
        signal?: AbortSignal;
      } = { input, meta: { requestId } };
      if (principal !== undefined) dispatchOptions.principal = principal;
      if (request.signal !== undefined) dispatchOptions.signal = request.signal;

      const result = await app.dispatch(route.operation, dispatchOptions);
      return finalize(respondDispatch(route, result, onError, info), info, matchedOrigin);
    } catch (error) {
      onError(error, info);
      return finalize(INTERNAL_RESPONSE, info, matchedOrigin);
    }
  };

  const toResponse = (outcome: HandlerResponse): Response => {
    if (outcome.status === 204) {
      // Preflight only: 204 forbids a body, so no content-type either.
      return new Response(null, { status: 204, headers: { ...outcome.headers } });
    }
    const headers: Record<string, string> = { "content-type": JSON_CONTENT_TYPE };
    if (outcome.headers !== undefined) {
      for (const name of Object.keys(outcome.headers)) {
        const value = outcome.headers[name];
        if (value !== undefined) headers[name] = value;
      }
    }
    return new Response(outcome.body, { status: outcome.status, headers });
  };

  const fetchEntry = async (request: Request): Promise<Response> => {
    let path = request.url; // fallback until the URL parses
    try {
      const url = new URL(request.url);
      path = url.pathname;
      const outcome = await handle({
        method: request.method,
        path: url.pathname,
        query: url.search.length > 1 ? url.search.slice(1) : "",
        headers: (name) => request.headers.get(name) ?? undefined,
        readBody: async () => {
          if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
            return undefined;
          }
          const text = await request.text();
          return text.length === 0 ? undefined : text;
        },
        signal: request.signal,
      });
      return toResponse(outcome);
    } catch (error) {
      const match = matchRoute(table, request.method, path);
      let requestId: string;
      let origin: string | undefined;
      try {
        requestId = resolveRequestId(request.headers.get("x-request-id") ?? undefined);
        origin = request.headers.get("origin") ?? undefined;
      } catch {
        requestId = resolveRequestId(undefined); // defensive: hostile request object
        origin = undefined;
      }
      onError(error, {
        method: request.method,
        path,
        requestId,
        ...(match.kind === "matched" ? { operationId: match.route.operationId } : {}),
      });
      const headers: Record<string, string> = { "x-request-id": requestId };
      if (
        cors !== undefined &&
        origin !== undefined &&
        (cors.allowAll || cors.originSet.has(origin))
      ) {
        applyCorsHeaders(headers, cors, origin);
      }
      return toResponse({ status: 500, body: INTERNAL_ERROR_BODY, headers });
    }
  };

  return Object.freeze({ fetch: fetchEntry, handle, routes: table, app });
};
