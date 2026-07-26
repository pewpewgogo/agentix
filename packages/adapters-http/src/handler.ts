import { authorize } from "@agentix/core";
import type {
  AnyBoundOperation,
  Application,
  DispatchResult,
  Principal,
} from "@agentix/core";

import { AuthenticationError } from "./auth.js";
import type { HttpRequestView, PrincipalExtractor } from "./auth.js";
import { compileRouteTable, matchRoute, queryRecord } from "./router.js";
import type {
  CompiledRoute,
  CompiledRouteTable,
  HttpRouteOverride,
} from "./router.js";

/* ------------------------------------------------------------------ */
/* Runtime-neutral request/response model (shared by BOTH entries)    */
/* ------------------------------------------------------------------ */

/** Host-agnostic request consumed by handler.handle(); no undici types. */
export interface HandlerRequest extends HttpRequestView {
  /** Raw query string without the leading "?" ("" when absent). */
  readonly query: string;
  /**
   * Deferred body read (UTF-8 text, undefined when absent). Called AFTER
   * authorization so 403 responses never touch the body. May throw
   * RequestBodyLimitError to answer 413.
   */
  readonly readBody: () => Promise<string | undefined>;
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
  readonly operationId?: string;
}

/** Observability hook for faults and unexpected adapter errors (500s + 413s excluded). */
export type HttpErrorObserver = (error: unknown, info: HttpErrorInfo) => void;

export interface CreateHttpHandlerOptions {
  /** Opt-in authentication; absent means every request is anonymous. */
  readonly authenticate?: PrincipalExtractor;
  /** Defaults to console.error when app.mode === "development", else no-op. */
  readonly onError?: HttpErrorObserver;
  /** defineHttpRoute overrides: replace auto routes of their operations, add new ones. */
  readonly routes?: readonly HttpRouteOverride[];
}

export interface HttpHandler {
  /** Web (edge-safe) entry. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Runtime-neutral engine used by hosts (serveNode, benchmarks, tests). */
  readonly handle: (request: HandlerRequest) => Promise<HandlerResponse>;
  /** Compiled method-bucketed route table, exposed for hosts and tooling. */
  readonly routes: CompiledRouteTable;
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

/** Constant bodies hosts may pre-encode once (e.g. into Buffers). */
export const RESPONSE_BODY_CONSTANTS: readonly string[] = Object.freeze([
  NOT_FOUND_BODY,
  METHOD_NOT_ALLOWED_BODY,
  PERMISSION_DENIED_BODY,
  INVALID_JSON_BODY,
  PAYLOAD_TOO_LARGE_BODY,
  INTERNAL_ERROR_BODY,
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

/**
 * Builds an HTTP handler whose routes are AUTO-derived from the app's
 * operations' `http` metadata. Request flow (both entries): route match ->
 * authenticate -> core authorize() 403 BEFORE body read -> body read ->
 * JSON.parse -> input mapping -> dispatch -> JSON envelope.
 */
export const createHttpHandler = <Ops>(
  app: Application<Ops>,
  options: CreateHttpHandlerOptions = {},
): HttpHandler => {
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

  const handle = async (request: HandlerRequest): Promise<HandlerResponse> => {
    const match = matchRoute(table, request.method, request.path);
    if (match.kind === "not_found") return NOT_FOUND_RESPONSE;
    if (match.kind === "method_not_allowed") {
      return { status: 405, body: METHOD_NOT_ALLOWED_BODY, headers: { allow: match.allow } };
    }
    const route = match.route;
    const info: HttpErrorInfo = {
      method: request.method,
      path: request.path,
      operationId: route.operationId,
    };
    try {
      let principal: Principal | undefined;
      if (authenticate !== undefined) {
        try {
          principal = (await authenticate(request)) ?? undefined;
        } catch (error) {
          if (error instanceof AuthenticationError) {
            return { status: 401, body: errorBody({ code: error.code }) };
          }
          onError(error, info);
          return INTERNAL_RESPONSE;
        }
      }

      // Single permission gate, BEFORE the body is read (spec requirement).
      if (!authorize(route.operation, principal)) return PERMISSION_DENIED_RESPONSE;

      let text: string | undefined;
      try {
        text = await request.readBody();
      } catch (error) {
        if (error instanceof RequestBodyLimitError) return PAYLOAD_TOO_LARGE_RESPONSE;
        onError(error, info);
        return INTERNAL_RESPONSE;
      }
      let body: unknown;
      if (text !== undefined && text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          return INVALID_JSON_RESPONSE;
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

      const result = await app.dispatch(
        route.operation,
        principal === undefined ? { input } : { input, principal },
      );
      return respondDispatch(route, result, onError, info);
    } catch (error) {
      onError(error, info);
      return INTERNAL_RESPONSE;
    }
  };

  const toResponse = (outcome: HandlerResponse): Response => {
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
    try {
      const url = new URL(request.url);
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
      });
      return toResponse(outcome);
    } catch (error) {
      onError(error, { method: request.method, path: request.url });
      return toResponse(INTERNAL_RESPONSE);
    }
  };

  return Object.freeze({ fetch: fetchEntry, handle, routes: table });
};
