import type { BoundPortAdapter } from "@agentixdev/core";
import pg from "pg";

import {
  InvoiceStore,
  type IncomingTransfer,
  type Invoice,
  type InvoiceStatus,
  type UnattributedReason,
  type UnattributedTransfer,
} from "../features/invoices.js";

/* ------------------------------------------------------------------ */
/* The SQL seam                                                       */
/*                                                                    */
/* The adapter is written against the minimal query surface it        */
/* actually uses — not against pg's full API. `pg.Pool` satisfies it  */
/* in production; a scripted fake satisfies it in unit tests          */
/* (postgres.test.ts) without a server.                               */
/* ------------------------------------------------------------------ */

export interface SqlRowSet {
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number | null;
}

/** One checked-out connection; the transaction scope. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<SqlRowSet>;
  release(): void;
}

export interface SqlPool {
  query(text: string, values?: unknown[]): Promise<SqlRowSet>;
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}

/** Binds a real `pg.Pool` to the seam. Constructing a Pool opens nothing —
 * connections are established lazily on first query. */
export const createPostgresPool = (connectionString: string): SqlPool => {
  const pool = new pg.Pool({ connectionString });
  return {
    query: (text, values) => pool.query(text, values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, values) => client.query(text, values),
        release: () => {
          client.release();
        },
      };
    },
    end: () => pool.end(),
  };
};

