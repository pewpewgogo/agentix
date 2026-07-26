import { describe, expect, it } from "vitest";
import { command, feature, port, query, s } from "@agentix/core";

import { createTestApplication } from "./test-application.js";

const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1 }),
  createdAt: s.string({ min: 1 }),
});

const NoteStorage = port.store("noteStorage", Note);
const Clock = port("clock", {
  now: port.time({ input: s.object({}), output: s.string() }),
});
const Ids = port("ids", {
  next: port.random({ input: s.object({}), output: s.string() }),
});
const Mailer = port("mailer", {
  send: port.external({
    input: s.object({ to: s.string({ min: 1 }) }),
    output: s.object({ sent: s.boolean() }),
  }),
});

const notes = feature("notes", {
  operations: {
    create: command({
      input: s.object({ title: s.string({ min: 1 }) }),
      output: Note,
      effects: { nextId: Ids.next, now: Clock.now, save: NoteStorage.save },
      async execute({ input, effects }) {
        const id = await effects.nextId({});
        const createdAt = await effects.now({});
        return effects.save({ id, title: input.title, createdAt });
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { details: { id: s.string() } } },
      effects: { load: NoteStorage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
    notify: command({
      input: s.object({ to: s.string({ min: 1 }) }),
      output: s.object({ sent: s.boolean() }),
      effects: { send: Mailer.send },
      execute: ({ input, effects }) => effects.send({ to: input.to }),
    }),
  },
});

describe("createTestApplication", () => {
  it("auto-binds store, clock, and id fakes and records their calls", async () => {
    const { app, calls, clock, ids } = createTestApplication({ features: [notes] });

    const created = await app.call("notes.create", { title: "Hello" });
    expect(created).toEqual({
      ok: true,
      value: {
        id: "id-1",
        title: "Hello",
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    });

    // Store fake persisted the record; the query reads it back.
    const loaded = await app.call("notes.get", { id: "id-1" });
    expect(loaded).toEqual({
      ok: true,
      value: { id: "id-1", title: "Hello", createdAt: "2000-01-01T00:00:00.000Z" },
    });

    // Declared errors surface as completed outcomes, not throws.
    const missing = await app.call("notes.get", { id: "nope" });
    expect(missing).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "nope" } },
    });

    // Deterministic sources advance per call and are exposed to the test.
    expect(clock.calls()).toBe(1);
    expect(ids.calls()).toBe(1);
    const second = await app.call("notes.create", { title: "Again" });
    expect(second).toMatchObject({
      ok: true,
      value: { id: "id-2", createdAt: "2000-01-01T00:00:01.000Z" },
    });

    // Calls are recorded per port operation id.
    expect(calls.of("noteStorage.save")).toHaveLength(2);
    expect(calls.of("noteStorage.save")[0]).toMatchObject({
      status: "returned",
      input: { id: "id-1", title: "Hello", createdAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(calls.of("ids.next")).toHaveLength(2);
    expect(calls.of("clock.now")[0]).toMatchObject({
      status: "returned",
      output: "2000-01-01T00:00:00.000Z",
    });
    expect(calls.all().map((call) => call.effectId)).toEqual([
      "ids.next",
      "clock.now",
      "noteStorage.save",
      "noteStorage.get",
      "noteStorage.get",
      "ids.next",
      "clock.now",
      "noteStorage.save",
    ]);

    calls.reset();
    expect(calls.all()).toEqual([]);
  });

  it("binds a throwing stub for underivable ops that names the override key", async () => {
    const { app, calls } = createTestApplication({ features: [notes] });

    const result = await app.dispatch("notes.notify", { input: { to: "a@b.c" } });
    expect(result.kind).toBe("fault");
    if (result.kind !== "fault") throw new Error("expected fault");
    expect(result.error.code).toBe("EFFECT_FAILURE");
    const cause = result.error.cause as Error;
    expect(cause.message).toContain('"mailer.send"');
    expect(cause.message).toContain("overrides");
    expect(calls.of("mailer.send")[0]).toMatchObject({ status: "threw" });
  });

  it("applies overrides in place of derived fakes and stubs", async () => {
    const { app, calls } = createTestApplication({
      features: [notes],
      overrides: {
        "ids.next": () => "note-42",
        "mailer.send": () => ({ sent: true }),
      },
    });

    const created = await app.call("notes.create", { title: "Custom" });
    expect(created).toMatchObject({ ok: true, value: { id: "note-42" } });

    const notified = await app.call("notes.notify", { to: "a@b.c" });
    expect(notified).toEqual({ ok: true, value: { sent: true } });
    expect(calls.of("mailer.send")).toHaveLength(1);
  });

  it("rejects overrides that do not match an auto-bound port operation", () => {
    expect(() =>
      createTestApplication({
        features: [notes],
        overrides: { "nope.effect": () => 0 },
      }),
    ).toThrow(/"nope\.effect" does not match an auto-bound port operation/);
    expect(() =>
      createTestApplication({
        features: [notes],
        overrides: { "nope.effect": () => 0 },
      }),
    ).toThrow(/"noteStorage\.save"/);
  });

  it("prefers user adapters and never fakes or records their ports", async () => {
    const { app, calls } = createTestApplication({
      features: [notes],
      adapters: [NoteStorage.memory()],
      overrides: { "mailer.send": () => ({ sent: false }) },
    });

    await app.call("notes.create", { title: "Real adapter" });
    expect(calls.of("noteStorage.save")).toEqual([]);
    expect(calls.of("ids.next")).toHaveLength(1);

    // Overriding an op on a covered port is a configuration error.
    expect(() =>
      createTestApplication({
        features: [notes],
        adapters: [NoteStorage.memory()],
        overrides: { "noteStorage.save": () => undefined },
      }),
    ).toThrow(/does not match an auto-bound port operation/);
  });
});
