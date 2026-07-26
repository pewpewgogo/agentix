/**
 * Minimal HTTP test driver over any object exposing a Web-standard
 * `fetch(request)` entry (structural on purpose: no adapter import).
 */
export interface TestHttpHandler {
  fetch(request: Request): Promise<Response>;
}

/**
 * Header used to carry `principal` option payloads (JSON). Read it back in a
 * test `authenticate` hook to build the principal on the server side.
 */
export const TEST_PRINCIPAL_HEADER = "x-agentix-test-principal";

export interface TestHttpRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-serialized into the TEST_PRINCIPAL_HEADER request header. */
  readonly principal?: unknown;
  /** Sent as `authorization: Bearer <token>` unless authorization is set. */
  readonly token?: string;
}

export interface TestHttpRequest extends TestHttpRequestOptions {
  readonly method: string;
  readonly path: string;
  /** JSON-serialized request body. */
  readonly body?: unknown;
}

export interface TestHttpResponse {
  readonly status: number;
  /** JSON-parsed response body; undefined when empty or not valid JSON. */
  readonly body: unknown;
  readonly headers: Headers;
  /** Raw response text (empty string for empty bodies). */
  readonly text: string;
}

export interface TestHttpClient {
  request(options: TestHttpRequest): Promise<TestHttpResponse>;
  get(path: string, options?: TestHttpRequestOptions): Promise<TestHttpResponse>;
  delete(path: string, options?: TestHttpRequestOptions): Promise<TestHttpResponse>;
  post(
    path: string,
    body?: unknown,
    options?: TestHttpRequestOptions,
  ): Promise<TestHttpResponse>;
  put(
    path: string,
    body?: unknown,
    options?: TestHttpRequestOptions,
  ): Promise<TestHttpResponse>;
  patch(
    path: string,
    body?: unknown,
    options?: TestHttpRequestOptions,
  ): Promise<TestHttpResponse>;
}

const BASE_URL = "http://agentix.test";

/** Wraps a `{ fetch }` handler in a small typed client for HTTP-level tests. */
export const testHttp = (handler: TestHttpHandler): TestHttpClient => {
  const request = async (options: TestHttpRequest): Promise<TestHttpResponse> => {
    const method = options.method.toUpperCase();
    const headers = new Headers(options.headers ?? {});
    if (options.token !== undefined && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${options.token}`);
    }
    if (options.principal !== undefined && !headers.has(TEST_PRINCIPAL_HEADER)) {
      headers.set(TEST_PRINCIPAL_HEADER, JSON.stringify(options.principal));
    }
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      init.body = JSON.stringify(options.body);
    }
    const url = /^https?:\/\//u.test(options.path)
      ? options.path
      : `${BASE_URL}${options.path.startsWith("/") ? "" : "/"}${options.path}`;

    const response = await handler.fetch(new Request(url, init));
    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { status: response.status, body, headers: response.headers, text };
  };

  const withoutBody =
    (method: string) =>
    (path: string, options: TestHttpRequestOptions = {}): Promise<TestHttpResponse> =>
      request({ ...options, method, path });

  const withBody =
    (method: string) =>
    (
      path: string,
      body?: unknown,
      options: TestHttpRequestOptions = {},
    ): Promise<TestHttpResponse> =>
      request({ ...options, method, path, ...(body === undefined ? {} : { body }) });

  return Object.freeze({
    request,
    get: withoutBody("GET"),
    delete: withoutBody("DELETE"),
    post: withBody("POST"),
    put: withBody("PUT"),
    patch: withBody("PATCH"),
  });
};