/* ------------------------------------------------------------------ */
/* Schema bootstrap                                                   */
/*                                                                    */
/* Inline so `docker compose up` + `npm start` is the whole setup. A  */
/* production service would own DDL with a migration tool run as a    */
/* deploy step (see docs/PERSISTENCE.md). Amounts and logical times   */
/* are NUMERIC(30,0): TON works in uint64 nanotons/lt, past the JS    */
/* float range; pg returns NUMERIC as strings, which is exactly what  */
/* the domain speaks.                                                 */
/* ------------------------------------------------------------------ */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invoices (
  id               text PRIMARY KEY,
  amount_nano      numeric(30,0) NOT NULL CHECK (amount_nano > 0),
  memo             text,
  comment          text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('pending','paid','expired','cancelled')),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  payment_link     text NOT NULL,
  paid_at          timestamptz,
  paid_tx_hash     text,
  paid_amount_nano numeric(30,0),
  cancelled_at     timestamptz,
  CONSTRAINT invoices_paid_covers_amount
    CHECK (paid_amount_nano IS NULL OR paid_amount_nano >= amount_nano)
);
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_paid_covers_amount
    CHECK (paid_amount_nano IS NULL OR paid_amount_nano >= amount_nano);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS transfers (
  tx_hash     text PRIMARY KEY,
  lt          numeric(30,0) NOT NULL,
  amount_nano numeric(30,0) NOT NULL,
  comment     text,
  invoice_id  text NOT NULL REFERENCES invoices(id),
  recorded_at timestamptz NOT NULL,
  utime       timestamptz
);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS utime timestamptz;
CREATE TABLE IF NOT EXISTS unattributed_transfers (
  tx_hash     text PRIMARY KEY,
  lt          numeric(30,0) NOT NULL,
  amount_nano numeric(30,0) NOT NULL,
  comment     text,
  utime       timestamptz,
  reason      text NOT NULL CHECK (reason IN ('no_match','underpaid','invoice_not_open','duplicate')),
  seen_at     timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS watcher_cursor (
  id integer PRIMARY KEY CHECK (id = 1),
  lt numeric(30,0) NOT NULL
);
`;

/* ------------------------------------------------------------------ */
/* Unit of work                                                       */
/* ------------------------------------------------------------------ */

/**
 * Runs `work` on one checked-out client inside BEGIN/COMMIT, rolling back
 * when `work` throws. The scope lives HERE, in the adapter — domain code
 * never sees a client, a BEGIN, or a savepoint.
 */
export const withTransaction = async <T>(
  pool: SqlPool,
  work: (tx: SqlClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (cause: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is broken; release() below discards it.
    }
    throw cause;
  } finally {
    client.release();
  }
};

/* ------------------------------------------------------------------ */
/* Row mapping                                                        */
/* ------------------------------------------------------------------ */

const INVOICE_COLUMNS =
  "id, amount_nano, memo, comment, status, created_at, expires_at, payment_link, paid_at, paid_tx_hash, paid_amount_nano, cancelled_at";

/** pg parses timestamptz columns into Date; the domain speaks ISO strings. */
const isoString = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const INVOICE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "paid",
  "expired",
  "cancelled",
]);

/** Core re-parses effect outputs in EVERY mode (so a corrupt row would fault
 * the dispatch anyway, as INVALID_EFFECT_OUTPUT); this guard runs first purely
 * to name the offending row — e.g. a hand-edited status — in a clear error
 * instead of a schema-path message. */
const parseStatus = (value: unknown): InvoiceStatus => {
  const status = String(value);
  if (!INVOICE_STATUSES.has(status)) {
    throw new Error(`invoices row carries unknown status '${status}'`);
  }
  return status as InvoiceStatus;
};

const UNATTRIBUTED_REASONS: ReadonlySet<string> = new Set([
  "no_match",
  "underpaid",
  "invoice_not_open",
  "duplicate",
]);

const parseReason = (value: unknown): UnattributedReason => {
  const reason = String(value);
  if (!UNATTRIBUTED_REASONS.has(reason)) {
    throw new Error(`unattributed_transfers row carries unknown reason '${reason}'`);
  }
  return reason as UnattributedReason;
};

const rowToInvoice = (row: Record<string, unknown>): Invoice => ({
  id: String(row["id"]),
  amountNano: String(row["amount_nano"]),
  ...(row["memo"] == null ? {} : { memo: String(row["memo"]) }),
  comment: String(row["comment"]),
  status: parseStatus(row["status"]),
  createdAt: isoString(row["created_at"]),
  expiresAt: isoString(row["expires_at"]),
  paymentLink: String(row["payment_link"]),
  ...(row["paid_at"] == null ? {} : { paidAt: isoString(row["paid_at"]) }),
  ...(row["paid_tx_hash"] == null ? {} : { paidTxHash: String(row["paid_tx_hash"]) }),
  ...(row["paid_amount_nano"] == null
    ? {}
    : { paidAmountNano: String(row["paid_amount_nano"]) }),
  ...(row["cancelled_at"] == null ? {} : { cancelledAt: isoString(row["cancelled_at"]) }),
});

const rowToUnattributed = (row: Record<string, unknown>): UnattributedTransfer => ({
  txHash: String(row["tx_hash"]),
  lt: String(row["lt"]),
  amountNano: String(row["amount_nano"]),
  ...(row["comment"] == null ? {} : { comment: String(row["comment"]) }),
  ...(row["utime"] == null ? {} : { utime: isoString(row["utime"]) }),
  reason: parseReason(row["reason"]),
  seenAt: isoString(row["seen_at"]),
});

/* ------------------------------------------------------------------ */
/* Effect handlers                                                    */
/*                                                                    */
/* Every statement is parameterized ($1, $2, ...) — values never enter */
/* the SQL text. Exported as a factory so unit tests can call the      */
/* handlers directly against a fake pool.                              */
/* ------------------------------------------------------------------ */

const CURSOR_UPSERT_SQL = `INSERT INTO watcher_cursor (id, lt) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET lt = GREATEST(watcher_cursor.lt, EXCLUDED.lt)`;

export const createInvoiceStoreHandlers = (pool: () => SqlPool) => ({
  get: async (id: string): Promise<Invoice | undefined> => {
    const result = await pool().query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToInvoice(row);
  },

  save: async (invoice: Invoice): Promise<Invoice> => {
    // Plain INSERT: ids are generated (UUID) and the comment tag is UNIQUE;
    // a conflict on either is a defect and surfaces as EFFECT_FAILURE.
    await pool().query(
      `INSERT INTO invoices (${INVOICE_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        invoice.id,
        invoice.amountNano,
        invoice.memo ?? null,
        invoice.comment,
        invoice.status,
        invoice.createdAt,
        invoice.expiresAt,
        invoice.paymentLink,
        invoice.paidAt ?? null,
        invoice.paidTxHash ?? null,
        invoice.paidAmountNano ?? null,
        invoice.cancelledAt ?? null,
      ],
    );
    return invoice;
  },

  list: async (): Promise<Invoice[]> => {
    const result = await pool().query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices ORDER BY created_at, id`,
    );
    return result.rows.map(rowToInvoice);
  },

  listPending: async (): Promise<Invoice[]> => {
    const result = await pool().query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE status = 'pending' ORDER BY created_at, id`,
    );
    return result.rows.map(rowToInvoice);
  },

  getByComment: async (input: { comment: string }): Promise<Invoice | undefined> => {
    const result = await pool().query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE comment = $1`,
      [input.comment],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToInvoice(row);
  },

  cancel: async (input: {
    id: string;
    cancelledAt: string;
  }): Promise<Invoice | undefined> => {
    // The WHERE clause is the guard: only a still-pending row flips, so a
    // concurrent settle or sweep can never be overwritten.
    const result = await pool().query(
      `UPDATE invoices SET status = 'cancelled', cancelled_at = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING ${INVOICE_COLUMNS}`,
      [input.id, input.cancelledAt],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToInvoice(row);
  },

  expirePending: async (input: { now: string }): Promise<Invoice[]> => {
    const result = await pool().query(
      `UPDATE invoices SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= $1
       RETURNING ${INVOICE_COLUMNS}`,
      [input.now],
    );
    return result.rows.map(rowToInvoice);
  },

  /**
   * The atomic unit of work: mark paid + record the transfer + advance the
   * cursor either all happen or none do. The guarded UPDATE doubles as the
   * idempotence AND money-invariant check — a not-pending invoice, a transfer
   * below the invoice amount, or an on-chain payment time at/past
   * `expires_at + grace` settles nothing and writes nothing (COMMIT of an
   * empty transaction); together with the `invoices_paid_covers_amount`
   * CHECK this enforces coverage in PRODUCTION, where the operation's
   * `ensures` postcondition does not run. The transfers PRIMARY KEY is the
   * last line of defense against paying one transfer out twice: a duplicate
   * tx_hash fails the INSERT and rolls the UPDATE back.
   */
  settle: async (input: {
    invoiceId: string;
    paidAt: string;
    transfer: IncomingTransfer;
    expiryGraceMs: number;
  }): Promise<Invoice | undefined> =>
    withTransaction(pool(), async (tx) => {
      const updated = await tx.query(
        `UPDATE invoices
         SET status = 'paid', paid_at = $2, paid_tx_hash = $3, paid_amount_nano = $4
         WHERE id = $1 AND status = 'pending'
           AND $4::numeric >= amount_nano
           AND ($5::timestamptz IS NULL OR $5::timestamptz < expires_at + $6 * interval '1 millisecond')
         RETURNING ${INVOICE_COLUMNS}`,
        [
          input.invoiceId,
          input.paidAt,
          input.transfer.txHash,
          input.transfer.amountNano,
          input.transfer.utime ?? null,
          input.expiryGraceMs,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) return undefined; // guard matched nothing; COMMIT is a no-op
      await tx.query(
        `INSERT INTO transfers (tx_hash, lt, amount_nano, comment, invoice_id, recorded_at, utime)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.transfer.txHash,
          input.transfer.lt,
          input.transfer.amountNano,
          input.transfer.comment ?? null,
          input.invoiceId,
          input.paidAt,
          input.transfer.utime ?? null,
        ],
      );
      await tx.query(CURSOR_UPSERT_SQL, [input.transfer.lt]);
      return rowToInvoice(row);
    }),

  /**
   * Unattributed record + cursor advance in ONE transaction: the reconcile
   * never moves the cursor past a transfer that left no durable trace.
   */
  recordUnmatched: async (input: {
    transfer: IncomingTransfer;
    reason: UnattributedReason;
    seenAt: string;
  }): Promise<{ lt: string }> =>
    withTransaction(pool(), async (tx) => {
      await tx.query(
        `INSERT INTO unattributed_transfers (tx_hash, lt, amount_nano, comment, utime, reason, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.transfer.txHash,
          input.transfer.lt,
          input.transfer.amountNano,
          input.transfer.comment ?? null,
          input.transfer.utime ?? null,
          input.reason,
          input.seenAt,
        ],
      );
      const result = await tx.query(`${CURSOR_UPSERT_SQL} RETURNING lt`, [
        input.transfer.lt,
      ]);
      const row = result.rows[0];
      return { lt: row === undefined ? input.transfer.lt : String(row["lt"]) };
    }),

  listUnattributed: async (): Promise<UnattributedTransfer[]> => {
    const result = await pool().query(
      `SELECT tx_hash, lt, amount_nano, comment, utime, reason, seen_at
       FROM unattributed_transfers ORDER BY lt, tx_hash`,
    );
    return result.rows.map(rowToUnattributed);
  },

  getCursor: async (): Promise<{ lt: string }> => {
    const result = await pool().query("SELECT lt FROM watcher_cursor WHERE id = 1");
    const row = result.rows[0];
    return { lt: row === undefined ? "0" : String(row["lt"]) };
  },

  advanceCursor: async (input: { lt: string }): Promise<{ lt: string }> => {
    // GREATEST keeps the cursor monotonic even under a concurrent settle.
    const result = await pool().query(`${CURSOR_UPSERT_SQL} RETURNING lt`, [input.lt]);
    const row = result.rows[0];
    return { lt: row === undefined ? input.lt : String(row["lt"]) };
  },
});

/* ------------------------------------------------------------------ */
/* Adapter with lifecycle                                             */
/* ------------------------------------------------------------------ */

export interface PostgresInvoiceStoreOptions {
  /**
   * Called once, inside the adapter's `init` hook (on `app.start()`).
   * Production passes `() => createPostgresPool(url)`; unit tests pass a
   * fake. The pool is ended in `dispose` (on `app.close()`).
   */
  readonly createPool: () => SqlPool;
}

export const createPostgresInvoiceStoreAdapter = (
  options: PostgresInvoiceStoreOptions,
): BoundPortAdapter => {
  let pool: SqlPool | undefined;
  const active = (): SqlPool => {
    if (pool === undefined) {
      throw new Error(
        "invoiceStore postgres adapter used before app.start() (or after app.close()).",
      );
    }
    return pool;
  };
  return InvoiceStore.adapter(createInvoiceStoreHandlers(active), {
    init: async () => {
      pool = options.createPool();
      await pool.query(SCHEMA_SQL);
    },
    dispose: async () => {
      const current = pool;
      pool = undefined;
      if (current !== undefined) await current.end();
    },
  });
};
