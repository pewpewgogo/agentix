import { describe, expect, it } from "vitest";

import {
  command,
  createApplication,
  event,
  feature,
  port,
  query,
  s,
  type ParseResult,
  type RuntimeMode,
  type Schema,
  type SchemaDescription,
} from "../src/index.js";

const emptyObjectDescription: SchemaDescription = Object.freeze({
  type: "object",
  fields: Object.freeze({}),
});

const throwingSchema = <T>(message: string): Schema<T> =>
  Object.freeze({
    description: emptyObjectDescription,
    parse(): T {
      throw new Error(message);
    },
    safeParse(): never {
      throw new Error(message);
    },
  });

const passthroughSchema = <T>(): Schema<T> =>
  Object.freeze({
    description: emptyObjectDescription,
    parse: (value: unknown): T => value as T,
    safeParse: (value: unknown): ParseResult<T> => ({
      success: true,
      data: value as T,
    }),
  });

describe("effect boundaries", () => {
  const Reader = port("reader", {
    read: port.read({
      input: s.object({ key: s.string() }),
      output: s.number(),
    }),
  });

  it("guards and traces invalid effect inputs without calling the adapter", async () => {
    let calls = 0;
    const invalid = feature("effects-input", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { read: Reader.read },
          async execute({ effects }) {
            await effects.read({ key: 1 } as never);
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [invalid],
      adapters: [
        Reader.adapter({
          read: () => {
            calls += 1;
            return 42;
          },
        }),
      ],
      mode: "test",
    });

    const result = await app.dispatch("effects-input.run", { input: {}, trace: true });
    expect(result).toMatchObject({
      kind: "fault",
      error: {
        code: "INVALID_EFFECT_INPUT",
        effectId: "reader.read",
        issues: [{ path: ["key"] }],
      },
      trace: [{ type: "effect", status: "fault", effectId: "reader.read" }],
    });
    expect(calls).toBe(0);
  });

  it("re-parses adapter outputs in dev/test but skips ONLY that re-parse in production", async () => {
    const makeApp = (mode: RuntimeMode) => {
      const flaky = feature("flaky", {
        operations: {
          run: command({
            input: s.object({}),
            output: s.literal(true),
            effects: { read: Reader.read },
            async execute({ effects }) {
              const value = await effects.read({ key: "k" });
              expect(value).toBe("not-a-number" as unknown as number);
              return true as const;
            },
          }),
        },
      });
      return createApplication({
        features: [flaky],
        adapters: [Reader.adapter({ read: () => "not-a-number" as never })],
        mode,
      });
    };

    for (const mode of ["development", "test"] as const) {
      await expect(makeApp(mode).dispatch("flaky.run", { input: {}, trace: true }))
        .resolves.toMatchObject({
          kind: "fault",
          error: { code: "INVALID_EFFECT_OUTPUT", effectId: "reader.read" },
          trace: [{ type: "effect", status: "fault" }],
        });
    }

    // Effect INPUT parsing is kept in ALL modes; only the output re-parse is
    // skipped in production, so the raw adapter value flows through.
    await expect(makeApp("production").dispatch("flaky.run", { input: {} }))
      .resolves.toMatchObject({ kind: "completed", outcome: { ok: true } });
  });

  it("keeps effect input validation in production", async () => {
    const invalid = feature("prod-effect-input", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { read: Reader.read },
          async execute({ effects }) {
            await effects.read({ key: 1 } as never);
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [invalid],
      adapters: [Reader.adapter({ read: () => 1 })],
      mode: "production",
    });
    await expect(app.dispatch("prod-effect-input.run", { input: {} }))
      .resolves.toMatchObject({
        kind: "fault",
        error: { code: "INVALID_EFFECT_INPUT" },
      });
  });

  it("faults with EFFECT_FAILURE when an adapter throws", async () => {
    const boom = feature("boom", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { read: Reader.read },
          async execute({ effects }) {
            await effects.read({ key: "k" });
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [boom],
      adapters: [
        Reader.adapter({
          read: () => {
            throw new Error("kaboom");
          },
        }),
      ],
      mode: "test",
    });
    await expect(app.dispatch("boom.run", { input: {}, trace: true }))
      .resolves.toMatchObject({
        kind: "fault",
        error: {
          code: "EFFECT_FAILURE",
          effectId: "reader.read",
          cause: expect.any(Error),
        },
        trace: [{ type: "effect", status: "fault", effectId: "reader.read" }],
      });
  });

  it("cannot turn caught effect boundary faults into success (latch survives trace-off)", async () => {
    const caught = feature("caught-effect", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { read: Reader.read },
          async execute({ effects }) {
            try {
              await effects.read({ key: 1 } as never);
            } catch {
              // A boundary fault is fatal even when application code catches it.
            }
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [caught],
      adapters: [Reader.adapter({ read: () => 42 })],
      mode: "test",
    });
    // Deliberately dispatched WITHOUT trace: the fault latch must not depend
    // on trace machinery.
    await expect(app.dispatch("caught-effect.run", { input: {} }))
      .resolves.toMatchObject({
        kind: "fault",
        error: { code: "INVALID_EFFECT_INPUT" },
      });
  });

  it("latches a custom effect input schema exception before code can catch it", async () => {
    let adapterCalls = 0;
    const Hostile = port("hostileInput", {
      read: port.read({
        input: throwingSchema<{ key: string }>("effect input schema exploded"),
        output: s.string(),
      }),
    });
    const operation = feature("hostile-effect-input", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { read: Hostile.read },
          async execute({ effects }) {
            try {
              await effects.read({ key: "caught" });
            } catch {
              // A hostile schema exception must still fault the dispatch.
            }
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [operation],
      adapters: [
        Hostile.adapter({
          read: () => {
            adapterCalls += 1;
            return "unreachable";
          },
        }),
      ],
      mode: "test",
    });

    await expect(
      app.dispatch("hostile-effect-input.run", { input: {}, trace: true }),
    ).resolves.toMatchObject({
      kind: "fault",
      error: {
        code: "INVALID_EFFECT_INPUT",
        effectId: "hostileInput.read",
        cause: expect.any(Error),
      },
      trace: [
        {
          type: "effect",
          status: "fault",
          effectId: "hostileInput.read",
          error: { code: "INVALID_EFFECT_INPUT" },
        },
      ],
    });
    expect(adapterCalls).toBe(0);
  });

  it("waits for started effects before completing dispatch", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let effectCompleted = false;
    const Deferred = port("deferred", {
      write: port.write({ input: s.object({}), output: s.literal(true) }),
    });
    const deferred = feature("deferred", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { write: Deferred.write },
          execute({ effects }) {
            void effects.write({});
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [deferred],
      adapters: [
        Deferred.adapter({
          async write() {
            await gate;
            effectCompleted = true;
            return true as const;
          },
        }),
      ],
      mode: "test",
    });
    let dispatchCompleted = false;
    const resultPromise = app
      .dispatch("deferred.run", { input: {} })
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
    const Delayed = port("delayedEffect", {
      write: port.write({
        input: s.object({ phase: s.string() }),
        output: s.literal(true),
      }),
    });
    const delayed = feature("delayed-effect", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { write: Delayed.write },
          execute({ effects }) {
            void effects.write({ phase: "started" });
            setTimeout(() => {
              void Promise.resolve(effects.write({ phase: "late" })).then(
                () => markLateAttempted?.(),
                () => markLateAttempted?.(),
              );
            }, 0);
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [delayed],
      adapters: [
        Delayed.adapter({
          async write({ phase }) {
            calls.push(phase);
            if (phase === "started") await hold;
            return true as const;
          },
        }),
      ],
      mode: "test",
    });

    const resultPromise = app.dispatch("delayed-effect.run", { input: {} });
    await lateAttempted;
    releaseHold?.();

    await expect(resultPromise).resolves.toMatchObject({
      kind: "fault",
      error: { code: "EFFECT_OUTSIDE_EXECUTION", effectId: "delayedEffect.write" },
    });
    expect(calls).toEqual(["started"]);
  });

  it("prevents a captured effect capability from running after execution", async () => {
    const calls: string[] = [];
    const Store = port("captureStore", {
      load: port.read({ input: s.string(), output: s.optional(s.string()) }),
    });
    let captured: ((id: string) => Promise<string | undefined>) | undefined;
    const capture = feature("capture", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { load: Store.load },
          execute({ effects }) {
            captured = effects.load;
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [capture],
      adapters: [
        Store.adapter({
          load: (id) => {
            calls.push(id);
            return undefined;
          },
        }),
      ],
      mode: "test",
    });

    await expect(app.dispatch("capture.run", { input: {} })).resolves.toMatchObject({
      kind: "completed",
    });
    expect(captured).toBeDefined();
    await expect(captured?.("late")).rejects.toThrow(/outside capture\.run/);
    expect(calls).toEqual([]);
  });
});

