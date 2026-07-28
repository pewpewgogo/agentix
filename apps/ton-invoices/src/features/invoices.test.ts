/**
 * Behavior tests through createTestApplication. The hand-declared
 * InvoiceStore port is not auto-faked, so the memory adapter from
 * src/adapters/memory.ts is bound as a user adapter (mirroring production
 * semantics: guarded writes, atomic settle, monotonic cursor). Time ops use
 * the deterministic clock (2000-01-01T00:00:00.000Z, +1s per reading);
 * random ops the shared "id-1", "id-2", ... sequence — so the first create
 * gets invoice id "id-1" and comment tag "id-2".
 */
import { principal, subscription, type BoundPortAdapter } from "@agentixdev/core";
import { checkEnsures, createTestApplication } from "@agentixdev/testing";
import { describe, expect, it } from "vitest";

import {
  createMemoryChainWatcher,
  createMemoryInvoiceStore,
} from "../adapters/memory.js";
import {
  InvoicePaid,
  invoices,
  InvoiceStore,
  presentInvoice,
  type IncomingTransfer,
  type Invoice,
  type InvoicePaidPayload,
} from "./invoices.js";

const admin = principal("admin", [
  "invoices:create",
  "invoices:read",
  "invoices:cancel",
  "invoices:reconcile",
]);
const reader = principal("reader", ["invoices:read"]);
const notifier = principal("invoice-paid-subscriber", ["invoices:notify"]);

const ADDRESS = "UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2";
const TTL_MS = 300_000; // 5 minutes

const T0 = "2000-01-01T00:00:00.000Z";
const T0_EXPIRY = "2000-01-01T00:05:00.000Z";

interface BuildOptions {
  /** Scripted pull pages; when given, the memory watcher is NOT bound. */
  readonly pulls?: IncomingTransfer[][];
  /** Expiry grace for on-chain payment times; default 0 (exact expiry). */
  readonly expiryGraceMs?: number;
  /** Replace the memory store (race-scenario adapters). */
  readonly storeAdapter?: BoundPortAdapter;
}

const build = (options: BuildOptions = {}) => {
  const store = createMemoryInvoiceStore();
  const watcher = createMemoryChainWatcher();
  const notifications: InvoicePaidPayload[] = [];
  const pulls = options.pulls === undefined ? undefined : [...options.pulls];
  const storeAdapter = options.storeAdapter ?? store.adapter;

  const harness = createTestApplication({
    features: [invoices],
    adapters: pulls === undefined ? [storeAdapter, watcher.adapter] : [storeAdapter],
    overrides: {
      "invoiceConfig.get": () => ({
        receiveAddress: ADDRESS,
        ttlMs: TTL_MS,
        expiryGraceMs: options.expiryGraceMs ?? 0,
      }),
      // The auto-fake for time ops answers clock.now() regardless of input;
      // plusMs needs its real semantics (pure date arithmetic, no tick).
      "invoiceClock.plusMs": ({ iso, ms }: { iso: string; ms: number }) =>
        new Date(Date.parse(iso) + ms).toISOString(),
      "invoiceNotifier.send": (notification: InvoicePaidPayload) => {
        notifications.push(notification);
        return { delivered: true };
      },
      ...(pulls === undefined
        ? {}
        : { "chainWatcher.pull": () => ({ transfers: pulls.shift() ?? [] }) }),
    },
    // Same wiring as the assembly: invoice.paid -> invoices.notifyPaid.
    subscribers: [
      subscription(InvoicePaid, async (payload) => {
        const result = await harness.app.dispatch("invoices.notifyPaid", {
          input: payload,
          principal: notifier,
        });
        if (result.kind !== "completed") throw new Error(result.error.code);
      }),
    ],
  });
  return { ...harness, harness, store, watcher, notifications };
};

const createInvoice = async (
  harness: ReturnType<typeof build>,
  amountNano = "1500000000",
): Promise<Invoice> => {
  const outcome = await harness.app.call(
    "invoices.create",
    { amountNano },
    { principal: admin },
  );
  if (!outcome.ok) throw new Error("create failed");
  return outcome.value;
};

/* ------------------------------------------------------------------ */
/* create                                                             */
/* ------------------------------------------------------------------ */

