/**
 * Unit tests for the PostgreSQL adapter against an in-memory fake of the pg
 * Pool/PoolClient query surface. No PostgreSQL server involved: the fake
 * records every statement so tests assert the parameterized SQL text, the
 * bound values, and the BEGIN/COMMIT/ROLLBACK ordering of the settle
 * transaction.
 */
import { describe, expect, it } from "vitest";

import type { Invoice } from "../features/invoices.js";
import {
  createInvoiceStoreHandlers,
  createPostgresInvoiceStoreAdapter,
  type SqlClient,
  type SqlPool,
  type SqlRowSet,
} from "./postgres.js";

/* ------------------------------------------------------------------ */
/* Fake pg pool                                                       */
/* ------------------------------------------------------------------ */

interface LoggedQuery {
  readonly via: "pool" | "client";
  readonly text: string;
  readonly values: unknown[] | undefined;
}

type Respond = (text: string, values: unknown[] | undefined) => SqlRowSet;

const emptyRows: SqlRowSet = { rows: [], rowCount: 0 };

/** Collapses whitespace so assertions read like the SQL they check. */
const sql = (entry: LoggedQuery): string => entry.text.replace(/\s+/g, " ").trim();

const createFakePool = (respond: Respond = () => emptyRows) => {
  const log: LoggedQuery[] = [];
  const releases: boolean[] = [];
  let connects = 0;
  let ended = false;

  const pool: SqlPool = {
    query: async (text, values) => {
      log.push({ via: "pool", text, values });
      return respond(text, values);
    },
    connect: async () => {
      const index = connects;
      connects += 1;
      releases[index] = false;
      const client: SqlClient = {
        query: async (text, values) => {
          log.push({ via: "client", text, values });
          return respond(text, values);
        },
        release: () => {
          releases[index] = true;
        },
      };
      return client;
    },
    end: async () => {
      ended = true;
    },
  };

  return {
    pool,
    log,
    statements: () => log.map(sql),
    released: (index = 0) => releases[index] === true,
    connectCount: () => connects,
    ended: () => ended,
  };
};

/** A pending invoice as PostgreSQL returns it: timestamptz as Date, numeric as string. */
const invoiceRow = {
  id: "inv-1",
  amount_nano: "1500000000",
  memo: null,
  comment: "tag-1",
  status: "pending",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  expires_at: new Date("2026-01-01T00:15:00.000Z"),
  payment_link: "ton://transfer/ADDR?amount=1500000000&text=tag-1",
  paid_at: null,
  paid_tx_hash: null,
  paid_amount_nano: null,
  cancelled_at: null,
};

const mappedInvoice: Invoice = {
  id: "inv-1",
  amountNano: "1500000000",
  comment: "tag-1",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:15:00.000Z",
  paymentLink: "ton://transfer/ADDR?amount=1500000000&text=tag-1",
};

const transfer = { txHash: "tx-1", lt: "12345", amountNano: "1500000000", comment: "tag-1" };

/* ------------------------------------------------------------------ */
/* Plain statements                                                   */
/* ------------------------------------------------------------------ */

