import { describe, expect, it } from "vitest";

import { NotesService } from "./notes-service.js";

describe("Express notes", () => {
  it("creates and gets a note", () => {
    const service = new NotesService();
    const created = service.create({ id: "note-1", title: " First ", body: "Body" });
    const loaded = service.get("note-1");

    expect(created).toEqual({
      ok: true,
      value: { id: "note-1", title: "First", body: "Body" },
    });
    expect(loaded).toEqual(created);
  });

  it("returns stable duplicate and missing-note failures", () => {
    const service = new NotesService();
    service.create({ id: "note-1", title: "First", body: "Body" });

    expect(service.create({ id: "note-1", title: "Again", body: "Body" }))
      .toEqual({
        ok: false,
        error: { code: "NOTE_ALREADY_EXISTS", details: { id: "note-1" } },
      });
    expect(service.get("missing")).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "missing" } },
    });
  });
});
