import { describe, expect, it } from "vitest";

import {
  ApplicationDefinitionError,
  bindPort,
  createApplication,
  defineCommand,
  defineEvent,
  defineFeature,
  defineFeatureContract,
  definePort,
  defineQuery,
  domainError,
  err,
  ok,
  portOperation,
  schema,
  type AnyOperationDescriptor,
  type BoundPortAdapter,
  type EffectHandler,
  type Schema,
} from "../src/index.js";

const Entity = schema.object({ id: schema.string(), value: schema.string() });

const Records = definePort({
  id: "records",
  operations: {
    load: portOperation({
      id: "records.load",
      kind: "read",
      input: schema.object({ id: schema.string() }),
      output: schema.optional(Entity),
      errors: {},
    }),
    save: portOperation({
      id: "records.save",
      kind: "write",
      input: Entity,
      output: Entity,
      errors: {},
    }),
  },
});

const EntityCreated = defineEvent({
  id: "entities.created",
  version: 1,
  payload: Entity,
});

const createEntity = defineCommand({
  id: "entities.create",
  input: Entity,
  output: Entity,
  errors: {
    ALREADY_EXISTS: schema.object({ id: schema.string() }),
  },
  permissions: ["entities:create"],
  effects: {
    load: Records.operations.load,
    save: Records.operations.save,
  },
  emits: { created: EntityCreated },
  async execute({ input, effects, emit }) {
    const existing = await effects.load({ id: input.id });
    if (existing.ok && existing.value !== undefined) {
      return err(domainError("ALREADY_EXISTS", { id: input.id }));
    }
    const saved = await effects.save(input);
    if (!saved.ok) return saved;
    emit.created(saved.value);
    return ok(saved.value);
  },
});

const getEntity = defineQuery({
  id: "entities.get",
  input: schema.object({ id: schema.string() }),
  output: schema.optional(Entity),
  errors: {},
  permissions: ["entities:read"],
  effects: { load: Records.operations.load },
  execute: ({ input, effects }) => effects.load(input),
});

const contract = defineFeatureContract({
  id: "entities",
  exports: { createEntity, getEntity, EntityCreated },
});

const entities = defineFeature({
  id: "entities",
  contract,
  dependencies: [],
  operations: [createEntity, getEntity],
  invariants: [],
  events: [EntityCreated],
  ports: [Records],
});

const allowed = {
  id: "user-1",
  permissions: ["entities:create", "entities:read"],
} as const;

const throwingSchema = <T>(message: string): Schema<T> => Object.freeze({
  description: Object.freeze({ type: "object", fields: Object.freeze({}) }),
  parse(): T {
    throw new Error(message);
  },
  safeParse(): never {
    throw new Error(message);
  },
});

const makeRecords = () => {
  const values = new Map<string, { id: string; value: string }>();
  const calls: string[] = [];
  const adapter = bindPort(Records, {
    load: ({ id }) => {
      calls.push(`load:${id}`);
      return ok(values.get(id));
    },
    save: (entity) => {
      calls.push(`save:${entity.id}`);
      values.set(entity.id, entity);
      return ok(entity);
    },
  });
  return { adapter, calls, values };
};

const featureFor = (
  id: string,
  operations: readonly AnyOperationDescriptor[],
  options: {
    readonly dependencies?: readonly { readonly id: string }[];
    readonly ports?: readonly (typeof Records)[];
  } = {},
) =>
  defineFeature({
    id,
    contract: defineFeatureContract({ id }),
    dependencies: options.dependencies ?? [],
    operations,
    invariants: [],
    ports: options.ports ?? [],
  });

