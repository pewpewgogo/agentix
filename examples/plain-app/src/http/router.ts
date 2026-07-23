import { COMMERCE_ERRORS } from "@agentix/shared-contract";
import { z } from "zod";

import { failure } from "../domain/result.js";
import type { Result } from "../domain/result.js";

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

export interface HttpError {
  readonly code: string;
  readonly message: string;
}

interface StandardHttpError extends HttpError {
  readonly status: number;
}

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
        return undefined;
      }
    } else if (expectedSegment !== actualSegment) {
      return undefined;
    }
  }
  return params;
};

export const jsonResponse = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const errorResponse = (error: StandardHttpError): Response =>
  jsonResponse(
    failure({ code: error.code, message: error.message }),
    error.status,
  );

export const normalizedPathId = (value: string | undefined): string | undefined => {
  const id = (value ?? "").trim();
  return id.length === 0 ? undefined : id;
};

export const invalidInputResponse = (): Response =>
  errorResponse(COMMERCE_ERRORS.validation);

export const parseJson = async <T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<Result<T, HttpError>> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return failure({
      code: COMMERCE_ERRORS.validation.code,
      message: COMMERCE_ERRORS.validation.message,
    });
  }

  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failure({
        code: COMMERCE_ERRORS.validation.code,
        message: COMMERCE_ERRORS.validation.message,
      });
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
    try {
      decodeURI(url.pathname);
    } catch {
      return invalidInputResponse();
    }

    const pathMatches = routes.flatMap((route) => {
      const params = matchPath(route.path, url.pathname);
      return params === undefined ? [] : [{ route, params }];
    });
    const match = pathMatches.find(
      ({ route }) => route.method === request.method.toUpperCase(),
    );

    if (match === undefined) {
      return errorResponse(COMMERCE_ERRORS.routeNotFound);
    }

    const principal = authenticate(request);
    if (!principal.permissions.has(match.route.permission)) {
      return errorResponse(COMMERCE_ERRORS.forbidden);
    }

    try {
      return await match.route.handle({
        request,
        url,
        params: match.params,
        principal,
      });
    } catch {
      return errorResponse(COMMERCE_ERRORS.internal);
    }
  };
};

export type RequestHandler = ReturnType<typeof createRouter>;
