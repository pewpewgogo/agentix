import type { BoundPortAdapter } from "@agentixdev/core";
import pg from "pg";

import { NoteStore, type ArchivedNote, type Note } from "../features/notes.js";

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
/* Kept inline so `docker compose up` + `npm start` is the whole      */
/* setup. A production service would own this with a migration tool   */
/* (see docs/PERSISTENCE.md).                                         */
/* ------------------------------------------------------------------ */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id         text PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notes_archive (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL,
  archived_at timestamptz NOT NULL
);
`;

/* ------------------------------------------------------------------ */
/* Unit of work                                                       */
/* ------------------------------------------------------------------ */

/**
 * Runs `work` on one checked-out client inside BEGIN/COMMIT, rolling back
 * when `work` throws. This is the whole transaction recipe: the scope lives
 * HERE, in the adapter — domain code never sees a client, a BEGIN, or a
 * savepoint. An effect handler that must be atomic wraps itself in
 * withTransaction; everything else uses the pool directly.
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

/** pg parses timestamptz columns into Date; the domain speaks ISO strings. */
const isoString = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const rowToNote = (row: Record<string, unknown>): Note => ({
  id: String(row["id"]),
  title: String(row["title"]),
  body: String(row["body"]),
  createdAt: isoString(row["created_at"]),
});

const rowToArchivedNote = (row: Record<string, unknown>): ArchivedNote => ({
  ...rowToNote(row),
  archivedAt: isoString(row["archived_at"]),
});

/* ------------------------------------------------------------------ */
/* Effect handlers                                                    */
/*                                                                    */
/* Every statement is parameterized ($1, $2, ...) — values never enter */
/* the SQL text. Exported as a factory so unit tests can call the      */
/* handlers directly against a fake pool.                              */
/* ------------------------------------------------------------------ */

export const createNoteStoreHandlers = (pool: () => SqlPool) => ({
  get: async (id: string): Promise<Note | undefined> => {
    const result = await pool().query(
      "SELECT id, title, body, created_at FROM notes WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToNote(row);
  },

  save: async (note: Note): Promise<Note> => {
    // UPSERT: the primary key is the uniqueness authority; saving an
    // existing id overwrites it atomically instead of racing a read.
    await pool().query(
      `INSERT INTO notes (id, title, body, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body`,
      [note.id, note.title, note.body, note.createdAt],
    );
    return note;
  },

  delete: async (id: string): Promise<boolean> => {
    const result = await pool().query("DELETE FROM notes WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  },

  list: async (): Promise<Note[]> => {
    const result = await pool().query(
      "SELECT id, title, body, created_at FROM notes ORDER BY created_at, id",
    );
    return result.rows.map(rowToNote);
  },

  /**
   * The atomic unit of work: DELETE from `notes` and INSERT into
   * `notes_archive` either both happen or neither does. A crash between the
   * two statements rolls back; the note is never lost or duplicated.
   */
  archive: async (input: {
    id: string;
    archivedAt: string;
  }): Promise<ArchivedNote | undefined> =>
    withTransaction(pool(), async (tx) => {
      const removed = await tx.query(
        "DELETE FROM notes WHERE id = $1 RETURNING id, title, body, created_at",
        [input.id],
      );
      const row = removed.rows[0];
      if (row === undefined) return undefined; // nothing moved; COMMIT is a no-op
      await tx.query(
        `INSERT INTO notes_archive (id, title, body, created_at, archived_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [row["id"], row["title"], row["body"], row["created_at"], input.archivedAt],
      );
      return rowToArchivedNote({ ...row, archived_at: input.archivedAt });
    }),

  listArchived: async (): Promise<ArchivedNote[]> => {
    const result = await pool().query(
      `SELECT id, title, body, created_at, archived_at
       FROM notes_archive ORDER BY archived_at, id`,
    );
    return result.rows.map(rowToArchivedNote);
  },
});

/* ------------------------------------------------------------------ */
/* Adapter with lifecycle                                             */
/* ------------------------------------------------------------------ */

export interface PostgresNotesAdapterOptions {
  /**
   * Called once, inside the adapter's `init` hook (i.e. on `app.start()`).
   * Production passes `() => createPostgresPool(url)`; unit tests pass a
   * fake. The pool is ended in `dispose` (on `app.close()`).
   */
  readonly createPool: () => SqlPool;
}

/**
 * The NoteStore adapter over PostgreSQL. Pool lifecycle is bound to the
 * application lifecycle: `app.start()` creates the pool and bootstraps the
 * schema; `app.close()` ends the pool (dispose hooks run in reverse
 * registration order, after serveNode's graceful drain when
 * `closeApplication: true`).
 */
export const createPostgresNotesAdapter = (
  options: PostgresNotesAdapterOptions,
): BoundPortAdapter => {
  let pool: SqlPool | undefined;
  const active = (): SqlPool => {
    if (pool === undefined) {
      throw new Error(
        "noteStore postgres adapter used before app.start() (or after app.close()).",
      );
    }
    return pool;
  };
  return NoteStore.adapter(createNoteStoreHandlers(active), {
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
