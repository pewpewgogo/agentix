/**
 * In-memory adapters for tests and dependency-free local runs. Each mirrors
 * the SEMANTICS the SQL adapter promises (guarded conditional writes, the
 * atomic settle, the monotonic cursor, the unique tx-hash constraint), so
 * behavior tests over these fakes stay honest about production.
 */
import type { BoundPortAdapter } from "@agentixdev/core";

import {
  ChainWatcher,
  InvoiceNotifier,
  InvoiceStore,
  type IncomingTransfer,
  type Invoice,
  type InvoicePaidPayload,
  type UnattributedTransfer,
} from "../features/invoices.js";

export interface RecordedTransfer extends IncomingTransfer {
  readonly invoiceId: string;
  readonly recordedAt: string;
}

export interface MemoryInvoiceStore {
  readonly adapter: BoundPortAdapter;
  readonly invoices: Map<string, Invoice>;
  readonly transfers: Map<string, RecordedTransfer>;
  readonly unattributed: Map<string, UnattributedTransfer>;
  cursor(): string;
}

export const createMemoryInvoiceStore = (): MemoryInvoiceStore => {
  const invoices = new Map<string, Invoice>();
  const transfers = new Map<string, RecordedTransfer>();
  const unattributed = new Map<string, UnattributedTransfer>();
  /** Mirrors the SQL UNIQUE on invoices.comment. */
  const comments = new Set<string>();
  let cursorLt = "0";

  const advance = (lt: string): string => {
    if (BigInt(lt) > BigInt(cursorLt)) cursorLt = lt;
    return cursorLt;
  };

  const adapter = InvoiceStore.adapter({
    get: (id) => invoices.get(id),
    save: (invoice) => {
      // Mirrors the PRIMARY KEY: a duplicate id is a defect, not an upsert.
      if (invoices.has(invoice.id)) {
        throw new Error(`invoice ${invoice.id} already exists`);
      }
      // Mirrors the UNIQUE on comment: a colliding tag would make the earlier
      // invoice unpayable (reconcile matches by comment), so it fails hard
      // exactly like the SQL INSERT would.
      if (comments.has(invoice.comment)) {
        throw new Error(`invoice comment tag ${invoice.comment} already exists`);
      }
      invoices.set(invoice.id, invoice);
      comments.add(invoice.comment);
      return invoice;
    },
    list: () => [...invoices.values()],
    listPending: () =>
      [...invoices.values()].filter((invoice) => invoice.status === "pending"),
    getByComment: ({ comment }) =>
      [...invoices.values()].find((invoice) => invoice.comment === comment),
    cancel: ({ id, cancelledAt }) => {
      const invoice = invoices.get(id);
      if (invoice === undefined || invoice.status !== "pending") return undefined;
      const cancelled: Invoice = { ...invoice, status: "cancelled", cancelledAt };
      invoices.set(id, cancelled);
      return cancelled;
    },
    expirePending: ({ now }) => {
      const swept: Invoice[] = [];
      for (const invoice of invoices.values()) {
        if (invoice.status === "pending" && invoice.expiresAt <= now) {
          const expired: Invoice = { ...invoice, status: "expired" };
          invoices.set(invoice.id, expired);
          swept.push(expired);
        }
      }
      return swept;
    },
    settle: ({ invoiceId, paidAt, transfer, expiryGraceMs }) => {
      const invoice = invoices.get(invoiceId);
      // Mirrors the guarded UPDATE's WHERE: not-pending, an amount below the
      // invoice, or an on-chain payment time at/past expiresAt + grace all
      // settle NOTHING (the SQL transaction would COMMIT empty).
      if (invoice === undefined || invoice.status !== "pending") return undefined;
      if (BigInt(transfer.amountNano) < BigInt(invoice.amountNano)) return undefined;
      if (
        transfer.utime !== undefined &&
        Date.parse(transfer.utime) >= Date.parse(invoice.expiresAt) + expiryGraceMs
      ) {
        return undefined;
      }
      // Mirrors the transfers PRIMARY KEY: recording the same tx twice is a
      // hard failure (in SQL the whole transaction would roll back).
      if (transfers.has(transfer.txHash)) {
        throw new Error(`transfer ${transfer.txHash} is already recorded`);
      }
      const paid: Invoice = {
        ...invoice,
        status: "paid",
        paidAt,
        paidTxHash: transfer.txHash,
        paidAmountNano: transfer.amountNano,
      };
      invoices.set(invoiceId, paid);
      transfers.set(transfer.txHash, { ...transfer, invoiceId, recordedAt: paidAt });
      advance(transfer.lt);
      return paid;
    },
    recordUnmatched: ({ transfer, reason, seenAt }) => {
      // Mirrors the unattributed_transfers PRIMARY KEY (and in SQL the row
      // insert + cursor advance share one transaction).
      if (unattributed.has(transfer.txHash)) {
        throw new Error(`transfer ${transfer.txHash} is already recorded as unattributed`);
      }
      unattributed.set(transfer.txHash, { ...transfer, reason, seenAt });
      return { lt: advance(transfer.lt) };
    },
    listUnattributed: () => [...unattributed.values()],
    getCursor: () => ({ lt: cursorLt }),
    advanceCursor: ({ lt }) => ({ lt: advance(lt) }),
  });

  return { adapter, invoices, transfers, unattributed, cursor: () => cursorLt };
};

export interface MemoryChainWatcher {
  readonly adapter: BoundPortAdapter;
  readonly transfers: IncomingTransfer[];
  push(transfer: IncomingTransfer): void;
}

/** A scriptable chain: tests (and local dev) `push` transfers onto it. */
export const createMemoryChainWatcher = (): MemoryChainWatcher => {
  const transfers: IncomingTransfer[] = [];
  const adapter = ChainWatcher.adapter({
    pull: ({ sinceLt }) => ({
      transfers: transfers
        .filter((transfer) => BigInt(transfer.lt) > BigInt(sinceLt))
        .sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1)),
    }),
  });
  return {
    adapter,
    transfers,
    push: (transfer) => {
      transfers.push(transfer);
    },
  };
};

export interface MemoryNotifier {
  readonly adapter: BoundPortAdapter;
  readonly notifications: InvoicePaidPayload[];
}

export const createMemoryNotifier = (): MemoryNotifier => {
  const notifications: InvoicePaidPayload[] = [];
  const adapter = InvoiceNotifier.adapter({
    send: (notification) => {
      notifications.push(notification);
      return { delivered: true };
    },
  });
  return { adapter, notifications };
};

/** Default notifier when no webhook/Telegram is configured: a JSON log line. */
export const createConsoleNotifier = (
  log: (line: string) => void = (line) => {
    console.log(line);
  },
): BoundPortAdapter =>
  InvoiceNotifier.adapter({
    send: (notification) => {
      log(JSON.stringify({ msg: "invoice.paid.notification", ...notification }));
      return { delivered: true };
    },
  });
