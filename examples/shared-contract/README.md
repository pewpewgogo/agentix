# Shared commerce contract

This package is the application-independent oracle used by both example arms.
It owns only public data types and black-box Vitest scenarios. It imports
neither the framework nor either commerce implementation.

Production code may import pure types and constants from
`@agentixdev/shared-contract`. Tests register the reusable suite from
`@agentixdev/shared-contract/acceptance`:

```ts
import { defineCommerceAcceptance } from "@agentixdev/shared-contract/acceptance";
import { createCommerceSystem } from "../src/index.js";

defineCommerceAcceptance("plain app", createCommerceSystem);
```

## HTTP surface

Every response is JSON with `content-type: application/json`. Successes use
`{ "ok": true, "value": ... }`. Domain failures use
`{ "ok": false, "error": { "code": "...", "details": { ... } } }`. Transport
failures are opaque `{ "ok": false, "error": { "code": "..." } }`, except
`INVALID_INPUT`, which adds a non-empty implementation-defined `issues` array.

Known routes require a non-blank `x-principal-id` and the route permission in
the comma-separated `x-permissions` header. Permission entries are trimmed.
A missing or insufficient principal yields the opaque 403 `PERMISSION_DENIED`.
Unknown paths return 404 `NOT_FOUND`; known paths with a wrong method return
405 `METHOD_NOT_ALLOWED` with an `Allow` header, both before authentication.
Authorization is resolved before request-body parsing. Malformed
percent-encoded paths never match a parameterized route and return
404 `NOT_FOUND`.

| Method and path | Permission | Input | Success |
| --- | --- | --- | --- |
| `POST /customers` | `customers:create` | `{ id, name, status? }` | `201 Customer` |
| `GET /customers/:id` | `customers:read` | none | `200 Customer` |
| `POST /products` | `products:create` | `{ id, name, unitPriceCents, stock }` | `201 Product` |
| `GET /products/:id` | `products:read` | none | `200 Product` |
| `POST /orders` | `orders:create` | `{ customerId, productId, quantity }` | `201 Order` |
| `GET /orders/:id` | `orders:read` | none | `200 Order` |
| `GET /events` | `events:read` | none | `200 CommerceEvent[]` |

Request objects are strict. IDs and names are trimmed and must then be
non-empty. `unitPriceCents` and `quantity` are positive safe integers; `stock`
is a non-negative safe integer. Customer status is `active` (the default) or
`suspended`. Unknown properties and invalid values return 400 `INVALID_INPUT`
with `issues`; a body that is not parseable JSON returns 400 `INVALID_JSON`.

## Order transaction

An authorized, valid order resolves the customer and product, rejects a
suspended customer or insufficient stock, then consumes one scripted payment
outcome. A decline returns `PAYMENT_DECLINED` without changing local state.
An approval obtains the next order ID and current time, then atomically:

- decrements stock;
- stores a paid order;
- stores an approved payment named `payment:<orderId>`; and
- stores an `order.created` event named `event:order.created:<orderId>`.

Thus every paid order has a corresponding approved payment. Missing or
exhausted payment scripts approve by default. Authorization, validation,
missing resources, suspension, and stock failures consume no scripted payment,
order ID, or time and produce no state changes. Customer and product creation
consume time only after all validation, authorization, and duplicate checks.
Concurrent duplicate losers consume no time. A blank generated order ID is an
internal failure and commits no local state.

`snapshot()` returns all records in insertion order as a detached value; callers
cannot mutate system state through a prior snapshot. Each factory invocation is
an isolated, initially empty system. Without an injected clock, both examples
use the fixed instant `2030-01-01T00:00:00.000Z` so their default behavior is
reproducible.
