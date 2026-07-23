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