describe("postgres invoice store handlers", () => {
  it("get issues a parameterized SELECT and maps the row (numeric -> string, timestamptz -> ISO)", async () => {
    const fake = createFakePool(() => ({ rows: [{ ...invoiceRow }], rowCount: 1 }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    const invoice = await handlers.get("inv-1");
    expect(invoice).toEqual(mappedInvoice);

    const entry = fake.log[0];
    expect(entry?.via).toBe("pool");
    expect(sql(entry!)).toContain("FROM invoices WHERE id = $1");
    expect(entry?.values).toEqual(["inv-1"]);
    // The value travels only through the parameter vector, never the text.
    expect(entry?.text).not.toContain("inv-1");
  });

  it("get returns undefined when no row matches", async () => {
    const fake = createFakePool();
    await expect(
      createInvoiceStoreHandlers(() => fake.pool).get("missing"),
    ).resolves.toBeUndefined();
  });

  it("save INSERTs with every value parameterized (nulls for absent optionals)", async () => {
    const fake = createFakePool();
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(handlers.save(mappedInvoice)).resolves.toEqual(mappedInvoice);

    const entry = fake.log[0];
    expect(sql(entry!)).toContain("INSERT INTO invoices");
    expect(sql(entry!)).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    );
    expect(entry?.values).toEqual([
      "inv-1",
      "1500000000",
      null,
      "tag-1",
      "pending",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:15:00.000Z",
      "ton://transfer/ADDR?amount=1500000000&text=tag-1",
      null,
      null,
      null,
      null,
    ]);
  });

  it("list and listPending select with a stable ORDER BY", async () => {
    const fake = createFakePool(() => ({ rows: [{ ...invoiceRow }], rowCount: 1 }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await handlers.list();
    await handlers.listPending();

    expect(fake.statements()[0]).toContain("ORDER BY created_at, id");
    expect(fake.statements()[1]).toContain("WHERE status = 'pending'");
    expect(fake.statements()[1]).toContain("ORDER BY created_at, id");
  });

  it("cancel is a guarded UPDATE: only a still-pending row flips", async () => {
    const cancelledRow = {
      ...invoiceRow,
      status: "cancelled",
      cancelled_at: new Date("2026-01-02T00:00:00.000Z"),
    };
    const fake = createFakePool(() => ({ rows: [cancelledRow], rowCount: 1 }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    const cancelled = await handlers.cancel({
      id: "inv-1",
      cancelledAt: "2026-01-02T00:00:00.000Z",
    });
    expect(cancelled).toEqual({
      ...mappedInvoice,
      status: "cancelled",
      cancelledAt: "2026-01-02T00:00:00.000Z",
    });

    const entry = fake.log[0];
    expect(sql(entry!)).toContain("SET status = 'cancelled', cancelled_at = $2");
    expect(sql(entry!)).toContain("WHERE id = $1 AND status = 'pending'");
    expect(entry?.values).toEqual(["inv-1", "2026-01-02T00:00:00.000Z"]);

    const miss = createFakePool();
    await expect(
      createInvoiceStoreHandlers(() => miss.pool).cancel({
        id: "inv-1",
        cancelledAt: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("expirePending sweeps set-based with the timestamp parameterized", async () => {
    const expiredRow = { ...invoiceRow, status: "expired" };
    const fake = createFakePool(() => ({ rows: [expiredRow], rowCount: 1 }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    const swept = await handlers.expirePending({ now: "2026-01-01T01:00:00.000Z" });
    expect(swept).toEqual([{ ...mappedInvoice, status: "expired" }]);

    const entry = fake.log[0];
    expect(sql(entry!)).toContain("SET status = 'expired'");
    expect(sql(entry!)).toContain("WHERE status = 'pending' AND expires_at <= $1");
    expect(entry?.values).toEqual(["2026-01-01T01:00:00.000Z"]);
  });

  it("getCursor answers '0' before any row exists and the stored lt afterwards", async () => {
    const empty = createFakePool();
    await expect(
      createInvoiceStoreHandlers(() => empty.pool).getCursor(),
    ).resolves.toEqual({ lt: "0" });

    const seeded = createFakePool(() => ({ rows: [{ lt: "12345" }], rowCount: 1 }));
    await expect(
      createInvoiceStoreHandlers(() => seeded.pool).getCursor(),
    ).resolves.toEqual({ lt: "12345" });
  });

  it("advanceCursor upserts monotonically via GREATEST", async () => {
    const fake = createFakePool(() => ({ rows: [{ lt: "99999" }], rowCount: 1 }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(handlers.advanceCursor({ lt: "500" })).resolves.toEqual({
      lt: "99999", // the store had already moved further; GREATEST won
    });
    const entry = fake.log[0];
    expect(sql(entry!)).toContain("INSERT INTO watcher_cursor (id, lt) VALUES (1, $1)");
    expect(sql(entry!)).toContain(
      "ON CONFLICT (id) DO UPDATE SET lt = GREATEST(watcher_cursor.lt, EXCLUDED.lt)",
    );
    expect(entry?.values).toEqual(["500"]);
  });
});

/* ------------------------------------------------------------------ */
/* The settle transaction                                             */
/* ------------------------------------------------------------------ */

describe("settle unit of work", () => {
  const paidRow = {
    ...invoiceRow,
    status: "paid",
    paid_at: new Date("2026-01-01T00:10:00.000Z"),
    paid_tx_hash: "tx-1",
    paid_amount_nano: "1500000000",
  };

  it("runs UPDATE + transfer INSERT + cursor upsert between BEGIN and COMMIT on one client", async () => {
    const fake = createFakePool((text) =>
      text.includes("SET status = 'paid'") ? { rows: [paidRow], rowCount: 1 } : emptyRows,
    );
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    const settled = await handlers.settle({
      invoiceId: "inv-1",
      paidAt: "2026-01-01T00:10:00.000Z",
      transfer,
      expiryGraceMs: 0,
    });

    expect(settled).toEqual({
      ...mappedInvoice,
      status: "paid",
      paidAt: "2026-01-01T00:10:00.000Z",
      paidTxHash: "tx-1",
      paidAmountNano: "1500000000",
    });

    const statements = fake.statements();
    expect(statements).toHaveLength(5);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("SET status = 'paid', paid_at = $2, paid_tx_hash = $3, paid_amount_nano = $4");
    expect(statements[1]).toContain("WHERE id = $1 AND status = 'pending'");
    // PRODUCTION money guards live in the WHERE (ensures are dev/test-only):
    // coverage of the invoice amount and the on-chain payment-time bound.
    expect(statements[1]).toContain("AND $4::numeric >= amount_nano");
    expect(statements[1]).toContain(
      "AND ($5::timestamptz IS NULL OR $5::timestamptz < expires_at + $6 * interval '1 millisecond')",
    );
    expect(statements[2]).toContain("INSERT INTO transfers");
    expect(statements[3]).toContain("INSERT INTO watcher_cursor");
    expect(statements[4]).toBe("COMMIT");

    // Every statement of the transaction ran on the checked-out client.
    expect(fake.log.every((entry) => entry.via === "client")).toBe(true);
    expect(fake.connectCount()).toBe(1);
    expect(fake.released()).toBe(true);

    expect(fake.log[1]?.values).toEqual([
      "inv-1",
      "2026-01-01T00:10:00.000Z",
      "tx-1",
      "1500000000",
      null, // no on-chain time on this transfer
      0,
    ]);
    expect(fake.log[2]?.values).toEqual([
      "tx-1",
      "12345",
      "1500000000",
      "tag-1",
      "inv-1",
      "2026-01-01T00:10:00.000Z",
      null,
    ]);
    expect(fake.log[3]?.values).toEqual(["12345"]);
  });

  it("binds the transfer's on-chain time and the grace budget into the settle guard", async () => {
    const fake = createFakePool((text) =>
      text.includes("SET status = 'paid'") ? { rows: [paidRow], rowCount: 1 } : emptyRows,
    );
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await handlers.settle({
      invoiceId: "inv-1",
      paidAt: "2026-01-01T00:10:00.000Z",
      transfer: { ...transfer, utime: "2026-01-01T00:09:00.000Z" },
      expiryGraceMs: 30_000,
    });

    expect(fake.log[1]?.values).toEqual([
      "inv-1",
      "2026-01-01T00:10:00.000Z",
      "tx-1",
      "1500000000",
      "2026-01-01T00:09:00.000Z",
      30_000,
    ]);
    expect(fake.log[2]?.values?.at(-1)).toBe("2026-01-01T00:09:00.000Z");
  });

  it("commits an empty transaction and returns undefined when the guard matches nothing", async () => {
    const fake = createFakePool();
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(
      handlers.settle({
        invoiceId: "inv-1",
        paidAt: "2026-01-01T00:10:00.000Z",
        transfer,
        expiryGraceMs: 0,
      }),
    ).resolves.toBeUndefined();

    const statements = fake.statements();
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((s) => s.includes("INSERT"))).toBe(false);
    expect(fake.released()).toBe(true);
  });

  it("rolls back, releases the client, and rethrows when the transfer INSERT fails", async () => {
    const failure = new Error("duplicate key value violates unique constraint");
    const fake = createFakePool((text) => {
      if (text.includes("SET status = 'paid'")) return { rows: [paidRow], rowCount: 1 };
      if (text.includes("INSERT INTO transfers")) throw failure;
      return emptyRows;
    });
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(
      handlers.settle({
        invoiceId: "inv-1",
        paidAt: "2026-01-01T00:10:00.000Z",
        transfer,
        expiryGraceMs: 0,
      }),
    ).rejects.toBe(failure);

    const statements = fake.statements();
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((s) => s.includes("watcher_cursor"))).toBe(false);
    expect(fake.released()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The unattributed quarantine                                        */
/* ------------------------------------------------------------------ */

describe("recordUnmatched unit of work", () => {
  const unmatched = {
    transfer: { txHash: "tx-u", lt: "777", amountNano: "500", comment: "tag-x" },
    reason: "underpaid" as const,
    seenAt: "2026-01-01T00:10:00.000Z",
  };

  it("INSERTs the unattributed row and advances the cursor in ONE transaction", async () => {
    const fake = createFakePool((text) =>
      text.includes("watcher_cursor") ? { rows: [{ lt: "777" }], rowCount: 1 } : emptyRows,
    );
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(handlers.recordUnmatched(unmatched)).resolves.toEqual({ lt: "777" });

    const statements = fake.statements();
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("INSERT INTO unattributed_transfers");
    expect(statements[2]).toContain("INSERT INTO watcher_cursor");
    expect(statements[3]).toBe("COMMIT");
    expect(fake.log.every((entry) => entry.via === "client")).toBe(true);
    expect(fake.released()).toBe(true);

    expect(fake.log[1]?.values).toEqual([
      "tx-u",
      "777",
      "500",
      "tag-x",
      null, // utime
      "underpaid",
      "2026-01-01T00:10:00.000Z",
    ]);
    expect(fake.log[2]?.values).toEqual(["777"]);
  });

  it("rolls back the cursor advance when the unattributed INSERT fails", async () => {
    const failure = new Error("duplicate key value violates unique constraint");
    const fake = createFakePool((text) => {
      if (text.includes("INSERT INTO unattributed_transfers")) throw failure;
      return emptyRows;
    });
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(handlers.recordUnmatched(unmatched)).rejects.toBe(failure);
    const statements = fake.statements();
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some((s) => s.includes("watcher_cursor"))).toBe(false);
  });

  it("getByComment selects by the parameterized tag", async () => {
    const fake = createFakePool(() => ({ rows: [{ ...invoiceRow }], rowCount: 1 }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(handlers.getByComment({ comment: "tag-1" })).resolves.toEqual(
      mappedInvoice,
    );
    const entry = fake.log[0];
    expect(sql(entry!)).toContain("FROM invoices WHERE comment = $1");
    expect(entry?.values).toEqual(["tag-1"]);
    expect(entry?.text).not.toContain("tag-1");
  });

  it("listUnattributed maps rows (numeric -> string, timestamptz -> ISO, null comment omitted)", async () => {
    const fake = createFakePool(() => ({
      rows: [
        {
          tx_hash: "tx-u",
          lt: "777",
          amount_nano: "500",
          comment: null,
          utime: new Date("2026-01-01T00:09:00.000Z"),
          reason: "no_match",
          seen_at: new Date("2026-01-01T00:10:00.000Z"),
        },
      ],
      rowCount: 1,
    }));
    const handlers = createInvoiceStoreHandlers(() => fake.pool);

    await expect(handlers.listUnattributed()).resolves.toEqual([
      {
        txHash: "tx-u",
        lt: "777",
        amountNano: "500",
        utime: "2026-01-01T00:09:00.000Z",
        reason: "no_match",
        seenAt: "2026-01-01T00:10:00.000Z",
      },
    ]);
    expect(fake.statements()[0]).toContain("ORDER BY lt, tx_hash");
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle hooks                                                    */
/* ------------------------------------------------------------------ */

describe("adapter lifecycle", () => {
  it("init creates the pool and bootstraps all four tables; dispose ends it", async () => {
    const fake = createFakePool();
    const adapter = createPostgresInvoiceStoreAdapter({ createPool: () => fake.pool });

    await adapter.init?.();
    const bootstrap = fake.statements()[0] ?? "";
    expect(bootstrap).toContain("CREATE TABLE IF NOT EXISTS invoices");
    expect(bootstrap).toContain("CREATE TABLE IF NOT EXISTS transfers");
    expect(bootstrap).toContain("CREATE TABLE IF NOT EXISTS unattributed_transfers");
    expect(bootstrap).toContain("CREATE TABLE IF NOT EXISTS watcher_cursor");
    // The database-level money invariant: paid can never be below the amount.
    expect(bootstrap).toContain(
      "CHECK (paid_amount_nano IS NULL OR paid_amount_nano >= amount_nano)",
    );
    expect(fake.ended()).toBe(false);

    await adapter.dispose?.();
    expect(fake.ended()).toBe(true);
  });

  it("using the adapter before init fails loudly instead of touching a half-built pool", async () => {
    const fake = createFakePool();
    const adapter = createPostgresInvoiceStoreAdapter({ createPool: () => fake.pool });

    await expect(
      Promise.resolve(adapter.operations["getCursor"]?.({} as never)),
    ).rejects.toThrow(/before app\.start\(\)/);
    expect(fake.log).toHaveLength(0);
  });
});
