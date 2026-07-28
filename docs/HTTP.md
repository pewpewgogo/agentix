# HTTP Adapter

`@agentixdev/adapters-http` maps operations to HTTP automatically. Routes are
derived from each operation's `http` metadata; the response envelope is fixed;
`defineHttpRoute` is the only escape hatch. Entries: the package root exports
everything, `./web` is the edge-safe subset (no Node built-ins), `./node`
exports the raw Node host.

## Handler

```ts
import { createHttpHandler } from "@agentixdev/adapters-http";

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
- `handler.app` — the application the handler serves (hosts use it, e.g.
  `serveNode`'s `closeApplication`).

Options: `{ authenticate?, onError?, routes?, health?, cors?,
responseHeaders? }`.

Request flow (both entries): CORS preflight / health short-circuit → route
match → `authenticate` → `app.authorize()` (the EFFECTIVE gate — a custom
`createApplication({ authorize })` hook is honored here; 403 BEFORE the body
is read) → read body → JSON parse → input mapping → dispatch (with `meta:
{ requestId }` and the request's abort signal) → envelope. A throwing
authorize hook answers 500 + `onError`.

## Request ids

Every request gets a `requestId`: a valid inbound `x-request-id` header
(matching `/^[\w.-]{1,64}$/`) is adopted; anything else (absent, too long,
unexpected characters) is replaced with `crypto.randomUUID()`. The id is:

- echoed as the `x-request-id` response header on EVERY response — including
  404, 405, 500, health, and CORS preflight;
- passed to `app.dispatch` as `meta: { requestId }`, so a configured
  `DispatchObserver` sees it in `dispatchStarted`/`dispatchSettled` for
  correlation (spans, logs);
- included in every `onError` info object (`{ method, path, requestId,
  operationId? }`).

## Health

`health: "/healthz"` registers a liveness endpoint: `GET /healthz` answers
`200 {"ok":true}` without authentication, authorization, or dispatch (load
balancers keep probing while credentials rotate). The path is validated like
a route — a conflict with an existing GET route (static or param) throws at
build time. Non-GET methods on the health path answer 405 with `allow: GET`.

## CORS

```ts
const handler = createHttpHandler(app, {
  cors: {
    origins: ["https://app.example"], // or "*"
    methods: ["GET", "POST"],          // default: the app's route methods
    headers: ["content-type"],         // default: echo the requested headers
    credentials: true,                 // adds allow-credentials, echoes origin
    maxAgeSeconds: 600,
  },
});
```

With `cors` configured, `OPTIONS` requests carrying `origin` and
`access-control-request-method` are answered as preflight: status **204**
with the `Access-Control-*` headers when the origin matches, and a bare 204
(no CORS headers — the browser then blocks) when it does not. Preflight is
answered on route hits AND misses, because browsers preflight the real path
before the request that would 404. This preflight is the ONLY 204 the
adapter ever produces and it bypasses the JSON envelope; operation statuses
still reject 204/205/304 — that validation is not relaxed.

Non-preflight responses (including 404/405/500 and health) carry
`access-control-allow-origin` (plus `vary: origin` and
`access-control-allow-credentials` when applicable) whenever the request's
`Origin` matches. `origins: "*"` answers a literal `*` unless `credentials`
is set, in which case the origin is echoed (the spec forbids `*` with
credentials).

## Response headers hook

```ts
const handler = createHttpHandler(app, {
  responseHeaders: ({ operationId, status, requestId }) =>
    status === 200 && operationId === "session.login"
      ? { "set-cookie": "sid=...; HttpOnly; Secure" }
      : undefined,
});
```

`responseHeaders` runs for every envelope response (and health; not for CORS
preflight) and its result is merged onto the response. `content-type`,
`content-length`, and `x-request-id` are protected — the hook cannot
override them (framework-managed CORS headers also win on conflict). A
throwing hook degrades that response to an opaque 500 + `onError`.

## Cookies

The authentication view exposes `cookie(name: string): string | undefined`.
The `Cookie` header is parsed lazily, at most once per request, on first
access: pairs split on `;`, names/values trimmed, quoted values unquoted,
percent-decoding applied when valid (kept raw otherwise), malformed pairs
(no `=`, empty name) skipped, first occurrence of a name wins.

```ts
const handler = createHttpHandler(app, {
  authenticate: async (request) => {
    const sid = request.cookie("session");
    return sid === undefined ? null : resolveSession(sid);
  },
});
```

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

Because the envelope always has a body, every authored status — `http.status`,
per-error `http`, and `defineHttpRoute`'s `status`/`errorStatus` — must be an
integer in 200..599 **excluding 204, 205, and 304** (RFC 9110 forbids bodies
on those; 1xx responses are informational and rejected too). Statuses outside
that contract throw a `TypeError` at authoring time. The CORS preflight 204
is not an exception to this rule: it is produced outside the envelope path
and no operation response can ever be 204.

`onError?: (error, { method, path, requestId, operationId? }) => void`
observes faults and unexpected authenticate throws; the default logs via
`console.error` in development mode only. `path` is always the request
pathname (never the full URL), `requestId` matches the `x-request-id`
response header, and `operationId` is present whenever a route matched.

## Input mapping

For object input schemas the default mapping merges, keyed by the schema's
shape, with precedence body < query < path params. String params/query values
are coerced to the schema's number/boolean/literal expectations (unions are
not coerced). Strict schemas still reject unknown body keys. Non-object input
schemas receive the parsed body verbatim. A present non-object JSON body
(array, string, number, boolean, `null`) on an object-schema route is never
silently discarded: it is handed to the schema verbatim, so the request
answers 400 `INVALID_INPUT` with an `invalid_type` issue.

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
} from "@agentixdev/adapters-http";

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
import { defineHttpRoute } from "@agentixdev/adapters-http";

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
import { serveNode } from "@agentixdev/adapters-http";

const server = await serveNode(handler, {
  port: 3000,          // 0 = ephemeral; server.url reflects the real port
  host: "127.0.0.1",   // default
  maxBodyBytes: 262_144, // default 1 MiB; exceeding answers 413
  gracefulTimeoutMs: 10_000, // default; drain window for close()
  closeApplication: true,    // default false; close() awaits app.close()
});
await server.close();
```