describe("invoices.create", () => {
  it("persists a pending invoice with generated id, tag, expiry, and payment link", async () => {
    const h = build();
    const outcome = await h.app.call(
      "invoices.create",
      { amountNano: "1500000000", memo: "  coffee  " },
      { principal: admin },
    );

    expect(outcome).toEqual({
      ok: true,
      value: {
        id: "id-1",
        amountNano: "1500000000",
        memo: "coffee", // trimmed by the input schema
        comment: "id-2",
        status: "pending",
        createdAt: T0,
        expiresAt: T0_EXPIRY, // createdAt + TTL via the clock port
        paymentLink: `ton://transfer/${ADDRESS}?amount=1500000000&text=id-2`,
      },
    });
    expect(h.store.invoices.get("id-1")?.status).toBe("pending");
    expect(h.calls.of("invoiceStore.save")).toHaveLength(1);
  });

  it("rejects non-integer, zero, negative, and leading-zero amounts", async () => {
    const h = build();
    for (const amountNano of ["0", "1.5", "-5", "007", "", "1e9"]) {
      const result = await h.app.dispatch("invoices.create", {
        input: { amountNano },
        principal: admin,
      });
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error.code).toBe("INVALID_INPUT");
      }
    }
    expect(h.store.invoices.size).toBe(0);
  });

  it("rejects unauthorized principals before any effect runs", async () => {
    const h = build();
    const anonymous = await h.app.dispatch("invoices.create", {
      input: { amountNano: "10" },
    });
    expect(anonymous.kind).toBe("rejected");
    if (anonymous.kind === "rejected") {
      expect(anonymous.error.code).toBe("PERMISSION_DENIED");
    }
    const readOnly = await h.app.dispatch("invoices.create", {
      input: { amountNano: "10" },
      principal: reader,
    });
    expect(readOnly.kind).toBe("rejected");
    expect(h.calls.all()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* get / list                                                         */
/* ------------------------------------------------------------------ */

describe("invoices.get", () => {
  it("is public and 404s an unknown id", async () => {
    const h = build();
    const invoice = await createInvoice(h);

    const found = await h.app.call("invoices.get", { id: invoice.id }); // anonymous
    expect(found).toEqual({ ok: true, value: invoice });

    const missing = await h.app.call("invoices.get", { id: "ghost" });
    expect(missing).toEqual({
      ok: false,
      error: { code: "INVOICE_NOT_FOUND", details: { id: "ghost" } },
    });
  });

  it("presents a pending invoice past expiry as expired WITHOUT writing", async () => {
    const h = build();
    const invoice = await createInvoice(h);
    h.clock.advanceBy(2 * TTL_MS);

    const found = await h.app.call("invoices.get", { id: invoice.id });
    expect(found.ok && found.value.status).toBe("expired");
    // Presentation only: the stored record is untouched, no write effect ran.
    expect(h.store.invoices.get(invoice.id)?.status).toBe("pending");
    expect(h.calls.of("invoiceStore.expirePending")).toHaveLength(0);
    expect(h.calls.of("invoiceStore.save")).toHaveLength(1); // the create
  });
});

describe("invoices.list", () => {
  it("filters on the PRESENTED status, consistent with get", async () => {
    const h = build();
    const stale = await createInvoice(h, "100");
    h.clock.advanceBy(2 * TTL_MS);
    const fresh = await createInvoice(h, "200");

    const all = await h.app.call("invoices.list", {}, { principal: reader });
    expect(all.ok && all.value.map((i) => [i.id, i.status])).toEqual([
      [stale.id, "expired"],
      [fresh.id, "pending"],
    ]);

    const expired = await h.app.call(
      "invoices.list",
      { status: "expired" },
      { principal: reader },
    );
    expect(expired.ok && expired.value.map((i) => i.id)).toEqual([stale.id]);

    const pending = await h.app.call(
      "invoices.list",
      { status: "pending" },
      { principal: reader },
    );
    expect(pending.ok && pending.value.map((i) => i.id)).toEqual([fresh.id]);
  });

  it("requires invoices:read", async () => {
    const h = build();
    const result = await h.app.dispatch("invoices.list", { input: {} });
    expect(result.kind).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */
/* cancel                                                             */
/* ------------------------------------------------------------------ */

describe("invoices.cancel", () => {
  it("cancels a pending invoice and stamps cancelledAt from the clock", async () => {
    const h = build();
    const invoice = await createInvoice(h);

    const cancelled = await h.app.call(
      "invoices.cancel",
      { id: invoice.id },
      { principal: admin },
    );
    expect(cancelled.ok && cancelled.value.status).toBe("cancelled");
    expect(cancelled.ok && cancelled.value.cancelledAt).toBe(
      "2000-01-01T00:00:01.000Z", // second clock reading
    );
    expect(h.store.invoices.get(invoice.id)?.status).toBe("cancelled");
  });

  it("conflicts on an already-cancelled invoice", async () => {
    const h = build();
    const invoice = await createInvoice(h);
    await h.app.call("invoices.cancel", { id: invoice.id }, { principal: admin });

    const again = await h.app.call(
      "invoices.cancel",
      { id: invoice.id },
      { principal: admin },
    );
    expect(again).toEqual({
      ok: false,
      error: {
        code: "INVOICE_NOT_PENDING",
        details: { id: invoice.id, status: "cancelled" },
      },
    });
  });

  it("conflicts on a paid invoice and 404s an unknown one", async () => {
    const h = build();
    const invoice = await createInvoice(h);
    h.watcher.push({
      txHash: "tx-1",
      lt: "101",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
    });
    await h.app.call("invoices.reconcile", {}, { principal: admin });

    const paid = await h.app.call(
      "invoices.cancel",
      { id: invoice.id },
      { principal: admin },
    );
    expect(paid).toEqual({
      ok: false,
      error: {
        code: "INVOICE_NOT_PENDING",
        details: { id: invoice.id, status: "paid" },
      },
    });

    const missing = await h.app.call(
      "invoices.cancel",
      { id: "ghost" },
      { principal: admin },
    );
    expect(missing).toEqual({
      ok: false,
      error: { code: "INVOICE_NOT_FOUND", details: { id: "ghost" } },
    });
  });
});

/* ------------------------------------------------------------------ */
/* reconcile                                                          */
/* ------------------------------------------------------------------ */

describe("invoices.reconcile", () => {
  it("pays a matching transfer atomically, emits invoice.paid, and notifies", async () => {
    const h = build();
    const invoice = await createInvoice(h); // id-1 / comment id-2
    h.watcher.push({
      txHash: "tx-1",
      lt: "101",
      amountNano: "1500000000",
      comment: invoice.comment,
    });

    const result = await h.app.dispatch("invoices.reconcile", {
      input: {},
      principal: admin,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;

    expect(result.outcome).toEqual({
      ok: true,
      value: {
        expired: [],
        paid: [
          {
            invoiceId: invoice.id,
            amountNano: "1500000000",
            transferAmountNano: "1500000000",
            txHash: "tx-1",
            lt: "101",
          },
        ],
        unattributed: [],
        malformed: [],
        transfersSeen: 1,
        cursor: "101",
      },
    });

    const paidAt = "2000-01-01T00:00:01.000Z"; // reconcile's clock reading
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: "invoice.paid",
      payload: {
        invoiceId: invoice.id,
        amountNano: "1500000000",
        transferAmountNano: "1500000000",
        txHash: "tx-1",
        comment: invoice.comment,
        paidAt,
      },
    });

    // The subscriber dispatched invoices.notifyPaid through the notifier port.
    expect(h.notifications).toEqual([
      {
        invoiceId: invoice.id,
        amountNano: "1500000000",
        transferAmountNano: "1500000000",
        txHash: "tx-1",
        comment: invoice.comment,
        paidAt,
      },
    ]);
    expect(h.calls.of("invoiceNotifier.send")).toHaveLength(1);

    // Persistence: paid invoice, recorded transfer, advanced cursor — the
    // one atomic settle.
    const stored = h.store.invoices.get(invoice.id);
    expect(stored?.status).toBe("paid");
    expect(stored?.paidTxHash).toBe("tx-1");
    expect(stored?.paidAmountNano).toBe("1500000000");
    expect(h.store.transfers.get("tx-1")?.invoiceId).toBe(invoice.id);
    expect(h.store.cursor()).toBe("101");
  });

  it("accepts an overpaying transfer (amount >= invoice amount)", async () => {
    const h = build();
    const invoice = await createInvoice(h, "1000");
    h.watcher.push({
      txHash: "tx-1",
      lt: "7",
      amountNano: "2500",
      comment: invoice.comment,
    });

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value.paid).toHaveLength(1);
    expect(h.store.invoices.get(invoice.id)?.paidAmountNano).toBe("2500");
  });

  it("records an underpaying transfer as unattributed and advances the cursor in the SAME write", async () => {
    const h = build();
    const invoice = await createInvoice(h, "1500000000");
    h.watcher.push({
      txHash: "tx-1",
      lt: "101",
      amountNano: "1499999999",
      comment: invoice.comment,
    });

    const result = await h.app.dispatch("invoices.reconcile", {
      input: {},
      principal: admin,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.outcome.ok && result.outcome.value).toMatchObject({
      paid: [],
      unattributed: [
        {
          txHash: "tx-1",
          lt: "101",
          amountNano: "1499999999",
          comment: invoice.comment,
          reason: "underpaid",
        },
      ],
      transfersSeen: 1,
      cursor: "101",
    });
    expect(h.store.invoices.get(invoice.id)?.status).toBe("pending");
    expect(h.store.transfers.size).toBe(0);
    // The money left a durable trace: partials are NOT accumulated, but they
    // are never invisible either.
    expect(h.store.unattributed.get("tx-1")).toMatchObject({
      amountNano: "1499999999",
      reason: "underpaid",
    });
    // ...and the operator event fired alongside the paid-less report.
    expect(
      result.events.filter((e) => e.eventId === "invoice.transferUnattributed"),
    ).toHaveLength(1);
    expect(h.notifications).toHaveLength(0);
    expect(h.calls.of("invoiceStore.settle")).toHaveLength(0);
    // Record + cursor advance are ONE store write, not a bare advanceCursor.
    expect(h.calls.of("invoiceStore.recordUnmatched")).toHaveLength(1);
    expect(h.calls.of("invoiceStore.advanceCursor")).toHaveLength(0);

    // The next run starts past the cursor: nothing is re-read.
    const again = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(again.ok && again.value).toMatchObject({ transfersSeen: 0, cursor: "101" });
  });

  it("does NOT accumulate partial payments, but a later full transfer still pays — with every partial on record", async () => {
    const h = build();
    const invoice = await createInvoice(h, "1000");
    h.watcher.push({ txHash: "tx-a", lt: "10", amountNano: "600", comment: invoice.comment });
    h.watcher.push({ txHash: "tx-b", lt: "20", amountNano: "400", comment: invoice.comment });

    const partials = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(partials.ok && partials.value).toMatchObject({
      paid: [],
      transfersSeen: 2,
      cursor: "20",
    });
    expect(partials.ok && partials.value.unattributed.map((u) => [u.txHash, u.reason]))
      .toEqual([
        ["tx-a", "underpaid"],
        ["tx-b", "underpaid"],
      ]);
    expect(h.store.invoices.get(invoice.id)?.status).toBe("pending");

    h.watcher.push({ txHash: "tx-c", lt: "30", amountNano: "1000", comment: invoice.comment });
    const full = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(full.ok && full.value.paid.map((p) => p.txHash)).toEqual(["tx-c"]);
    expect(h.store.invoices.get(invoice.id)?.status).toBe("paid");
    // The 1000 nanotons from tx-a/tx-b did not vanish: both stayed recorded.
    expect([...h.store.transfers.keys()]).toEqual(["tx-c"]);
    expect([...h.store.unattributed.keys()]).toEqual(["tx-a", "tx-b"]);
  });

  it("records a second transfer for an already-paid invoice as 'duplicate'", async () => {
    const h = build();
    const invoice = await createInvoice(h, "1000");
    h.watcher.push({ txHash: "tx-1", lt: "10", amountNano: "1000", comment: invoice.comment });
    const first = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(first.ok && first.value.paid).toHaveLength(1);

    // Wallet retry / user pays twice: same comment, fresh lt.
    h.watcher.push({ txHash: "tx-2", lt: "20", amountNano: "1000", comment: invoice.comment });
    const second = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(second.ok && second.value).toMatchObject({
      paid: [],
      unattributed: [{ txHash: "tx-2", reason: "duplicate" }],
      transfersSeen: 1,
      cursor: "20",
    });
    expect([...h.store.transfers.keys()]).toEqual(["tx-1"]);
    expect(h.store.unattributed.get("tx-2")?.reason).toBe("duplicate");
    expect(h.notifications).toHaveLength(1); // only the real payment notified
  });

  it("records the transfer when settle loses a race to a concurrent cancel", async () => {
    // A store whose listPending answer is STALE: by settle time the invoice
    // is cancelled, so the guarded settle writes nothing — exactly the
    // interleaving the cancel docblock documents as safe.
    const raced: Invoice = {
      id: "inv-raced",
      amountNano: "1000",
      comment: "tag-raced",
      status: "pending",
      createdAt: T0,
      expiresAt: T0_EXPIRY,
      paymentLink: `ton://transfer/${ADDRESS}?amount=1000&text=tag-raced`,
    };
    const unattributed: Array<{ txHash: string; reason: string }> = [];
    let cursor = "0";
    const storeAdapter = InvoiceStore.adapter({
      get: () => ({ ...raced, status: "cancelled", cancelledAt: T0 }),
      save: (invoice) => invoice,
      list: () => [],
      listPending: () => [raced], // stale: the cancel raced in after this read
      getByComment: () => ({ ...raced, status: "cancelled", cancelledAt: T0 }),
      cancel: () => undefined,
      expirePending: () => [],
      settle: () => undefined, // the guarded UPDATE matched nothing
      recordUnmatched: ({ transfer, reason }) => {
        unattributed.push({ txHash: transfer.txHash, reason });
        cursor = transfer.lt;
        return { lt: cursor };
      },
      listUnattributed: () => [],
      getCursor: () => ({ lt: cursor }),
      advanceCursor: ({ lt }) => ({ lt }),
    });
    const h = build({
      storeAdapter,
      pulls: [
        [{ txHash: "tx-race", lt: "11", amountNano: "1000", comment: "tag-raced" }],
      ],
    });

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value).toMatchObject({
      paid: [],
      unattributed: [{ txHash: "tx-race", reason: "invoice_not_open" }],
      transfersSeen: 1,
      cursor: "11",
    });
    // The funding transfer was recorded BEFORE the cursor moved past it.
    expect(unattributed).toEqual([{ txHash: "tx-race", reason: "invoice_not_open" }]);
  });

  it("records transfers without a matching comment tag as 'no_match' instead of dropping them", async () => {
    const h = build();
    await createInvoice(h);
    h.watcher.push({ txHash: "tx-1", lt: "50", amountNano: "9999999999" });
    h.watcher.push({
      txHash: "tx-2",
      lt: "60",
      amountNano: "9999999999",
      comment: "unrelated",
    });

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value).toMatchObject({
      paid: [],
      unattributed: [
        { txHash: "tx-1", reason: "no_match" },
        { txHash: "tx-2", reason: "no_match" },
      ],
      transfersSeen: 2,
      cursor: "60",
    });
    expect(h.store.unattributed.size).toBe(2);
  });

  it("never double-pays when the SAME transfer is delivered twice", async () => {
    const transfer: IncomingTransfer = {
      txHash: "tx-dup",
      lt: "101",
      amountNano: "1500000000",
      comment: "id-2",
    };
    // A watcher that ignores the cursor and re-delivers the same page twice.
    const h = build({ pulls: [[transfer], [transfer]] });
    const invoice = await createInvoice(h);

    const first = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(first.ok && first.value.paid).toHaveLength(1);

    const second = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(second.ok && second.value).toMatchObject({
      paid: [],
      transfersSeen: 0, // dropped by the cursor filter before any matching
      cursor: "101",
    });
    expect(h.store.invoices.get(invoice.id)?.status).toBe("paid");
    expect(h.store.transfers.size).toBe(1);
    expect(h.notifications).toHaveLength(1);
    expect(h.calls.of("invoiceStore.settle")).toHaveLength(1);
  });

  it("sweeps pending invoices past expiry; a transfer without an on-chain time cannot prove it was on time and is recorded", async () => {
    const h = build();
    const invoice = await createInvoice(h);
    h.watcher.push({
      txHash: "tx-late",
      lt: "101",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
      // no utime: matching falls back to the poller's clock, which is late
    });
    h.clock.advanceBy(2 * TTL_MS);

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value).toMatchObject({
      expired: [invoice.id],
      paid: [],
      unattributed: [{ txHash: "tx-late", reason: "invoice_not_open" }],
      transfersSeen: 1,
      cursor: "101",
    });
    expect(h.store.invoices.get(invoice.id)?.status).toBe("expired");
    expect(h.store.transfers.size).toBe(0);
    expect(h.store.unattributed.get("tx-late")?.reason).toBe("invoice_not_open");
    expect(h.notifications).toHaveLength(0);
  });

  it("settles a payment made ON CHAIN before expiry even when the poll observes it after (outage/backlog)", async () => {
    const h = build();
    const invoice = await createInvoice(h);
    h.watcher.push({
      txHash: "tx-ontime",
      lt: "101",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
      utime: "2000-01-01T00:01:00.000Z", // paid while the invoice was open
    });
    // The poller wakes only after expiry (e.g. toncenter was down).
    h.clock.advanceBy(2 * TTL_MS);

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value).toMatchObject({
      expired: [], // paid during matching, so the sweep found nothing pending
      paid: [{ invoiceId: invoice.id, txHash: "tx-ontime" }],
      unattributed: [],
      cursor: "101",
    });
    expect(h.store.invoices.get(invoice.id)?.status).toBe("paid");
    expect(h.store.transfers.get("tx-ontime")?.invoiceId).toBe(invoice.id);
    expect(h.notifications).toHaveLength(1);
  });

  it("refuses a payment whose ON-CHAIN time is past expiry and records it", async () => {
    const h = build();
    const invoice = await createInvoice(h); // expires at T0_EXPIRY
    h.watcher.push({
      txHash: "tx-too-late",
      lt: "101",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
      utime: "2000-01-01T00:06:40.000Z", // 100 s past expiry
    });
    h.clock.advanceBy(2 * TTL_MS);

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value).toMatchObject({
      expired: [invoice.id],
      paid: [],
      unattributed: [{ txHash: "tx-too-late", reason: "invoice_not_open" }],
    });
    expect(h.store.invoices.get(invoice.id)?.status).toBe("expired");
  });

  it("honors the configured expiry grace for on-chain payment times", async () => {
    const h = build({ expiryGraceMs: 120_000 });
    const invoice = await createInvoice(h);
    h.watcher.push({
      txHash: "tx-grace",
      lt: "101",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
      utime: "2000-01-01T00:06:40.000Z", // 100 s past expiry, inside 120 s grace
    });
    h.clock.advanceBy(2 * TTL_MS);

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value.paid.map((p) => p.txHash)).toEqual(["tx-grace"]);
    expect(h.store.invoices.get(invoice.id)?.status).toBe("paid");
  });

  it("fails loudly when two pending invoices share a comment tag instead of silently shadowing one", async () => {
    const shared = (id: string): Invoice => ({
      id,
      amountNano: "1000",
      comment: "tag-shared",
      status: "pending",
      createdAt: T0,
      expiresAt: T0_EXPIRY,
      paymentLink: `ton://transfer/${ADDRESS}?amount=1000&text=tag-shared`,
    });
    // The memory/SQL stores both forbid this state; inject it directly to
    // prove the reconcile refuses to guess which invoice the payer funded.
    const storeAdapter = InvoiceStore.adapter({
      get: () => undefined,
      save: (invoice) => invoice,
      list: () => [shared("inv-1"), shared("inv-2")],
      listPending: () => [shared("inv-1"), shared("inv-2")],
      getByComment: () => shared("inv-1"),
      cancel: () => undefined,
      expirePending: () => [],
      settle: () => undefined,
      recordUnmatched: ({ transfer }) => ({ lt: transfer.lt }),
      listUnattributed: () => [],
      getCursor: () => ({ lt: "0" }),
      advanceCursor: ({ lt }) => ({ lt }),
    });
    const h = build({ storeAdapter, pulls: [[]] });

    const result = await h.app.dispatch("invoices.reconcile", {
      input: {},
      principal: admin,
    });
    expect(result.kind).toBe("fault");
  });

  it("matches each transfer to the invoice with its comment tag", async () => {
    const h = build();
    const first = await createInvoice(h, "1000"); // comment id-2
    const second = await createInvoice(h, "2000"); // comment id-4
    h.watcher.push({
      txHash: "tx-b",
      lt: "20",
      amountNano: "2000",
      comment: second.comment,
    });

    const outcome = await h.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value.paid.map((p) => p.invoiceId)).toEqual([
      second.id,
    ]);
    expect(h.store.invoices.get(first.id)?.status).toBe("pending");
    expect(h.store.invoices.get(second.id)?.status).toBe("paid");
  });

  it("requires invoices:reconcile", async () => {
    const h = build();
    const result = await h.app.dispatch("invoices.reconcile", {
      input: {},
      principal: reader,
    });
    expect(result.kind).toBe("rejected");
  });

  it("surfaces watcher-quarantined (malformed) transactions in the report without failing the run", async () => {
    const store = createMemoryInvoiceStore();
    const harness = createTestApplication({
      features: [invoices],
      adapters: [store.adapter],
      overrides: {
        "invoiceConfig.get": () => ({
          receiveAddress: ADDRESS,
          ttlMs: TTL_MS,
          expiryGraceMs: 0,
        }),
        "invoiceClock.plusMs": ({ iso, ms }: { iso: string; ms: number }) =>
          new Date(Date.parse(iso) + ms).toISOString(),
        "chainWatcher.pull": () => ({
          transfers: [],
          malformed: [
            {
              path: "$.transactions[1]",
              detail: "toncenter response malformed at $.transactions[1].lt",
              txHash: "bad-tx",
            },
          ],
        }),
      },
    });

    const outcome = await harness.app.call("invoices.reconcile", {}, { principal: admin });
    expect(outcome.ok && outcome.value).toMatchObject({
      paid: [],
      unattributed: [],
      malformed: [{ path: "$.transactions[1]", txHash: "bad-tx" }],
      transfersSeen: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* listUnattributed                                                   */
/* ------------------------------------------------------------------ */

describe("invoices.listUnattributed", () => {
  it("lists every recorded unattributed transfer for operators (invoices:read)", async () => {
    const h = build();
    const invoice = await createInvoice(h, "1000");
    h.watcher.push({ txHash: "tx-u", lt: "5", amountNano: "999", comment: invoice.comment });
    await h.app.call("invoices.reconcile", {}, { principal: admin });

    const listed = await h.app.call("invoices.listUnattributed", {}, { principal: reader });
    expect(listed.ok && listed.value).toMatchObject([
      { txHash: "tx-u", amountNano: "999", reason: "underpaid" },
    ]);

    const anonymous = await h.app.dispatch("invoices.listUnattributed", { input: {} });
    expect(anonymous.kind).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */
/* Memory store: SQL-semantics mirrors                                */
/* ------------------------------------------------------------------ */

describe("memory store SQL mirrors", () => {
  it("rejects a duplicate comment tag exactly like the SQL UNIQUE would", async () => {
    const store = createMemoryInvoiceStore();
    const harness = createTestApplication({
      features: [invoices],
      adapters: [store.adapter],
      overrides: {
        "invoiceConfig.get": () => ({
          receiveAddress: ADDRESS,
          ttlMs: TTL_MS,
          expiryGraceMs: 0,
        }),
        "invoiceClock.plusMs": ({ iso, ms }: { iso: string; ms: number }) =>
          new Date(Date.parse(iso) + ms).toISOString(),
        // Force the collision the ~48-bit tag made plausible at scale.
        "invoiceIds.commentTag": () => "inv-collide",
      },
    });

    const first = await harness.app.dispatch("invoices.create", {
      input: { amountNano: "1000" },
      principal: admin,
    });
    expect(first.kind).toBe("completed");

    const second = await harness.app.dispatch("invoices.create", {
      input: { amountNano: "1000" },
      principal: admin,
    });
    expect(second.kind).toBe("fault");
    if (second.kind === "fault") expect(second.error.code).toBe("EFFECT_FAILURE");
    expect(store.invoices.size).toBe(1); // the shadowing invoice never existed
  });

  it("settle refuses an amount below the invoice (mirror of the SQL coverage guard + CHECK)", async () => {
    const store = createMemoryInvoiceStore();
    const invoice: Invoice = {
      id: "inv-1",
      amountNano: "999999999999",
      comment: "tag-1",
      status: "pending",
      createdAt: T0,
      expiresAt: T0_EXPIRY,
      paymentLink: "ton://x",
    };
    store.invoices.set(invoice.id, invoice);

    const settle = store.adapter.operations["settle"];
    const settled = await settle?.({
      invoiceId: "inv-1",
      paidAt: T0,
      transfer: { txHash: "tx-1", lt: "1", amountNano: "1000" },
      expiryGraceMs: 0,
    } as never);
    expect(settled).toBeUndefined();
    expect(store.invoices.get("inv-1")?.status).toBe("pending");
    expect(store.transfers.size).toBe(0);
  });

  it("settle refuses an on-chain payment time at/past expiresAt + grace (mirror of the SQL time guard)", async () => {
    const store = createMemoryInvoiceStore();
    const invoice: Invoice = {
      id: "inv-1",
      amountNano: "1000",
      comment: "tag-1",
      status: "pending",
      createdAt: T0,
      expiresAt: T0_EXPIRY,
      paymentLink: "ton://x",
    };
    store.invoices.set(invoice.id, invoice);

    const settle = store.adapter.operations["settle"];
    const late = await settle?.({
      invoiceId: "inv-1",
      paidAt: T0,
      transfer: { txHash: "tx-1", lt: "1", amountNano: "1000", utime: T0_EXPIRY },
      expiryGraceMs: 0,
    } as never);
    expect(late).toBeUndefined();

    const inGrace = await settle?.({
      invoiceId: "inv-1",
      paidAt: T0,
      transfer: { txHash: "tx-2", lt: "2", amountNano: "1000", utime: T0_EXPIRY },
      expiryGraceMs: 60_000,
    } as never);
    expect(inGrace).toMatchObject({ status: "paid", paidTxHash: "tx-2" });
  });
});

/* ------------------------------------------------------------------ */
/* Invariants and helpers                                             */
/* ------------------------------------------------------------------ */

describe("ensures (dev/test regression guards — the PRODUCTION gate is the guarded settle SQL + CHECK)", () => {
  it("flags a paid entry whose recorded transfer is below the invoice amount", () => {
    const violated = checkEnsures(invoices.operations.reconcile, {
      input: {},
      output: {
        expired: [],
        paid: [
          {
            invoiceId: "i1",
            amountNano: "100",
            transferAmountNano: "99",
            txHash: "t1",
            lt: "1",
          },
        ],
        unattributed: [],
        malformed: [],
        transfersSeen: 1,
        cursor: "1",
      },
    });
    expect(violated).toEqual(["paidTransferCoversInvoiceAmount"]);
  });

  it("flags a report where a fresh transfer is neither paid nor unattributed (silently dropped)", () => {
    const violated = checkEnsures(invoices.operations.reconcile, {
      input: {},
      output: {
        expired: [],
        paid: [],
        unattributed: [],
        malformed: [],
        transfersSeen: 1, // one transfer seen, zero accounted for
        cursor: "1",
      },
    });
    expect(violated).toEqual(["everyFreshTransferAccountedFor"]);
  });

  it("passes when every recorded transfer covers its invoice", () => {
    const clean = checkEnsures(invoices.operations.reconcile, {
      input: {},
      output: {
        expired: [],
        paid: [
          {
            invoiceId: "i1",
            amountNano: "100",
            transferAmountNano: "250",
            txHash: "t1",
            lt: "1",
          },
        ],
        unattributed: [],
        malformed: [],
        transfersSeen: 1,
        cursor: "1",
      },
    });
    expect(clean).toEqual([]);
  });
});

describe("presentInvoice", () => {
  const base: Invoice = {
    id: "i1",
    amountNano: "10",
    comment: "tag",
    status: "pending",
    createdAt: "2000-01-01T00:00:00.000Z",
    expiresAt: "2000-01-01T00:05:00.000Z",
    paymentLink: "ton://transfer/x?amount=10&text=tag",
  };

  it("flips only stored-pending invoices past expiry", () => {
    expect(presentInvoice(base, "2000-01-01T00:04:59.999Z").status).toBe("pending");
    expect(presentInvoice(base, "2000-01-01T00:05:00.000Z").status).toBe("expired");
    expect(
      presentInvoice({ ...base, status: "cancelled" }, "2001-01-01T00:00:00.000Z")
        .status,
    ).toBe("cancelled");
  });
});
