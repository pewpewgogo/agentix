# HTTP Adapter

`@agentix/adapters-http/web` is a small inbound adapter, not a second application
runtime. It maps explicit routes to an Agentix `Application` using Web-standard
`Request` and `Response` values. `@agentix/adapters-http/node` provides the
optional thin `node:http` host. The package root re-exports both for
compatibility.

## Define a route

```ts
import {
  defineHttpRoute,
  readJsonBody,
} from "@agentix/adapters-http/web";
import type { Infer } from "@agentix/core";

const createOrderRoute = defineHttpRoute({
  method: "POST",
  path: "/orders",
  operation: createOrder,
  mapRequest: async ({ request }) =>
    await readJsonBody(request) as Infer<typeof createOrder.input>,
  responses: {
    successStatus: 201,
    domainErrorStatuses: {
      CUSTOMER_NOT_FOUND: 404,
      PRODUCT_NOT_FOUND: 404,
      PAYMENT_DECLINED: 402,
    },
  },
});
```

`mapRequest` translates transport data into the operation input shape. The cast
does not bypass runtime validation: core parses the mapped value with the
operation's input schema before `execute` runs. Use `HttpInputError` for
transport-specific failures such as a missing header; operation-schema failures
should normally remain core `INVALID_INPUT` rejections.

Route methods can be upper- or lowercase forms of `DELETE`, `GET`, `HEAD`,
`OPTIONS`, `PATCH`, `POST`, and `PUT`. Paths:

- must start with `/` and cannot include a query or fragment;
- support one-segment parameters such as `/orders/:id`;
- expose decoded values through `context.params`;
- ignore one trailing slash during matching; and
- match the exact number of path segments.

Handler construction requires every route to reference the exact operation
descriptor registered by the application. A different descriptor that reuses a
stable ID is rejected before any request can be served.

Avoid overlapping static and parameter paths such as `/orders/new` and
`/orders/:id` for the same method. Route selection is declaration-ordered when
multiple shapes match. Duplicate method/shape declarations are rejected at
handler construction.

## Create the handler

```ts
const handler = createHttpHandler({
  application,
  routes: [createOrderRoute, getOrderRoute],
  principal: createBearerPrincipalExtractor({
    async resolve(token) {
      return identityService.resolvePrincipal(token);
    },
  }),
});
```

The request flow is:

1. Match the path and method.
2. Extract a principal.
3. Check the operation's permissions.
4. Run `mapRequest`.
5. Dispatch through core, which repeats the permission check defensively.
6. Run a custom `mapResponse` or the default response mapper.

Permission denial happens before parsing a body or calling `mapRequest`.

If no `principal` extractor is configured, the handler uses
`{ id: "anonymous", permissions: [] }`. You may override that value with
`anonymousPrincipal`, which is useful for truly public operations. Do not grant
privileged permissions to an anonymous principal in production.

## Authentication extractors

### Bearer tokens

`createBearerPrincipalExtractor` parses the `Authorization: Bearer ...` header
and delegates token verification to your `resolve` function. Agentix does not
choose a JWT library, key source, session store, or permission model.

- no authorization header or an unresolved token returns `null` and produces
  `401 UNAUTHENTICATED`;
- a malformed header throws `AuthenticationError` and produces a sanitized
  401 response; and
- a resolved principal proceeds to the operation permission check.

### Trusted proxy headers

`createTrustedHeaderPrincipalExtractor` reads `x-principal-id` and a comma-
separated `x-principal-permissions` header by default. It is safe only behind a
trusted proxy that strips all client-supplied identity headers and inserts
verified replacements. Never expose this extractor directly to untrusted
clients.

Header names and the separator are configurable.

## Default response mapping

Without `mapResponse`, `mapDispatchResult` produces JSON with these defaults:

| Result | Status | Body shape |
| --- | ---: | --- |
| Completed success | `responses.successStatus` or 200 | `{ "ok": true, "value": ... }` |
| Completed domain error | per-code status, `domainErrorStatus`, or 422 | `{ "ok": false, "error": ... }` |
| Invalid operation input | 400 | `{ "ok": false, "error": { "code": "INVALID_INPUT", ... } }` |
| Missing permission | 403 | `{ "ok": false, "error": { "code": "PERMISSION_DENIED", ... } }` |
| Unknown operation | 404 | rejected-error envelope |
| Dispatch fault | 500 | sanitized `INTERNAL_ERROR` envelope |

Framework fault details and exception causes are not sent to the client.
Successful and domain-error responses contain the core `Outcome`, not the outer
dispatch kind or trace.

The handler itself additionally returns:

- 401 for missing/failed authentication when an extractor is configured;
- 404 `ROUTE_NOT_FOUND` when no path matches;
- 405 `METHOD_NOT_ALLOWED` with a sorted `Allow` header when the path exists for
  another method; and
- 500 with sanitized details when route mapping fails unexpectedly.

`readJsonBody` reports malformed JSON as `400 INVALID_JSON`. It does not enforce
a `Content-Type` header.

## Custom response mapping

Use `mapResponse` when your public API needs a different envelope. It receives
the complete `DispatchResult` and route context:

```ts
const route = defineHttpRoute({
  method: "POST",
  path: "/orders",
  operation: createOrder,
  mapRequest: async ({ request }) =>
    await readJsonBody(request) as Infer<typeof createOrder.input>,
  mapResponse(result) {
    if (result.kind === "completed" && result.outcome.ok) {
      return jsonResponse({ ok: true, data: result.outcome.value }, 201);
    }
    if (result.kind === "completed") {
      return jsonResponse({ ok: false, error: result.outcome.error }, 422);
    }
    return mapDispatchResult(result);
  },
});
```

The commerce example uses a custom mapper so both study applications expose the
same `{ ok, data | error }` contract. That envelope is application-specific and
is not Agentix's default.

## Run with Node HTTP

```ts
import { createServer } from "node:http";
import { createNodeHttpListener } from "@agentix/adapters-http/node";

const server = createServer(createNodeHttpListener(handler, {
  maxBodyBytes: 1_048_576,
  trustForwardedProto: false,
}));

server.listen(3000, "127.0.0.1");
```

`createNodeHttpListener` returns a listener; it does not create, start, or close
a server. The default body limit is one mebibyte. Requests and responses are
buffered, so this host is not suitable for streaming or large uploads.

The listener uses `http` unless `trustForwardedProto` is enabled. Enable that
option only when a trusted proxy controls `x-forwarded-proto`. `fallbackOrigin`
is used only when a Node request has no `Host` header.

## Production ownership

The adapter intentionally does not provide TLS termination, compression, CORS,
rate limiting, access logs, request IDs, graceful shutdown, streaming, or proxy
trust policy. Add these explicitly in the host or trusted edge, and test them as
part of the deployed application.

For a complete route set and custom response contract, see
[`examples/framework-app/src/application.ts`](../examples/framework-app/src/application.ts).
