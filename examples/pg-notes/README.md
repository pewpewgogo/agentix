# pg-notes

A production-shaped notes service on `@agentix/core` + `@agentix/adapters-http`
backed by a **real PostgreSQL adapter** (`pg`). It is the canonical reference
for [docs/PERSISTENCE.md](../../docs/PERSISTENCE.md): adapter pattern,
lifecycle hooks, a transactional unit of work, bearer auth, structured logs,
health path, CORS, and graceful shutdown.

## Run it

```sh
# from the repo root
npm ci && npm run build

cd examples/pg-notes
docker compose up -d           # postgres:17-alpine on 127.0.0.1:55432
npm start                      # creates the pool + schema on app.start()
```

Environment (all optional): `PG_NOTES_DATABASE_URL` (default
`postgres://notes:notes@127.0.0.1:55432/notes`), `PORT` (3000),
`HOST` (127.0.0.1), `PG_NOTES_CORS_ORIGIN`.

```sh
curl -s http://127.0.0.1:3000/healthz            # liveness, no auth

curl -s -X POST http://127.0.0.1:3000/notes \
  -H 'authorization: Bearer writer-token' \
  -H 'content-type: application/json' \
  -d '{"id":"n1","title":"First","body":"hello"}'

curl -s http://127.0.0.1:3000/notes \
  -H 'authorization: Bearer reader-token'

curl -s -X POST http://127.0.0.1:3000/notes/n1/archive \
  -H 'authorization: Bearer writer-token'

curl -s http://127.0.0.1:3000/notes/archived \
  -H 'authorization: Bearer reader-token'
```

`DEMO_TOKENS` in `src/application.ts` maps `writer-token` / `reader-token` to
principals — a stand-in for a credential store or JWT verification. Unknown
tokens answer 401; a valid token without the needed permission answers 403
before the request body is read.

Stop with Ctrl+C or `kill -TERM <pid>`: the server drains in-flight requests
(up to `gracefulTimeoutMs`), then `app.close()` runs the adapter dispose hooks,
which end the pg pool.

## Layout

| File | What it shows |
| --- | --- |
| `src/features/notes.ts` | Store-shaped port hand-declared with `port()` (get/save/delete/list + transactional `archive`), operations, permissions, an event |
| `src/adapters/postgres.ts` | The port implemented over `pg` with parameterized SQL, `withTransaction`, and init/dispose lifecycle hooks |
| `src/application.ts` | Assembly: adapters, bearer authentication, health, CORS, structured `onError` |
| `src/observability.ts` | Console JSON `DispatchObserver` + the OTel wiring sketch |
| `src/server.ts` | `serveNode` with graceful shutdown and SIGTERM/SIGINT handling |

## Why a hand-declared port and not `port.store`?

The quartet keeps the `port.store` shape (`get`/`save`/`delete`/`list`) so a
memory fake stays trivial, but the SQL adapter carries semantics the generic
store cannot express: `save` is an `INSERT ... ON CONFLICT (id) DO UPDATE`
upsert (the primary key is the uniqueness authority), `archive` is an atomic
two-table move (BEGIN/COMMIT lives in the adapter), and the list operations
promise a stable `ORDER BY`. The trade-off: no free `.memory()` adapter and no
auto-faking by `createTestApplication` — the tests bind a small Map-backed
fake through `overrides` instead.

Known and documented: `notes.create` does a read-before-insert for its
friendly 409; two racing creates both pass the read and the upsert makes the
last write win. If that matters, make the insert itself the check (a
`claim`-style write returning `false` on conflict, e.g. over
`INSERT ... ON CONFLICT DO NOTHING`), as `examples/framework-app` does for
customers.

## Transactions: the unit-of-work pattern

`notes.archive` must move a row from `notes` to `notes_archive` atomically.
The domain calls **one effect** — `effects.archive({ id, archivedAt })` — and
stays plain. The adapter wraps DELETE + INSERT in `withTransaction`
(BEGIN → work → COMMIT, ROLLBACK + rethrow on failure, always `release()`).
Transaction scope is an adapter guarantee, deliberately not a framework
abstraction: the framework never sees a transaction handle, and an effect is
atomic exactly when its adapter says so.

## Tests (no live PostgreSQL needed)

```sh
node_modules/.bin/vitest run examples/pg-notes   # from the repo root
```

- `src/adapters/postgres.test.ts` — the SQL adapter against an in-memory fake
  of the `pg` Pool/PoolClient query surface: parameterized SQL text + values,
  BEGIN/COMMIT/ROLLBACK ordering on success and failure, lifecycle hooks.
- `src/features/notes.test.ts` — behavior through `createTestApplication`
  with the port overridden by memory fakes.
- `src/http.test.ts` — HTTP envelope, bearer auth (401/403), health, CORS
  preflight via `testHttp` (no sockets).
- `src/integration.test.ts` — the same service against **real** PostgreSQL;
  runs only when `PG_NOTES_DATABASE_URL` is set, skips cleanly otherwise:

```sh
docker compose up -d
PG_NOTES_DATABASE_URL=postgres://notes:notes@127.0.0.1:55432/notes \
  node_modules/.bin/vitest run examples/pg-notes/src/integration.test.ts
```
