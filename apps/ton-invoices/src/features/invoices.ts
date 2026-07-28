import { command, event, feature, port, query, s } from "@agentixdev/core";

/* ------------------------------------------------------------------ */
/* Value schemas                                                      */
/* ------------------------------------------------------------------ */

/**
 * Nanotons as a decimal string. TON amounts are 64-bit integers of
 * nanotons; a JS float would silently lose precision above 2^53, so the
 * domain NEVER represents an amount as a number. Digits only, no sign, no
 * decimals, no leading zeros; comparisons go through BigInt.
 */
export const AmountNano = s.refine(
  s.string({ min: 1, max: 30 }),
  (value) => /^[1-9][0-9]*$/.test(value),
  {
    id: "amount-nano",
    message:
      "amountNano must be a positive integer string of nanotons (digits only, no sign, no decimals, no leading zeros)",
  },
);

/** A TON logical time (uint64) as a decimal string; "0" means "from the start". */
export const LogicalTime = s.refine(
  s.string({ min: 1, max: 30 }),
  (value) => /^(0|[1-9][0-9]*)$/.test(value),
  {
    id: "logical-time",
    message: "lt must be a non-negative integer string (TON logical time)",
  },
);

export const InvoiceStatus = s.union([
  s.literal("pending"),
  s.literal("paid"),
  s.literal("expired"),
  s.literal("cancelled"),
]);
export type InvoiceStatus = s.Infer<typeof InvoiceStatus>;

/* ------------------------------------------------------------------ */
/* Domain records                                                     */
/* ------------------------------------------------------------------ */

export const Invoice = s.object({
  id: s.string({ min: 1 }),
  amountNano: AmountNano,
  memo: s.optional(s.string({ max: 500 })),
  /** The unique transfer comment tag that ties an on-chain payment to this invoice. */
  comment: s.string({ min: 1 }),
  status: InvoiceStatus,
  createdAt: s.string({ min: 1 }),
  expiresAt: s.string({ min: 1 }),
  /** ton://transfer deep link the payer opens in a wallet. */
  paymentLink: s.string({ min: 1 }),
  paidAt: s.optional(s.string({ min: 1 })),
  paidTxHash: s.optional(s.string({ min: 1 })),
  /** Amount actually received; the reconcile ensure guarantees >= amountNano. */
  paidAmountNano: s.optional(AmountNano),
  cancelledAt: s.optional(s.string({ min: 1 })),
});
export type Invoice = s.Infer<typeof Invoice>;

/** One incoming on-chain transfer to the receive address. */
export const IncomingTransfer = s.object({
  txHash: s.string({ min: 1, max: 128 }),
  lt: LogicalTime,
  amountNano: AmountNano,
  comment: s.optional(s.string({ max: 500 })),
  /**
   * The transaction's ON-CHAIN time (toncenter v3 `now`, unix seconds),
   * normalized by the adapter to the same fixed-length UTC ISO form the clock
   * port produces. Expiry matching uses THIS time — a payment made while the
   * invoice was open must not be refused just because the poller observed it
   * late. Optional defensively; when absent, matching falls back to the
   * reconcile's wall clock (the pre-utime behavior).
   */
  utime: s.optional(s.string({ min: 1 })),
});
export type IncomingTransfer = s.Infer<typeof IncomingTransfer>;

/** Why a recorded transfer could not be attributed to an invoice. */
export const UnattributedReason = s.union([
  s.literal("no_match"),
  s.literal("underpaid"),
  s.literal("invoice_not_open"),
  s.literal("duplicate"),
]);
export type UnattributedReason = s.Infer<typeof UnattributedReason>;

/**
 * A transfer the reconcile saw but could NOT settle against an invoice. The
 * funds are on chain in the merchant's wallet either way, so every such
 * transfer is persisted (never silently dropped) for manual refund/credit:
 * `no_match` (unknown/absent comment), `underpaid` (below the invoice amount —
 * partial payments are NOT accumulated), `invoice_not_open` (paid after
 * expiry, or the invoice was expired/cancelled/lost a settle race), and
 * `duplicate` (the invoice was already paid by an earlier transfer).
 */
