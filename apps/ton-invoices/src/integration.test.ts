/**
 * Integration tests against REAL PostgreSQL. Gated behind
 * TON_INVOICES_DATABASE_URL and skipped cleanly when it is absent:
 *
 *   docker compose up -d   # in apps/ton-invoices
 *   TON_INVOICES_DATABASE_URL=postgres://ton_invoices:ton_invoices@127.0.0.1:55433/ton_invoices \
 *     vitest run apps/ton-invoices/src/integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryChainWatcher,
  createMemoryNotifier,
  type MemoryChainWatcher,
  type MemoryNotifier,
} from "./adapters/memory.js";
import { createPostgresPool, type SqlPool } from "./adapters/postgres.js";
import {
  createTonInvoicesApplication,
  POLLER_PRINCIPAL,
  type TonInvoicesApplication,
} from "./app.js";
import { principal } from "@agentixdev/core";
import type { Invoice } from "./features/invoices.js";

const databaseUrl = process.env["TON_INVOICES_DATABASE_URL"];

const admin = principal("admin", [
  "invoices:create",
  "invoices:read",
  "invoices:cancel",
  "invoices:reconcile",
]);

const ADDRESS = "UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2";

describe.skipIf(databaseUrl === undefined)("ton-invoices against real PostgreSQL", () => {
  let app: TonInvoicesApplication;
  let watcher: MemoryChainWatcher;
  let notifier: MemoryNotifier;
  /** Second pool for direct table inspection/cleanup, outside the app. */
  let inspect: SqlPool;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("unreachable: gated by skipIf");
    watcher = createMemoryChainWatcher();
    notifier = createMemoryNotifier();
    app = createTonInvoicesApplication({
      receiveAddress: ADDRESS,
      invoiceTtlMs: 60 * 60 * 1000,
      databaseUrl,
      chainWatcherAdapter: watcher.adapter,
      notifierAdapter: notifier.adapter,
      log: () => {},
    });
    await app.start(); // creates the app's pool + bootstraps the schema
    inspect = createPostgresPool(databaseUrl);
  });

  afterAll(async () => {
    await app.close(); // dispose hook ends the app's pool
    await inspect.end();
  });

  beforeEach(async () => {
    await inspect.query(
      "TRUNCATE transfers, unattributed_transfers, invoices, watcher_cursor",
    );
    watcher.transfers.length = 0;
    notifier.notifications.length = 0;
  });

  const createInvoice = async (amountNano = "1500000000"): Promise<Invoice> => {
    const outcome = await app.call(
      "invoices.create",
      { amountNano, memo: "integration" },
      { principal: admin },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("create failed");
    return outcome.value;
  };

  it("round-trips create -> get: numeric amounts and timestamptz stay exact", async () => {
    const created = await createInvoice();
    expect(created.paymentLink).toBe(
      `ton://transfer/${ADDRESS}?amount=1500000000&text=${created.comment}`,
    );

    const fetched = await app.call("invoices.get", { id: created.id });
    expect(fetched).toEqual({ ok: true, value: created });

    const listed = await app.call("invoices.list", { status: "pending" }, { principal: admin });
    expect(listed.ok && listed.value.map((i) => i.id)).toEqual([created.id]);
  });

  it("reconcile pays atomically, records the transfer, advances the cursor, notifies — and reruns clean", async () => {
    const invoice = await createInvoice();
    watcher.push({
      txHash: "tx-int-1",
      lt: "12345",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
    });

    const first = await app.call("invoices.reconcile", {}, { principal: POLLER_PRINCIPAL });
    expect(first.ok && first.value.paid.map((p) => p.invoiceId)).toEqual([invoice.id]);
    expect(first.ok && first.value.cursor).toBe("12345");

    const rows = await inspect.query(
      "SELECT invoice_id, lt::text AS lt FROM transfers WHERE tx_hash = $1",
      ["tx-int-1"],
    );
    expect(rows.rows).toEqual([{ invoice_id: invoice.id, lt: "12345" }]);
    const cursor = await inspect.query("SELECT lt::text AS lt FROM watcher_cursor WHERE id = 1");
    expect(cursor.rows).toEqual([{ lt: "12345" }]);
    expect(notifier.notifications.map((n) => n.invoiceId)).toEqual([invoice.id]);

    // Idempotent rerun: the same transfer is behind the cursor now.
    const second = await app.call("invoices.reconcile", {}, { principal: POLLER_PRINCIPAL });
    expect(second.ok && second.value).toMatchObject({
      paid: [],
      transfersSeen: 0,
      cursor: "12345",
    });
    expect(notifier.notifications).toHaveLength(1);
  });

  it("settle is atomic: a failing transfer INSERT rolls the paid UPDATE back", async () => {
    const target = await createInvoice("1000");
    const other = await createInvoice("2000");
    // Occupy the transfers primary key so the settle transaction's INSERT
    // must fail after the invoice UPDATE succeeded.
    await inspect.query(
      `INSERT INTO transfers (tx_hash, lt, amount_nano, comment, invoice_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      ["tx-blocked", "1", "2000", null, other.id],
    );
    watcher.push({
      txHash: "tx-blocked",
      lt: "500",
      amountNano: "1000",
      comment: target.comment,
    });

    const result = await app.dispatch("invoices.reconcile", {
      input: {},
      principal: POLLER_PRINCIPAL,
    });
    expect(result.kind).toBe("fault");
    if (result.kind === "fault") {
      expect(result.error.code).toBe("EFFECT_FAILURE");
    }

    // The transaction rolled back: still pending, cursor untouched, and the
    // blocker row is the only transfer.
    const still = await app.call("invoices.get", { id: target.id });
    expect(still.ok && still.value.status).toBe("pending");
    const cursor = await inspect.query("SELECT lt::text AS lt FROM watcher_cursor");
    expect(cursor.rows).toEqual([]);
    const transfers = await inspect.query("SELECT count(*)::int AS count FROM transfers");
    expect(transfers.rows).toEqual([{ count: 1 }]);
    expect(notifier.notifications).toHaveLength(0);
  });

  it("records an underpaying transfer as unattributed and advances the cursor in the same transaction", async () => {
    const invoice = await createInvoice("1500000000");
    watcher.push({
      txHash: "tx-under-1",
      lt: "900",
      amountNano: "1",
      comment: invoice.comment,
    });

    const outcome = await app.call("invoices.reconcile", {}, { principal: POLLER_PRINCIPAL });
    expect(outcome.ok && outcome.value.paid).toEqual([]);
    expect(outcome.ok && outcome.value.unattributed.map((u) => [u.txHash, u.reason]))
      .toEqual([["tx-under-1", "underpaid"]]);

    const rows = await inspect.query(
      "SELECT tx_hash, reason, amount_nano::text AS amount_nano FROM unattributed_transfers",
    );
    expect(rows.rows).toEqual([
      { tx_hash: "tx-under-1", reason: "underpaid", amount_nano: "1" },
    ]);
    const cursor = await inspect.query("SELECT lt::text AS lt FROM watcher_cursor WHERE id = 1");
    expect(cursor.rows).toEqual([{ lt: "900" }]);
    expect(await app.call("invoices.get", { id: invoice.id }).then((r) => r.ok && r.value.status)).toBe("pending");
  });

  it("enforces paid >= amount at the DATABASE level (CHECK), independent of dev-only ensures", async () => {
    const invoice = await createInvoice("1000");
    await expect(
      inspect.query(
        "UPDATE invoices SET status = 'paid', paid_amount_nano = $2 WHERE id = $1",
        [invoice.id, "999"],
      ),
    ).rejects.toThrow(/invoices_paid_covers_amount/);
  });

  it("settles a payment whose ON-CHAIN time is before expiry even when observed after it", async () => {
    // TTL is one hour in this suite; backdate expiry so wall-clock 'now' is
    // past it while the transfer's utime is not.
    const invoice = await createInvoice("1000");
    await inspect.query("UPDATE invoices SET expires_at = now() - interval '1 minute' WHERE id = $1", [invoice.id]);
    const utime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // paid 5 min ago, while open
    watcher.push({
      txHash: "tx-ontime-int",
      lt: "950",
      amountNano: "1000",
      comment: invoice.comment,
      utime,
    });

    const outcome = await app.call("invoices.reconcile", {}, { principal: POLLER_PRINCIPAL });
    expect(outcome.ok && outcome.value.paid.map((p) => p.txHash)).toEqual(["tx-ontime-int"]);
    const status = await app.call("invoices.get", { id: invoice.id });
    expect(status.ok && status.value.status).toBe("paid");
  });

  it("cancel conflicts once paid", async () => {
    const invoice = await createInvoice();
    watcher.push({
      txHash: "tx-int-2",
      lt: "777",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
    });
    await app.call("invoices.reconcile", {}, { principal: POLLER_PRINCIPAL });

    const conflict = await app.call(
      "invoices.cancel",
      { id: invoice.id },
      { principal: admin },
    );
    expect(conflict).toEqual({
      ok: false,
      error: {
        code: "INVOICE_NOT_PENDING",
        details: { id: invoice.id, status: "paid" },
      },
    });
  });
});
