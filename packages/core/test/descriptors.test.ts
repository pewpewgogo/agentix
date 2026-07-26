import { describe, expect, expectTypeOf, it } from "vitest";

import {
  command,
  event,
  FAIL_RESULT,
  feature,
  port,
  query,
  s,
  type BoundPortAdapter,
  type DeclaredError,
  type Schema,
} from "../src/index.js";

const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});
type Note = s.Infer<typeof Note>;

const KeyValue = port("keyValue", {
  get: port.read({
    input: s.object({ key: s.string() }),
    output: s.optional(s.string()),
  }),
  put: port.write({
    input: s.object({ key: s.string(), value: s.string() }),
    output: s.literal(true),
  }),
});

const callAdapter = (
  adapter: BoundPortAdapter,
  key: string,
  input: unknown,
): unknown => {
  const handler = adapter.operations[key] as (input: unknown) => unknown;
  return handler(input);
};

describe("port descriptors", () => {
  it("derives port operation ids and exposes ops as top-level properties", () => {
    expect(KeyValue).toMatchObject({ descriptorType: "port", id: "keyValue" });
    expect(KeyValue.operations.get).toMatchObject({
      descriptorType: "port-operation",
      id: "keyValue.get",
      kind: "read",
      portId: "keyValue",
      opKey: "get",
    });
    expect(KeyValue.operations.put).toMatchObject({
      id: "keyValue.put",
      kind: "write",
    });
    // Amendment A4: ops addressable as Port.opName.
    expect(KeyValue.get).toBe(KeyValue.operations.get);
    expect(KeyValue.put).toBe(KeyValue.operations.put);
    expect(Object.isFrozen(KeyValue)).toBe(true);
    expect(Object.isFrozen(KeyValue.operations)).toBe(true);
    expect(Object.isFrozen(KeyValue.get)).toBe(true);
  });

  it("provides time/random/external effect kinds", () => {
    const Clock = port("clock", {
      now: port.time({ input: s.object({}), output: s.number() }),
      seed: port.random({ input: s.object({}), output: s.number() }),
      fetch: port.external({ input: s.string(), output: s.string() }),
    });
    expect(Clock.now.kind).toBe("time");
    expect(Clock.seed.kind).toBe("random");
    expect(Clock.fetch.kind).toBe("external");
  });

  it("rejects malformed port authoring", () => {
    // ids must be stable
    expect(() => port("has space", { get: port.read({ input: Note, output: Note }) }))
      .toThrow(TypeError);
    expect(() => port("", { get: port.read({ input: Note, output: Note }) }))
      .toThrow(TypeError);
    // operation values must come from port.read/write/time/random/external
    expect(() => port("p", { get: "nope" as never })).toThrow(
      /must be created with port\.read/,
    );
    // an already-bound operation cannot be re-bound
    expect(() => port("p", { get: KeyValue.get as never })).toThrow(TypeError);
    // keys must not contain dots (ids are derived)
    expect(() =>
      port("p", { "a.b": port.read({ input: Note, output: Note }) }),
    ).toThrow(/without whitespace or dots/);
    // keys must not collide with reserved port properties
    for (const reserved of ["adapter", "id", "operations", "descriptorType"]) {
      expect(() =>
        port("p", { [reserved]: port.read({ input: Note, output: Note }) }),
      ).toThrow(/reserved port property/);
    }
    // port op factories require schemas
    expect(() => port.read({ input: "x" as never, output: Note })).toThrow(TypeError);
    expect(() => port.write({ input: Note, output: undefined as never })).toThrow(
      TypeError,
    );
  });

  it("binds adapters that implement every operation with plain values", async () => {
    const values = new Map<string, string>();
    const adapter = KeyValue.adapter({
      get: ({ key }) => values.get(key),
      put: ({ key, value }) => {
        values.set(key, value);
        return true;
      },
    });
    expect(adapter).toMatchObject({
      descriptorType: "port-adapter",
      portId: "keyValue",
    });
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(adapter.operations)).toBe(true);

    expect(await callAdapter(adapter, "put", { key: "k", value: "v" })).toBe(true);
    expect(await callAdapter(adapter, "get", { key: "k" })).toBe("v");
    expect(await callAdapter(adapter, "get", { key: "missing" })).toBeUndefined();
  });

  it("rejects adapters that miss an operation", () => {
    expect(() =>
      KeyValue.adapter({ get: ({ key }: { key: string }) => key } as never),
    ).toThrow(/must implement operation "put"/);
  });
});

