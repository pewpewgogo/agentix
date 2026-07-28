import { COMMERCE_ERRORS } from "@agentixdev/shared-contract";
import { z } from "zod";

export interface Principal {
  readonly id: string;
  readonly permissions: ReadonlySet<string>;
}

export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly principal: Principal;
}

export interface Route {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly permission: string;
  readonly handle: (context: RouteContext) => Promise<Response>;
}

export interface RouterOptions {
  readonly routes: readonly Route[];
  readonly authenticate: (request: Request) => Principal;
}

/** Validation issue surfaced in 400 INVALID_INPUT envelopes. */
export interface HttpIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code: string;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const routeSegments = (path: string): readonly string[] =>
  path === "/" ? [] : path.replace(/\/$/u, "").slice(1).split("/");

const matchPath = (
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | undefined => {
  const expected = routeSegments(pattern);
  const actual = routeSegments(pathname);
  if (expected.length !== actual.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedSegment = expected[index];
    const actualSegment = actual[index];
    if (expectedSegment === undefined || actualSegment === undefined) {
      return undefined;
    }
    if (expectedSegment.startsWith(":")) {
      try {
        params[expectedSegment.slice(1)] = decodeURIComponent(actualSegment);
      } catch {
        // Malformed percent-encoding never matches a param route (=> 404).
        return undefined;
      }
    } else if (expectedSegment !== actualSegment) {
      return undefined;
    }
  }
  return params;
};

export const jsonResponse = (
  value: unknown,
  status: number,
  headers?: Readonly<Record<string, string>>,
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });

/** Opaque transport error: `{ ok: false, error: { code } }`. */
export const opaqueErrorResponse = (error: {
  readonly status: number;
  readonly code: string;
}): Response => jsonResponse({ ok: false, error: { code: error.code } }, error.status);

/** Domain error: `{ ok: false, error: { code, details } }`. */
export const domainErrorResponse = (
  error: { readonly status: number; readonly code: string },
  details: unknown,
): Response =>
  jsonResponse(
    { ok: false, error: { code: error.code, details } },
    error.status,
  );

export const invalidInputResponse = (
  issues: readonly HttpIssue[],
): Response =>
  jsonResponse(
    { ok: false, error: { code: COMMERCE_ERRORS.invalidInput.code, issues } },
    COMMERCE_ERRORS.invalidInput.status,
  );

export const internalErrorResponse = (): Response =>
  opaqueErrorResponse(COMMERCE_ERRORS.internal);

export const zodIssues = (error: z.ZodError): readonly HttpIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    message: issue.message,
    code: issue.code,
  }));

export type ParsedRequest<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

/**
 * Reads and validates a JSON body. An absent body validates like `{}` so a
 * missing payload reports INVALID_INPUT field issues, matching malformed JSON
 * only when the body text itself cannot parse (INVALID_JSON).
 */
export const parseJson = async <T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ParsedRequest<T>> => {
  let value: unknown = {};
  const text = await request.text();
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      return {
        ok: false,
        response: opaqueErrorResponse(COMMERCE_ERRORS.invalidJson),
      };
    }
  }

  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: invalidInputResponse(zodIssues(parsed.error)) };
};

const pathIdSchema = z.string().trim().min(1);

/** Validates a trimmed, non-empty path parameter; blank values are 400 INVALID_INPUT. */
export const parsePathId = (
  name: string,
  value: string | undefined,
): ParsedRequest<string> => {
  const parsed = pathIdSchema.safeParse(value ?? "");
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        response: invalidInputResponse(
          parsed.error.issues.map((issue) => ({
            path: [name],
            message: issue.message,
            code: issue.code,
          })),
        ),
      };
};

export const createRouter = ({ routes, authenticate }: RouterOptions) => {
  const duplicateKeys = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (duplicateKeys.has(key)) {
      throw new TypeError(`Duplicate route ${key}.`);
    }
    duplicateKeys.add(key);
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    const allowed = new Set<string>();
    let matched:
      | { readonly route: Route; readonly params: Readonly<Record<string, string>> }
      | undefined;
    for (const route of routes) {
      const params = matchPath(route.path, url.pathname);
      if (params === undefined) continue;
      if (route.method === method) {
        matched = { route, params };
        break;
      }
      allowed.add(route.method);
    }

    if (matched === undefined) {
      if (allowed.size === 0) {
        return opaqueErrorResponse(COMMERCE_ERRORS.routeNotFound);
      }
      return jsonResponse(
        { ok: false, error: { code: COMMERCE_ERRORS.methodNotAllowed.code } },
        COMMERCE_ERRORS.methodNotAllowed.status,
        { allow: [...allowed].sort().join(", ") },
      );
    }

    // The permission gate runs BEFORE any body read or parse.
    const principal = authenticate(request);
    if (!principal.permissions.has(matched.route.permission)) {
      return opaqueErrorResponse(COMMERCE_ERRORS.forbidden);
    }

    try {
      return await matched.route.handle({
        request,
        url,
        params: matched.params,
        principal,
      });
    } catch {
      return internalErrorResponse();
    }
  };
};

export type RequestHandler = ReturnType<typeof createRouter>;
