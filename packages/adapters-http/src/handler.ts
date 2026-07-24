import type {
  AnyOperationDescriptor,
  Application,
  Principal,
  RejectedDispatch,
} from "@agentix/core";

import { AuthenticationError } from "./auth.js";
import type { PrincipalExtractor } from "./auth.js";
import { HttpInputError, jsonResponse, mapDispatchResult } from "./route.js";
import type { HttpRoute, HttpRouteContext } from "./route.js";

export type HttpHandler = (request: Request) => Promise<Response>;

export interface CreateHttpHandlerOptions {
  readonly application: Application;
  readonly routes: readonly HttpRoute<AnyOperationDescriptor>[];
  readonly principal?: PrincipalExtractor;
  readonly anonymousPrincipal?: Principal;
}

interface CompiledRoute {
  readonly route: HttpRoute;
  readonly segments: readonly string[];
}

const pathSegments = (path: string): readonly string[] =>
  path === "/" ? [] : path.slice(1).split("/");

const matchPath = (
  route: CompiledRoute,
  path: string,
): Readonly<Record<string, string>> | null => {
  const actual = pathSegments(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
  if (actual.length !== route.segments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const expectedSegment = route.segments[index];
    const actualSegment = actual[index];
    if (expectedSegment === undefined || actualSegment === undefined) {
      return null;
    }
    if (expectedSegment.startsWith(":")) {
      try {
        params[expectedSegment.slice(1)] = decodeURIComponent(actualSegment);
      } catch {
        throw new HttpInputError("The request path is not valid URI encoding.", {
          code: "INVALID_PATH_ENCODING",
        });
      }
    } else if (expectedSegment !== actualSegment) {
      return null;
    }
  }
  return params;
};

const compileRoutes = (
  routes: readonly HttpRoute[],
): readonly CompiledRoute[] => {
  const identities = new Set<string>();
  return routes.map((route) => {
    const routeShape = route.path
      .split("/")
      .map((segment) => (segment.startsWith(":") ? ":" : segment))
      .join("/");
    const identity = `${route.method} ${routeShape}`;
    if (identities.has(identity)) {
      throw new TypeError(`Duplicate HTTP route ${identity}.`);
    }
    identities.add(identity);
    return { route, segments: pathSegments(route.path) };
  });
};

const unauthenticated = (): Response =>
  jsonResponse(
    {
      ok: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
    },
    401,
  );

const routeNotFound = (): Response =>
  jsonResponse(
    { ok: false, error: { code: "ROUTE_NOT_FOUND", message: "Route not found." } },
    404,
  );

export const createHttpHandler = (
  options: CreateHttpHandlerOptions,
): HttpHandler => {
  for (const route of options.routes) {
    const registered = options.application.getOperation(route.operation.id);
    if (registered === undefined) {
      throw new TypeError(
        `HTTP route ${route.method} ${route.path} references unknown operation ${route.operation.id}.`,
      );
    }
    if (registered !== route.operation) {
      throw new TypeError(
        `HTTP route ${route.method} ${route.path} does not use the registered descriptor for ${route.operation.id}.`,
      );
    }
  }
  const routes = compileRoutes(options.routes);
  const anonymousPrincipal = options.anonymousPrincipal ?? {
    id: "anonymous",
    permissions: [],
  };

  return async (request) => {
    try {
      const url = new URL(request.url);
      const pathMatches = routes.flatMap((compiled) => {
        const params = matchPath(compiled, url.pathname);
        return params === null ? [] : [{ compiled, params }];
      });
      const match = pathMatches.find(
        ({ compiled }) => compiled.route.method === request.method.toUpperCase(),
      );

      if (match === undefined) {
        if (pathMatches.length > 0) {
          const allowed = [...new Set(pathMatches.map(({ compiled }) => compiled.route.method))]
            .sort()
            .join(", ");
          return jsonResponse(
            {
              ok: false,
              error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
            },
            405,
            { allow: allowed },
          );
        }
        return routeNotFound();
      }

      const principal = options.principal === undefined
        ? anonymousPrincipal
        : await options.principal(request);
      if (principal === null) {
        return unauthenticated();
      }

      const context: HttpRouteContext = {
        request,
        url,
        params: match.params,
      };
      const responseContext = {
        ...context,
        operationId: match.compiled.route.operation.id,
      };
      const grantedPermissions = new Set(principal.permissions);
      const missingPermissions = match.compiled.route.operation.permissions.filter(
        (permission) => !grantedPermissions.has(permission),
      );
      if (missingPermissions.length > 0) {
        const result: RejectedDispatch = Object.freeze({
          kind: "rejected",
          operationId: match.compiled.route.operation.id,
          error: Object.freeze({
            code: "PERMISSION_DENIED",
            principalId: principal.id,
            missingPermissions: Object.freeze(missingPermissions),
          }),
        });
        return match.compiled.route.mapResponse === undefined
          ? mapDispatchResult(result, match.compiled.route.responses)
          : await match.compiled.route.mapResponse(result, responseContext);
      }

      const input = await match.compiled.route.mapRequest(context);
      const dispatchOptions = {
        input,
        principal,
        ...(match.compiled.route.trace === undefined
          ? {}
          : { trace: match.compiled.route.trace }),
      };
      const result = await options.application.dispatch(
        match.compiled.route.operation,
        dispatchOptions,
      );
      return match.compiled.route.mapResponse === undefined
        ? mapDispatchResult(result, match.compiled.route.responses)
        : await match.compiled.route.mapResponse(result, responseContext);
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) {
        return jsonResponse(
          { ok: false, error: { code: error.code, message: error.message } },
          401,
        );
      }
      if (error instanceof HttpInputError) {
        return jsonResponse(
          { ok: false, error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "The HTTP adapter failed unexpectedly.",
          },
        },
        500,
      );
    }
  };
};
