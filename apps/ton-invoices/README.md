# ton-invoices

A TON payment-request (invoice) API on `@agentixdev/core` + `@agentixdev/adapters-http`:
create an invoice, hand the payer its `ton://` deep link, and let the
reconcile poller watch the chain (toncenter v3) until a transfer with the
invoice's comment tag and a sufficient amount arrives — then the invoice is
marked paid **atomically** (paid + recorded transfer + advanced cursor in one
transaction) and an `invoice.paid` event fans out to a webhook or Telegram.

Amounts are **nanotons as decimal strings** end to end (never floats).
Matching requires `transfer.amount >= invoice.amount`, enforced in production
by the guarded settle SQL (`WHERE ... AND paid >= amount_nano`) plus a
database `CHECK (paid_amount_nano >= amount_nano)`; the operation's `ensures`
postcondition re-checks it as a dev/test-only regression guard (ensures do
not run in production mode). Expiry is decided against the payment's
**on-chain time** (toncenter `now`), not the poller's wall clock, so a
payment made while the invoice was open still settles when the poll that
observes it runs late (`EXPIRY_GRACE_MS` adds slack).

**A transfer below the invoice amount is NOT accumulated and NOT refunded
automatically.** Every transfer the reconcile cannot settle — partial
payments (`underpaid`), a second payment for an already-paid invoice
(`duplicate`), payments after expiry or for a cancelled invoice
(`invoice_not_open`), unknown comment tags (`no_match`) — is persisted to
`unattributed_transfers` **before** the watcher cursor moves past it, emitted
as an `invoice.transferUnattributed` event, and listed at
`GET /invoices/transfers/unattributed` for manual refund/credit. Received
funds are never invisible.

## Run it

```sh
# from the repo root
npm ci && npm run build

cd apps/ton-invoices
docker compose up -d           # postgres:17-alpine on 127.0.0.1:55433
RECEIVE_ADDRESS=UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2 \
ADMIN_TOKEN=admin-token \
DATABASE_URL=postgres://ton_invoices:ton_invoices@127.0.0.1:55433/ton_invoices \
npm start
```

| Env | Required | Meaning |
| --- | --- | --- |
| `RECEIVE_ADDRESS` | yes | TON address invoices are payable to (in every `ton://` link; watched on chain) |
| `ADMIN_TOKEN` | yes | Bearer token granting `invoices:create/read/cancel/reconcile` |
| `DATABASE_URL` | no | `postgres://...`; omitted = in-memory persistence |
| `TONCENTER_API_KEY` | no | X-API-Key for toncenter (anonymous ≈ 1 req/s is fine at default polling) |
| `TONCENTER_ENDPOINT` | no | Default `https://toncenter.com/api/v3` (point at testnet if needed) |
| `INVOICE_TTL_MS` | no | How long an invoice stays payable; default 900000 (15 min) |
| `EXPIRY_GRACE_MS` | no | Slack past expiry within which an ON-CHAIN payment time still settles; default 0 |
| `POLL_MS` | no | Reconcile poll interval; default 10000 |
| `NOTIFY_WEBHOOK_URL` | no | POST target for `invoice.paid` notifications |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | no | Telegram sendMessage variant (webhook wins if both set) |
| `PORT` / `HOST` / `CORS_ORIGIN` | no | 3000 / 127.0.0.1 / CORS **off** unless set |

```sh
curl -s http://127.0.0.1:3000/healthz              # liveness, no auth

curl -s -X POST http://127.0.0.1:3000/invoices \
  -H 'authorization: Bearer admin-token' \
  -H 'content-type: application/json' \
  -d '{"amountNano":"1500000000","memo":"coffee"}'
# -> 201 {"ok":true,"value":{"id":"...","comment":"inv-3f45647149ea63f45647149ea6","status":"pending",
#    "paymentLink":"ton://transfer/UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2?amount=1500000000&text=inv-...",...}}

curl -s http://127.0.0.1:3000/invoices/<id>        # public: payers poll status
curl -s 'http://127.0.0.1:3000/invoices?status=pending' -H 'authorization: Bearer admin-token'
curl -s -X POST http://127.0.0.1:3000/invoices/<id>/cancel -H 'authorization: Bearer admin-token'
curl -s -X POST http://127.0.0.1:3000/invoices/reconcile -H 'authorization: Bearer admin-token'  # manual poll
curl -s http://127.0.0.1:3000/invoices/transfers/unattributed -H 'authorization: Bearer admin-token'  # funds needing manual action
```

