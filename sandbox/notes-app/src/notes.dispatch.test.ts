import { associateOperationTest } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import { createNotesApp } from "./app.js";
import { notes } from "./features/notes.js";

associateOperationTest(notes.operations.create);
associateOperationTest(notes.operations.get);

describe("Agentix notes via call", () => {
  it("creates and gets a note", async () => {
    const { app } = createNotesApp();
    const created = await app.call("notes.create", { id: "note-1", title: " First ", body: "Body" });
    const loaded = await app.call("notes.get", { id: "note-1" });

    expect(created).toEqual({
      ok: true,
      value: { id: "note-1", title: "First", body: "Body" },
    });
    expect(loaded).toEqual(created);
  });

  it("returns stable duplicate and missing-note failures", async () => {
    const { app } = createNotesApp();
    await app.call("notes.create", { id: "note-1", title: "First", body: "Body" });

    expect(await app.call("notes.create", { id: "note-1", title: "Again", body: "Body" }))
      .toEqual({
        ok: false,
        error: { code: "NOTE_ALREADY_EXISTS", details: { id: "note-1" } },
      });
    expect(await app.call("notes.get", { id: "missing" })).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "missing" } },
    });
  });
});
