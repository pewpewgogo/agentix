import { testHttp } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import { createNotesApp } from "./app.js";

describe("Agentix notes", () => {
  it("creates and gets a note", async () => {
    const http = testHttp(createNotesApp().handler);
    const created = await http.post("/notes", { id: "note-1", title: " First ", body: "Body" });
    const loaded = await http.get("/notes/note-1");

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ok: true,
      value: { id: "note-1", title: "First", body: "Body" },
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual(created.body);
  });

  it("returns stable duplicate and missing-note failures", async () => {
    const http = testHttp(createNotesApp().handler);
    await http.post("/notes", { id: "note-1", title: "First", body: "Body" });

    const dup = await http.post("/notes", { id: "note-1", title: "Again", body: "Body" });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({
      ok: false,
      error: { code: "NOTE_ALREADY_EXISTS", details: { id: "note-1" } },
    });
    const missing = await http.get("/notes/missing");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "missing" } },
    });
  });
});
