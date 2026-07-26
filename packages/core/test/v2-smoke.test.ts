import { describe, expect, it } from "vitest";

import {
  ApplicationDefinitionError,
  authorize,
  command,
  createApplication,
  DispatchError,
  event,
  feature,
  port,
  principal,
  query,
  s,
  type RuntimeMode,
} from "../src/index.js";

const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});
type Note = s.Infer<typeof Note>;

const NoteStorage = port.store("noteStorage", Note);

const noteCreated = event("notes.created", 1, Note);

const notes = feature("notes", {
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: { NOTE_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStorage.get, save: NoteStorage.save },
      emits: { created: noteCreated },
      async execute({ input, effects, emit, fail }) {
        if (await effects.load(input.id)) {
          return fail("NOTE_ALREADY_EXISTS", { id: input.id });
        }
        const saved = await effects.save(input);
        emit.created(saved);
        return saved;
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStorage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
    list: query({
      input: s.object({}),
      output: s.array(Note),
      effects: { list: NoteStorage.list },
      async execute({ effects }) {
        return effects.list({});
      },
    }),
    remove: command({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: s.boolean(),
      permissions: ["notes:remove"],
      effects: { remove: NoteStorage.delete },
      async execute({ input, effects }) {
        return effects.remove(input.id);
      },
    }),
    teapot: command({
      input: s.object({ leaf: s.optional(s.string()) }),
      output: s.boolean(),
      errors: {
        IM_A_TEAPOT: { http: 418 },
        BAD_LEAF: s.object({ reason: s.string() }),
      },
      http: { method: "POST", path: "/teapot" },
      async execute({ input, fail }) {
        if (input.leaf === "bad") return fail("BAD_LEAF", { reason: "moldy" });
        return fail("IM_A_TEAPOT");
      },
    }),
  },
});

const makeApp = (mode: RuntimeMode = "test") =>
  createApplication({
    features: [notes],
    adapters: [NoteStorage.memory()],
    mode,
  });

