# HTTP Adapter

`@agentix/adapters-http` maps operations to HTTP automatically. Routes are
derived from each operation's `http` metadata; the response envelope is fixed;
`defineHttpRoute` is the only escape hatch. Entries: the package root exports
everything, `./web` is the edge-safe subset (no Node built-ins), `./node`
exports the raw Node host.

## Handler

```ts
import { createHttpHandler } from "@agentix/adapters-http";

const handler = createHttpHandler(app);
```

`createHttpHandler(app, options?)` compiles a route table from every registered
operation carrying `http` metadata (conflicts already failed at
`createApplication`). The result is an object:

- `handler.fetch(request: Request): Promise<Response>` — Web entry; works on
  edge runtimes and in tests.
- `handler.handle(request: HandlerRequest): Promise<HandlerResponse>` — the
  runtime-neutral engine (plain strings, no `Request` construction); used by
  `serveNode` and custom hosts.
- `handler.routes` — the compiled route table.

Options: `{ authenticate?, onError?, routes? }`.

Request flow (both entries): route match → `authenticate` → core
`authorize()` (403 BEFORE the body is read) → read body → JSON parse →
input mapping → dispatch → envelope.

## Envelope

Every response is `application/json; charset=utf-8`.

| Case | Status | Body |
| --- | --- | --- |
| Completed, `outcome.ok` | route `status` ?? `http.status` ?? 200 | `{"ok":true,"value":...}` |
| Completed, declared error | per-error `http` ?? 422 | `{"ok":false,"error":{"code":...,"details":...}}` |
| Invalid input (rejected) | 400 | `{"ok":false,"error":{"code":"INVALID_INPUT","issues":[...]}}` |
| Malformed JSON body | 400 | `{"ok":false,"error":{"code":"INVALID_JSON"}}` |
| Authentication threw `AuthenticationError` | 401 | `{"ok":false,"error":{"code":<error.code, default "UNAUTHENTICATED">}}` |
| Permission denied (pre-body or dispatch) | 403 | `{"ok":false,"error":{"code":"PERMISSION_DENIED"}}` (opaque, no detail leak) |
| No route for path | 404 | `{"ok":false,"error":{"code":"NOT_FOUND"}}` |
| Path exists, wrong method | 405 + `Allow` header | `{"ok":false,"error":{"code":"METHOD_NOT_ALLOWED"}}` |
| Body over cap (`serveNode`) | 413 | `{"ok":false,"error":{"code":"PAYLOAD_TOO_LARGE"}}` |
| Fault (defect) | 500 | `{"ok":false,"error":{"code":"INTERNAL"}}` (opaque) + `onError` |

`onError?: (error, { method, path, operationId? }) => void` observes faults and
unexpected authenticate throws; the default logs via `console.error` in
development mode only.

## Input mapping

For object input schemas the default mapping merges, keyed by the schema's
shape, with precedence body < query < path params. String params/query values
are coerced to the schema's number/boolean/literal expectations (unions are
not coerced). Strict schemas still reject unknown body keys. Non-object input
schemas receive the parsed body verbatim.

## Authentication

`authenticate` is opt-in. Absent, every request is anonymous — operations
without `permissions` still work (rejections happen per-operation via
`authorize`). Returning `null` also means anonymous (403 comes later if the
operation requires permissions); throw `AuthenticationError` for malformed
credentials (401):

```ts
import {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createHttpHandler,
} from "@agentix/adapters-http";

const bearer = createBearerPrincipalExtractor({
  resolve: async (token) =>
    token === "s3cret" ? { id: "cli", permissions: ["notes:write"] } : null,
});

const handler = createHttpHandler(app, { authenticate: bearer });
```

Also available: `createTrustedHeaderPrincipalExtractor({ idHeader?,
permissionsHeader?, separator? })` for proxy-injected identity, or any
`(request: HttpRequestView) => Principal | null` function. The permission
check runs before the request body is read in all cases.

## Route overrides

`defineHttpRoute` remaps an operation (replacing its auto-derived routes) or
exposes an operation that has no `http` metadata:

```ts
import { defineHttpRoute } from "@agentix/adapters-http";

const handler = createHttpHandler(app, {
  routes: [
    defineHttpRoute({
      method: "GET",
      path: "/api/notes/:noteId",
      operation: notes.operations.get,
      mapRequest: ({ params }) => ({ id: params["noteId"] ?? "" }),
    }),
  ],
});
```

Options: `method`, `path`, `operation` (must be a descriptor registered in the
app), `status?`, `errorStatus?` (merged over the declared per-error statuses),
`mapRequest?(context)`. `mapRequest` runs after the central body read — the
403-before-body guarantee cannot be broken by an override. There is no
`mapResponse`; the envelope is fixed.

## Hosts

Node (raw `node:http`, no per-request `Request` allocation):

```ts
import { serveNode } from "@agentix/adapters-http";

const server = await serveNode(handler, {
  port: 3000,          // 0 = ephemeral; server.url reflects the real port
  host: "127.0.0.1",   // default
  maxBodyBytes: 262_144, // default 1 MiB; exceeding answers 413
});
await server.close();
```

Edge/workers — export the Web entry directly:

```ts
export default { fetch: (request: Request) => handler.fetch(request) };
```

Note: `maxBodyBytes` is a `serveNode` option. `handler.fetch` enforces no body
cap of its own — edge runtimes cap requests upstream; custom hosts can throw
`RequestBodyLimitError` from `readBody` to produce a 413.

## Routing details

Static segments win over params deterministically (`/notes/export` beats
`/notes/:id`); param values are percent-decoded; malformed percent-encoding
skips that candidate rather than failing the request; trailing slashes are
normalized; `405 Allow` is computed from the other method buckets. Custom
hosts can use `compileRouteTable`/`matchRoute`/`queryRecord` directly.