### Graceful shutdown

`server.close()` is a graceful, idempotent drain:

1. The server stops accepting new connections and destroys idle keep-alive
   sockets immediately; new connection attempts are refused.
2. In-flight requests get up to `gracefulTimeoutMs` (default 10 000 ms) to
   complete; their responses are sent with `connection: close` so finished
   sockets never linger.
3. When the timeout expires, the remaining sockets are destroyed.
4. With `closeApplication: true`, `handler.app.close()` is awaited AFTER the
   drain — adapter `dispose` hooks never run while a request may still be
   mid-dispatch on this host. `createApplication` and `serveNode` never
   auto-`start()` the app; call `app.start()` yourself before serving.

Repeat `close()` calls return the same promise.

### Client aborts

Every request gets an `AbortController` wired to the client socket: when the
client disconnects before the response is finished, the controller aborts
and its signal — which was passed to `app.dispatch` — cancels the dispatch
cooperatively (fault `DISPATCH_ABORTED`, observable via the dispatch
observer). Aborted requests never write to the socket. The Web entry
forwards `Request.signal` to dispatch the same way.

Edge/workers — export the Web entry directly:

```ts
export default { fetch: (request: Request) => handler.fetch(request) };
```

Note: `maxBodyBytes` is a `serveNode` option. `handler.fetch` enforces no body
cap of its own — edge runtimes cap requests upstream; custom hosts can throw
`RequestBodyLimitError` from `readBody` to produce a 413. When the cap trips
mid-stream (chunked upload, or bytes streaming past a declared length), the
413 answers with `connection: close` and the socket is destroyed once the
response flushes, so leftover body bytes can never be misread as a pipelined
request; a cap hit on the declared `content-length` alone keeps the
connection reusable.

## Routing details

Static segments win over params deterministically (`/notes/export` beats
`/notes/:id`); param values are percent-decoded; malformed percent-encoding
skips that candidate rather than failing the request; trailing slashes are
normalized; `405 Allow` is computed from the other method buckets. Custom
hosts can use `compileRouteTable`/`matchRoute`/`queryRecord` directly.

## Scope: what this adapter will not do

Explicit stance, so nobody waits for a roadmap item:

- **Streaming, SSE, WebSockets, and multipart are out of scope in-process.**
  Operations are request/response with validated JSON on both sides — that
  contract is what makes the envelope, testing story, and benchmarks exact.
  Terminate streaming protocols and file uploads at a proxy or a sidecar
  (nginx, Envoy, a dedicated upload service) and hand the operation the
  resulting JSON (e.g. an object-storage key), or run a separate
  purpose-built server next to this one.
- **JSON-only bodies by design.** There is no content negotiation, no form
  decoding, and no binary body support; `content-type` is always
  `application/json; charset=utf-8`. Anything else belongs in front of, not
  inside, the adapter.

This keeps the in-process surface small enough to stay fully specified:
every byte either fits the envelope or is answered by one of the documented
status codes.
