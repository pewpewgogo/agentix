/**
 * Unit tests for the PostgreSQL adapter against an in-memory fake of the pg
 * Pool/PoolClient query surface. No PostgreSQL server is involved: the fake
 * records every statement so the tests can assert the parameterized SQL text,
 * the bound values, and the BEGIN/COMMIT/ROLLBACK ordering.
 */
import { createApplication, principal } from "@agentixdev/core";
import { describe, expect, it } from "vitest";

import { NoteClock, notes } from "../features/notes.js";
import {
  createNoteStoreHandlers,
  createPostgresNotesAdapter,
  type SqlClient,
  type SqlPool,
  type SqlRowSet,
} from "./postgres.js";

/* ------------------------------------------------------------------ */
/* Fake pg pool                                                       */
/* ------------------------------------------------------------------ */

interface LoggedQuery {
  /** "pool" for pool.query, "client" for statements on a checked-out client. */
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
    /** Normalized SQL of every recorded statement, in order. */
    statements: () => log.map(sql),
    released: (index = 0) => releases[index] === true,
    connectCount: () => connects,
    ended: () => ended,
  };
};

const noteRow = {
  id: "n1",
  title: "First",
  body: "hello",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};

/* ------------------------------------------------------------------ */
/* Plain statements: parameterized text + values                      */
/* ------------------------------------------------------------------ */

