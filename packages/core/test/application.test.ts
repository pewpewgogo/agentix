import { describe, expect, it, vi } from "vitest";

import {
  ApplicationDefinitionError,
  authorize,
  command,
  createApplication,
  DispatchError,
  event,
  feature,
  ok,
  port,
  principal,
  query,
  s,
  type AnyBoundOperation,
  type AnyUnboundOperation,
  type BoundPortAdapter,
  type Principal,
} from "../src/index.js";

const Entity = s.object({ id: s.string({ min: 1 }), value: s.string() });
type Entity = s.Infer<typeof Entity>;

const Records = port("records", {
  load: port.read({
    input: s.object({ id: s.string() }),
    output: s.optional(Entity),
  }),
  save: port.write({ input: Entity, output: Entity }),
});

const EntityCreated = event("entities.created", 1, Entity);

const entities = feature("entities", {
  operations: {
    create: command({
      input: Entity,
      output: Entity,
      errors: { ALREADY_EXISTS: s.object({ id: s.string() }) },
      permissions: ["entities:create"],
      effects: { load: Records.load, save: Records.save },
      emits: { created: EntityCreated },
      async execute({ input, effects, emit, fail }) {
        const existing = await effects.load({ id: input.id });
        if (existing !== undefined) return fail("ALREADY_EXISTS", { id: input.id });
        const saved = await effects.save(input);
        emit.created(saved);
        return saved;
      },
    }),
    get: query({
      input: s.object({ id: s.string() }),
      output: s.optional(Entity),
      permissions: ["entities:read"],
      effects: { load: Records.load },
      async execute({ input, effects }) {
        return effects.load(input);
      },
    }),
  },
});

const allowed = principal("user-1", ["entities:create", "entities:read"]);

const makeRecords = () => {
  const values = new Map<string, Entity>();
  const calls: string[] = [];
  const adapter = Records.adapter({
    load: ({ id }) => {
      calls.push(`load:${id}`);
      return values.get(id);
    },
    save: (entity) => {
      calls.push(`save:${entity.id}`);
      values.set(entity.id, entity);
      return entity;
    },
  });
  return { adapter, calls, values };
};

