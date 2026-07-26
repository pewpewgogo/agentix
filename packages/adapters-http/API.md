# `@agentix/adapters-http` API

Every public export, one line each. Entries: root (all), `./web` (edge-safe),
`./node` (`serveNode` only). Full guide: the repository's `docs/HTTP.md`.

## Handler

- `createHttpHandler(app, {authenticate?, onError?, routes?}?): HttpHandler` — compiles routes from operations' `http` metadata.
- `HttpHandler.fetch(request: Request): Promise<Response>` — Web/edge entry.
- `HttpHandler.handle(request: HandlerRequest): Promise<HandlerResponse>` — runtime-neutral engine for custom hosts.
- `HttpHandler.routes: CompiledRouteTable` — the compiled table.
- `RequestBodyLimitError` — throw from a custom host's `readBody` to answer 413.
- `JSON_CONTENT_TYPE` — `"application/json; charset=utf-8"`.
- Types: `CreateHttpHandlerOptions`, `HandlerRequest` (`HttpRequestView` + `query` + `readBody()`), `HandlerResponse` (`{status, body, headers?}`), `HttpErrorInfo`, `HttpErrorObserver`.

## Authentication

- `createBearerPrincipalExtractor({resolve(token, request)}): PrincipalExtractor` — 401 on malformed header; resolver decides trust.
- `createTrustedHeaderPrincipalExtractor({idHeader?, permissionsHeader?, separator?}?): PrincipalExtractor` — proxy-injected identity.
- `AuthenticationError(message?, code?)` — throw from an extractor for a 401 with `code` (default `"UNAUTHENTICATED"`).
- Types: `PrincipalExtractor` (`(view) => Principal | null`, null = anonymous), `HttpRequestView`, `BearerPrincipalExtractorOptions`, `TrustedHeaderPrincipalOptions`.

## Routing

- `defineHttpRoute({method, path, operation, status?, errorStatus?, mapRequest?}): HttpRouteOverride` — the only escape hatch; replaces the operation's auto routes.
- `compileRouteTable(operations, overrides?): CompiledRouteTable` — method-bucketed static/param tables.
- `matchRoute(table, method, path): MatchResult` — `matched | method_not_allowed (with allow) | not_found`; static-first precedence.
- `queryRecord(query): Record<string, string>` — first-value-wins query parsing.
- `EMPTY_PARAMS` — shared frozen empty params record.
- Types: `DefineHttpRouteOptions`, `HttpRouteOverride`, `HttpRequestContext` (`{method, path, params, query, body, headers}`), `CompiledRoute`, `CompiledRouteTable`, `MatchResult`, `RouteBucket`, `RouteSegment`, `BuildInput`, `Awaitable`, re-exported `HttpMethod`.

## Node host (root and `./node`)

- `serveNode(handler, {port, host?, maxBodyBytes?}): Promise<NodeHttpServer>` — raw `node:http` host; `port: 0` = ephemeral; `maxBodyBytes` default 1 MiB (413 above it).
- `NodeHttpServer` — `{server, url, close(): Promise<void>}`.
- Types: `ServeNodeOptions`, `NodeHttpServer`.

## Envelope summary

completed ok ⇒ route/`http.status` ?? 200 with `{"ok":true,"value"}`; declared
error ⇒ per-error `http` ?? 422 with `{"ok":false,"error":{code,details}}`;
`INVALID_INPUT` 400 (with `issues`); `INVALID_JSON` 400; 401 via
`AuthenticationError`; `PERMISSION_DENIED` 403 (opaque, pre-body);
`NOT_FOUND` 404; `METHOD_NOT_ALLOWED` 405 + `Allow`; `PAYLOAD_TOO_LARGE` 413
(`serveNode`); faults 500 opaque `INTERNAL` + `onError`.
