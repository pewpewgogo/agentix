# Plain TypeScript commerce application

This package is the strong control implementation for the framework study. It
implements the shared commerce HTTP contract with strict TypeScript, Zod at
request boundaries, feature-oriented services, explicit constructor injection,
typed results, repository and gateway interfaces, and a small `Request` to
`Response` router. Like the framework implementation, it imports only the shared
public transport contract for route, permission, status, and error constants.
Production code does not import the experimental framework or use its compiler,
generated index, registry, dispatcher, or test helpers.

## Where behavior lives

- `src/features/customers`: customer schema, service, and routes.
- `src/features/products`: product schema, service, and routes.
- `src/features/orders`: order orchestration, routes, and the paid-order/payment
  invariant.
- `src/infrastructure`: detached in-memory persistence and the deterministic
  scripted payment gateway.
- `src/http/router.ts`: route matching, permission checks, JSON validation, and
  stable transport errors.
- `src/system.ts`: the explicit composition root and deterministic test seams.

Order creation checks customer status and stock before calling the payment
gateway. After approval it obtains the order ID and time, asserts the
cross-feature invariant, and atomically commits the stock decrement, paid order,
approved payment, and domain event. Generated IDs are trimmed and rejected when
empty before any local commit. Declines and invalid generated IDs leave local
state unchanged. Customer and product creation use per-entity atomic claims so a
concurrent duplicate is rejected before reading the clock without serializing
unrelated entity IDs.

## Verification

```sh
npm run typecheck --workspace @agentixdev/plain-app
npm test --workspace @agentixdev/plain-app
```

The package registers the implementation-independent acceptance suite from
`@agentixdev/shared-contract/acceptance`; focused tests additionally cover customer
boundaries and the cross-feature invariant.