describe("v2 core smoke", () => {
  it("creates and reads notes through dispatch and call", async () => {
    const app = makeApp();
    const first: Note = { id: "n1", title: " First ", body: "Body" };

    const created = await app.dispatch("notes.create", { input: first });
    expect(created.kind).toBe("completed");
    if (created.kind !== "completed") return;
    expect(created.outcome).toEqual({
      ok: true,
      value: { id: "n1", title: "First", body: "Body" },
    });
    expect(created.events).toEqual([
      {
        operationId: "notes.create",
        alias: "created",
        eventId: "notes.created",
        version: 1,
        payload: { id: "n1", title: "First", body: "Body" },
      },
    ]);

    const loaded = await app.call("notes.get", { id: "n1" });
    expect(loaded).toEqual({
      ok: true,
      value: { id: "n1", title: "First", body: "Body" },
    });

    const duplicate = await app.call("notes.create", {
      id: "n1",
      title: "Again",
      body: "Body",
    });
    expect(duplicate).toEqual({
      ok: false,
      error: { code: "NOTE_ALREADY_EXISTS", details: { id: "n1" } },
    });

    const missing = await app.call("notes.get", { id: "missing" });
    expect(missing).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "missing" } },
    });
  });

  it("supports store list/delete presets", async () => {
    const app = makeApp();
    await app.call("notes.create", { id: "n1", title: "First", body: "" });
    await app.call("notes.create", { id: "n2", title: "Second", body: "" });

    const listed = await app.call("notes.list", {});
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.map((note) => note.id)).toEqual(["n1", "n2"]);

    const removed = await app.call(
      "notes.remove",
      { id: "n1" },
      { principal: principal("admin", ["notes:remove"]) },
    );
    expect(removed).toEqual({ ok: true, value: true });

    const gone = await app.call("notes.get", { id: "n1" });
    expect(gone).toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "n1" } },
    });
  });

  it("handles fail() declarations with empty and bare-schema details", async () => {
    const app = makeApp();
    expect(await app.call("notes.teapot", {})).toEqual({
      ok: false,
      error: { code: "IM_A_TEAPOT", details: {} },
    });
    expect(await app.call("notes.teapot", { leaf: "bad" })).toEqual({
      ok: false,
      error: { code: "BAD_LEAF", details: { reason: "moldy" } },
    });
  });

  it("rejects invalid input and unknown operations; call throws DispatchError", async () => {
    const app = makeApp();

    const rejected = await app.dispatch("notes.create", {
      input: { id: "n1", title: "", body: "Body", extra: true } as unknown as Note,
    });
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") return;
    expect(rejected.error.code).toBe("INVALID_INPUT");
    if (rejected.error.code === "INVALID_INPUT") {
      const codes = rejected.error.issues.map((issue) => issue.code).sort();
      expect(codes).toEqual(["invalid_string", "unexpected_key"]);
    }

    const unknown = await app.dispatch("notes.nope" as unknown as "notes.get", {
      input: { id: "n1" },
    });
    expect(unknown.kind).toBe("rejected");
    if (unknown.kind === "rejected") {
      expect(unknown.error.code).toBe("UNKNOWN_OPERATION");
    }

    const thrown: unknown = await app
      .call("notes.get", { id: "" })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DispatchError);
    if (thrown instanceof DispatchError) {
      expect(thrown.kind).toBe("rejected");
      expect(thrown.code).toBe("INVALID_INPUT");
      expect(thrown.operationId).toBe("notes.get");
    }
  });

  it("enforces permissions through the exported authorize gate", async () => {
    const app = makeApp();
    await app.call("notes.create", { id: "n1", title: "First", body: "" });

    const anonymous = await app.dispatch("notes.remove", { input: { id: "n1" } });
    expect(anonymous.kind).toBe("rejected");
    if (anonymous.kind === "rejected") {
      expect(anonymous.error).toEqual({
        code: "PERMISSION_DENIED",
        missingPermissions: ["notes:remove"],
      });
    }

    const underPrivileged = await app.dispatch("notes.remove", {
      input: { id: "n1" },
      principal: principal("u1", ["other"]),
    });
    expect(underPrivileged.kind).toBe("rejected");

    const allowed = await app.dispatch("notes.remove", {
      input: { id: "n1" },
      principal: principal("u1", ["notes:remove"]),
    });
    expect(allowed.kind).toBe("completed");

    const removeOp = app.operations["notes.remove"];
    expect(authorize(removeOp)).toBe(false);
    expect(authorize(removeOp, principal("u1", []))).toBe(false);
    expect(authorize(removeOp, principal("u1", ["notes:remove"]))).toBe(true);
    expect(authorize(app.operations["notes.get"])).toBe(true);
  });

  it("supports a custom authorize hook", async () => {
    const app = createApplication({
      features: [notes],
      adapters: [NoteStorage.memory()],
      mode: "test",
      authorize: (who) => who?.id === "root",
    });
    const denied = await app.dispatch("notes.get", { input: { id: "x" } });
    expect(denied.kind).toBe("rejected");
    const granted = await app.dispatch("notes.get", {
      input: { id: "x" },
      principal: principal("root", []),
    });
    expect(granted.kind).toBe("completed");
  });

  it("derives operation and port-op ids and exposes unified http metadata", () => {
    const app = makeApp();

    expect(notes.operations.create.id).toBe("notes.create");
    expect(notes.operations.get.id).toBe("notes.get");
    expect(NoteStorage.save.id).toBe("noteStorage.save");
    expect(NoteStorage.save).toBe(NoteStorage.operations.save);
    expect(NoteStorage.get.kind).toBe("read");
    expect(NoteStorage.save.kind).toBe("write");

    expect(app.operations["notes.create"].http).toEqual({
      method: "POST",
      path: "/notes",
      status: 201,
      errorStatus: { NOTE_ALREADY_EXISTS: 409 },
    });
    expect(app.operations["notes.get"].http).toEqual({
      method: "GET",
      path: "/notes/:id",
      errorStatus: { NOTE_NOT_FOUND: 404 },
    });
    expect(app.operations["notes.list"].http).toBeUndefined();
    expect(app.operations["notes.teapot"].http?.errorStatus).toEqual({
      IM_A_TEAPOT: 418,
    });
  });

  it("dispatches by descriptor and faults on foreign descriptors", async () => {
    const app = makeApp();
    await app.call("notes.create", { id: "n1", title: "First", body: "" });

    const direct = await app.dispatch(notes.operations.get, { input: { id: "n1" } });
    expect(direct.kind).toBe("completed");

    const impostor = feature("notes", {
      operations: {
        get: query({
          input: s.object({ id: s.string({ min: 1 }) }),
          output: s.optional(Note),
          effects: { load: NoteStorage.get },
          async execute({ input, effects }) {
            return effects.load(input.id);
          },
        }),
      },
    });
    const mismatched = await app.dispatch(impostor.operations.get, {
      input: { id: "n1" },
    });
    expect(mismatched.kind).toBe("fault");
    if (mismatched.kind === "fault") {
      expect(mismatched.error.code).toBe("OPERATION_DESCRIPTOR_MISMATCH");
    }
  });

  it("collects traces only when asked", async () => {
    const app = makeApp();
    await app.call("notes.create", { id: "n1", title: "First", body: "" });

    const untraced = await app.dispatch("notes.get", { input: { id: "n1" } });
    expect(untraced.trace).toBeUndefined();

    const traced = await app.dispatch("notes.get", {
      input: { id: "n1" },
      trace: true,
    });
    expect(traced.trace).toBeDefined();
    expect(traced.trace).toEqual([
      {
        type: "effect",
        operationId: "notes.get",
        alias: "load",
        effectId: "noteStorage.get",
        input: "n1",
        status: "completed",
        value: { id: "n1", title: "First", body: "" },
      },
    ]);
  });

  it("faults with EFFECT_FAILURE when an adapter throws", async () => {
    const Boom = port("boomPort", {
      hit: port.external({ input: s.object({}), output: s.string() }),
    });
    const boom = feature("boom", {
      operations: {
        hit: command({
          input: s.object({}),
          output: s.string(),
          effects: { hit: Boom.hit },
          async execute({ effects }) {
            return effects.hit({});
          },
        }),
      },
    });
    const app = createApplication({
      features: [boom],
      adapters: [
        Boom.adapter({
          hit: () => {
            throw new Error("kaboom");
          },
        }),
      ],
      mode: "test",
    });

    const result = await app.dispatch("boom.hit", { input: {} });
    expect(result.kind).toBe("fault");
    if (result.kind === "fault") {
      expect(result.error.code).toBe("EFFECT_FAILURE");
      expect(result.error.effectId).toBe("boomPort.hit");
    }

    const thrown: unknown = await app.call("boom.hit", {}).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DispatchError);
    if (thrown instanceof DispatchError) {
      expect(thrown.kind).toBe("fault");
      expect(thrown.code).toBe("EFFECT_FAILURE");
    }
  });

  it("re-parses effect outputs in every mode, production included", async () => {
    const Flaky = port("flakyPort", {
      read: port.read({ input: s.object({}), output: s.string({ min: 5 }) }),
    });
    const flaky = feature("flaky", {
      operations: {
        read: query({
          input: s.object({}),
          output: s.string(),
          effects: { read: Flaky.read },
          async execute({ effects }) {
            return effects.read({});
          },
        }),
      },
    });
    const makeFlaky = (mode: RuntimeMode) =>
      createApplication({
        features: [flaky],
        adapters: [Flaky.adapter({ read: () => "ab" })],
        mode,
      });

    // Orchestrator amendment overriding SPEC section 1: production behaves
    // exactly like dev/test for effect outputs (detached parse product, fault
    // on invalid).
    for (const mode of ["development", "test", "production"] as const) {
      const result = await makeFlaky(mode).dispatch("flaky.read", { input: {} });
      expect(result.kind).toBe("fault");
      if (result.kind === "fault") {
        expect(result.error.code).toBe("INVALID_EFFECT_OUTPUT");
      }
    }
  });

  it("keeps external boundaries validated in production", async () => {
    const app = makeApp("production");

    // Input parse (with trim normalization) still runs.
    const trimmed = await app.call("notes.create", {
      id: "n1",
      title: "  Padded  ",
      body: "",
    });
    expect(trimmed).toEqual({
      ok: true,
      value: { id: "n1", title: "Padded", body: "" },
    });
    const rejected = await app.dispatch("notes.get", { input: { id: 5 } as never });
    expect(rejected.kind).toBe("rejected");

    // Operation output parse still runs.
    const bad = feature("bad", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.number(),
          async execute() {
            return "nope" as unknown as number;
          },
        }),
      },
    });
    const badApp = createApplication({ features: [bad], mode: "production" });
    const faulted = await badApp.dispatch("bad.run", { input: {} });
    expect(faulted.kind).toBe("fault");
    if (faulted.kind === "fault") expect(faulted.error.code).toBe("INVALID_OUTPUT");

    // Event payload validation still runs.
    const sent = event("badevt.sent", 1, s.object({ id: s.string() }));
    const badEvent = feature("badevt", {
      operations: {
        send: command({
          input: s.object({}),
          output: s.boolean(),
          emits: { sent },
          async execute({ emit }) {
            emit.sent({ id: 5 as unknown as string });
            return true;
          },
        }),
      },
    });
    const eventApp = createApplication({ features: [badEvent], mode: "production" });
    const eventFault = await eventApp.dispatch("badevt.send", { input: {} });
    expect(eventFault.kind).toBe("fault");
    if (eventFault.kind === "fault") {
      expect(eventFault.error.code).toBe("INVALID_EVENT_PAYLOAD");
    }
  });

  it("runs ensures invariants post-completion in dev/test only", async () => {
    const ensured = feature("ensured", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.string(),
          ensures: {
            longEnough: { check: ({ output }) => output.length > 5 },
          },
          async execute() {
            return "abc";
          },
        }),
      },
    });
    const makeEnsured = (mode: RuntimeMode) =>
      createApplication({ features: [ensured], mode });

    const testResult = await makeEnsured("test").dispatch("ensured.run", { input: {} });
    expect(testResult.kind).toBe("fault");
    if (testResult.kind === "fault") {
      expect(testResult.error.code).toBe("INVARIANT_VIOLATION");
      expect(testResult.error.invariant).toBe("longEnough");
    }

    const productionResult = await makeEnsured("production").dispatch("ensured.run", {
      input: {},
    });
    expect(productionResult.kind).toBe("completed");
  });

  it("freezes results and event payloads in test mode but not in production", async () => {
    const input = { id: "n1", title: "First", body: "" };

    const testApp = makeApp("test");
    const frozen = await testApp.dispatch("notes.create", { input });
    expect(Object.isFrozen(frozen)).toBe(true);
    if (frozen.kind === "completed") {
      expect(Object.isFrozen(frozen.outcome)).toBe(true);
      expect(Object.isFrozen(frozen.events)).toBe(true);
      const payload = frozen.events[0]?.payload;
      expect(Object.isFrozen(payload)).toBe(true);
    }

    const productionApp = makeApp("production");
    const loose = await productionApp.dispatch("notes.create", { input });
    expect(Object.isFrozen(loose)).toBe(false);
    if (loose.kind === "completed") {
      expect(Object.isFrozen(loose.outcome)).toBe(false);
      const payload = loose.events[0]?.payload;
      expect(Object.isFrozen(payload)).toBe(false);
    }
  });

  it("defaults mode from NODE_ENV", () => {
    const empty = feature("emptyish", {
      operations: {
        noop: query({
          input: s.object({}),
          output: s.boolean(),
          async execute() {
            return true;
          },
        }),
      },
    });
    const app = createApplication({ features: [empty] });
    expect(["production", "development", "test"]).toContain(app.mode);
    expect(makeApp("production").mode).toBe("production");
  });

  it("validates the application definition at startup", () => {
    let caught: unknown;
    try {
      createApplication({ features: [notes], adapters: [], mode: "test" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationDefinitionError);
    if (caught instanceof ApplicationDefinitionError) {
      expect(caught.issues.map((issue) => issue.code)).toContain("MISSING_ADAPTER");
    }

    const r1 = feature("r1", {
      operations: {
        a: query({
          input: s.object({}),
          output: s.boolean(),
          http: { method: "GET", path: "/dup" },
          async execute() {
            return true;
          },
        }),
      },
    });
    const r2 = feature("r2", {
      operations: {
        a: query({
          input: s.object({}),
          output: s.boolean(),
          http: { method: "GET", path: "/dup" },
          async execute() {
            return true;
          },
        }),
      },
    });
    let routeConflict: unknown;
    try {
      createApplication({ features: [r1, r2], mode: "test" });
    } catch (error) {
      routeConflict = error;
    }
    expect(routeConflict).toBeInstanceOf(ApplicationDefinitionError);
    if (routeConflict instanceof ApplicationDefinitionError) {
      expect(routeConflict.issues.map((issue) => issue.code)).toContain(
        "HTTP_ROUTE_CONFLICT",
      );
    }

    let duplicate: unknown;
    try {
      createApplication({ features: [r1, r1], mode: "test" });
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(ApplicationDefinitionError);
    if (duplicate instanceof ApplicationDefinitionError) {
      expect(duplicate.issues.map((issue) => issue.code)).toContain("DUPLICATE_ID");
    }
  });

  it("rejects impure or malformed authoring at creation time", () => {
    // Query purity is enforced at runtime as well as in the type system.
    expect(() =>
      query({
        input: s.object({}),
        output: s.boolean(),
        effects: { save: NoteStorage.save } as unknown as Record<never, never>,
        async execute() {
          return true;
        },
      }),
    ).toThrow(TypeError);

    // port.store requires a shape with an id field.
    expect(() => port.store("broken", s.object({ name: s.string() }) as never)).toThrow(
      TypeError,
    );

    // Port operation keys must not collide with reserved port properties.
    expect(() =>
      port("clash", { adapter: port.read({ input: s.object({}), output: s.boolean() }) }),
    ).toThrow(TypeError);

    // Operation keys must not contain dots (ids are derived).
    const noop = query({
      input: s.object({}),
      output: s.boolean(),
      async execute() {
        return true;
      },
    });
    expect(() => feature("weird", { operations: { "a.b": noop } })).toThrow(TypeError);

    // Unified error declarations validate their http statuses.
    expect(() =>
      command({
        input: s.object({}),
        output: s.boolean(),
        errors: { NOPE: { http: 42 } },
        async execute({ fail }) {
          return fail("NOPE");
        },
      }),
    ).toThrow(TypeError);
  });
});