describe("postgres note store handlers", () => {
  it("get issues a parameterized SELECT and maps the row to a Note", async () => {
    const fake = createFakePool(() => ({ rows: [{ ...noteRow }], rowCount: 1 }));
    const handlers = createNoteStoreHandlers(() => fake.pool);

    const note = await handlers.get("n1");

    expect(note).toEqual({
      id: "n1",
      title: "First",
      body: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const entry = fake.log[0];
    expect(entry?.via).toBe("pool");
    expect(sql(entry!)).toBe(
      "SELECT id, title, body, created_at FROM notes WHERE id = $1",
    );
    expect(entry?.values).toEqual(["n1"]);
    // The value travels only through the parameter vector, never the text.
    expect(entry?.text).not.toContain("n1");
  });

  it("get returns undefined when no row matches", async () => {
    const fake = createFakePool();
    const handlers = createNoteStoreHandlers(() => fake.pool);
    await expect(handlers.get("missing")).resolves.toBeUndefined();
  });

  it("save upserts with every value parameterized", async () => {
    const fake = createFakePool();
    const handlers = createNoteStoreHandlers(() => fake.pool);

    const note = {
      id: "n1",
      title: "First",
      body: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(handlers.save(note)).resolves.toEqual(note);

    const entry = fake.log[0];
    expect(sql(entry!)).toContain("INSERT INTO notes (id, title, body, created_at)");
    expect(sql(entry!)).toContain("ON CONFLICT (id) DO UPDATE");
    expect(entry?.values).toEqual([
      "n1",
      "First",
      "hello",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("delete maps the affected row count to a boolean", async () => {
    const hit = createFakePool(() => ({ rows: [], rowCount: 1 }));
    await expect(
      createNoteStoreHandlers(() => hit.pool).delete("n1"),
    ).resolves.toBe(true);
    expect(hit.log[0]?.values).toEqual(["n1"]);

    const miss = createFakePool(() => ({ rows: [], rowCount: 0 }));
    await expect(
      createNoteStoreHandlers(() => miss.pool).delete("n1"),
    ).resolves.toBe(false);

    // pg reports null rowCount for some commands; treat it as "no rows".
    const unknown = createFakePool(() => ({ rows: [], rowCount: null }));
    await expect(
      createNoteStoreHandlers(() => unknown.pool).delete("n1"),
    ).resolves.toBe(false);
  });

  it("list selects with a stable ORDER BY", async () => {
    const fake = createFakePool(() => ({ rows: [{ ...noteRow }], rowCount: 1 }));
    const listed = await createNoteStoreHandlers(() => fake.pool).list();
    expect(listed).toHaveLength(1);
    expect(fake.statements()[0]).toContain("ORDER BY created_at, id");
  });
});

/* ------------------------------------------------------------------ */
/* Transaction ordering                                               */
/* ------------------------------------------------------------------ */

describe("archive unit of work", () => {
  it("runs DELETE + INSERT between BEGIN and COMMIT on one client", async () => {
    const fake = createFakePool((text) =>
      text.includes("RETURNING") ? { rows: [{ ...noteRow }], rowCount: 1 } : emptyRows,
    );
    const handlers = createNoteStoreHandlers(() => fake.pool);

    const archived = await handlers.archive({
      id: "n1",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(archived).toEqual({
      id: "n1",
      title: "First",
      body: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(fake.statements()).toEqual([
      "BEGIN",
      "DELETE FROM notes WHERE id = $1 RETURNING id, title, body, created_at",
      "INSERT INTO notes_archive (id, title, body, created_at, archived_at) VALUES ($1, $2, $3, $4, $5)",
      "COMMIT",
    ]);
    // Every statement of the transaction ran on the checked-out client.
    expect(fake.log.every((entry) => entry.via === "client")).toBe(true);
    expect(fake.connectCount()).toBe(1);
    expect(fake.released()).toBe(true);
    // The archive timestamp is bound as $5, not spliced into the text.
    expect(fake.log[2]?.values?.[4]).toBe("2026-02-01T00:00:00.000Z");
  });

  it("commits without inserting and returns undefined for an unknown id", async () => {
    const fake = createFakePool();
    const handlers = createNoteStoreHandlers(() => fake.pool);

    await expect(
      handlers.archive({ id: "ghost", archivedAt: "2026-02-01T00:00:00.000Z" }),
    ).resolves.toBeUndefined();

    expect(fake.statements()).toEqual([
      "BEGIN",
      "DELETE FROM notes WHERE id = $1 RETURNING id, title, body, created_at",
      "COMMIT",
    ]);
    expect(fake.released()).toBe(true);
  });

  it("rolls back, releases the client, and rethrows when the INSERT fails", async () => {
    const failure = new Error("duplicate key value violates unique constraint");
    const fake = createFakePool((text) => {
      if (text.includes("RETURNING")) return { rows: [{ ...noteRow }], rowCount: 1 };
      if (text.includes("INSERT INTO notes_archive")) throw failure;
      return emptyRows;
    });
    const handlers = createNoteStoreHandlers(() => fake.pool);

    await expect(
      handlers.archive({ id: "n1", archivedAt: "2026-02-01T00:00:00.000Z" }),
    ).rejects.toBe(failure);

    const statements = fake.statements();
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(fake.released()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle hooks through a real application                         */
/* ------------------------------------------------------------------ */

describe("adapter lifecycle", () => {
  const writer = principal("writer", ["notes:read", "notes:write"]);

  const build = (respond?: Respond) => {
    const fake = createFakePool(respond);
    const app = createApplication({
      features: [notes],
      adapters: [
        createPostgresNotesAdapter({ createPool: () => fake.pool }),
        NoteClock.adapter({ now: () => "2026-01-01T00:00:00.000Z" }),
      ],
      mode: "test",
    });
    return { fake, app };
  };

  it("start() creates the pool and bootstraps the schema; close() ends it", async () => {
    const { fake, app } = build();

    await app.start();
    expect(fake.statements()[0]).toContain("CREATE TABLE IF NOT EXISTS notes");
    expect(fake.statements()[0]).toContain("CREATE TABLE IF NOT EXISTS notes_archive");
    expect(fake.ended()).toBe(false);

    const listed = await app.call("notes.list", {}, { principal: writer });
    expect(listed).toEqual({ ok: true, value: [] });

    await app.close();
    expect(fake.ended()).toBe(true);
  });

  it("dispatching before start() faults instead of touching a half-built pool", async () => {
    const { fake, app } = build();

    const result = await app.dispatch("notes.list", {
      input: {},
      principal: writer,
    });

    expect(result.kind).toBe("fault");
    if (result.kind === "fault") {
      expect(result.error.code).toBe("EFFECT_FAILURE");
    }
    expect(fake.log).toHaveLength(0);
  });
});