describe("port.store", () => {
  const NoteStorage = port.store("noteStorage", Note);

  it("presets get/save/delete/list operations keyed by the id field", () => {
    expect(NoteStorage.id).toBe("noteStorage");
    expect(NoteStorage.get).toMatchObject({
      id: "noteStorage.get",
      kind: "read",
      portId: "noteStorage",
      opKey: "get",
    });
    expect(NoteStorage.save).toMatchObject({ id: "noteStorage.save", kind: "write" });
    expect(NoteStorage.delete).toMatchObject({
      id: "noteStorage.delete",
      kind: "write",
    });
    expect(NoteStorage.list).toMatchObject({ id: "noteStorage.list", kind: "read" });
    expect(NoteStorage.operations.save).toBe(NoteStorage.save);

    // get takes the id value, not the record
    expect(NoteStorage.get.input.parse("n1")).toBe("n1");
    expect(NoteStorage.save.input.safeParse({ id: "n1" })).toMatchObject({
      success: false,
    });
    expect(NoteStorage.delete.input.parse("n1")).toBe("n1");
    expect(NoteStorage.list.input.parse({})).toEqual({});
    expect(NoteStorage.list.output.parse([])).toEqual([]);
  });

  it("requires an object schema with an id field", () => {
    expect(() => port.store("broken", s.string() as never)).toThrow(
      /requires an object schema/,
    );
    expect(() => port.store("broken", s.object({ name: s.string() }) as never)).toThrow(
      /"id" field/,
    );
    expect(() => port.store("bad id", Note)).toThrow(TypeError);
  });

  it("ships an isolated Map-backed memory adapter", async () => {
    const first = NoteStorage.memory();
    const second = NoteStorage.memory();
    const note: Note = { id: "n1", title: "First", body: "" };

    expect(await callAdapter(first, "get", "n1")).toBeUndefined();
    expect(await callAdapter(first, "save", note)).toBe(note);
    expect(await callAdapter(first, "get", "n1")).toBe(note);
    // adapters from separate memory() calls do not share state
    expect(await callAdapter(second, "get", "n1")).toBeUndefined();

    await callAdapter(first, "save", { id: "n2", title: "Second", body: "" });
    expect(
      (await callAdapter(first, "list", {}) as readonly Note[]).map((entry) => entry.id),
    ).toEqual(["n1", "n2"]);

    // re-saving the same id replaces the record
    await callAdapter(first, "save", { id: "n1", title: "Replaced", body: "" });
    expect((await callAdapter(first, "get", "n1") as Note).title).toBe("Replaced");
    expect((await callAdapter(first, "list", {}) as readonly Note[]).length).toBe(2);

    expect(await callAdapter(first, "delete", "n1")).toBe(true);
    expect(await callAdapter(first, "delete", "n1")).toBe(false);
    expect(await callAdapter(first, "get", "n1")).toBeUndefined();
  });
});

describe("events", () => {
  it("creates frozen event descriptors from positional arguments", () => {
    const created = event("notes.created", 2, Note);
    expect(created).toMatchObject({
      descriptorType: "event",
      id: "notes.created",
      version: 2,
    });
    expect(created.payload).toBe(Note);
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(() => event("bad id", 1, Note)).toThrow(TypeError);
    expect(() => event("evt", 0 as never, Note)).toThrow(/positive safe integer/);
    expect(() => event("evt", 1.5 as never, Note)).toThrow(/positive safe integer/);
    expect(() => event("evt", 1, "nope" as never)).toThrow(/payload schema/);
  });
});