describe("event boundaries", () => {
  it("validates emitted payloads and separates unexpected exceptions", async () => {
    const BrokenEvent = event("broken.event", 1, s.object({ value: s.string() }));
    const broken = feature("broken", {
      operations: {
        emit: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { broken: BrokenEvent },
          execute({ emit }) {
            emit.broken({ value: 3 } as never);
            return true as const;
          },
        }),
        throw: command({
          input: s.object({}),
          output: s.literal(true),
          execute() {
            throw new Error("private details");
          },
        }),
      },
    });
    const app = createApplication({ features: [broken], mode: "test" });

    await expect(app.dispatch("broken.emit", { input: {} })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "INVALID_EVENT_PAYLOAD", eventId: "broken.event" },
    });
    await expect(app.dispatch("broken.throw", { input: {} })).resolves.toMatchObject({
      kind: "fault",
      error: { code: "EXECUTION_FAILED", cause: expect.any(Error) },
    });
  });

  it("cannot turn a caught event boundary fault into success", async () => {
    const CaughtEvent = event("caught.event", 1, s.object({ value: s.string() }));
    const caught = feature("caught-event", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { happened: CaughtEvent },
          execute({ emit }) {
            try {
              emit.happened({ value: 1 } as never);
            } catch {
              // A boundary fault is fatal even when application code catches it.
            }
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [caught], mode: "test" });
    await expect(app.dispatch("caught-event.run", { input: {} }))
      .resolves.toMatchObject({
        kind: "fault",
        error: { code: "INVALID_EVENT_PAYLOAD" },
      });
  });

  it("latches a custom event payload schema exception before code can catch it", async () => {
    const HostileEvent = event(
      "hostile-event-schema.happened",
      1,
      throwingSchema<{ value: string }>("event schema exploded"),
    );
    const operation = feature("hostile-event-schema", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { happened: HostileEvent },
          execute({ emit }) {
            try {
              emit.happened({ value: "caught" });
            } catch {
              // A hostile schema exception must still fault the dispatch.
            }
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [operation], mode: "test" });

    const result = await app.dispatch("hostile-event-schema.run", {
      input: {},
      trace: true,
    });
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
    const HostileEvent = event(
      "hostile-event-snapshot.happened",
      1,
      passthroughSchema<HostilePayload>(),
    );
    const payload = {} as HostilePayload;
    Object.defineProperty(payload, "value", {
      enumerable: true,
      get() {
        throw new Error("snapshot getter exploded");
      },
    });
    const operation = feature("hostile-event-snapshot", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { happened: HostileEvent },
          execute({ emit }) {
            try {
              emit.happened(payload);
            } catch {
              // Snapshot failures remain fatal boundary faults.
            }
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [operation], mode: "test" });

    const result = await app.dispatch("hostile-event-snapshot.run", {
      input: {},
      trace: true,
    });
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

  it("rejects a timer-delayed event while started effects are draining", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markLateAttempted: (() => void) | undefined;
    const lateAttempted = new Promise<void>((resolve) => {
      markLateAttempted = resolve;
    });
    const Holding = port("delayedEventHold", {
      write: port.write({ input: s.object({}), output: s.literal(true) }),
    });
    const DelayedEvent = event(
      "delayed-event.happened",
      1,
      s.object({ value: s.string() }),
    );
    const delayed = feature("delayed-event", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          effects: { hold: Holding.write },
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
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({
      features: [delayed],
      adapters: [
        Holding.adapter({
          async write() {
            await hold;
            return true as const;
          },
        }),
      ],
      mode: "test",
    });

    const resultPromise = app.dispatch("delayed-event.run", { input: {} });
    await lateAttempted;
    releaseHold?.();

    const result = await resultPromise;
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "EVENT_OUTSIDE_EXECUTION", eventId: "delayed-event.happened" },
    });
    expect(result).not.toHaveProperty("events");
  });

  it("does not expose attempted events when execution later faults", async () => {
    const Created = event("attempted.created", 1, s.object({ id: s.string() }));
    const attempted = feature("attempted", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { created: Created },
          execute({ emit }) {
            emit.created({ id: "attempted" });
            throw new Error("after emit");
          },
        }),
      },
    });
    const app = createApplication({ features: [attempted], mode: "test" });

    const result = await app.dispatch("attempted.run", { input: {}, trace: true });
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "EXECUTION_FAILED" },
      trace: [{ type: "event", eventId: "attempted.created" }],
    });
    expect(result).not.toHaveProperty("events");
  });
});