export const UnattributedTransfer = s.object({
  txHash: s.string({ min: 1, max: 128 }),
  lt: LogicalTime,
  amountNano: AmountNano,
  comment: s.optional(s.string({ max: 500 })),
  utime: s.optional(s.string({ min: 1 })),
  reason: UnattributedReason,
  seenAt: s.string({ min: 1 }),
});
export type UnattributedTransfer = s.Infer<typeof UnattributedTransfer>;

/** One transaction the chain watcher could not parse; quarantined, not fatal. */
export const MalformedTransaction = s.object({
  path: s.string({ min: 1, max: 200 }),
  detail: s.string({ min: 1, max: 500 }),
  txHash: s.optional(s.string({ min: 1, max: 128 })),
});
export type MalformedTransaction = s.Infer<typeof MalformedTransaction>;

/* ------------------------------------------------------------------ */
/* Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hand-declared store port (not `port.store`) because the SQL adapter
 * carries semantics a generic store cannot express: `cancel` is a guarded
 * conditional UPDATE (only a pending invoice flips to cancelled),
 * `expirePending` is a set-based sweep, and `settle` is a transactional
 * unit of work — mark paid + record the transfer + advance the watcher
 * cursor in ONE transaction (BEGIN/COMMIT lives in the adapter). The
 * trade-off is explicit: no free `.memory()` and no auto-faking by
 * createTestApplication — src/adapters/memory.ts binds the fake.
 */
export const InvoiceStore = port("invoiceStore", {
  get: port.read({ input: s.string({ min: 1 }), output: s.optional(Invoice) }),
  save: port.write({ input: Invoice, output: Invoice }),
  list: port.read({ input: s.object({}), output: s.array(Invoice) }),
  listPending: port.read({ input: s.object({}), output: s.array(Invoice) }),
  /** Lookup by the UNIQUE comment tag, any status — reconcile uses it to
   * classify a transfer whose tag matches no OPEN invoice. */
  getByComment: port.read({
    input: s.object({ comment: s.string({ min: 1 }) }),
    output: s.optional(Invoice),
  }),
  /** Guarded flip pending -> cancelled; undefined when the invoice is not pending (or unknown). */
  cancel: port.write({
    input: s.object({ id: s.string({ min: 1 }), cancelledAt: s.string({ min: 1 }) }),
    output: s.optional(Invoice),
  }),
  /** Set-based sweep pending -> expired for invoices whose expiresAt <= now. */
  expirePending: port.write({
    input: s.object({ now: s.string({ min: 1 }) }),
    output: s.array(Invoice),
  }),
  /**
   * The atomic unit of work: mark the invoice paid, record the matched
   * transfer, and advance the watcher cursor to the transfer's lt — all in
   * one transaction. Undefined when the guarded UPDATE matches nothing (the
   * settle is skipped entirely; nothing is written): the invoice is no longer
   * pending, the transfer does not cover the invoice amount, or the
   * transfer's on-chain time is past `expiresAt + expiryGraceMs`. The last
   * two guards live in the adapter (SQL WHERE / memory mirror) so the money
   * invariant holds even if domain matching regresses.
   */
  settle: port.write({
    input: s.object({
      invoiceId: s.string({ min: 1 }),
      paidAt: s.string({ min: 1 }),
      transfer: IncomingTransfer,
      expiryGraceMs: s.number({ int: true, min: 0 }),
    }),
    output: s.optional(Invoice),
  }),
  /**
   * Persists a transfer the reconcile could not attribute AND advances the
   * watcher cursor to its lt in the SAME transaction, so a transfer is never
   * skipped without a durable record. Returns the stored (monotonic) cursor.
   */
  recordUnmatched: port.write({
    input: s.object({
      transfer: IncomingTransfer,
      reason: UnattributedReason,
      seenAt: s.string({ min: 1 }),
    }),
    output: s.object({ lt: LogicalTime }),
  }),
  listUnattributed: port.read({
    input: s.object({}),
    output: s.array(UnattributedTransfer),
  }),
  getCursor: port.read({
    input: s.object({}),
    output: s.object({ lt: LogicalTime }),
  }),
  /** Monotonic advance (never moves backwards); returns the stored cursor. */
  advanceCursor: port.write({
    input: s.object({ lt: LogicalTime }),
    output: s.object({ lt: LogicalTime }),
  }),
});