describe("command and query descriptors", () => {
  it("normalizes unified error declarations including the bare-schema shorthand", () => {
    const op = command({
      input: s.object({}),
      output: s.boolean(),
      errors: {
        FULL_FORM: { http: 409, details: { id: s.string() } },
        SCHEMA_DETAILS: { http: 410, details: s.object({ at: s.number() }) },
        BARE_SCHEMA: s.object({ reason: s.string() }),
        NO_DETAILS: { http: 423 },
        EMPTY_CONFIG: {},
      },
      async execute({ fail }) {
        return fail("NO_DETAILS");
      },
    });

    expect(op.descriptorType).toBe("operation");
    expect(op.kind).toBe("command");
    expect(Object.keys(op.errorDetails).sort()).toEqual([
      "BARE_SCHEMA",
      "EMPTY_CONFIG",
      "FULL_FORM",
      "NO_DETAILS",
      "SCHEMA_DETAILS",
    ]);

    // record-of-schemas becomes a strict object schema
    expect(op.errorDetails["FULL_FORM"]?.parse({ id: "x" })).toEqual({ id: "x" });
    expect(op.errorDetails["FULL_FORM"]?.safeParse({ id: "x", extra: 1 })).toMatchObject(
      { success: false },
    );
    // explicit details schema is stored as-is
    expect(op.errorDetails["SCHEMA_DETAILS"]?.parse({ at: 3 })).toEqual({ at: 3 });
    // bare schema is shorthand for { details }
    expect(op.errorDetails["BARE_SCHEMA"]?.parse({ reason: "r" })).toEqual({
      reason: "r",
    });
    // detail-less declarations validate against a strict empty object
    expect(op.errorDetails["NO_DETAILS"]?.parse({})).toEqual({});
    expect(op.errorDetails["NO_DETAILS"]?.safeParse({ x: 1 })).toMatchObject({
      success: false,
    });
    expect(op.errorDetails["EMPTY_CONFIG"]?.parse({})).toEqual({});
  });

  it("derives http errorStatus from per-error http numbers", () => {
    const op = command({
      input: s.object({}),
      output: s.boolean(),
      errors: {
        WITH_STATUS: { http: 404, details: { id: s.string() } },
        WITHOUT_STATUS: s.object({ id: s.string() }),
      },
      http: { method: "POST", path: "/things", status: 201 },
      async execute({ fail }) {
        return fail("WITH_STATUS", { id: "x" });
      },
    });
    expect(op.http).toEqual({
      method: "POST",
      path: "/things",
      status: 201,
      errorStatus: { WITH_STATUS: 404 },
    });
    expect(Object.isFrozen(op.http)).toBe(true);
    expect(Object.isFrozen(op.http?.errorStatus)).toBe(true);

    const plain = query({
      input: s.object({}),
      output: s.boolean(),
      async execute() {
        return true;
      },
    });
    expect(plain.http).toBeUndefined();
    expect(plain.kind).toBe("query");
  });

  it("validates http metadata and per-error statuses", () => {
    const base = {
      input: s.object({}),
      output: s.boolean(),
      execute: async () => true,
    };
    expect(() =>
      command({ ...base, http: { method: "FETCH" as never, path: "/x" } }),
    ).toThrow(/http\.method/);
    expect(() =>
      command({ ...base, http: { method: "GET", path: "x" } }),
    ).toThrow(/http\.path/);
    expect(() =>
      command({ ...base, http: { method: "GET", path: "/x", status: 99 } }),
    ).toThrow(/http\.status/);
    expect(() =>
      command({ ...base, http: { method: "GET", path: "/x", status: 600 } }),
    ).toThrow(/http\.status/);
    expect(() =>
      command({
        ...base,
        errors: { NOPE: { http: 42 } },
      }),
    ).toThrow(/http status must be an integer in 200\.\.599/);
    expect(() =>
      command({
        ...base,
        errors: { NOPE: { http: 200.5 } },
      }),
    ).toThrow(TypeError);
  });

  it("rejects statuses the fixed JSON envelope cannot carry (204/205/304, 1xx)", () => {
    const base = {
      input: s.object({}),
      output: s.boolean(),
      execute: async () => true,
    };
    // The canonical REST mistake: DELETE + 204. The envelope always has a
    // body, so bodiless statuses must fail loudly at authoring time.
    expect(() =>
      command({ ...base, http: { method: "DELETE", path: "/x/:id", status: 204 } }),
    ).toThrow(
      /http\.status cannot be 204: 204, 205, and 304 forbid a response body/,
    );
    for (const status of [205, 304]) {
      expect(() =>
        command({ ...base, http: { method: "GET", path: "/x", status } }),
      ).toThrow(new RegExp(`http\\.status cannot be ${status}`));
    }
    // 1xx is informational and cannot carry a final JSON body either.
    for (const status of [100, 101, 199]) {
      expect(() =>
        command({ ...base, http: { method: "GET", path: "/x", status } }),
      ).toThrow(/http\.status must be an integer in 200\.\.599/);
    }
    // Per-error statuses share the same contract.
    expect(() =>
      command({ ...base, errors: { GONE: { http: 304 } } }),
    ).toThrow(/Error GONE http status cannot be 304/);
    expect(() =>
      command({ ...base, errors: { EARLY: { http: 102 } } }),
    ).toThrow(/Error EARLY http status must be an integer in 200\.\.599/);
  });

  it("rejects malformed inputs, outputs, errors, and permissions", () => {
    const base = {
      input: s.object({}),
      output: s.boolean(),
      execute: async () => true,
    };
    expect(() => command({ ...base, input: "x" as never })).toThrow(
      /requires input and output schemas/,
    );
    expect(() =>
      command({ ...base, output: 5 as unknown as Schema<boolean> }),
    ).toThrow(TypeError);
    expect(() =>
      command({ ...base, execute: "nope" as never }),
    ).toThrow(/requires an execute function/);
    expect(() => command({ ...base, errors: { BAD: 42 as never } })).toThrow(
      /must be a schema or an \{ http\?, details\? \} declaration/,
    );
    expect(() =>
      command({ ...base, errors: { BAD: { details: 42 as never } } }),
    ).toThrow(/details must be a schema or a record of schemas/,
    );
    expect(() =>
      command({ ...base, errors: { "BAD CODE": s.object({}) } }),
    ).toThrow(/Error code/);
    expect(() => command({ ...base, permissions: ["same", "same"] })).toThrow(
      /Duplicate permission/,
    );
    expect(() => command({ ...base, permissions: ["has space"] })).toThrow(TypeError);
  });

  it("requires effects to reference bound port operations without duplicates", () => {
    const base = {
      input: s.object({}),
      output: s.boolean(),
      execute: async () => true,
    };
    // an unbound port op (not attached to a port) is rejected
    const unbound = port.read({ input: s.object({}), output: s.string() });
    expect(() =>
      command({ ...base, effects: { read: unbound as never } }),
    ).toThrow(/must reference a port operation/);
    expect(() =>
      command({ ...base, effects: { read: "nope" as never } }),
    ).toThrow(/must reference a port operation/);
    // the same port op cannot be aliased twice in one operation
    expect(() =>
      command({
        ...base,
        effects: { first: KeyValue.get, second: KeyValue.get },
      }),
    ).toThrow(/Duplicate effect id/);
  });

  it("rejects write effects on queries at runtime even via hostile casts", () => {
    expect(() =>
      query({
        input: s.object({}),
        output: s.boolean(),
        effects: { save: KeyValue.put } as never,
        async execute() {
          return true;
        },
      }),
    ).toThrow(/cannot declare write effect/);
  });

  it("requires emits to reference events without duplicate ids", () => {
    const created = event("things.created", 1, Note);
    const base = {
      input: s.object({}),
      output: s.boolean(),
      execute: async () => true,
    };
    expect(() =>
      command({ ...base, emits: { created: "nope" as never } }),
    ).toThrow(/must reference an event/);
    expect(() =>
      command({ ...base, emits: { a: created, b: created } }),
    ).toThrow(/Duplicate emitted event id/);
    const op = command({ ...base, emits: { created } });
    expect(op.emits["created"]).toBe(created);
  });

  it("validates ensures declarations and stores evidence as metadata", () => {
    const base = {
      input: s.object({}),
      output: s.string(),
      execute: async () => "value",
    };
    expect(() =>
      command({ ...base, ensures: { broken: {} as never } }),
    ).toThrow(/requires a check function/);
    expect(() =>
      command({
        ...base,
        ensures: { broken: { evidence: 42, check: () => true } as never },
      }),
    ).toThrow(/evidence must be a schema/);

    const evidence = s.object({ length: s.number() });
    const op = command({
      ...base,
      ensures: { nonEmpty: { evidence, check: ({ output }) => output.length > 0 } },
    });
    expect(op.ensures["nonEmpty"]?.evidence).toBe(evidence);
    expect(op.ensures["nonEmpty"]?.check({ input: {}, output: "x" })).toBe(true);
  });

  it("brands fail() results so plain outputs stay unambiguous", () => {
    const op = command({
      input: s.object({}),
      output: s.boolean(),
      errors: {
        GONE: { http: 410 },
        NAMED: { details: { name: s.string() } },
      },
      async execute({ fail }) {
        return fail("GONE");
      },
    });

    const failure = op.fail("GONE");
    expect(failure[FAIL_RESULT]).toBe(true);
    expect(failure.ok).toBe(false);
    // details default to {} only for detail-less declarations
    expect(failure.error).toEqual({ code: "GONE", details: {} });
    expect(op.fail("NAMED", { name: "x" }).error).toEqual({
      code: "NAMED",
      details: { name: "x" },
    });
    expect(op.fail("NAMED").error).toEqual({ code: "NAMED", details: undefined });
  });

  it("infers execute context types from the declaration", () => {
    command({
      input: s.object({ key: s.string(), value: s.string() }),
      output: s.literal(true),
      errors: { SAVE_FAILED: s.object({ key: s.string() }) },
      permissions: ["values:write"],
      effects: { save: KeyValue.put },
      async execute({ input, effects, fail }) {
        expectTypeOf(input).toEqualTypeOf<{ key: string; value: string }>();
        expectTypeOf(effects.save).toEqualTypeOf<
          (input: { key: string; value: string }) => Promise<true>
        >();
        expectTypeOf(fail("SAVE_FAILED", { key: input.key }).error).toEqualTypeOf<
          Readonly<{ code: "SAVE_FAILED"; details: { key: string } }>
        >();
        await effects.save(input);
        return true as const;
      },
    });

    type Errors = (typeof opWithErrors)["errors"];
    const opWithErrors = command({
      input: s.object({}),
      output: s.boolean(),
      errors: { ONLY: s.object({ key: s.string() }) },
      async execute({ fail }) {
        return fail("ONLY", { key: "k" });
      },
    });
    expectTypeOf<DeclaredError<Errors>>().toEqualTypeOf<
      Readonly<{ code: "ONLY"; details: { key: string } }>
    >();
  });
});