describe("application dispatch", () => {
  it("runs the documented boundary sequence and records ordered effects/events", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: { records: records.adapter },
      mode: "test",
    });

    const result = await app.dispatch(createEntity, {
      input: { id: "entity-1", value: "first" },
      principal: allowed,
    });

    expect(result).toMatchObject({
      kind: "completed",
      operationId: "entities.create",
      outcome: {
        ok: true,
        value: { id: "entity-1", value: "first" },
      },
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
      {
        type: "effect",
        alias: "load",
        effectId: "records.load",
        status: "completed",
      },
      {
        type: "effect",
        alias: "save",
        effectId: "records.save",
        status: "completed",
      },
      {
        type: "event",
        alias: "created",
        eventId: "entities.created",
        version: 1,
      },
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
    const result = await app.dispatch(createEntity, {
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
  });

  it("returns validated events in production independently of tracing", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "production",
    });

    const result = await app.dispatch(createEntity, {
      input: { id: "eventful", value: "visible" },
      principal: allowed,
    });

    expect(result).not.toHaveProperty("trace");
    expect(result).toMatchObject({
      kind: "completed",
      events: [
        {
          eventId: "entities.created",
          payload: { id: "eventful", value: "visible" },
        },
      ],
    });
    if (result.kind === "completed") {
      expect(Object.isFrozen(result.events)).toBe(true);
      expect(Object.isFrozen(result.events[0])).toBe(true);
    }
  });

  it("returns detached deeply immutable structured event payloads", async () => {
    const StructuredPayload = schema.object({
      details: schema.object({
        labels: schema.array(schema.object({ value: schema.string() })),
      }),
    });
    const StructuredEvent = defineEvent({
      id: "events.structured",
      version: 1,
      payload: StructuredPayload,
    });
    const publish = defineCommand({
      id: "events.publish-structured",
      input: StructuredPayload,
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { published: StructuredEvent },
      execute({ input, emit }) {
        emit.published(input);
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("structured-events", [publish])],
      adapters: [],
      mode: "production",
    });
    const input = { details: { labels: [{ value: "original" }] } };

    const result = await app.dispatch(publish, { input, principal: allowed });
    expect(result).toMatchObject({
      kind: "completed",
      events: [{ payload: input }],
    });
    if (result.kind !== "completed") return;

    const payload = result.events[0]?.payload as {
      details: { labels: Array<{ value: string }> };
    };
    expect(payload).not.toBe(input);
    expect(payload.details).not.toBe(input.details);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.details)).toBe(true);
    expect(Object.isFrozen(payload.details.labels)).toBe(true);
    expect(Object.isFrozen(payload.details.labels[0])).toBe(true);
    expect(() => payload.details.labels.push({ value: "mutated" })).toThrow(TypeError);
    expect(() => {
      payload.details.labels[0]!.value = "mutated";
    }).toThrow(TypeError);
    expect(payload.details.labels).toEqual([{ value: "original" }]);
  });

  it("preserves cycles and shared references in immutable event snapshots", async () => {
    interface CyclicPayload {
      name: string;
      self?: CyclicPayload;
      shared: { value: string };
      duplicate: { value: string };
    }
    const CyclicPayloadSchema = Object.freeze({
      description: Object.freeze({
        type: "object" as const,
        fields: Object.freeze({}),
      }),
      parse(value: unknown): CyclicPayload {
        return value as CyclicPayload;
      },
      safeParse(value: unknown) {
        return Object.freeze({ success: true as const, data: value as CyclicPayload });
      },
    }) satisfies Schema<CyclicPayload>;
    const CyclicEvent = defineEvent({
      id: "events.cyclic",
      version: 1,
      payload: CyclicPayloadSchema,
    });
    const shared = { value: "original" };
    const source: CyclicPayload = {
      name: "root",
      shared,
      duplicate: shared,
    };
    source.self = source;
    const publish = defineCommand({
      id: "events.publish-cyclic",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { published: CyclicEvent },
      execute({ emit }) {
        emit.published(source);
        source.shared.value = "changed-after-emit";
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("cyclic-events", [publish])],
      adapters: [],
      mode: "production",
    });

    const result = await app.dispatch(publish, { input: {}, principal: allowed });
    if (result.kind !== "completed") throw new Error("Expected completed dispatch");
    const payload = result.events[0]?.payload as CyclicPayload;

    expect(payload).not.toBe(source);
    expect(payload.self).toBe(payload);
    expect(payload.shared).toBe(payload.duplicate);
    expect(payload.shared.value).toBe("original");
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.shared)).toBe(true);
  });

  it("checks permissions before input parsing or effect execution", async () => {
    let parses = 0;
    const CountingInput = schema.refine(
      schema.string(),
      () => {
        parses += 1;
        return true;
      },
      "counting-input",
    );
    let executions = 0;
    const guarded = defineCommand({
      id: "guarded.run",
      input: CountingInput,
      output: schema.literal(true),
      errors: {},
      permissions: ["guarded:run"],
      effects: {},
      emits: {},
      execute: () => {
        executions += 1;
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("guarded", [guarded])],
      adapters: [],
      mode: "test",
    });

    const denied = await app.dispatch(guarded, {
      input: "valid",
      principal: { id: "denied", permissions: [] },
    });
    expect(denied).toMatchObject({
      kind: "rejected",
      error: {
        code: "PERMISSION_DENIED",
        missingPermissions: ["guarded:run"],
      },
      trace: [],
    });
    expect(parses).toBe(0);
    expect(executions).toBe(0);
  });

  it("rejects invalid input without invoking effects", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });
    const result = await app.dispatch(createEntity, {
      input: { id: 1, value: "bad" } as never,
      principal: allowed,
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
    const hostileInput = defineCommand({
      id: "hostile-input.run",
      input: schema.object({ value: schema.string() }),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: {},
      execute() {
        executions += 1;
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("hostile-input", [hostileInput])],
      adapters: [],
      mode: "test",
    });
    const input = {} as { value: string };
    Object.defineProperty(input, "value", {
      enumerable: true,
      get() {
        throw new Error("hostile input getter");
      },
    });

    await expect(app.dispatch(hostileInput, { input, principal: allowed }))
      .resolves.toMatchObject({
        kind: "fault",
        error: {
          code: "INPUT_VALIDATION_FAILED",
          cause: expect.any(Error),
        },
        trace: [],
      });
    expect(executions).toBe(0);
  });

  it("resolves operations by stable ID and rejects unknown IDs", async () => {
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
    });
    const known = await app.dispatch("entities.get", {
      input: { id: "missing" },
      principal: allowed,
    });
    expect(known).toMatchObject({ kind: "completed", outcome: { ok: true } });
    expect(known).not.toHaveProperty("trace");

    const unknown = await app.dispatch("entities.missing", {
      input: {},
      principal: allowed,
    });
    expect(unknown).toEqual({
      kind: "rejected",
      operationId: "entities.missing",
      error: { code: "UNKNOWN_OPERATION", operationId: "entities.missing" },
    });
  });

  it("reports malformed success and domain-error values as boundary faults", async () => {
    const badOutput = defineCommand({
      id: "bad.output",
      input: schema.object({}),
      output: schema.object({ value: schema.string() }),
      errors: {},
      permissions: [],
      effects: {},
      emits: {},
      execute: () => ok({ value: 3 } as never),
    });
    const badError = defineCommand({
      id: "bad.error",
      input: schema.object({}),
      output: schema.literal(true),
      errors: { EXPECTED: schema.object({ reason: schema.string() }) },
      permissions: [],
      effects: {},
      emits: {},
      execute: () => err({ code: "UNDECLARED", details: {} } as never),
    });
    const app = createApplication({
      features: [featureFor("bad", [badOutput, badError])],
      adapters: [],
      mode: "test",
    });

    await expect(app.dispatch(badOutput, { input: {}, principal: allowed })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_OUTPUT" },
    });
    await expect(app.dispatch(badError, { input: {}, principal: allowed })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_DOMAIN_ERROR" },
    });
  });

  it("guards and traces invalid effect inputs and adapter outputs", async () => {
    const BadEffect = definePort({
      id: "bad-effect",
      operations: {
        read: portOperation({
          id: "bad-effect.read",
          kind: "read",
          input: schema.object({ key: schema.string() }),
          output: schema.number(),
          errors: {},
        }),
      },
    });
    let calls = 0;
    const invalidInput = defineCommand({
      id: "effects.invalid-input",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { read: BadEffect.operations.read },
      emits: {},
      async execute({ effects }) {
        await effects.read({ key: 1 } as never);
        return ok(true as const);
      },
    });
    const invalidOutput = defineCommand({
      id: "effects.invalid-output",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { read: BadEffect.operations.read },
      emits: {},
      async execute({ effects }) {
        await effects.read({ key: "x" });
        return ok(true as const);
      },
    });
    const adapter = bindPort(BadEffect, {
      read: () => {
        calls += 1;
        return ok("not-a-number" as never);
      },
    });
    const app = createApplication({
      features: [featureFor("effects", [invalidInput, invalidOutput])],
      adapters: [adapter],
      mode: "test",
    });

    const badInput = await app.dispatch(invalidInput, { input: {}, principal: allowed });
    expect(badInput).toMatchObject({
      kind: "fault",
      error: { code: "INVALID_EFFECT_INPUT", effectId: "bad-effect.read" },
      trace: [{ type: "effect", status: "fault", effectId: "bad-effect.read" }],
    });
    expect(calls).toBe(0);

    const badOutput = await app.dispatch(invalidOutput, { input: {}, principal: allowed });
    expect(badOutput).toMatchObject({
      kind: "fault",
      error: { code: "INVALID_EFFECT_OUTPUT", effectId: "bad-effect.read" },
      trace: [{ type: "effect", status: "fault", effectId: "bad-effect.read" }],
    });
    expect(calls).toBe(1);
  });

  it.each(["production", "development", "test"] as const)(
    "validates adapter payloads in %s mode",
    async (mode) => {
      const Invalid = definePort({
        id: `invalid-${mode}`,
        operations: {
          read: portOperation({
            id: `invalid-${mode}.read`,
            kind: "read",
            input: schema.object({}),
            output: schema.string(),
            errors: {},
          }),
        },
      });
      const operation = defineCommand({
        id: `invalid-${mode}.run`,
        input: schema.object({}),
        output: schema.literal(true),
        errors: {},
        permissions: [],
        effects: { read: Invalid.operations.read },
        emits: {},
        async execute({ effects }) {
          await effects.read({});
          return ok(true as const);
        },
      });
      const app = createApplication({
        features: [featureFor(`invalid-${mode}`, [operation])],
        adapters: [bindPort(Invalid, { read: () => ok(42 as never) })],
        mode,
      });

      await expect(app.dispatch(operation, { input: {}, principal: allowed }))
        .resolves.toMatchObject({
          kind: "fault",
          error: { code: "INVALID_EFFECT_OUTPUT" },
        });
    },
  );

  it("cannot turn caught effect or event boundary faults into success", async () => {
    const Caught = definePort({
      id: "caught",
      operations: {
        read: portOperation({
          id: "caught.read",
          kind: "read",
          input: schema.object({ key: schema.string() }),
          output: schema.string(),
          errors: {},
        }),
      },
    });
    const CaughtEvent = defineEvent({
      id: "caught.event",
      version: 1,
      payload: schema.object({ value: schema.string() }),
    });
    const caughtEffect = defineCommand({
      id: "caught.effect",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { read: Caught.operations.read },
      emits: {},
      async execute({ effects }) {
        try {
          await effects.read({ key: 1 } as never);
        } catch {
          // A boundary fault is fatal even when application code catches it.
        }
        return ok(true as const);
      },
    });
    const caughtEvent = defineCommand({
      id: "caught.event-operation",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { happened: CaughtEvent },
      execute({ emit }) {
        try {
          emit.happened({ value: 1 } as never);
        } catch {
          // A boundary fault is fatal even when application code catches it.
        }
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("caught", [caughtEffect, caughtEvent])],
      adapters: [bindPort(Caught, { read: () => ok("value") })],
      mode: "test",
    });

    await expect(app.dispatch(caughtEffect, { input: {}, principal: allowed }))
      .resolves.toMatchObject({
        kind: "fault",
        error: { code: "INVALID_EFFECT_INPUT" },
      });
    await expect(app.dispatch(caughtEvent, { input: {}, principal: allowed }))
      .resolves.toMatchObject({
        kind: "fault",
        error: { code: "INVALID_EVENT_PAYLOAD" },
      });
  });

  it("latches a custom effect input schema exception before code can catch it", async () => {
    let adapterCalls = 0;
    const HostileInput = definePort({
      id: "hostile-effect-input",
      operations: {
        read: portOperation({
          id: "hostile-effect-input.read",
          kind: "read",
          input: throwingSchema<{ key: string }>("effect input schema exploded"),
          output: schema.string(),
          errors: {},
        }),
      },
    });
    const operation = defineCommand({
      id: "hostile-effect-input.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { read: HostileInput.operations.read },
      emits: {},
      async execute({ effects }) {
        try {
          await effects.read({ key: "caught" });
        } catch {
          // A hostile schema exception must still fault the dispatch.
        }
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("hostile-effect-input", [operation])],
      adapters: [bindPort(HostileInput, {
        read() {
          adapterCalls += 1;
          return ok("unreachable");
        },
      })],
      mode: "test",
    });

    await expect(app.dispatch(operation, { input: {}, principal: allowed }))
      .resolves.toMatchObject({
        kind: "fault",
        error: {
          code: "INVALID_EFFECT_INPUT",
          effectId: "hostile-effect-input.read",
          cause: expect.any(Error),
        },
        trace: [{
          type: "effect",
          status: "fault",
          effectId: "hostile-effect-input.read",
          error: { code: "INVALID_EFFECT_INPUT" },
        }],
      });
    expect(adapterCalls).toBe(0);
  });

  it("latches exceptions while inspecting a hostile adapter outcome", async () => {
    const HostileOutcome = definePort({
      id: "hostile-effect-outcome",
      operations: {
        read: portOperation({
          id: "hostile-effect-outcome.read",
          kind: "read",
          input: schema.object({}),
          output: schema.string(),
          errors: {},
        }),
      },
    });
    const operation = defineCommand({
      id: "hostile-effect-outcome.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { read: HostileOutcome.operations.read },
      emits: {},
      async execute({ effects }) {
        try {
          await effects.read({});
        } catch {
          // Outcome inspection failures remain fatal boundary faults.
        }
        return ok(true as const);
      },
    });
    const hostileOutcome = new Proxy({}, {
      has() {
        throw new Error("outcome proxy exploded");
      },
    });
    const app = createApplication({
      features: [featureFor("hostile-effect-outcome", [operation])],
      adapters: [bindPort(HostileOutcome, {
        read: () => hostileOutcome as never,
      })],
      mode: "test",
    });

    await expect(app.dispatch(operation, { input: {}, principal: allowed }))
      .resolves.toMatchObject({
        kind: "fault",
        error: {
          code: "INVALID_EFFECT_RESULT",
          effectId: "hostile-effect-outcome.read",
          cause: expect.any(Error),
        },
        trace: [{
          type: "effect",
          status: "fault",
          effectId: "hostile-effect-outcome.read",
          error: { code: "INVALID_EFFECT_RESULT" },
        }],
      });
  });

  it("waits for started effects before completing dispatch", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let effectCompleted = false;
    const Deferred = definePort({
      id: "deferred",
      operations: {
        write: portOperation({
          id: "deferred.write",
          kind: "write",
          input: schema.object({}),
          output: schema.literal(true),
          errors: {},
        }),
      },
    });
    const deferred = defineCommand({
      id: "deferred.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { write: Deferred.operations.write },
      emits: {},
      execute({ effects }) {
        void effects.write({});
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("deferred", [deferred])],
      adapters: [bindPort(Deferred, {
        async write() {
          await gate;
          effectCompleted = true;
          return ok(true as const);
        },
      })],
      mode: "test",
    });
    let dispatchCompleted = false;
    const resultPromise = app.dispatch(deferred, { input: {}, principal: allowed })
      .then((result) => {
        dispatchCompleted = true;
        return result;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchCompleted).toBe(false);

    release?.();
    await expect(resultPromise).resolves.toMatchObject({ kind: "completed" });
    expect(effectCompleted).toBe(true);
  });

  it("rejects a timer-delayed effect while started effects are draining", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markLateAttempted: (() => void) | undefined;
    const lateAttempted = new Promise<void>((resolve) => {
      markLateAttempted = resolve;
    });
    const calls: string[] = [];
    const Delayed = definePort({
      id: "delayed-effect",
      operations: {
        write: portOperation({
          id: "delayed-effect.write",
          kind: "write",
          input: schema.object({ phase: schema.string() }),
          output: schema.literal(true),
          errors: {},
        }),
      },
    });
    const delayed = defineCommand({
      id: "delayed-effect.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { write: Delayed.operations.write },
      emits: {},
      execute({ effects }) {
        void effects.write({ phase: "started" });
        setTimeout(() => {
          void Promise.resolve(effects.write({ phase: "late" })).then(
            () => markLateAttempted?.(),
            () => markLateAttempted?.(),
          );
        }, 0);
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("delayed-effect", [delayed])],
      adapters: [bindPort(Delayed, {
        async write({ phase }) {
          calls.push(phase);
          if (phase === "started") await hold;
          return ok(true as const);
        },
      })],
      mode: "test",
    });

    const resultPromise = app.dispatch(delayed, { input: {}, principal: allowed });
    await lateAttempted;
    releaseHold?.();

    await expect(resultPromise).resolves.toMatchObject({
      kind: "fault",
      error: { code: "EFFECT_OUTSIDE_EXECUTION" },
    });
    expect(calls).toEqual(["started"]);
  });

  it("rejects a timer-delayed event while started effects are draining", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markLateAttempted: (() => void) | undefined;
    const lateAttempted = new Promise<void>((resolve) => {
      markLateAttempted = resolve;
    });
    const Holding = definePort({
      id: "delayed-event-hold",
      operations: {
        write: portOperation({
          id: "delayed-event-hold.write",
          kind: "write",
          input: schema.object({}),
          output: schema.literal(true),
          errors: {},
        }),
      },
    });
    const DelayedEvent = defineEvent({
      id: "delayed-event.happened",
      version: 1,
      payload: schema.object({ value: schema.string() }),
    });
    const delayed = defineCommand({
      id: "delayed-event.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { hold: Holding.operations.write },
      emits: { happened: DelayedEvent },
      execute({ effects, emit }) {
        void effects.hold({});
        setTimeout(() => {
          try {
            emit.happened({ value: "late" });
          } catch {
            // The boundary fault is reflected by the dispatch result below.
          } finally {
            markLateAttempted?.();
          }
        }, 0);
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("delayed-event", [delayed])],
      adapters: [bindPort(Holding, {
        async write() {
          await hold;
          return ok(true as const);
        },
      })],
      mode: "test",
    });

    const resultPromise = app.dispatch(delayed, { input: {}, principal: allowed });
    await lateAttempted;
    releaseHold?.();

    const result = await resultPromise;
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "EVENT_OUTSIDE_EXECUTION" },
    });
    expect(result).not.toHaveProperty("events");
  });

  it("validates emitted payloads and separates unexpected exceptions", async () => {
    const BrokenEvent = defineEvent({
      id: "broken.event",
      version: 1,
      payload: schema.object({ value: schema.string() }),
    });
    const invalidEvent = defineCommand({
      id: "broken.emit",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { broken: BrokenEvent },
      execute: ({ emit }) => {
        emit.broken({ value: 3 } as never);
        return ok(true as const);
      },
    });
    const throwing = defineCommand({
      id: "broken.throw",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: {},
      execute: () => {
        throw new Error("private details");
      },
    });
    const app = createApplication({
      features: [featureFor("broken", [invalidEvent, throwing])],
      adapters: [],
      mode: "test",
    });

    await expect(app.dispatch(invalidEvent, { input: {}, principal: allowed })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_EVENT_PAYLOAD", eventId: "broken.event" },
    });
    await expect(app.dispatch(throwing, { input: {}, principal: allowed })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "EXECUTION_FAILED", cause: expect.any(Error) },
    });
  });

  it("latches a custom event payload schema exception before code can catch it", async () => {
    const HostileEvent = defineEvent({
      id: "hostile-event-schema.happened",
      version: 1,
      payload: throwingSchema<{ value: string }>("event schema exploded"),
    });
    const operation = defineCommand({
      id: "hostile-event-schema.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { happened: HostileEvent },
      execute({ emit }) {
        try {
          emit.happened({ value: "caught" });
        } catch {
          // A hostile schema exception must still fault the dispatch.
        }
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("hostile-event-schema", [operation])],
      adapters: [],
      mode: "test",
    });

    const result = await app.dispatch(operation, { input: {}, principal: allowed });
    expect(result).toMatchObject({
      kind: "fault",
      error: {
        code: "INVALID_EVENT_PAYLOAD",
        eventId: "hostile-event-schema.happened",
        cause: expect.any(Error),
      },
      trace: [],
    });
    expect(result).not.toHaveProperty("events");
  });

  it("latches an event snapshot exception from a hostile payload getter", async () => {
    interface HostilePayload {
      value: string;
    }
    const PassthroughPayload = Object.freeze({
      description: Object.freeze({
        type: "object" as const,
        fields: Object.freeze({ value: Object.freeze({ type: "string" as const }) }),
      }),
      parse(value: unknown): HostilePayload {
        return value as HostilePayload;
      },
      safeParse(value: unknown) {
        return Object.freeze({ success: true as const, data: value as HostilePayload });
      },
    }) satisfies Schema<HostilePayload>;
    const HostileEvent = defineEvent({
      id: "hostile-event-snapshot.happened",
      version: 1,
      payload: PassthroughPayload,
    });
    const payload = {} as HostilePayload;
    Object.defineProperty(payload, "value", {
      enumerable: true,
      get() {
        throw new Error("snapshot getter exploded");
      },
    });
    const operation = defineCommand({
      id: "hostile-event-snapshot.run",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { happened: HostileEvent },
      execute({ emit }) {
        try {
          emit.happened(payload);
        } catch {
          // Snapshot failures remain fatal boundary faults.
        }
        return ok(true as const);
      },
    });
    const app = createApplication({
      features: [featureFor("hostile-event-snapshot", [operation])],
      adapters: [],
      mode: "test",
    });

    const result = await app.dispatch(operation, { input: {}, principal: allowed });
    expect(result).toMatchObject({
      kind: "fault",
      error: {
        code: "INVALID_EVENT_PAYLOAD",
        eventId: "hostile-event-snapshot.happened",
        cause: expect.any(Error),
      },
      trace: [],
    });
    expect(result).not.toHaveProperty("events");
  });

  it("does not expose attempted events when execution later faults", async () => {
    const attempted = defineCommand({
      id: "events.attempted",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: { created: EntityCreated },
      execute({ emit }) {
        emit.created({ id: "attempted", value: "not-completed" });
        throw new Error("after emit");
      },
    });
    const app = createApplication({
      features: [featureFor("events", [attempted])],
      adapters: [],
      mode: "test",
    });

    const result = await app.dispatch(attempted, { input: {}, principal: allowed });
    expect(result).toMatchObject({
      kind: "fault",
      trace: [{ type: "event", eventId: "entities.created" }],
    });
    expect(result).not.toHaveProperty("events");
  });

  it("rejects an impostor descriptor that reuses a registered id", async () => {
    const impostor = defineCommand({
      id: "entities.create",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: {},
      execute: () => ok(true as const),
    });
    const records = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [records.adapter],
      mode: "test",
    });

    await expect(app.dispatch(impostor as never, { input: {}, principal: allowed }))
      .resolves.toMatchObject({
        kind: "fault",
        error: { code: "OPERATION_DESCRIPTOR_MISMATCH" },
      });
    expect(records.calls).toEqual([]);
  });

  it("prevents a captured capability from running after execution", async () => {
    let captured: EffectHandler<typeof Records.operations.load> | undefined;
    const capture = defineCommand({
      id: "capture.effect",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: { load: Records.operations.load },
      emits: {},
      execute: ({ effects }) => {
        captured = effects.load;
        return ok(true as const);
      },
    });
    const records = makeRecords();
    const app = createApplication({
      features: [featureFor("capture", [capture])],
      adapters: [records.adapter],
      mode: "test",
    });
    await app.dispatch(capture, { input: {}, principal: allowed });
    expect(captured).toBeDefined();
    await expect(captured?.({ id: "late" })).rejects.toThrow(/outside capture.effect/);
    expect(records.calls).toEqual([]);
  });
});

