import type { AnyBoundOperation, HttpMethod, Infer } from "@agentix/core";

import { normalizeRoutePath } from "./router.js";
import type { Awaitable, HttpRequestContext, HttpRouteOverride } from "./router.js";

const ROUTE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const assertStatus = (status: number, label: string): void => {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new TypeError(`${label} must be an integer in 100..599`);
  }
};

export interface DefineHttpRouteOptions<Operation extends AnyBoundOperation> {
  readonly method: HttpMethod | Lowercase<HttpMethod>;
  readonly path: string;
  readonly operation: Operation;
  /** Success status; defaults to the operation's http.status, then 200. */
  readonly status?: number;
  /** Per-error status overrides merged over the descriptor's derived errorStatus. */
  readonly errorStatus?: Readonly<Record<string, number>>;
  /** Custom input mapping; the JSON body is already parsed when this runs. */
  readonly mapRequest?: (
    context: HttpRequestContext,
  ) => Awaitable<Infer<Operation["input"]>>;
}

/**
 * Escape hatch for custom HTTP mappings. Routes are normally AUTO-derived
 * from operations' `http` metadata; pass overrides via createHttpHandler's
 * `routes` option to remap an operation (its auto routes are then dropped)
 * or to expose an operation without `http` metadata.
 */
export const defineHttpRoute = <Operation extends AnyBoundOperation>(
  options: DefineHttpRouteOptions<Operation>,
): HttpRouteOverride<Operation> => {
  const method = options.method.toUpperCase();
  if (!ROUTE_METHODS.has(method)) {
    throw new TypeError(`Unsupported HTTP route method ${options.method}`);
  }
  const path = normalizeRoutePath(options.path);
  if (options.status !== undefined) assertStatus(options.status, "Route status");
  if (options.errorStatus !== undefined) {
    for (const code of Object.keys(options.errorStatus)) {
      const status = options.errorStatus[code];
      if (status !== undefined) assertStatus(status, `Route errorStatus[${code}]`);
    }
  }
  return Object.freeze({
    kind: "http-route" as const,
    method: method as HttpMethod,
    path,
    operation: options.operation,
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.errorStatus === undefined ? {} : { errorStatus: options.errorStatus }),
    ...(options.mapRequest === undefined ? {} : { mapRequest: options.mapRequest }),
  });
};
