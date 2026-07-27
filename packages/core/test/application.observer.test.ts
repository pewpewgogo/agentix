import { describe, expect, it, vi } from "vitest";

import {
  command,
  createApplication,
  event,
  feature,
  port,
  principal,
  s,
  subscription,
  type DispatchObserver,
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
  },
});

const makeRecords = () => {
  const values = new Map<string, Entity>();
  return Records.adapter({
    load: ({ id }) => values.get(id),
    save: (entity) => {
      values.set(entity.id, entity);
      return entity;
    },
  });
};

describe("dispatch observer", () => {
  it("fires callbacks in order and passes the started token everywhere", async () => {
    const calls: Array<{ name: string; ctx: Record<string, unknown> }> = [];
    const token = { span: "trace-1" };
    const observer: DispatchObserver = {
      dispatchStarted(ctx) {
        calls.push({ name: "dispatchStarted", ctx: { ...ctx } });
        return token;
      },
      dispatchSettled(ctx) {
        calls.push({ name: "dispatchSettled", ctx: { ...ctx } });
      },
      effectSettled(ctx) {
        calls.push({ name: "effectSettled", ctx: { ...ctx } });
      },
      eventEmitted(ctx) {
        calls.push({ name: "eventEmitted", ctx: { ...ctx } });
      },
    };
    const app = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
      observer,
    });

    const meta = { requestId: "req-1" };
    const result = await app.dispatch("entities.create", {
      input: { id: "e1", value: "v" },
      principal: principal("user-1", []),
      meta,
    });
    expect(result.kind).toBe("completed");

    expect(calls.map((entry) => entry.name)).toEqual([
      "dispatchStarted",
      "effectSettled",
      "effectSettled",
      "eventEmitted",
      "dispatchSettled",
    ]);

    const [started, load, save, emitted, settled] = calls;
    expect(started?.ctx).toEqual({
      operationId: "entities.create",
      principalId: "user-1",
      meta,
    });
    expect(started?.ctx["meta"]).toBe(meta); // opaque passthrough, same reference
    expect(load?.ctx).toMatchObject({
      operationId: "entities.create",
      alias: "load",
      effectId: "records.load",
      ok: true,
      token,
    });
    expect(typeof load?.ctx["durationNs"]).toBe("bigint");
    expect(save?.ctx).toMatchObject({
      alias: "save",
      effectId: "records.save",
      ok: true,
      token,
    });
    expect(emitted?.ctx).toEqual({
      operationId: "entities.create",
      eventId: "entities.created",
      token,
    });
    expect(settled?.ctx).toMatchObject({
      operationId: "entities.create",
      kind: "completed",
      token,
    });
    expect(settled?.ctx["meta"]).toBe(meta);
    expect(settled?.ctx["code"]).toBeUndefined();
    expect((settled?.ctx["durationNs"] as bigint) >= 0n).toBe(true);
  });

  it("reports the outcome error code, rejection code, and fault code", async () => {
    const settled: Array<Record<string, unknown>> = [];
    const observer: DispatchObserver = {
      dispatchSettled(ctx) {
        settled.push({ ...ctx });
      },
    };
    const adapter = makeRecords();
    const app = createApplication({
      features: [entities],
      adapters: [adapter],
      mode: "test",
      observer,
    });

    const loose = app.dispatch as (
      id: string,
      options: { input: unknown },
    ) => Promise<unknown>;
    await app.dispatch("entities.create", { input: { id: "dup", value: "a" } });
    await app.dispatch("entities.create", { input: { id: "dup", value: "b" } });
    await loose("entities.create", { input: { id: 1, value: "c" } });
    await loose("entities.missing", { input: {} });

    expect(settled).toMatchObject([
      { kind: "completed", operationId: "entities.create" },
      { kind: "completed", code: "ALREADY_EXISTS" },
      { kind: "rejected", code: "INVALID_INPUT" },
      { kind: "rejected", code: "UNKNOWN_OPERATION", operationId: "entities.missing" },
    ]);
    expect(settled[0]?.["code"]).toBeUndefined();
  });

  it("marks failing effects with ok:false and settles the dispatch as a fault", async () => {
    const calls: string[] = [];
    const observer: DispatchObserver = {
      effectSettled(ctx) {
        calls.push(`effect:${ctx.effectId}:${ctx.ok}`);
      },
      dispatchSettled(ctx) {
        calls.push(`settled:${ctx.kind}:${ctx.code}`);
      },
    };
    const failing = Records.adapter({
      load: () => {
        throw new Error("boom");
      },
      save: (entity) => entity,
    });
    const app = createApplication({
      features: [entities],
      adapters: [failing],
      mode: "test",
      observer,
    });
    const result = await app.dispatch("entities.create", {
      input: { id: "e1", value: "v" },
    });
    expect(result.kind).toBe("fault");
    expect(calls).toEqual([
      "effect:records.load:false",
      "settled:fault:EFFECT_FAILURE",
    ]);
  });

  it("never lets a throwing observer affect dispatch results", async () => {
    const throwing: DispatchObserver = {
      dispatchStarted() {
        throw new Error("started boom");
      },
      dispatchSettled() {
        throw new Error("settled boom");
      },
      effectSettled() {
        throw new Error("effect boom");
      },
      eventEmitted() {
        throw new Error("event boom");
      },
      subscriberFailed() {
        throw new Error("subscriber boom");
      },
    };
    const observed = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
      observer: throwing,
      subscribers: [
        subscription(EntityCreated, () => {
          throw new Error("projection boom");
        }),
      ],
    });
    const plain = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
    });

    const input = { id: "e1", value: "v" };
    const observedResult = await observed.dispatch("entities.create", { input });
    const plainResult = await plain.dispatch("entities.create", { input });
    expect(observedResult).toEqual(plainResult);
    expect(observedResult.kind).toBe("completed");
  });

  it("logs throwing observers with console.error in development mode only", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer: DispatchObserver = {
      dispatchStarted() {
        throw new Error("boom");
      },
    };

    const testApp = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
      observer,
    });
    await testApp.dispatch("entities.create", { input: { id: "a", value: "v" } });
    expect(consoleError).not.toHaveBeenCalled();

    const devApp = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "development",
      observer,
    });
    await devApp.dispatch("entities.create", { input: { id: "b", value: "v" } });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("observes call()-driven dispatches too", async () => {
    const names: string[] = [];
    const app = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
      observer: {
        dispatchStarted(ctx) {
          names.push(`started:${ctx.operationId}`);
          return undefined;
        },
        dispatchSettled(ctx) {
          names.push(`settled:${ctx.kind}`);
        },
      },
    });
    await app.call("entities.create", { id: "e1", value: "v" });
    expect(names).toEqual(["started:entities.create", "settled:completed"]);
  });
});

