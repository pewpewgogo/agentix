import { associateOperationTest } from "@agentixdev/testing";
import { describe, expect, it } from "vitest";

import { createNote, getNote } from "./features/notes/operations.js";
import { createNotesSystem } from "./system.js";

export const createNoteBehavior = associateOperationTest(
  createNote,
  "notes.create.behavior",
);
export const getNoteBehavior = associateOperationTest(
  getNote,
  "notes.get.behavior",
);

describe("Agentix notes", () => {
  it("creates and gets a note", async () => {
    const system = createNotesSystem();
    const created = await system.create({ id: "note-1", title: " First ", body: "Body" });
    const loaded = await system.get("note-1");

    expect(created).toEqual({
      ok: true,
      value: { id: "note-1", title: "First", body: "Body" },
    });
    expect(loaded).toEqual(created);
  });

  it("returns stable duplicate and missing-note failures", async () => {
    const system = createNotesSystem();
    await system.create({ id: "note-1", title: "First", body: "Body" });

    expect(await system.create({ id: "note-1", title: "Again", body: "Body" }))
      .toEqual({
        ok: false,
        error: { code: "NOTE_ALREADY_EXISTS", details: { id: "note-1" } },
      });
    expect(await system.get("missing")).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "missing" } },
    });
  });
});
