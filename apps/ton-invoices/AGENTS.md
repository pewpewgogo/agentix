# ton-invoices — agent notes

- One feature file owns the whole domain: `src/features/invoices.ts`. A domain
  change touches exactly it and `src/features/invoices.test.ts`. No ambient
  I/O/time/random/env there — everything enters through the declared ports.
- Start every change with
  `node ../../packages/cli/dist/bin.js inspect <operation> --root . --json --compact`
  (operations: `invoices.create|get|list|cancel|reconcile|listUnattributed|notifyPaid`).
- Money is nanotons as decimal STRINGS (`AmountNano`); compare with BigInt,
  never parseFloat/Number.
- `settle` is the only place "paid" happens: one transactional effect (paid +
  transfer + cursor), guarded in the ADAPTER (amount coverage + on-chain-time
  bound). Never split it into separate effects.
- The reconcile must account for EVERY fresh transfer: settle it or
  `recordUnmatched` it (row + cursor advance in one transaction). Never move
  the cursor past a transfer that left no durable record — the funds are on
  chain either way. Expiry matching uses the transfer's `utime` (on-chain
  time), falling back to the poller clock only when absent.
- Adapters: `postgres.ts` (SQL seam, unit-tested against a fake pool),
  `toncenter.ts` (strict per-field parsing, fetch allowed HERE only; one
  unparseable transaction is quarantined into `malformed`, never a page
  failure — its grammar must stay exactly as tight as the domain schemas),
  `notify.ts`, `memory.ts` (must mirror SQL semantics — guarded writes,
  unique tx hash, UNIQUE comment).
- Assembly-only concerns: observer/subscriber wiring, digest-keyed bearer
  auth (NEVER a plain-object token table — `tokens[token]` resolves
  Object.prototype members), and `createReconcilePoller` (overlap guard,
  cause-carrying failure logs, stalled alert) in `src/app.ts`; env validation
  in `src/server.ts`. The poller is not a domain concept.
- Verify: `../../node_modules/.bin/tsc -b . --pretty false` +
  `tsc -p tsconfig.test.json --pretty false`, then from the repo root
  `node_modules/.bin/vitest run apps/ton-invoices`. Integration is gated by
  `TON_INVOICES_DATABASE_URL` (docker-compose.yml, port 55433).