describe("feature descriptors", () => {
  const noop = query({
    input: s.object({}),
    output: s.boolean(),
    async execute() {
      return true;
    },
  });

  it("derives operation ids as `${featureId}.${key}`", () => {
    const created = event("values.changed", 1, Note);
    const values = feature("values", {
      operations: { check: noop },
      events: [created],
    });

    expect(values).toMatchObject({ descriptorType: "feature", id: "values" });
    expect(values.operations.check.id).toBe("values.check");
    expect(values.operations.check.kind).toBe("query");
    expect(values.events).toEqual([created]);
    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(values.operations)).toBe(true);
    expect(Object.isFrozen(values.operations.check)).toBe(true);
    // the unbound source operation stays id-less
    expect("id" in noop).toBe(false);
  });

  it("binds the same unbound operation into distinct features independently", () => {
    const first = feature("first", { operations: { run: noop } });
    const second = feature("second", { operations: { go: noop } });
    expect(first.operations.run.id).toBe("first.run");
    expect(second.operations.go.id).toBe("second.go");
    expect(first.operations.run.execute).toBe(noop.execute);
  });

  it("rejects malformed features", () => {
    expect(() => feature("bad id", { operations: { run: noop } })).toThrow(TypeError);
    expect(() => feature("f", { operations: { "a.b": noop } })).toThrow(
      /without whitespace or dots/,
    );
    expect(() => feature("f", { operations: { run: "nope" as never } })).toThrow(
      /must be created with command\(\) or query\(\)/,
    );
    expect(() =>
      feature("f", { operations: { run: noop }, events: ["nope" as never] }),
    ).toThrow(/must be created with event\(\)/);
  });
});

