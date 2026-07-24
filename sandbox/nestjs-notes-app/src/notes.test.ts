import "reflect-metadata";

import { describe, expect, it } from "vitest";

import { NotesController } from "./notes.controller.js";
import { NotesService } from "./notes.service.js";

describe("NestJS notes", () => {
  it("creates and gets a note through the controller", () => {
    const controller = new NotesController(new NotesService());
    const created = controller.create({ id: "note-1", title: " First ", body: "Body" });
    const loaded = controller.get("note-1");

    expect(created).toEqual({
      ok: true,
      value: { id: "note-1", title: "First", body: "Body" },
    });
    expect(loaded).toEqual(created);
  });

  it("returns stable duplicate and missing-note failures", () => {
    const controller = new NotesController(new NotesService());
    controller.create({ id: "note-1", title: "First", body: "Body" });

    expect(controller.create({ id: "note-1", title: "Again", body: "Body" }))
      .toEqual({
        ok: false,
        error: { code: "NOTE_ALREADY_EXISTS", details: { id: "note-1" } },
      });
    expect(controller.get("missing")).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "missing" } },
    });
  });
});
