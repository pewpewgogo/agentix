# `@agentixdev/adapters-http` API

Every public export, one line each. Entries: root (all), `./web` (edge-safe),
`./node` (`serveNode` only). Full guide: the repository's `docs/HTTP.md`.

## Handler

- `createHttpHandler(app, {authenticate?, onError?, routes?, health?, cors?, responseHeaders?}?): HttpHandler` — compiles routes from operations' `http` metadata.
- `HttpHandler.fetch(request: Request): Promise<Response>` — Web/edge entry.
- `HttpHandler.handle(request: HandlerRequest): Promise<HandlerResponse>` — runtime-neutral engine for custom hosts.
- `HttpHandler.routes: CompiledRouteTable` — the compiled table.
- `HttpHandler.app` — the application the handler serves (hosts use it for `closeApplication`).
- Every response carries `x-request-id` (valid inbound header adopted, else generated); dispatch receives `meta: {requestId}` and the request's abort signal.
- `health?: string` — GET path answering `200 {"ok":true}` without auth/dispatch; conflicts with GET routes throw.
- `cors?: CorsOptions` — `{origins: readonly string[] | "*", methods?, headers?, credentials?, maxAgeSeconds?}`; answers OPTIONS preflight (204, outside the envelope) and adds Access-Control-* on matching origins.
- `responseHeaders?: ResponseHeadersHook` — `({operationId?, status, requestId}) => headers?` merged onto responses; cannot override `content-type`/`content-length`/`x-request-id`.
- `RequestBodyLimitError` — throw from a custom host's `readBody` to answer 413.
- `JSON_CONTENT_TYPE` — `"application/json; charset=utf-8"`.
- Types: `CreateHttpHandlerOptions`, `HandlerRequest` (`{method, path, headers, query, readBody(), signal?}`), `HandlerResponse` (`{status, body, headers?}`), `HttpErrorInfo` (`{method, path, requestId, operationId?}`), `HttpErrorObserver`, `CorsOptions`, `ResponseHeadersContext`, `ResponseHeadersHook`.

## Authentication

- `createBearerPrincipalExtractor({resolve(token, request)}): PrincipalExtractor` — 401 on malformed header; resolver decides trust.
- `createTrustedHeaderPrincipalExtractor({idHeader?, permissionsHeader?, separator?}?): PrincipalExtractor` — proxy-injected identity.
- `AuthenticationError(message?, code?)` — throw from an extractor for a 401 with `code` (default `"UNAUTHENTICATED"`).
- `createCookieLookup(headers): (name) => string | undefined` — lazy single-parse Cookie-header lookup (the accessor behind `HttpRequestView.cookie`).
- Types: `PrincipalExtractor` (`(view) => Principal | null`, null = anonymous), `HttpRequestView` (`{method, path, headers, cookie}`), `BearerPrincipalExtractorOptions`, `TrustedHeaderPrincipalOptions`.

## Routing

- `defineHttpRoute({method, path, operation, status?, errorStatus?, mapRequest?}): HttpRouteOverride` — the only escape hatch; replaces the operation's auto routes.
- `compileRouteTable(operations, overrides?): CompiledRouteTable` — method-bucketed static/param tables.
- `matchRoute(table, method, path): MatchResult` — `matched | method_not_allowed (with allow) | not_found`; static-first precedence.
- `queryRecord(query): Record<string, string>` — first-value-wins query parsing.
- `EMPTY_PARAMS` — shared frozen empty params record.
- Types: `DefineHttpRouteOptions`, `HttpRouteOverride`, `HttpRequestContext` (`{method, path, params, query, body, headers}`), `CompiledRoute`, `CompiledRouteTable`, `MatchResult`, `RouteBucket`, `RouteSegment`, `BuildInput`, `Awaitable`, re-exported `HttpMethod`.

## Node host (root and `./node`)

- `serveNode(handler, {port, host?, maxBodyBytes?, gracefulTimeoutMs?, closeApplication?}): Promise<NodeHttpServer>` — raw `node:http` host; `port: 0` = ephemeral; `maxBodyBytes` default 1 MiB (413 above it).
- `NodeHttpServer` — `{server, url, close(): Promise<void>}`; `close()` drains in-flight requests up to `gracefulTimeoutMs` (default 10 000 ms), then destroys remaining sockets; with `closeApplication` it awaits `handler.app.close()` after the drain. Idempotent.
- Client disconnects abort the per-request signal wired into dispatch (`DISPATCH_ABORTED`); aborted requests never write to the socket.
- Types: `ServeNodeOptions`, `NodeHttpServer`.

## Envelope summary

completed ok ⇒ route/`http.status` ?? 200 with `{"ok":true,"value"}`; declared
error ⇒ per-error `http` ?? 422 with `{"ok":false,"error":{code,details}}`;
`INVALID_INPUT` 400 (with `issues`); `INVALID_JSON` 400; 401 via
`AuthenticationError`; `PERMISSION_DENIED` 403 (opaque, pre-body);
`NOT_FOUND` 404; `METHOD_NOT_ALLOWED` 405 + `Allow`; `PAYLOAD_TOO_LARGE` 413
(`serveNode`); faults 500 opaque `INTERNAL` + `onError`. Authored statuses
(`http.status`, per-error `http`, route `status`/`errorStatus`) must be
integers in 200..599 excluding 204/205/304 — the envelope always has a body.
The CORS preflight 204 is produced outside the envelope path and is the only
204 the adapter emits. Every response (envelope, health, preflight) carries
`x-request-id`. Streaming/SSE/multipart are out of scope by design —
terminate them at a proxy; bodies are JSON-only.
