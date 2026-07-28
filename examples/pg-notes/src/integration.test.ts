/**
 * Integration tests against REAL PostgreSQL. Gated behind
 * PG_NOTES_DATABASE_URL and skipped cleanly when it is absent:
 *
 *   docker compose up -d   # in examples/pg-notes
 *   PG_NOTES_DATABASE_URL=postgres://notes:notes@127.0.0.1:55432/notes \
 *     vitest run examples/pg-notes/src/integration.test.ts
 */
import { principal } from "@agentixdev/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresPool, type SqlPool } from "./adapters/postgres.js";
import { createPgNotesApplication, type PgNotesApplication } from "./application.js";

const databaseUrl = process.env["PG_NOTES_DATABASE_URL"];

const writer = principal("writer", ["notes:read", "notes:write"]);
const reader = principal("reader", ["notes:read"]);

describe.skipIf(databaseUrl === undefined)(
  "pg-notes against real PostgreSQL",
  () => {
    let app: PgNotesApplication;
    /** Second pool for direct table inspection/cleanup, outside the app. */
    let inspect: SqlPool;

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("unreachable: gated by skipIf");
      app = createPgNotesApplication({ databaseUrl, log: () => {} });
      await app.start(); // creates the app's pool + bootstraps the schema
      inspect = createPostgresPool(databaseUrl);
    });

    afterAll(async () => {
      await app.close(); // dispose hook ends the app's pool
      await inspect.end();
    });

    beforeEach(async () => {
      await inspect.query("TRUNCATE notes, notes_archive");
    });

    it("round-trips create -> get -> list -> archive -> listArchived", async () => {
      const created = await app.call(
        "notes.create",
        { id: "n1", title: "First", body: "hello" },
        { principal: writer },
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // The timestamptz column round-trips the ISO timestamp exactly.
      const fetched = await app.call("notes.get", { id: "n1" }, { principal: reader });
      expect(fetched).toEqual({ ok: true, value: created.value });

      const listed = await app.call("notes.list", {}, { principal: reader });
      expect(listed.ok && listed.value.map((note) => note.id)).toEqual(["n1"]);

      const archived = await app.call("notes.archive", { id: "n1" }, { principal: writer });
      expect(archived.ok).toBe(true);

      const gone = await app.call("notes.get", { id: "n1" }, { principal: reader });
      expect(gone).toEqual({
        ok: false,
        error: { code: "NOTE_NOT_FOUND", details: { id: "n1" } },
      });

      const archiveList = await app.call("notes.listArchived", {}, { principal: reader });
      expect(archiveList.ok && archiveList.value.map((note) => note.id)).toEqual(["n1"]);
    });

    it("duplicate create answers 409-shaped NOTE_ALREADY_EXISTS", async () => {
      const input = { id: "dup", title: "Once", body: "" };
      await app.call("notes.create", input, { principal: writer });
      const duplicate = await app.call("notes.create", input, { principal: writer });
      expect(duplicate).toEqual({
        ok: false,
        error: { code: "NOTE_ALREADY_EXISTS", details: { id: "dup" } },
      });
    });

    it("archive is atomic: a failing INSERT rolls the DELETE back", async () => {
      await app.call(
        "notes.create",
        { id: "n1", title: "First", body: "hello" },
        { principal: writer },
      );
      // Occupy the archive primary key so the transaction's INSERT must fail.
      await inspect.query(
        `INSERT INTO notes_archive (id, title, body, created_at, archived_at)
         VALUES ($1, $2, $3, now(), now())`,
        ["n1", "Blocker", ""],
      );

      const result = await app.dispatch("notes.archive", {
        input: { id: "n1" },
        principal: writer,
      });

      // The adapter threw (unique violation) -> EFFECT_FAILURE fault ...
      expect(result.kind).toBe("fault");
      if (result.kind === "fault") {
        expect(result.error.code).toBe("EFFECT_FAILURE");
      }
      // ... and the transaction rolled back: the note is still active,
      // and the archive still holds only the blocker row.
      const still = await inspect.query("SELECT id, title FROM notes WHERE id = $1", ["n1"]);
      expect(still.rows).toEqual([{ id: "n1", title: "First" }]);
      const blockers = await inspect.query(
        "SELECT title FROM notes_archive WHERE id = $1",
        ["n1"],
      );
      expect(blockers.rows).toEqual([{ title: "Blocker" }]);
    });

    it("archiving an unknown id changes nothing", async () => {
      const before = await inspect.query("SELECT count(*)::int AS count FROM notes");
      const result = await app.call("notes.archive", { id: "ghost" }, { principal: writer });
      expect(result).toEqual({
        ok: false,
        error: { code: "NOTE_NOT_FOUND", details: { id: "ghost" } },
      });
      const after = await inspect.query("SELECT count(*)::int AS count FROM notes");
      expect(after.rows).toEqual(before.rows);
    });
  },
);