/**
 * Deployment configuration as a READ port, not an `external` one: the
 * receive address and invoice TTL are static per process (the assembly
 * closes over env-derived values), reading them has no side effects, no
 * latency, and no failure mode that a timeout would model. `external` is
 * reserved for calls that leave the process (chain watcher, notifier).
 */
export const InvoiceConfig = port("invoiceConfig", {
  get: port.read({
    input: s.object({}),
    output: s.object({
      receiveAddress: s.string({ min: 1 }),
      ttlMs: s.number({ int: true, min: 1 }),
      /** Extra slack past expiresAt within which an ON-CHAIN payment time
       * still settles the invoice (0 = exact expiry). */
      expiryGraceMs: s.number({ int: true, min: 0 }),
    }),
  }),
});

export const InvoiceClock = port("invoiceClock", {
  now: port.time({ input: s.object({}), output: s.string({ min: 1 }) }),
  /**
   * ISO timestamp + millisecond offset -> ISO timestamp. Date arithmetic is
   * a clock capability so the domain stays free of ambient Date usage; the
   * adapter owns the one-line Date computation.
   */
  plusMs: port.time({
    input: s.object({ iso: s.string({ min: 1 }), ms: s.number({ int: true, min: 0 }) }),
    output: s.string({ min: 1 }),
  }),
});

export const InvoiceIds = port("invoiceIds", {
  invoiceId: port.random({ input: s.object({}), output: s.string({ min: 1 }) }),
  commentTag: port.random({ input: s.object({}), output: s.string({ min: 1 }) }),
});

/**
 * Blockchain read model: new incoming transfers since a logical-time cursor.
 * A transaction the adapter cannot parse is QUARANTINED into `malformed`
 * (path + detail + tx hash when readable) instead of failing the page — one
 * bad transaction must never stall every healthy payment behind it.
 */
export const ChainWatcher = port("chainWatcher", {
  pull: port.external({
    input: s.object({ sinceLt: LogicalTime }),
    output: s.object({
      transfers: s.array(IncomingTransfer),
      malformed: s.optional(s.array(MalformedTransaction)),
    }),
    timeoutMs: 15_000,
  }),
});

/* ------------------------------------------------------------------ */
/* Events + notifier                                                  */
/* ------------------------------------------------------------------ */

export const InvoicePaidPayload = s.object({
  invoiceId: s.string({ min: 1 }),
  amountNano: AmountNano,
  transferAmountNano: AmountNano,
  txHash: s.string({ min: 1 }),
  comment: s.string({ min: 1 }),
  paidAt: s.string({ min: 1 }),
});
export type InvoicePaidPayload = s.Infer<typeof InvoicePaidPayload>;

export const InvoicePaid = event("invoice.paid", 1, InvoicePaidPayload);

/** Fired for every transfer recorded as unattributed, so operators can wire
 * an alert/refund flow without polling `invoices.listUnattributed`. */
export const InvoiceTransferUnattributed = event(
  "invoice.transferUnattributed",
  1,
  UnattributedTransfer,
);

/** Outbound notification channel (webhook / Telegram); definitely external. */
export const InvoiceNotifier = port("invoiceNotifier", {
  send: port.external({
    input: InvoicePaidPayload,
    output: s.object({ delivered: s.boolean() }),
    timeoutMs: 5_000,
  }),
});

/* ------------------------------------------------------------------ */
/* Pure helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Presentation rule: a stored-pending invoice past its expiry reads as
 * "expired" WITHOUT a write. Both timestamps come from the same clock
 * adapter in fixed-length UTC ISO form, so `<=` on the strings is the
 * correct chronological comparison. The reconcile sweep later persists the
 * transition; until then reads simply present it.
 */
export const presentInvoice = (invoice: Invoice, nowIso: string): Invoice =>
  invoice.status === "pending" && invoice.expiresAt <= nowIso
    ? { ...invoice, status: "expired" }
    : invoice;

const byLtAscending = (a: IncomingTransfer, b: IncomingTransfer): number => {
  const left = BigInt(a.lt);
  const right = BigInt(b.lt);
  return left < right ? -1 : left > right ? 1 : 0;
};

