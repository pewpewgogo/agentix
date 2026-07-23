import type {
  AnyOperationDescriptor,
  DispatchResult,
  Infer,
} from "@agentix/core";

export type Awaitable<T> = T | Promise<T>;

export type HttpMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

const HTTP_METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

export interface HttpRouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

export interface HttpResponseContext extends HttpRouteContext {
  readonly operationId: string;
}

export interface HttpRoute<
  Operation extends AnyOperationDescriptor = AnyOperationDescriptor,
> {
  readonly kind: "http-route";
  readonly method: HttpMethod;
  readonly path: string;
  readonly operation: Operation;
  readonly mapRequest: (
    context: HttpRouteContext,
  ) => Awaitable<Infer<Operation["input"]>>;
  readonly mapResponse?: (
    result: DispatchResult,
    context: HttpResponseContext,
  ) => Awaitable<Response>;
  readonly responses?: HttpOutcomeResponseOptions<
    keyof Operation["errors"] & string
  >;
  readonly trace?: boolean;
}

export type DefineHttpRouteOptions<
  Operation extends AnyOperationDescriptor,
> = Omit<HttpRoute<Operation>, "kind" | "method" | "path"> & {
  readonly method: HttpMethod | Lowercase<HttpMethod>;
  readonly path: string;
};

const normalizePath = (path: string): string => {
  if (!path.startsWith("/")) {
    throw new TypeError(`HTTP route path ${path} must start with "/".`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new TypeError("An HTTP route path cannot include a query or fragment.");
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
};

export const defineHttpRoute = <Operation extends AnyOperationDescriptor>(
  options: DefineHttpRouteOptions<Operation>,
): HttpRoute<Operation> => {
  const path = normalizePath(options.path);
  const method = options.method.toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new TypeError(`Unsupported HTTP route method ${options.method}.`);
  }
  const parameterNames = path
    .split("/")
    .filter((part) => part.startsWith(":"))
    .map((part) => part.slice(1));
  if (parameterNames.some((name) => name.length === 0)) {
    throw new TypeError("An HTTP route parameter requires a name.");
  }
  if (new Set(parameterNames).size !== parameterNames.length) {
    throw new TypeError(`HTTP route ${path} repeats a parameter name.`);
  }

  return Object.freeze({
    ...options,
    kind: "http-route" as const,
    method: method as HttpMethod,
    path,
  });
};

export class HttpInputError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(
    message: string,
    options: { readonly status?: number; readonly code?: string } = {},
  ) {
    super(message);
    this.name = "HttpInputError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "INVALID_HTTP_INPUT";
  }
}

export const readJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch (cause: unknown) {
    throw new HttpInputError("The request body must contain valid JSON.", {
      code: "INVALID_JSON",
    });
  }
};

export interface HttpOutcomeResponseOptions<ErrorCode extends string = string> {
  readonly successStatus?: number;
  readonly domainErrorStatus?: number;
  readonly domainErrorStatuses?: Readonly<Partial<Record<ErrorCode, number>>>;
  readonly headers?: HeadersInit;
}

export const jsonResponse = (
  value: unknown,
  status: number,
  headers?: HeadersInit,
): Response => {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
};

const errorCode = (error: unknown): string | undefined => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
};

const rejectedStatus = (code: string): number => {
  switch (code) {
    case "AUTHORIZATION_DENIED":
    case "FORBIDDEN":
    case "PERMISSION_DENIED":
      return 403;
    case "INVALID_INPUT":
    case "INPUT_INVALID":
      return 400;
    case "OPERATION_NOT_FOUND":
    case "UNKNOWN_OPERATION":
      return 404;
    default:
      return 400;
  }
};

/** Maps core dispatch results without exposing unexpected exception details. */
export const mapDispatchResult = (
  result: DispatchResult,
  options: HttpOutcomeResponseOptions = {},
): Response => {
  if (result.kind === "completed") {
    if (result.outcome.ok) {
      return jsonResponse(
        result.outcome,
        options.successStatus ?? 200,
        options.headers,
      );
    }
    const code = errorCode(result.outcome.error);
    const status =
      (code === undefined ? undefined : options.domainErrorStatuses?.[code]) ??
      options.domainErrorStatus ??
      422;
    return jsonResponse(result.outcome, status, options.headers);
  }

  if (result.kind === "rejected") {
    return jsonResponse(
      { ok: false, error: result.error },
      rejectedStatus(result.error.code),
      options.headers,
    );
  }

  return jsonResponse(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "The operation failed unexpectedly.",
      },
    },
    500,
    options.headers,
  );
};
