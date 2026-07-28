/**
 * HTTP surface tests without sockets: envelope, bearer authentication
 * (401 vs 403), the health path, and CORS preflight — all through
 * `testHttp` driving the handler's Web entry, with the persistence port
 * replaced by memory fakes.
 */
import { createTestApplication, testHttp } from "@agentixdev/testing";
import { describe, expect, it } from "vitest";

import { createPgNotesHandler } from "./application.js";
import { notes, type ArchivedNote, type Note } from "./features/notes.js";

const build = () => {
  const active = new Map<string, Note>();
  const archived = new Map<string, ArchivedNote>();
  const harness = createTestApplication({
    features: [notes],
    overrides: {
      "noteStore.get": (id: string) => active.get(id),
      "noteStore.save": (note: Note) => {
        active.set(note.id, note);
        return note;
      },
      "noteStore.delete": (id: string) => active.delete(id),
      "noteStore.list": () => [...active.values()],
      "noteStore.archive": (input: { id: string; archivedAt: string }) => {
        const note = active.get(input.id);
        if (note === undefined) return undefined;
        active.delete(input.id);
        const moved = { ...note, archivedAt: input.archivedAt };
        archived.set(input.id, moved);
        return moved;
      },
      "noteStore.listArchived": () => [...archived.values()],
    },
  });
  const handler = createPgNotesHandler(harness.app, {
    corsOrigins: ["https://app.example"],
    logError: () => {},
  });
  return { http: testHttp(handler), harness };
};

describe("pg-notes over HTTP", () => {
  it("creates through the envelope with a writer bearer token", async () => {
    const { http } = build();
    const created = await http.post(
      "/notes",
      { id: "n1", title: "First", body: "hello" },
      { token: "writer-token" },
    );

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ok: true,
      value: {
        id: "n1",
        title: "First",
        body: "hello",
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    });
    expect(created.headers.get("x-request-id")).toMatch(/[\w-]+/);
  });

  it("answers 401 UNKNOWN_TOKEN for a token outside the table", async () => {
    const { http } = build();
    const response = await http.get("/notes", { token: "stolen-token" });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      error: { code: "UNKNOWN_TOKEN" },
    });
  });

  it("answers an opaque 403 for missing permissions, before the body is read", async () => {
    const { http } = build();

    const anonymous = await http.post("/notes", { id: "n1", title: "X", body: "" });
    expect(anonymous.status).toBe(403);

    const readerWrite = await http.post(
      "/notes",
      { id: "n1", title: "X", body: "" },
      { token: "reader-token" },
    );
    expect(readerWrite.status).toBe(403);
    expect(readerWrite.body).toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("maps declared errors to their statuses (404 NOTE_NOT_FOUND)", async () => {
    const { http } = build();
    const missing = await http.get("/notes/ghost", { token: "reader-token" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "ghost" } },
    });
  });

  it("archives over HTTP and lists the archive", async () => {
    const { http } = build();
    await http.post("/notes", { id: "n1", title: "First", body: "" }, { token: "writer-token" });

    const archivedResponse = await http.post("/notes/n1/archive", undefined, {
      token: "writer-token",
    });
    expect(archivedResponse.status).toBe(200);

    const listed = await http.get("/notes/archived", { token: "reader-token" });
    expect(listed.status).toBe(200);
    const body = listed.body as { ok: boolean; value: Array<{ id: string }> };
    expect(body.value.map((note) => note.id)).toEqual(["n1"]);
  });

  it("serves the liveness path without authentication", async () => {
    const { http } = build();
    const health = await http.get("/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
  });

  it("answers CORS preflight for the configured origin only", async () => {
    const { http } = build();

    const allowed = await http.request({
      method: "OPTIONS",
      path: "/notes",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );

    const blocked = await http.request({
      method: "OPTIONS",
      path: "/notes",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(blocked.status).toBe(204);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });
});