describe("application dispatch", () => {
  it("runs the documented boundary sequence and records ordered effects/events", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });

    const result = await app.dispatch("entities.create", {
      input: { id: "entity-1", value: "first" },
      principal: allowed,
      trace: true,
    });

    expect(result).toMatchObject({
      kind: "completed",
      operationId: "entities.create",
      outcome: { ok: true, value: { id: "entity-1", value: "first" } },
      events: [
        {
          operationId: "entities.create",
          alias: "created",
          eventId: "entities.created",
          version: 1,
          payload: { id: "entity-1", value: "first" },
        },
      ],
    });
    expect(records.calls).toEqual(["load:entity-1", "save:entity-1"]);
    expect(result.trace).toMatchObject([
      { type: "effect", alias: "load", effectId: "records.load", status: "completed" },
      { type: "effect", alias: "save", effectId: "records.save", status: "completed" },
      { type: "event", alias: "created", eventId: "entities.created", version: 1 },
    ]);
  });

  it("returns typed domain errors after validating their details", async () => {
    const records = makeRecords();
    records.values.set("same", { id: "same", value: "old" });
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });
    const result = await app.dispatch("entities.create", {
      input: { id: "same", value: "new" },
      principal: allowed,
    });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: {
        ok: false,
        error: { code: "ALREADY_EXISTS", details: { id: "same" } },
      },
    });
    expect(records.calls).toEqual(["load:same"]);
    if (result.kind === "completed") expect(result.events).toEqual([]);
  });

  it("produces identical results with tracing on and off", async () => {
    const run = async (trace: boolean) => {
      const records = makeRecords();
      const app = createApplication({
        features: [entities],
        adapters: [records.adapter],
        mode: "test",
      });
      return app.dispatch("entities.create", {
        input: { id: "e", value: "v" },
        principal: allowed,
        trace,
      });
    };

    const untraced = await run(false);
    const traced = await run(true);
    expect(untraced.trace).toBeUndefined();
    expect(traced.trace).toHaveLength(3);
    const strip = (result: object): Record<string, unknown> => {
      const clone: Record<string, unknown> = { ...result };
      delete clone["trace"];
      return clone;
    };
    expect(strip(untraced)).toEqual(strip(traced));
  });

  it("checks permissions before input parsing or effect execution", async () => {
    let parses = 0;
    const CountingInput = s.refine(
      s.string(),
      () => {
        parses += 1;
        return true;
      },
      "counting-input",
    );
    let executions = 0;
    const guarded = feature("guarded", {
      operations: {
        run: command({
          input: CountingInput,
          output: s.literal(true),
          permissions: ["guarded:run"],
          async execute() {
            executions += 1;
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [guarded], mode: "test" });

    const denied = await app.dispatch("guarded.run", {
      input: "valid",
      principal: principal("denied", []),
      trace: true,
    });
    expect(denied).toMatchObject({
      kind: "rejected",
      operationId: "guarded.run",
      error: {
        code: "PERMISSION_DENIED",
        principalId: "denied",
        missingPermissions: ["guarded:run"],
      },
      trace: [],
    });
    expect(parses).toBe(0);
    expect(executions).toBe(0);

    // Anonymous dispatch of a permissioned operation omits principalId.
    const anonymous = await app.dispatch("guarded.run", { input: "valid" });
    expect(anonymous.kind).toBe("rejected");
    if (anonymous.kind === "rejected") {
      expect(anonymous.error).toEqual({
        code: "PERMISSION_DENIED",
        missingPermissions: ["guarded:run"],
      });
    }

    const granted = await app.dispatch("guarded.run", {
      input: "valid",
      principal: principal("ok", ["guarded:run", "extra"]),
    });
    expect(granted.kind).toBe("completed");
  });

  it("accepts anonymous dispatches for operations without permissions (A2)", async () => {
    const open = feature("open", {
      operations: {
        ping: query({
          input: s.object({}),
          output: s.literal("pong"),
          async execute() {
            return "pong" as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [open], mode: "test" });
    const result = await app.dispatch("open.ping", { input: {} });
    expect(result).toMatchObject({ kind: "completed", outcome: { ok: true, value: "pong" } });
  });

  it("supports a custom authorize hook receiving principal and operation", async () => {
    const seen: Array<{ principalId: string | undefined; operationId: string }> = [];
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
      authorize: (who, operation) => {
        seen.push({ principalId: who?.id, operationId: operation.id });
        return who?.id === "root";
      },
    });

    // The hook can DENY even when the permission subset is satisfied; the
    // reported missingPermissions then comes from the default subset diff ([]).
    const denied = await app.dispatch("entities.get", {
      input: { id: "x" },
      principal: allowed,
    });
    expect(denied).toMatchObject({
      kind: "rejected",
      error: {
        code: "PERMISSION_DENIED",
        principalId: "user-1",
        missingPermissions: [],
      },
    });

    // The hook can GRANT where the default subset check would deny.
    const granted = await app.dispatch("entities.get", {
      input: { id: "x" },
      principal: principal("root", []),
    });
    expect(granted.kind).toBe("completed");
    expect(seen).toEqual([
      { principalId: "user-1", operationId: "entities.get" },
      { principalId: "root", operationId: "entities.get" },
    ]);
  });

  it("exposes the single permission gate as authorize()", () => {
    const createOp = entities.operations.create;
    const getOp = entities.operations.get;
    expect(authorize(createOp)).toBe(false);
    expect(authorize(createOp, principal("u", []))).toBe(false);
    expect(authorize(createOp, principal("u", ["entities:create"]))).toBe(true);
    expect(authorize(getOp, { id: "u", permissions: new Set(["entities:read"]) })).toBe(
      true,
    );
    expect(authorize(getOp, { id: "u", permissions: new Set() })).toBe(false);
    expect(authorize({ permissions: [] })).toBe(true);
    expect(authorize({})).toBe(true);
  });

  it("rejects invalid input without invoking effects", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });
    const result = await app.dispatch("entities.create", {
      input: { id: 1, value: "bad" } as never,
      principal: allowed,
      trace: true,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      error: { code: "INVALID_INPUT", issues: [{ path: ["id"] }] },
      trace: [],
    });
    expect(records.calls).toEqual([]);
  });

  it("faults when operation input validation throws on a hostile getter", async () => {
    let executions = 0;
    const hostile = feature("hostile-input", {
      operations: {
        run: command({
          input: s.object({ value: s.string() }),
          output: s.literal(true),
          async execute() {
            executions += 1;
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [hostile], mode: "test" });
    const input = {} as { value: string };
    Object.defineProperty(input, "value", {
      enumerable: true,
      get() {
        throw new Error("hostile input getter");
      },
    });

    await expect(
      app.dispatch("hostile-input.run", { input, trace: true }),
    ).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INPUT_VALIDATION_FAILED", cause: expect.any(Error) },
      trace: [],
    });
    expect(executions).toBe(0);
  });

  it("resolves operations by stable ID and rejects unknown IDs", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });
    const known = await app.dispatch("entities.get", {
      input: { id: "missing" },
      principal: allowed,
    });
    expect(known).toMatchObject({ kind: "completed", outcome: { ok: true } });
    expect(known).not.toHaveProperty("trace");

    const unknown = await app.dispatch("entities.missing" as unknown as "entities.get", {
      input: { id: "x" },
    });
    expect(unknown).toEqual({
      kind: "rejected",
      operationId: "entities.missing",
      error: { code: "UNKNOWN_OPERATION", operationId: "entities.missing" },
    });
  });

  it("dispatches by descriptor and faults on impostor same-id descriptors", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });

    const direct = await app.dispatch(entities.operations.get, {
      input: { id: "nope" },
      principal: allowed,
    });
    expect(direct).toMatchObject({ kind: "completed" });

    const impostor = feature("entities", {
      operations: {
        create: command({
          input: s.object({}),
          output: s.literal(true),
          async execute() {
            return true as const;
          },
        }),
      },
    });
    await expect(
      app.dispatch(impostor.operations.create as AnyBoundOperation, {
        input: {},
        principal: allowed,
      }),
    ).resolves.toMatchObject({
      kind: "fault",
      operationId: "entities.create",
      error: { code: "OPERATION_DESCRIPTOR_MISMATCH" },
    });
    expect(records.calls).toEqual(["load:nope"]);
  });

  it("reports malformed success values and undeclared or invalid errors as faults", async () => {
    const bad = feature("bad", {
      operations: {
        output: command({
          input: s.object({}),
          output: s.object({ value: s.string() }),
          async execute() {
            return { value: 3 } as never;
          },
        }),
        undeclared: command({
          input: s.object({}),
          output: s.literal(true),
          errors: { EXPECTED: s.object({ reason: s.string() }) },
          async execute({ fail }) {
            const loose = fail as unknown as (code: string, details?: unknown) => never;
            return loose("UNDECLARED", {});
          },
        }),
        invalidDetails: command({
          input: s.object({}),
          output: s.literal(true),
          errors: { EXPECTED: s.object({ reason: s.string() }) },
          async execute({ fail }) {
            return fail("EXPECTED", { reason: 5 as never });
          },
        }),
      },
    });
    const app = createApplication({ features: [bad], mode: "test" });

    await expect(app.dispatch("bad.output", { input: {} })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_OUTPUT", issues: [{ path: ["value"] }] },
    });
    await expect(app.dispatch("bad.undeclared", { input: {} })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_DOMAIN_ERROR" },
    });
    await expect(
      app.dispatch("bad.invalidDetails", { input: {} }),
    ).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_DOMAIN_ERROR", issues: [{ path: ["reason"] }] },
    });
  });

  it("treats returned ok()/err() outcomes as plain output values (v2 contract)", async () => {
    const legacy = feature("legacy", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.object({ value: s.string() }),
          async execute() {
            // v1-style Outcome wrapping is no longer understood by dispatch:
            // it is validated as output and fails the schema.
            return ok({ value: "x" }) as never;
          },
        }),
      },
    });
    const app = createApplication({ features: [legacy], mode: "test" });
    await expect(app.dispatch("legacy.run", { input: {} })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_OUTPUT" },
    });
  });

  it("faults instead of throwing when execute returns an uninspectable value", async () => {
    const hostileValue = new Proxy(
      {},
      {
        has() {
          throw new Error("hostile has trap");
        },
      },
    );
    const hostile = feature("hostile-result", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.object({}),
          async execute() {
            return hostileValue as never;
          },
        }),
      },
    });
    const app = createApplication({ features: [hostile], mode: "test" });
    await expect(app.dispatch("hostile-result.run", { input: {} })).resolves.toMatchObject(
      {
        kind: "fault",
        error: { code: "INVALID_OUTPUT", cause: expect.any(Error) },
      },
    );
  });

  it("call() returns outcomes and throws DispatchError on rejections and faults", async () => {
    const records = makeRecords();
    records.values.set("dup", { id: "dup", value: "old" });
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });

    const created = await app.call(
      "entities.create",
      { id: "fresh", value: "v" },
      { principal: allowed },
    );
    expect(created).toEqual({ ok: true, value: { id: "fresh", value: "v" } });

    const duplicate = await app.call(
      "entities.create",
      { id: "dup", value: "v" },
      { principal: allowed },
    );
    expect(duplicate).toEqual({
      ok: false,
      error: { code: "ALREADY_EXISTS", details: { id: "dup" } },
    });

    const rejection: unknown = await app
      .call("entities.create", { id: "", value: "v" }, { principal: allowed })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    if (rejection instanceof DispatchError) {
      expect(rejection.kind).toBe("rejected");
      expect(rejection.code).toBe("INVALID_INPUT");
      expect(rejection.operationId).toBe("entities.create");
      expect(rejection.message).toBe("Dispatch rejected: INVALID_INPUT");
      expect(rejection.detail.code).toBe("INVALID_INPUT");
    }

    const denied: unknown = await app
      .call("entities.create", { id: "x", value: "v" })
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(DispatchError);
    if (denied instanceof DispatchError) expect(denied.code).toBe("PERMISSION_DENIED");

    const unknown: unknown = await app
      .call("entities.missing" as unknown as "entities.get", { id: "x" })
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(DispatchError);
    if (unknown instanceof DispatchError) expect(unknown.code).toBe("UNKNOWN_OPERATION");

    const broken = feature("broken", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          async execute() {
            throw new Error("boom");
          },
        }),
      },
    });
    const faultApp = createApplication({ features: [broken], mode: "test" });
    const faulted: unknown = await faultApp
      .call("broken.run", {})
      .catch((error: unknown) => error);
    expect(faulted).toBeInstanceOf(DispatchError);
    if (faulted instanceof DispatchError) {
      expect(faulted.kind).toBe("fault");
      expect(faulted.code).toBe("EXECUTION_FAILED");
    }
  });

  it("exposes mode, features, operations, and getOperation", () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });
    expect(app.mode).toBe("test");
    expect(app.features).toEqual([entities]);
    expect(Object.keys(app.operations).sort()).toEqual([
      "entities.create",
      "entities.get",
    ]);
    expect(app.operations["entities.get"]).toBe(entities.operations.get);
    expect(app.getOperation("entities.get")).toBe(entities.operations.get);
    expect(app.getOperation("entities.missing")).toBeUndefined();
  });

  it("defaults mode from NODE_ENV (A6) unless overridden", () => {
    const simple = feature("modal", {
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
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(createApplication({ features: [simple] }).mode).toBe("production");
      vi.stubEnv("NODE_ENV", "test");
      expect(createApplication({ features: [simple] }).mode).toBe("test");
      vi.stubEnv("NODE_ENV", "staging");
      expect(createApplication({ features: [simple] }).mode).toBe("development");
      vi.stubEnv("NODE_ENV", "");
      expect(createApplication({ features: [simple] }).mode).toBe("development");
      vi.stubEnv("NODE_ENV", "production");
      expect(createApplication({ features: [simple], mode: "test" }).mode).toBe("test");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("application assembly", () => {
  it("requires an adapter for every port operation reachable from effects", () => {
    let caught: unknown;
    try {
      createApplication({ features: [entities], adapters: [], mode: "test" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationDefinitionError);
    if (caught instanceof ApplicationDefinitionError) {
      expect(caught.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "MISSING_ADAPTER", id: "records" }),
        ]),
      );
      expect(caught.message).toContain("MISSING_ADAPTER");
      expect(Object.isFrozen(caught.issues)).toBe(true);
    }
  });

  it("reports adapters that do not implement every required operation", () => {
    const incomplete: BoundPortAdapter = {
      descriptorType: "port-adapter",
      portId: "records",
      operations: { load: () => undefined },
    };
    try {
      createApplication({ features: [entities], adapters: [incomplete], mode: "test" });
      expect.unreachable("expected ApplicationDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationDefinitionError);
      expect((error as ApplicationDefinitionError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "INCOMPLETE_ADAPTER", id: "records.save" }),
        ]),
      );
    }
  });

  it("rejects duplicate adapters for the same port", () => {
    const records = makeRecords();
    const again = makeRecords();
    try {
      createApplication({
        features: [entities],
        adapters: [records.adapter, again.adapter],
        mode: "test",
      });
      expect.unreachable("expected ApplicationDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationDefinitionError);
      expect((error as ApplicationDefinitionError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "DUPLICATE_ADAPTER", id: "records" }),
        ]),
      );
    }
  });

  it("does not require adapters for ports no operation references", () => {
    const Unused = port("unused", {
      read: port.read({ input: s.object({}), output: s.string() }),
    });
    void Unused;
    const open = feature("standalone", {
      operations: {
        ping: query({
          input: s.object({}),
          output: s.boolean(),
          async execute() {
            return true;
          },
        }),
      },
    });
    // No adapter for `unused` is needed; an extra adapter is tolerated.
    const extra: BoundPortAdapter = {
      descriptorType: "port-adapter",
      portId: "unused",
      operations: { read: () => "x" },
    };
    expect(() =>
      createApplication({ features: [open], adapters: [extra], mode: "test" }),
    ).not.toThrow();
  });

  it("aggregates duplicate-id and missing-adapter issues in one error", () => {
    let caught: unknown;
    try {
      createApplication({ features: [entities, entities], mode: "test" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationDefinitionError);
    if (caught instanceof ApplicationDefinitionError) {
      const codes = caught.issues.map((issue) => issue.code);
      expect(codes).toContain("DUPLICATE_ID");
      expect(codes).toContain("MISSING_ADAPTER");
    }
  });

  it("rejects id collisions across descriptor kinds", () => {
    // An event reusing an operation id is a collision.
    const clashingEvent = event("entities.create", 1, Entity);
    const other = feature("other", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { clash: clashingEvent },
          async execute({ emit }) {
            emit.clash({ id: "x", value: "y" });
            return true as const;
          },
        }),
      },
    });
    const records = makeRecords();
    try {
      createApplication({
        features: [entities, other],
        adapters: [records.adapter],
        mode: "test",
      });
      expect.unreachable("expected ApplicationDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationDefinitionError);
      expect((error as ApplicationDefinitionError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "DUPLICATE_ID", id: "entities.create" }),
        ]),
      );
    }

    // Two distinct ports with the same id collide through their operations.
    const P1 = port("dup", {
      read: port.read({ input: s.object({}), output: s.string() }),
    });
    const P2 = port("dup", {
      read: port.read({ input: s.object({}), output: s.string() }),
    });
    const usesBoth = feature("uses-both", {
      operations: {
        a: query({
          input: s.object({}),
          output: s.string(),
          effects: { read: P1.read },
          async execute({ effects }) {
            return effects.read({});
          },
        }),
        b: query({
          input: s.object({}),
          output: s.string(),
          effects: { read: P2.read },
          async execute({ effects }) {
            return effects.read({});
          },
        }),
      },
    });
    try {
      createApplication({
        features: [usesBoth],
        adapters: [P1.adapter({ read: () => "x" })],
        mode: "test",
      });
      expect.unreachable("expected ApplicationDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationDefinitionError);
      expect((error as ApplicationDefinitionError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "DUPLICATE_ID", id: "dup.read" }),
        ]),
      );
    }
  });

  it("shares port operations and events across operations without false duplicates", () => {
    const shared = feature("shared", {
      operations: {
        first: query({
          input: s.object({ id: s.string() }),
          output: s.optional(Entity),
          effects: { load: Records.load },
          async execute({ input, effects }) {
            return effects.load(input);
          },
        }),
        second: query({
          input: s.object({ id: s.string() }),
          output: s.optional(Entity),
          effects: { load: Records.load },
          async execute({ input, effects }) {
            return effects.load(input);
          },
        }),
      },
      events: [EntityCreated],
    });
    const records = makeRecords();
    expect(() =>
      createApplication({
        features: [shared, entities],
        adapters: [records.adapter],
        mode: "test",
      }),
    ).not.toThrow();
  });

  it("rejects conflicting http routes at startup", () => {
    const routeFeature = (id: string, path: string) =>
      feature(id, {
        operations: {
          run: query({
            input: s.object({}),
            output: s.boolean(),
            http: { method: "GET", path },
            async execute() {
              return true;
            },
          }),
        },
      });

    expect(() =>
      createApplication({
        features: [routeFeature("ra", "/same"), routeFeature("rb", "/other")],
        mode: "test",
      }),
    ).not.toThrow();

    try {
      createApplication({
        features: [routeFeature("rc", "/same"), routeFeature("rd", "/same")],
        mode: "test",
      });
      expect.unreachable("expected ApplicationDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationDefinitionError);
      expect((error as ApplicationDefinitionError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "HTTP_ROUTE_CONFLICT",
            id: "rd.run",
            message: expect.stringContaining("GET /same"),
          }),
        ]),
      );
    }
  });

  it("rejects write effects and emitted events on queries that evade authoring checks", () => {
    const writeCommand = command({
      input: s.object({}),
      output: s.literal(true),
      effects: { save: Records.save },
      async execute() {
        return true as const;
      },
    });
    const emitCommand = command({
      input: s.object({}),
      output: s.literal(true),
      emits: { created: EntityCreated },
      async execute() {
        return true as const;
      },
    });
    const sneakyWrite = { ...writeCommand, kind: "query" } as AnyUnboundOperation;
    const sneakyEmit = { ...emitCommand, kind: "query" } as AnyUnboundOperation;
    const sneaky = feature("sneaky", {
      operations: { write: sneakyWrite, emit: sneakyEmit },
    });
    const records = makeRecords();
    try {
      createApplication({
        features: [sneaky],
        adapters: [records.adapter],
        mode: "test",
      });
      expect.unreachable("expected ApplicationDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationDefinitionError);
      const codes = (error as ApplicationDefinitionError).issues.map(
        (issue) => issue.code,
      );
      expect(codes).toContain("QUERY_WRITE_EFFECT");
      expect(codes).toContain("QUERY_EMITS_EVENT");
    }
  });
});
