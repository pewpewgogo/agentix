# Persistence

How to put a real database behind an Agentix application. The canonical,
runnable reference is [`examples/pg-notes`](../examples/pg-notes) — a notes
service over PostgreSQL (`pg`) with unit, behavior, and gated integration
tests. This page names the patterns it uses.

## The adapter pattern

Persistence enters the domain only as a port. The domain declares what it may
do; one adapter per port implements it; the framework validates every effect
input and output crossing that line ([Core Concepts](CORE_CONCEPTS.md)).

Two ways to declare a store port:

- **`port.store(id, schema)`** when generic CRUD is enough: you get
  `get/save/delete/list`, a free `.memory()` adapter, and auto-faking in
  `createTestApplication`.
- **A hand-declared `port(id, { ... })`** when the SQL carries semantics of
  its own. `pg-notes` does this: `save` is an `INSERT ... ON CONFLICT (id) DO
  UPDATE` upsert, `archive` is a transactional two-table move, the list
  operations promise a stable `ORDER BY`. Keep the `get/save/delete/list`
  shape so a memory fake stays a page of code — but expect to bind that fake
  yourself (`overrides` / a memory adapter); only true `port.store` ports are
  auto-faked.

Write the adapter against the minimal query surface it actually uses, not
against the driver's full API (`SqlPool`/`SqlClient` in
[`postgres.ts`](../examples/pg-notes/src/adapters/postgres.ts)). Production
binds `pg.Pool` to that seam; unit tests bind a scripted fake. Every statement
is parameterized — values travel in `$1, $2, ...` vectors, never in the SQL
text.

## Lifecycle: pool create / end

Adapters take `{ init, dispose }` hooks (`Port.adapter(impl, hooks)`):

```ts
NoteStore.adapter(handlers, {
  init: async () => {
    pool = createPostgresPool(databaseUrl); // constructing a Pool opens nothing
    await pool.query(SCHEMA_SQL);           // bootstrap; real apps: migrations
  },
  dispose: async () => { await pool?.end(); },
});
```

`app.start()` runs init hooks in registration order — connect before traffic,
fail fast when the database is unreachable. `app.close()` runs dispose hooks
in reverse order. Neither is automatic: the host calls both. With
`serveNode(handler, { gracefulTimeoutMs, closeApplication: true })`, `close()`
first drains in-flight HTTP requests, then closes the app — dispose never runs
while a request is mid-dispatch ([HTTP](HTTP.md)). A SIGTERM handler calling
`server.close()` completes the story
([`server.ts`](../examples/pg-notes/src/server.ts)).

Schema bootstrap in `init` is an example-sized convenience. A production
service should own DDL with a migration tool (node-pg-migrate, Flyway,
Atlas, ...) run as a deploy step, keeping `init` to pool creation and maybe a
version assertion.

## Transactions: the unit-of-work recipe

The framework has no transaction abstraction — deliberately. A dispatch is not
a transaction; effects are plain async calls. When several statements must be
atomic, make them **one effect** whose adapter owns the transaction:

```ts
// Domain: one call, no client, no BEGIN.
const archived = await effects.archive({ id, archivedAt });

// Adapter: the scope lives here.
archive: (input) => withTransaction(pool, async (tx) => {
  const removed = await tx.query("DELETE FROM notes WHERE id = $1 RETURNING ...", [input.id]);
  if (removed.rows[0] === undefined) return undefined;
  await tx.query("INSERT INTO notes_archive ... VALUES ($1, ...)", [...]);
  return ...;
}),
```

`withTransaction` checks out one client, runs `BEGIN` → work → `COMMIT`,
rolls back and rethrows on failure, and always releases the client. An
adapter throw surfaces as an `EFFECT_FAILURE` fault (HTTP 500) — after the
rollback, so state is consistent even when the response is an error.

Honest limits of the pattern:

- Atomicity spans **one effect call**. A command calling two write effects is
  two transactions; if that's wrong, redesign it as one effect (as
  `notes.archive` does) or accept a compensation step (as
  `examples/framework-app`'s `customers.create` does with `releaseClaim`).
- Domain code stays plain because it never sees the transaction. The cost is
  that transactional composition is an adapter-level decision, not something
  callers can request per dispatch.
- Cross-port transactions require the ports to share an adapter-level
  unit-of-work — at that point, merge the ports.

## Events and the outbox (sketch)

Operations emit validated events, but the framework neither persists nor
publishes them — a completed dispatch *returns* them, and in-process
`subscribers` are read-model conveniences, not durable delivery. To publish
reliably alongside a database write, use a transactional outbox at the
adapter level:

1. Give the atomic effect the event data it should make durable
   (`archive: { id, archivedAt }` already carries it), and INSERT a row into
   an `outbox` table inside the same `withTransaction` as the state change.
2. A relay (poller or logical decoding) reads `outbox`, publishes to the
   broker, and marks rows done. At-least-once; consumers deduplicate on the
   event id.
3. The dispatch's returned `events` remain the in-process truth for tests and
   subscribers; the outbox row is the cross-process truth.

The framework's stance stays: durable delivery belongs to the caller — the
outbox is adapter SQL plus a relay process, no framework hook required.

## Testing strategy

Three layers, only the last needing a server
([`examples/pg-notes` tests](../examples/pg-notes)):

| Layer | Binds | Asserts |
| --- | --- | --- |
| Adapter unit tests | Fake pg `Pool`/`PoolClient` (records `query(text, values)`) | Exact parameterized SQL + values; `BEGIN/COMMIT/ROLLBACK` ordering on success and failure; client release; init/dispose behavior |
| Behavior tests | `createTestApplication` with the port overridden by memory fakes | Domain outcomes, declared errors, permissions, emitted events — through the real dispatcher |
| Integration tests | Real PostgreSQL, gated by an env var (`describe.skipIf`) | Schema bootstrap, ISO/timestamptz round-trips, real rollback (e.g. occupy a PK so the transaction's INSERT fails, then observe the DELETE undone) |

Guidelines:

- The fake implements the **seam interface** (`SqlPool`), not all of `pg`;
  scripted responses keyed on the statement text keep tests declarative.
- Gate integration on the env var and skip *cleanly* when absent, so `npm
  test` never needs infrastructure:
  `describe.skipIf(process.env["PG_NOTES_DATABASE_URL"] === undefined)`.
- `defineAdapterContract`/`runAdapterContract` (see [Testing](TESTING.md)) can
  run one behavioral contract against both the memory fake and the SQL
  adapter, keeping them semantically aligned.

## Checklist for a new database adapter

1. Declare the port with realistic operation semantics (kinds gate query
   purity; outputs model expected alternatives — `undefined`, unions).
2. Implement handlers over a minimal query seam; parameterize everything.
3. Wrap multi-statement invariants in `withTransaction` inside one effect.
4. Put pool creation + `end()` in `init`/`dispose`; let the host drive
   `start()`/`close()` (serveNode: `closeApplication: true`).
5. Unit-test SQL against a fake pool; behavior-test with memory fakes;
   integration-test behind an env gate.
6. Migrations via a real tool; observer for structured logs/OTel
   ([Core Concepts § Observability](CORE_CONCEPTS.md#observability)).