describe("reserved (prototype-polluting) identifiers", () => {
  const RESERVED = ["__proto__", "prototype", "constructor"] as const;
  const makeOp = () =>
    command({
      input: s.object({}),
      output: s.literal(true),
      async execute() {
        return true as const;
      },
    });

  it("rejects reserved operation keys instead of silently swallowing them", () => {
    for (const key of RESERVED) {
      // Computed key: creates an OWN property so the key reaches feature().
      const operations = { [key]: makeOp() };
      expect(() => feature("weird", { operations: operations as never })).toThrow(
        /reserved/,
      );
    }
  });

  it("rejects reserved feature and port ids", () => {
    for (const id of RESERVED) {
      expect(() => feature(id, { operations: { run: makeOp() } })).toThrow(/reserved/);
      expect(() =>
        port(id, { get: port.read({ input: s.string(), output: s.string() }) }),
      ).toThrow(/reserved/);
    }
  });

  it("rejects reserved error codes", () => {
    for (const code of RESERVED) {
      expect(() =>
        command({
          input: s.object({}),
          output: s.literal(true),
          errors: { [code]: { http: 400 } } as never,
          async execute() {
            return true as const;
          },
        }),
      ).toThrow(/reserved/);
    }
  });

  it("rejects reserved port operation keys and effect aliases", () => {
    for (const key of RESERVED) {
      expect(() =>
        port("cachePort", {
          [key]: port.read({ input: s.string(), output: s.string() }),
        } as never),
      ).toThrow(/reserved/);
    }

    const Cache = port("reservedAliasCache", {
      get: port.read({ input: s.string(), output: s.string() }),
    });
    for (const alias of RESERVED) {
      expect(() =>
        command({
          input: s.object({}),
          output: s.literal(true),
          effects: { [alias]: Cache.get } as never,
          async execute() {
            return true as const;
          },
        }),
      ).toThrow(/reserved/);
    }
  });
});
