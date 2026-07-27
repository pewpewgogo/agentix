/**
 * Behavior tests through createTestApplication. The hand-declared NoteStore
 * port is not auto-faked (only true `port.store` ports are), so a Map-backed
 * fake is bound through `overrides`. The time port IS auto-faked with the
 * deterministic clock: 2000-01-01T00:00:00.000Z, +1s per reading.
 */
import { principal } from "@agentix/core";
import { createTestApplication } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import { notes, type ArchivedNote, type Note } from "./notes.js";

const writer = principal("writer", ["notes:read", "notes:write"]);
const reader = principal("reader", ["notes:read"]);

const createMemoryNoteStore = () => {
  const active = new Map<string, Note>();
  const archived = new Map<string, ArchivedNote>();
  return {
    active,
    archived,
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
  };
};

const build = () => {
  const memory = createMemoryNoteStore();
  const harness = createTestApplication({
    features: [notes],
    overrides: memory.overrides,
  });
  return { ...harness, memory, harness };
};

describe("notes.create", () => {
  it("persists with the deterministic clock's timestamp", async () => {
    const { app, calls, memory } = build();

    const outcome = await app.call(
      "notes.create",
      { id: "n1", title: "  First  ", body: "hello" },
      { principal: writer },
    );

    expect(outcome).toEqual({
      ok: true,
      value: {
        id: "n1",
        title: "First", // trimmed by the input schema
        body: "hello",
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    });
    expect(memory.active.get("n1")?.createdAt).toBe("2000-01-01T00:00:00.000Z");
    expect(calls.of("noteStore.save")).toHaveLength(1);
  });

  it("answers NOTE_ALREADY_EXISTS for a duplicate id", async () => {
    const { app } = build();
    const input = { id: "n1", title: "First", body: "" };

    await app.call("notes.create", input, { principal: writer });
    const duplicate = await app.call("notes.create", input, { principal: writer });

    expect(duplicate).toEqual({
      ok: false,
      error: { code: "NOTE_ALREADY_EXISTS", details: { id: "n1" } },
    });
  });

  it("rejects anonymous and read-only principals before executing", async () => {
    const { app, calls } = build();
    const input = { id: "n1", title: "First", body: "" };

    const anonymous = await app.dispatch("notes.create", { input });
    expect(anonymous.kind).toBe("rejected");
    if (anonymous.kind === "rejected") {
      expect(anonymous.error.code).toBe("PERMISSION_DENIED");
    }

    const readOnly = await app.dispatch("notes.create", {
      input,
      principal: reader,
    });
    expect(readOnly.kind).toBe("rejected");
    expect(calls.all()).toHaveLength(0); // no effect ever ran
  });
});

describe("notes.get / notes.list / notes.remove", () => {
  it("round-trips a stored note and 404s an unknown id", async () => {
    const { app } = build();
    await app.call(
      "notes.create",
      { id: "n1", title: "First", body: "hello" },
      { principal: writer },
    );

    const found = await app.call("notes.get", { id: "n1" }, { principal: reader });
    expect(found.ok).toBe(true);

    const missing = await app.call("notes.get", { id: "nope" }, { principal: reader });
    expect(missing).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "nope" } },
    });
  });

  it("removes exactly the requested note", async () => {
    const { app, memory } = build();
    await app.call("notes.create", { id: "n1", title: "A", body: "" }, { principal: writer });
    await app.call("notes.create", { id: "n2", title: "B", body: "" }, { principal: writer });

    const removed = await app.call("notes.remove", { id: "n1" }, { principal: writer });
    expect(removed).toEqual({ ok: true, value: { id: "n1", deleted: true } });
    expect([...memory.active.keys()]).toEqual(["n2"]);

    const again = await app.call("notes.remove", { id: "n1" }, { principal: writer });
    expect(again).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "n1" } },
    });
  });
});

describe("notes.archive", () => {
  it("moves the note, stamps archivedAt from the clock, and emits the event", async () => {
    const { app, calls, memory } = build();
    await app.call(
      "notes.create",
      { id: "n1", title: "First", body: "hello" },
      { principal: writer },
    );
    calls.reset();

    const result = await app.dispatch("notes.archive", {
      input: { id: "n1" },
      principal: writer,
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.outcome).toEqual({
      ok: true,
      value: {
        id: "n1",
        title: "First",
        body: "hello",
        createdAt: "2000-01-01T00:00:00.000Z",
        archivedAt: "2000-01-01T00:00:01.000Z", // second clock reading
      },
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: "notes.archived",
      payload: { id: "n1", archivedAt: "2000-01-01T00:00:01.000Z" },
    });
    expect(calls.all().map((call) => call.effectId)).toEqual([
      "noteClock.now",
      "noteStore.archive",
    ]);
    expect(memory.active.size).toBe(0);
    expect(memory.archived.get("n1")?.archivedAt).toBe("2000-01-01T00:00:01.000Z");
  });

  it("404s an unknown id and emits nothing", async () => {
    const { app } = build();
    const result = await app.dispatch("notes.archive", {
      input: { id: "ghost" },
      principal: writer,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.outcome).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "ghost" } },
    });
    expect(result.events).toHaveLength(0);
  });

  it("archived notes appear in listArchived and leave list", async () => {
    const { app } = build();
    await app.call("notes.create", { id: "n1", title: "A", body: "" }, { principal: writer });
    await app.call("notes.archive", { id: "n1" }, { principal: writer });

    const active = await app.call("notes.list", {}, { principal: reader });
    expect(active).toEqual({ ok: true, value: [] });

    const archived = await app.call("notes.listArchived", {}, { principal: reader });
    expect(archived.ok).toBe(true);
    if (archived.ok) {
      expect(archived.value.map((note) => note.id)).toEqual(["n1"]);
    }
  });
});
