import { describe, expect, it } from "vitest";
import {
  command,
  event,
  feature,
  port,
  query,
  s,
  subscription,
  type DispatchObserver,
} from "@agentixdev/core";

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

  it("prefers user adapters over fakes and now records their calls too", async () => {
    const { app, calls } = createTestApplication({
      features: [notes],
      adapters: [NoteStorage.memory()],
      overrides: { "mailer.send": () => ({ sent: false }) },
    });

    await app.call("notes.create", { title: "Real adapter" });
    // The memory adapter (a user adapter here) is wrapped for recording.
    expect(calls.of("noteStorage.save")).toHaveLength(1);
    expect(calls.of("noteStorage.save")[0]).toMatchObject({
      status: "returned",
      input: { id: "id-1", title: "Real adapter" },
    });
    expect(calls.of("ids.next")).toHaveLength(1);

    // Overriding an op on a covered port is still a configuration error.
    expect(() =>
      createTestApplication({
        features: [notes],
        adapters: [NoteStorage.memory()],
        overrides: { "noteStorage.save": () => undefined },
      }),
    ).toThrow(/does not match an auto-bound port operation/);
  });

  describe("store preset detection", () => {
    // Structurally identical to a store port (get/save/delete/list with the
    // matching read/write kinds) but hand-built, so no preset === "store" tag.
    const LookalikeStore = port("lookalikeStore", {
      get: port.read({ input: s.string({ min: 1 }), output: s.optional(Note) }),
      save: port.write({ input: Note, output: Note }),
      delete: port.write({ input: s.string({ min: 1 }), output: s.boolean() }),
      list: port.read({ input: s.object({}), output: s.array(Note) }),
    });

    const lookalikes = feature("lookalikes", {
      operations: {
        save: command({
          input: Note,
          output: Note,
          effects: { save: LookalikeStore.save },
          execute: ({ input, effects }) => effects.save(input),
        }),
      },
    });

    it("does NOT memory-fake a hand-built lookalike port without the preset tag", async () => {
      const { app, calls } = createTestApplication({ features: [lookalikes] });

      const result = await app.dispatch("lookalikes.save", {
        input: { id: "n1", title: "T", createdAt: "now" },
      });
      expect(result.kind).toBe("fault");
      if (result.kind !== "fault") throw new Error("expected fault");
      expect(result.error.code).toBe("EFFECT_FAILURE");
      const cause = result.error.cause as Error;
      expect(cause.message).toContain('"lookalikeStore.save"');
      expect(cause.message).toContain("No test fake is derivable");
      expect(calls.of("lookalikeStore.save")[0]).toMatchObject({ status: "threw" });
    });

    it("memory-fakes ports carrying the exact preset === \"store\" tag", async () => {
      // The notes feature's NoteStorage is a port.store() port; every op it
      // mints carries the tag the detection keys on.
      expect(NoteStorage.save.preset).toBe("store");
      expect(LookalikeStore.save.preset).toBeUndefined();

      const { app } = createTestApplication({ features: [notes] });
      const created = await app.call("notes.create", { title: "Tagged" });
      expect(created).toMatchObject({ ok: true, value: { id: "id-1" } });
      const loaded = await app.call("notes.get", { id: "id-1" });
      expect(loaded).toMatchObject({ ok: true, value: { title: "Tagged" } });
    });
  });

  describe("reset()", () => {
    it("clears store state, recorded calls, clock, and id sequences without rebuilding", async () => {
      const harness = createTestApplication({ features: [notes] });
      const { app, calls, clock, ids } = harness;

      await app.call("notes.create", { title: "One" });
      expect(calls.all().length).toBeGreaterThan(0);
      expect(clock.calls()).toBe(1);
      expect(ids.calls()).toBe(1);

      harness.reset();

      // Recorded calls and deterministic sequences are back to zero.
      expect(calls.all()).toEqual([]);
      expect(clock.calls()).toBe(0);
      expect(ids.calls()).toBe(0);

      // Auto-bound store state is gone: the earlier record no longer exists.
      const missing = await app.call("notes.get", { id: "id-1" });
      expect(missing).toEqual({
        ok: false,
        error: { code: "NOTE_NOT_FOUND", details: { id: "id-1" } },
      });

      // Fresh-app semantics: sequences restart from their initial values.
      const again = await app.call("notes.create", { title: "Two" });
      expect(again).toEqual({
        ok: true,
        value: { id: "id-1", title: "Two", createdAt: "2000-01-01T00:00:00.000Z" },
      });
    });

    it("does NOT touch user-supplied adapter state", async () => {
      const harness = createTestApplication({
        features: [notes],
        adapters: [NoteStorage.memory()],
      });

      await harness.app.call("notes.create", { title: "Keep" });
      harness.reset();

      // The user adapter owns its state; the record survives reset().
      const loaded = await harness.app.call("notes.get", { id: "id-1" });
      expect(loaded).toMatchObject({ ok: true, value: { id: "id-1", title: "Keep" } });
      // ...while everything the harness owns was still cleared.
      expect(harness.calls.of("noteStorage.get")).toHaveLength(1);
      expect(harness.ids.calls()).toBe(0);
    });
  });

  describe("user-adapter call recording", () => {
    it("records user adapter calls and preserves returned value identity", async () => {
      const payload = { sent: true };
      const mailer = Mailer.adapter({ send: () => payload });
      const { app, calls } = createTestApplication({
        features: [notes],
        adapters: [mailer],
      });

      const outcome = await app.call("notes.notify", { to: "a@b.c" });
      expect(outcome).toEqual({ ok: true, value: { sent: true } });

      const entries = calls.of("mailer.send");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: "returned", input: { to: "a@b.c" } });
      // Transparent wrapping: the recorded output IS the adapter's value.
      expect((entries[0] as { output: unknown }).output).toBe(payload);
    });

    it("records user adapter throws", async () => {
      const boom = new Error("mailer down");
      const mailer = Mailer.adapter({
        send: () => {
          throw boom;
        },
      });
      const { app, calls } = createTestApplication({
        features: [notes],
        adapters: [mailer],
      });

      const result = await app.dispatch("notes.notify", { input: { to: "a@b.c" } });
      expect(result).toMatchObject({
        kind: "fault",
        error: { code: "EFFECT_FAILURE", effectId: "mailer.send" },
      });
      expect(calls.of("mailer.send")[0]).toMatchObject({ status: "threw", error: boom });
    });
  });

  describe("lifecycle: started() and close()", () => {
    it("started() awaits app.start(), returns the harness, and hooks reach user adapters", async () => {
      const lifecycle: string[] = [];
      const mailer = Mailer.adapter(
        { send: () => ({ sent: true }) },
        {
          init: () => {
            lifecycle.push("init");
          },
          dispose: () => {
            lifecycle.push("dispose");
          },
        },
      );
      const harness = createTestApplication({ features: [notes], adapters: [mailer] });

      // createTestApplication does not auto-start.
      expect(lifecycle).toEqual([]);

      const same = await harness.started();
      expect(same).toBe(harness);
      expect(lifecycle).toEqual(["init"]);

      // Idempotent, like app.start().
      await harness.started();
      expect(lifecycle).toEqual(["init"]);

      await harness.app.close();
      expect(lifecycle).toEqual(["init", "dispose"]);

      const afterClose = await harness.app.dispatch("notes.notify", {
        input: { to: "a@b.c" },
      });
      expect(afterClose).toMatchObject({
        kind: "fault",
        error: { code: "APPLICATION_CLOSED" },
      });
    });
  });

  describe("observer and subscribers passthrough", () => {
    const Pinged = event("testapp.pinged", 1, s.object({ id: s.string({ min: 1 }) }));
    const pings = feature("pings", {
      operations: {
        ping: command({
          input: s.object({ id: s.string({ min: 1 }) }),
          output: s.literal(true),
          emits: { pinged: Pinged },
          async execute({ input, emit }) {
            emit.pinged({ id: input.id });
            return true as const;
          },
        }),
      },
    });

    it("forwards observer and subscribers to the underlying application", async () => {
      const observed: string[] = [];
      const delivered: string[] = [];
      const observer: DispatchObserver = {
        dispatchStarted: ({ operationId }) => {
          observed.push(`started:${operationId}`);
          return "tok";
        },
        dispatchSettled: ({ operationId, kind, token }) => {
          observed.push(`settled:${operationId}:${kind}:${String(token)}`);
        },
      };

      const { app } = createTestApplication({
        features: [pings],
        observer,
        subscribers: [
          subscription(Pinged, ({ id }) => {
            delivered.push(id);
          }),
        ],
      });

      const result = await app.dispatch("pings.ping", { input: { id: "p1" } });
      expect(result.kind).toBe("completed");
      expect(delivered).toEqual(["p1"]);
      expect(observed).toEqual([
        "started:pings.ping",
        "settled:pings.ping:completed:tok",
      ]);
    });
  });

  describe("adapter call options passthrough", () => {
    const Slow = port("slow", {
      fetch: port.external({
        input: s.object({}),
        output: s.object({ ok: s.boolean() }),
        timeoutMs: 20,
      }),
    });
    const slowly = feature("slowly", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.object({ ok: s.boolean() }),
          effects: { fetch: Slow.fetch },
          execute: ({ effects }) => effects.fetch({}),
        }),
      },
    });

    it("passes {signal} through to wrapped user adapters and records timeout-aborted calls", async () => {
      const adapter = Slow.adapter({
        fetch: (_input, { signal }) =>
          new Promise<{ ok: boolean }>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted by effect signal")),
              { once: true },
            );
          }),
      });
      const { app, calls } = createTestApplication({
        features: [slowly],
        adapters: [adapter],
      });

      const result = await app.dispatch("slowly.run", { input: {} });
      expect(result).toMatchObject({
        kind: "fault",
        error: { code: "EFFECT_TIMEOUT", effectId: "slow.fetch" },
      });

      // The adapter promise settles via the abort listener; the wrapper still
      // records it (as "threw") at its original sequence position.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const entries = calls.of("slow.fetch");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: "threw" });
      expect(((entries[0] as { error: unknown }).error as Error).message).toBe(
        "aborted by effect signal",
      );
    });

    it("hands overrides the adapter call options with an AbortSignal", async () => {
      let seen: AbortSignal | undefined;
      const { app } = createTestApplication({
        features: [notes],
        overrides: {
          "mailer.send": (_input, options) => {
            seen = options.signal;
            return { sent: true };
          },
        },
      });

      const outcome = await app.call("notes.notify", { to: "a@b.c" });
      expect(outcome).toEqual({ ok: true, value: { sent: true } });
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(false);
    });
  });
});