describe("observer hot path", () => {
  it("performs no hrtime reads when no observer is configured", async () => {
    const bigintSpy = vi.spyOn(process.hrtime, "bigint");
    const app = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
    });
    bigintSpy.mockClear();
    const result = await app.dispatch("entities.create", {
      input: { id: "e1", value: "v" },
    });
    expect(result.kind).toBe("completed");
    expect(bigintSpy).not.toHaveBeenCalled();

    // With a settled observer configured the same dispatch DOES read the clock.
    const observed = createApplication({
      features: [entities],
      adapters: [makeRecords()],
      mode: "test",
      observer: { dispatchSettled: () => {} },
    });
    bigintSpy.mockClear();
    await observed.dispatch("entities.create", { input: { id: "e2", value: "v" } });
    expect(bigintSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    bigintSpy.mockRestore();
  });

  it("reuses the shared signal singleton and adapter call options across dispatches", async () => {
    const seenSignals: AbortSignal[] = [];
    const seenOptions: unknown[] = [];
    const Probe = port("probe", {
      read: port.read({ input: s.object({}), output: s.literal(true) }),
    });
    const probed = feature("probed", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { read: Probe.read },
          async execute({ effects, signal }) {
            seenSignals.push(signal);
            return effects.read({});
          },
        }),
      },
    });
    const adapter = Probe.adapter({
      read: (_input, options) => {
        seenOptions.push(options);
        return true;
      },
    });
    const app = createApplication({
      features: [probed],
      adapters: [adapter],
      mode: "test",
    });

    await app.dispatch("probed.run", { input: {} });
    await app.dispatch("probed.run", { input: {} });

    // Identity across dispatches proves nothing was allocated per call.
    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBe(seenSignals[1]);
    expect(seenSignals[0]?.aborted).toBe(false);
    expect(seenOptions).toHaveLength(2);
    expect(seenOptions[0]).toBe(seenOptions[1]);
    expect((seenOptions[0] as { signal: AbortSignal }).signal).toBe(seenSignals[0]);
  });
});