const ReconcileReport = s.object({
  /** Invoice ids swept pending -> expired this run. */
  expired: s.array(s.string({ min: 1 })),
  paid: s.array(
    s.object({
      invoiceId: s.string({ min: 1 }),
      amountNano: AmountNano,
      transferAmountNano: AmountNano,
      txHash: s.string({ min: 1 }),
      lt: LogicalTime,
    }),
  ),
  /** Fresh transfers persisted as unattributed this run (never dropped). */
  unattributed: s.array(UnattributedTransfer),
  /** Transactions the watcher quarantined as unparseable this page. */
  malformed: s.array(MalformedTransaction),
  /** Fresh transfers processed this run (after the cursor filter). */
  transfersSeen: s.number({ int: true, min: 0 }),
  cursor: LogicalTime,
});
export type ReconcileReport = s.Infer<typeof ReconcileReport>;

/* ------------------------------------------------------------------ */
/* Operations                                                         */
/* ------------------------------------------------------------------ */

export const invoices = feature("invoices", {
  events: [InvoicePaid, InvoiceTransferUnattributed],
  operations: {
    create: command({
      input: s.object({
        amountNano: AmountNano,
        memo: s.optional(s.string({ max: 500, trim: true })),
      }),
      output: Invoice,
      permissions: ["invoices:create"],
      http: { method: "POST", path: "/invoices", status: 201 },
      effects: {
        config: InvoiceConfig.get,
        nextId: InvoiceIds.invoiceId,
        nextTag: InvoiceIds.commentTag,
        now: InvoiceClock.now,
        plus: InvoiceClock.plusMs,
        save: InvoiceStore.save,
      },
      async execute({ input, effects }) {
        const { receiveAddress, ttlMs } = await effects.config({});
        const id = await effects.nextId({});
        const comment = await effects.nextTag({});
        const createdAt = await effects.now({});
        const expiresAt = await effects.plus({ iso: createdAt, ms: ttlMs });
        return effects.save({
          id,
          amountNano: input.amountNano,
          ...(input.memo === undefined ? {} : { memo: input.memo }),
          comment,
          status: "pending",
          createdAt,
          expiresAt,
          paymentLink: `ton://transfer/${receiveAddress}?amount=${input.amountNano}&text=${comment}`,
        });
      },
    }),

    /** Public: anyone holding an invoice id (e.g. the payer) may poll it. */
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Invoice,
      errors: { INVOICE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/invoices/:id" },
      effects: { load: InvoiceStore.get, now: InvoiceClock.now },
      async execute({ input, effects, fail }) {
        const invoice = await effects.load(input.id);
        if (invoice === undefined) return fail("INVOICE_NOT_FOUND", { id: input.id });
        return presentInvoice(invoice, await effects.now({}));
      },
    }),

    list: query({
      input: s.object({ status: s.optional(InvoiceStatus) }),
      output: s.array(Invoice),
      permissions: ["invoices:read"],
      http: { method: "GET", path: "/invoices" },
      effects: { list: InvoiceStore.list, now: InvoiceClock.now },
      async execute({ input, effects }) {
        // The status filter applies to the PRESENTED status, so a stored-
        // pending invoice past expiry lists under "expired", matching what
        // invoices.get answers for it. Filtering therefore happens here,
        // after presentation, not in the adapter's SQL.
        const now = await effects.now({});
        const presented = (await effects.list({})).map((invoice) =>
          presentInvoice(invoice, now),
        );
        return input.status === undefined
          ? presented
          : presented.filter((invoice) => invoice.status === input.status);
      },
    }),

    cancel: command({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Invoice,
      errors: {
        INVOICE_NOT_FOUND: { http: 404, details: { id: s.string() } },
        INVOICE_NOT_PENDING: {
          http: 409,
          details: { id: s.string(), status: InvoiceStatus },
        },
      },
      permissions: ["invoices:cancel"],
      http: { method: "POST", path: "/invoices/:id/cancel" },
      effects: {
        load: InvoiceStore.get,
        now: InvoiceClock.now,
        cancel: InvoiceStore.cancel,
      },
      async execute({ input, effects, fail }) {
        const invoice = await effects.load(input.id);
        if (invoice === undefined) return fail("INVOICE_NOT_FOUND", { id: input.id });
        if (invoice.status !== "pending") {
          return fail("INVOICE_NOT_PENDING", { id: input.id, status: invoice.status });
        }
        // A stored-pending invoice past expiry is still cancellable (the
        // sweep just has not run yet); only paid/cancelled/expired STORED
        // states conflict. The adapter re-checks pending inside the UPDATE,
        // so a concurrent settle/sweep loses nothing: undefined here means
        // the friendly read above lost a race.
        const cancelled = await effects.cancel({
          id: input.id,
          cancelledAt: await effects.now({}),
        });
        if (cancelled === undefined) {
          return fail("INVOICE_NOT_PENDING", { id: input.id, status: invoice.status });
        }
        return cancelled;
      },
    }),

    /**
     * The poller's command (also exposed over HTTP for manual runs):
     * 1. pull fresh incoming transfers since the stored cursor (transactions
     *    the watcher could not parse arrive quarantined in `malformed`);
     * 2. match by comment tag, ON-CHAIN payment time within
     *    `expiresAt + expiryGraceMs` (the poller's clock only as fallback for
     *    a transfer without `utime`), AND transfer amount >= invoice amount;
     * 3. settle each match ATOMICALLY (paid + transfer + cursor in one
     *    transaction, inside the ONE settle effect);
     * 4. persist every OTHER fresh transfer as unattributed — cursor advance
     *    and record share one transaction, so received funds are NEVER
     *    invisible: a transfer below the invoice amount is NOT accumulated
     *    and NOT refunded automatically, it is recorded as `underpaid` for
     *    manual operator action;
     * 5. sweep pending invoices past expiry to "expired" — AFTER matching, so
     *    a payment made on time but observed late still settles.
     * Idempotent by construction: transfers at or below the cursor are
     * dropped, and settle only ever flips a still-pending invoice.
     */
    reconcile: command({
      input: s.object({}),
      output: ReconcileReport,
      permissions: ["invoices:reconcile"],
      http: { method: "POST", path: "/invoices/reconcile" },
      effects: {
        now: InvoiceClock.now,
        plus: InvoiceClock.plusMs,
        config: InvoiceConfig.get,
        expire: InvoiceStore.expirePending,
        getCursor: InvoiceStore.getCursor,
        pull: ChainWatcher.pull,
        listPending: InvoiceStore.listPending,
        getByComment: InvoiceStore.getByComment,
        settle: InvoiceStore.settle,
        recordUnmatched: InvoiceStore.recordUnmatched,
        advanceCursor: InvoiceStore.advanceCursor,
      },
      emits: { paid: InvoicePaid, unattributed: InvoiceTransferUnattributed },
      ensures: {
        paidTransferCoversInvoiceAmount: {
          check: ({ output }) =>
            output.paid.every(
              (entry) => BigInt(entry.transferAmountNano) >= BigInt(entry.amountNano),
            ),
        },
        everyFreshTransferAccountedFor: {
          check: ({ output }) =>
            output.paid.length + output.unattributed.length === output.transfersSeen,
        },
      },
      async execute({ effects, emit }) {
        const now = await effects.now({});
        const { expiryGraceMs } = await effects.config({});
        const { lt: cursor } = await effects.getCursor({});
        const { transfers, malformed = [] } = await effects.pull({ sinceLt: cursor });

        // Defensive replay filter: even a watcher that ignores sinceLt (or
        // re-delivers a page) cannot double-process a transfer at or below
        // the cursor. Ascending lt order keeps per-settle cursor advances
        // monotonic.
        const fresh = transfers
          .filter((transfer) => BigInt(transfer.lt) > BigInt(cursor))
          .sort(byLtAscending);

        // Pending invoices indexed by comment tag. The tag is UNIQUE in the
        // store; a duplicate here would make the shadowed invoice permanently
        // unpayable, so it fails the reconcile loudly instead of being
        // silently overwritten.
        const pendingByComment = new Map<string, Invoice>();
        for (const invoice of await effects.listPending({})) {
          if (pendingByComment.has(invoice.comment)) {
            throw new Error(
              `invariant violated: comment tag '${invoice.comment}' is shared by multiple pending invoices`,
            );
          }
          pendingByComment.set(invoice.comment, invoice);
        }

        const paid: Array<ReconcileReport["paid"][number]> = [];
        const unattributed: UnattributedTransfer[] = [];
        let cursorAfter = cursor;

        /** Persist + cursor-advance (one transaction), report, and notify. */
        const quarantine = async (
          transfer: IncomingTransfer,
          reason: UnattributedReason,
        ): Promise<void> => {
          const advanced = await effects.recordUnmatched({
            transfer,
            reason,
            seenAt: now,
          });
          cursorAfter = advanced.lt;
          const entry: UnattributedTransfer = { ...transfer, reason, seenAt: now };
          unattributed.push(entry);
          emit.unattributed(entry);
        };

        for (const transfer of fresh) {
          const match =
            transfer.comment === undefined
              ? undefined
              : pendingByComment.get(transfer.comment);
          if (match === undefined) {
            const known =
              transfer.comment === undefined
                ? undefined
                : await effects.getByComment({ comment: transfer.comment });
            await quarantine(
              transfer,
              known === undefined
                ? "no_match"
                : known.status === "paid"
                  ? "duplicate"
                  : "invoice_not_open",
            );
            continue;
          }
          // The payment counts while paidAtChain < expiresAt + grace — the
          // same boundary expirePending/presentInvoice use (expired once
          // expiresAt <= now). All values are fixed-length UTC ISO strings
          // from the clock/watcher adapters, so `<` compares chronologically.
          const paidAtChain = transfer.utime ?? now;
          const deadline = await effects.plus({ iso: match.expiresAt, ms: expiryGraceMs });
          if (paidAtChain >= deadline) {
            await quarantine(transfer, "invoice_not_open");
            continue;
          }
          if (BigInt(transfer.amountNano) < BigInt(match.amountNano)) {
            await quarantine(transfer, "underpaid");
            continue;
          }
          const settled = await effects.settle({
            invoiceId: match.id,
            paidAt: now,
            transfer,
            expiryGraceMs,
          });
          if (settled === undefined) {
            // Lost a race (concurrent cancel/sweep/reconcile): settle wrote
            // nothing, but the funds are on chain — record them.
            await quarantine(transfer, "invoice_not_open");
            continue;
          }
          pendingByComment.delete(match.comment);
          cursorAfter = transfer.lt;
          paid.push({
            invoiceId: settled.id,
            amountNano: settled.amountNano,
            transferAmountNano: transfer.amountNano,
            txHash: transfer.txHash,
            lt: transfer.lt,
          });
          emit.paid({
            invoiceId: settled.id,
            amountNano: settled.amountNano,
            transferAmountNano: transfer.amountNano,
            txHash: transfer.txHash,
            comment: match.comment,
            paidAt: now,
          });
        }

        // Sweep AFTER matching: an invoice paid on chain before expiry but
        // observed late has already settled above and is no longer pending.
        const expired = await effects.expire({ now });

        // Defense in depth: every fresh transfer already advanced the cursor
        // through settle/recordUnmatched, but a trailing gap (should one ever
        // appear) must not cause a re-read.
        const last = fresh.at(-1);
        if (last !== undefined && BigInt(last.lt) > BigInt(cursorAfter)) {
          const advanced = await effects.advanceCursor({ lt: last.lt });
          cursorAfter = advanced.lt;
        }

        return {
          expired: expired.map((invoice) => invoice.id),
          paid,
          unattributed,
          malformed: [...malformed],
          transfersSeen: fresh.length,
          cursor: cursorAfter,
        };
      },
    }),

    /**
     * Operator visibility for every transfer the reconcile could not settle
     * (partial payments, duplicates, post-expiry payments, race losers) so
     * they can be refunded or credited manually.
     */
    listUnattributed: query({
      input: s.object({}),
      output: s.array(UnattributedTransfer),
      permissions: ["invoices:read"],
      http: { method: "GET", path: "/invoices/transfers/unattributed" },
      effects: { list: InvoiceStore.listUnattributed },
      async execute({ effects }) {
        return effects.list({});
      },
    }),

    /**
     * Internal delivery command (no `http` metadata, so it is never routed).
     * The assembly's invoice.paid subscriber dispatches it, which is what
     * lets the notifier stay a REAL external port: declared timeout,
     * validated payload, observable effect call, swappable adapter
     * (webhook / Telegram / console).
     */
    notifyPaid: command({
      input: InvoicePaidPayload,
      output: s.object({ delivered: s.boolean() }),
      permissions: ["invoices:notify"],
      effects: { deliver: InvoiceNotifier.send },
      async execute({ input, effects }) {
        return effects.deliver(input);
      },
    }),
  },
});