The payer opens `paymentLink` in a wallet; the comment tag `inv-...` in the
transfer is what ties the payment back to the invoice. A pending invoice past
its TTL *presents* as `expired` on reads immediately; the next reconcile run
persists the sweep. Cancel conflicts (409 `INVOICE_NOT_PENDING`) once the
invoice is paid or cancelled.

Stop with Ctrl+C or `kill -TERM <pid>`: the poller stops, in-flight requests
drain, then `app.close()` ends the pg pool.

## Layout

| File | What it shows |
| --- | --- |
| `src/features/invoices.ts` | The whole domain: schemas, ports (store, config, clock, ids, chainWatcher, notifier), operations, `invoice.paid` / `invoice.transferUnattributed` events, ensures |
| `src/adapters/postgres.ts` | invoices/transfers/unattributed_transfers/watcher_cursor tables, parameterized SQL, `withTransaction` settle + recordUnmatched, init/dispose pool lifecycle |
| `src/adapters/toncenter.ts` | ChainWatcher over toncenter v3 `/transactions`; strict per-field validation with per-transaction quarantine (one bad tx never stalls the page) |
| `src/adapters/notify.ts` / `memory.ts` | Webhook + Telegram notifiers; memory fakes mirroring SQL semantics |
| `src/app.ts` | Assembly: adapters, console-JSON observer (requestId-correlated), the `invoice.paid` → `invoices.notifyPaid` subscriber, digest-keyed bearer auth handler, the reconcile poller (overlap guard + consecutive-failure alert) |
| `src/server.ts` | Env validation, `serveNode`, poller wiring, graceful shutdown |

Reconcile is idempotent by construction: transfers at or below the stored
cursor are dropped, `settle` only flips a *still-pending* invoice inside its
transaction, and the transfers PRIMARY KEY refuses a double-recorded tx hash —
the same transfer delivered twice can never double-pay. The cursor only moves
past a transfer inside the same transaction that records it (settle or
recordUnmatched), and a transaction the toncenter parser rejects is
quarantined per transaction (reported + logged with its `$.transactions[i]`
path) instead of failing the page, so one poison transaction cannot pin the
cursor and freeze payment crediting; three consecutive failed polls escalate
to a `reconcile.stalled` log line.

## Tests (no live PostgreSQL or network needed)

```sh
node_modules/.bin/vitest run apps/ton-invoices        # from the repo root
```

Dispatch-level behavior (fake chain drives pay/expire/cancel/idempotence),
HTTP envelope + auth (401/403/404/409/param routes), pg adapter SQL +
BEGIN/COMMIT/ROLLBACK ordering over a fake pool, toncenter parsing over
stubbed fetch. Integration against real PostgreSQL is env-gated and skips
cleanly:

```sh
docker compose up -d
TON_INVOICES_DATABASE_URL=postgres://ton_invoices:ton_invoices@127.0.0.1:55433/ton_invoices \
  node_modules/.bin/vitest run apps/ton-invoices/src/integration.test.ts
```

## Agentix CLI

```sh
node packages/cli/dist/bin.js inspect invoices.create --root apps/ton-invoices --json --compact
node packages/cli/dist/bin.js context invoices.reconcile --root apps/ton-invoices --json --compact
node packages/cli/dist/bin.js graph invoices --root apps/ton-invoices
```

`inspect` returns the bounded change context (routes, errors, effects,
ensures, tests); `.agentix/index.json` is a gitignored cache that regenerates
whenever sources change.