describe("event snapshot semantics per mode", () => {
  const StructuredPayload = s.object({
    details: s.object({
      labels: s.array(s.object({ value: s.string() })),
    }),
  });
  const StructuredEvent = event("structured.published", 1, StructuredPayload);
  const publishFeature = feature("structured", {
    operations: {
      publish: command({
        input: StructuredPayload,
        output: s.literal(true),
        emits: { published: StructuredEvent },
        execute({ input, emit }) {
          emit.published(input);
          return true as const;
        },
      }),
    },
  });
  const input = { details: { labels: [{ value: "original" }] } };

  it("returns detached deeply frozen structured payloads in dev/test", async () => {
    const app = createApplication({ features: [publishFeature], mode: "test" });
    const result = await app.dispatch("structured.publish", { input });
    expect(result).toMatchObject({ kind: "completed", events: [{ payload: input }] });
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

  it("returns detached but UNFROZEN structured payloads in production (deliberate v2 change)", async () => {
    const app = createApplication({ features: [publishFeature], mode: "production" });
    const result = await app.dispatch("structured.publish", { input });
    expect(result).toMatchObject({ kind: "completed", events: [{ payload: input }] });
    expect(result).not.toHaveProperty("trace");
    if (result.kind !== "completed") return;

    const payload = result.events[0]?.payload as {
      details: { labels: Array<{ value: string }> };
    };
    expect(payload).not.toBe(input);
    expect(payload.details).not.toBe(input.details);
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(payload.details)).toBe(false);
    // Consumers may mutate their copy; the source input stays untouched.
    payload.details.labels.push({ value: "mutated" });
    expect(input.details.labels).toEqual([{ value: "original" }]);
  });

  it("preserves cycles and shared references in production snapshots", async () => {
    interface CyclicPayload {
      name: string;
      self?: CyclicPayload;
      shared: { value: string };
      duplicate: { value: string };
    }
    const CyclicEvent = event("cyclic.published", 1, passthroughSchema<CyclicPayload>());
    const shared = { value: "original" };
    const source: CyclicPayload = { name: "root", shared, duplicate: shared };
    source.self = source;
    const publish = feature("cyclic", {
      operations: {
        publish: command({
          input: s.object({}),
          output: s.literal(true),
          emits: { published: CyclicEvent },
          execute({ emit }) {
            emit.published(source);
            source.shared.value = "changed-after-emit";
            return true as const;
          },
        }),
      },
    });
    const app = createApplication({ features: [publish], mode: "production" });

    const result = await app.dispatch("cyclic.publish", { input: {} });
    if (result.kind !== "completed") throw new Error("Expected completed dispatch");
    const payload = result.events[0]?.payload as CyclicPayload;

    expect(payload).not.toBe(source);
    expect(payload.self).toBe(payload);
    expect(payload.shared).toBe(payload.duplicate);
    expect(payload.shared.value).toBe("original");
    expect(Object.isFrozen(payload)).toBe(false);
  });
});

describe("ensures invariants", () => {
  const makeEnsured = (
    mode: RuntimeMode,
    check: (context: { input: unknown; output: unknown }) => boolean,
  ) => {
    const ensured = feature("ensured", {
      operations: {
        run: command({
          input: s.object({ title: s.string({ trim: true }) }),
          output: s.string(),
          errors: { REFUSED: { http: 409 } },
          ensures: { titleEcho: { check } },
          async execute({ input, fail }) {
            if (input.title === "refuse") return fail("REFUSED");
            return input.title;
          },
        }),
      },
    });
    return createApplication({ features: [ensured], mode });
  };

  it("runs ensures on ok outcomes in dev/test and faults on violation", async () => {
    for (const mode of ["development", "test"] as const) {
      const app = makeEnsured(mode, ({ output }) => (output as string).length > 5);
      const result = await app.dispatch("ensured.run", { input: { title: "abc" } });
      expect(result).toMatchObject({
        kind: "fault",
        error: {
          code: "INVARIANT_VIOLATION",
          invariant: "titleEcho",
          message: expect.stringContaining("titleEcho"),
        },
      });

      const passing = await app.dispatch("ensured.run", {
        input: { title: "long enough" },
      });
      expect(passing.kind).toBe("completed");
    }
  });

  it("receives the parsed input and validated output", async () => {
    const seen: Array<{ input: unknown; output: unknown }> = [];
    const app = makeEnsured("test", (context) => {
      seen.push(context);
      return true;
    });
    await app.dispatch("ensured.run", { input: { title: "  padded  " } });
    // trim already applied: the check sees normalized values.
    expect(seen).toEqual([{ input: { title: "padded" }, output: "padded" }]);
  });

  it("treats a throwing ensure as INVARIANT_VIOLATION", async () => {
    const app = makeEnsured("test", () => {
      throw new Error("check exploded");
    });
    await expect(app.dispatch("ensured.run", { input: { title: "x" } }))
      .resolves.toMatchObject({
        kind: "fault",
        error: {
          code: "INVARIANT_VIOLATION",
          invariant: "titleEcho",
          cause: expect.any(Error),
        },
      });
  });

  it("does not run ensures on declared-error outcomes", async () => {
    let checks = 0;
    const app = makeEnsured("test", () => {
      checks += 1;
      return false;
    });
    const result = await app.dispatch("ensured.run", { input: { title: "refuse" } });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: { ok: false, error: { code: "REFUSED", details: {} } },
    });
    expect(checks).toBe(0);
  });

  it("skips ensures entirely in production", async () => {
    let checks = 0;
    const app = makeEnsured("production", () => {
      checks += 1;
      return false;
    });
    const result = await app.dispatch("ensured.run", { input: { title: "x" } });
    expect(result).toMatchObject({ kind: "completed", outcome: { ok: true } });
    expect(checks).toBe(0);
  });

  it("stores evidence schemas as metadata without executing them at runtime", async () => {
    let evidenceParses = 0;
    const evidence: Schema<{ length: number }> = Object.freeze({
      description: emptyObjectDescription,
      parse: (value: unknown) => {
        evidenceParses += 1;
        return value as { length: number };
      },
      safeParse: (value: unknown): ParseResult<{ length: number }> => {
        evidenceParses += 1;
        return { success: true, data: value as { length: number } };
      },
    });
    const ensured = feature("evidence", {
      operations: {
        run: command({
          input: s.object({}),
          output: s.string(),
          ensures: { hasEvidence: { evidence, check: () => true } },
          async execute() {
            return "value";
          },
        }),
      },
    });
    const app = createApplication({ features: [ensured], mode: "test" });
    const result = await app.dispatch("evidence.run", { input: {} });
    expect(result.kind).toBe("completed");
    expect(evidenceParses).toBe(0);
    expect(ensured.operations.run.ensures["hasEvidence"]?.evidence).toBe(evidence);
  });
});

describe("query effect access", () => {
  it("gives queries read effects and validates their optional outputs", async () => {
    const Store = port("queryStore", {
      find: port.read({ input: s.string(), output: s.optional(s.number()) }),
    });
    const lookup = feature("lookup", {
      operations: {
        find: query({
          input: s.object({ key: s.string() }),
          output: s.optional(s.number()),
          effects: { find: Store.find },
          async execute({ input, effects }) {
            return effects.find(input.key);
          },
        }),
      },
    });
    const app = createApplication({
      features: [lookup],
      adapters: [Store.adapter({ find: (key) => (key === "hit" ? 7 : undefined) })],
      mode: "test",
    });

    await expect(app.call("lookup.find", { key: "hit" })).resolves.toEqual({
      ok: true,
      value: 7,
    });
    await expect(app.call("lookup.find", { key: "miss" })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });
});