describe("application assembly", () => {
  it("requires every referenced operation from an implicitly discovered port", () => {
    const incomplete = bindPort(Records, {
      load: () => ok(undefined),
    } as never) as BoundPortAdapter;

    expect(() =>
      createApplication({
        features: [featureFor("implicit", [createEntity])],
        adapters: [incomplete],
      }),
    ).toThrowError(ApplicationDefinitionError);
    try {
      createApplication({
        features: [featureFor("implicit", [createEntity])],
        adapters: [incomplete],
      });
    } catch (error) {
      expect((error as ApplicationDefinitionError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "INCOMPLETE_ADAPTER",
            id: "records.save",
          }),
        ]),
      );
    }
  });

  it("rejects missing dependencies, duplicate IDs, and missing adapters", () => {
    const one = defineCommand({
      id: "duplicate.operation",
      input: schema.object({}),
      output: schema.literal(true),
      errors: {},
      permissions: [],
      effects: {},
      emits: {},
      execute: () => ok(true as const),
    });
    const two = defineCommand({ ...one, execute: () => ok(true as const) });
    const invalid = featureFor("invalid", [one, two], {
      dependencies: [{ id: "missing" }],
    });
    expect(() => createApplication({ features: [invalid], adapters: [] })).toThrow(
      /MISSING_DEPENDENCY.*DUPLICATE_ID|DUPLICATE_ID.*MISSING_DEPENDENCY/,
    );

    expect(() =>
      createApplication({ features: [entities], adapters: [] }),
    ).toThrow(/MISSING_ADAPTER/);
  });

  it("rejects query writes even when hostile casts evade the type system", () => {
    expect(() =>
      defineQuery({
        id: "hostile.query",
        input: Entity,
        output: Entity,
        errors: {},
        permissions: [],
        effects: { save: Records.operations.save } as never,
        execute: async ({ input }) => ok(input),
      }),
    ).toThrow(/cannot declare write effect/);
  });
});
