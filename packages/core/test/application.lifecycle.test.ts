import { describe, expect, it } from "vitest";

import {
  command,
  createApplication,
  feature,
  port,
  s,
} from "../src/index.js";

const PortA = port("portA", {
  ping: port.read({ input: s.object({}), output: s.literal(true) }),
});
const PortB = port("portB", {
  ping: port.read({ input: s.object({}), output: s.literal(true) }),
});

const lifecycleFeature = feature("life", {
  operations: {
    ping: command({
      input: s.object({}),
      output: s.literal(true),
      effects: { a: PortA.ping, b: PortB.ping },
      async execute({ effects }) {
        await effects.a({});
        await effects.b({});
        return true as const;
      },
    }),
  },
});

const makeApp = (log: string[]) => {
  const adapterA = PortA.adapter(
    { ping: () => true },
    {
      init: async () => {
        log.push("init:A");
      },
      dispose: async () => {
        log.push("dispose:A");
      },
    },
  );
  const adapterB = PortB.adapter(
    { ping: () => true },
    {
      init: () => {
        log.push("init:B");
      },
      dispose: () => {
        log.push("dispose:B");
      },
    },
  );
  return createApplication({
    features: [lifecycleFeature],
    adapters: [adapterA, adapterB],
    mode: "test",
  });
};

describe("application lifecycle", () => {
  it("start() runs inits in registration order and returns the app; close() disposes in reverse", async () => {
    const log: string[] = [];
    const app = makeApp(log);
    expect(log).toEqual([]); // createApplication does NOT auto-start

    const started = await app.start();
    expect(started).toBe(app);
    expect(log).toEqual(["init:A", "init:B"]);

    await app.close();
    expect(log).toEqual(["init:A", "init:B", "dispose:B", "dispose:A"]);
  });

  it("start() and close() are idempotent (including concurrent calls)", async () => {
    const log: string[] = [];
    const app = makeApp(log);
    await Promise.all([app.start(), app.start()]);
    await app.start();
    expect(log).toEqual(["init:A", "init:B"]);

    await Promise.all([app.close(), app.close()]);
    await app.close();
    expect(log).toEqual(["init:A", "init:B", "dispose:B", "dispose:A"]);
  });

  it("dispatch after close() faults with APPLICATION_CLOSED", async () => {
    const log: string[] = [];
    const app = makeApp(log);
    await app.start();

    const before = await app.dispatch("life.ping", { input: {} });
    expect(before.kind).toBe("completed");

    await app.close();
    const after = await app.dispatch("life.ping", { input: {} });
    expect(after).toMatchObject({
      kind: "fault",
      operationId: "life.ping",
      error: { code: "APPLICATION_CLOSED" },
    });

    await expect(app.start()).rejects.toThrow(/closed/);
  });

  it("adapters without hooks work with start/close (Port.memory needs none)", async () => {
    const Note = s.object({ id: s.string({ min: 1 }), title: s.string() });
    const NoteStore = port.store("lifeNotes", Note);
    const noteFeature = feature("lifeNoteOps", {
      operations: {
        create: command({
          input: Note,
          output: Note,
          effects: { save: NoteStore.save },
          async execute({ input, effects }) {
            return effects.save(input);
          },
        }),
      },
    });
    const app = createApplication({
      features: [noteFeature],
      adapters: [NoteStore.memory()],
      mode: "test",
    });
    await app.start();
    const result = await app.dispatch("lifeNoteOps.create", {
      input: { id: "n1", title: "t" },
    });
    expect(result.kind).toBe("completed");
    await app.close();
  });

  it("close() disposes even when start() never ran", async () => {
    const log: string[] = [];
    const app = makeApp(log);
    await app.close();
    expect(log).toEqual(["dispose:B", "dispose:A"]);
  });

  it("a failed start() propagates and may be retried", async () => {
    const log: string[] = [];
    let failures = 1;
    const flaky = PortA.adapter(
      { ping: () => true },
      {
        init: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("init boom");
          }
          log.push("init:A");
        },
      },
    );
    const app = createApplication({
      features: [
        feature("flaky", {
          operations: {
            ping: command({
              input: s.object({}),
              output: s.literal(true),
              effects: { a: PortA.ping },
              async execute({ effects }) {
                return effects.a({});
              },
            }),
          },
        }),
      ],
      adapters: [flaky],
      mode: "test",
    });

    await expect(app.start()).rejects.toThrow("init boom");
    await app.start(); // retry succeeds
    expect(log).toEqual(["init:A"]);
  });

  it("close() during an in-flight start() awaits init before disposing; that start() rejects", async () => {
    const log: string[] = [];
    let initFinished = false;
    const adapter = PortA.adapter(
      { ping: () => true },
      {
        init: async () => {
          log.push("init-start");
          await new Promise((resolve) => setTimeout(resolve, 30));
          initFinished = true;
          log.push("init-end");
        },
        dispose: () => {
          log.push(`dispose-start:init-finished=${initFinished}`);
        },
      },
    );
    const app = createApplication({
      features: [
        feature("race", {
          operations: {
            ping: command({
              input: s.object({}),
              output: s.literal(true),
              effects: { a: PortA.ping },
              async execute({ effects }) {
                return effects.a({});
              },
            }),
          },
        }),
      ],
      adapters: [adapter],
      mode: "test",
    });

    const pendingStart = app.start();
    // An in-flight start() must not resolve successfully on a closed app.
    const startRejected = expect(pendingStart).rejects.toThrow(/closed/);
    await new Promise((resolve) => setTimeout(resolve, 5)); // init is mid-flight
    await app.close();
    // Dispose never ran concurrently with init: close() awaited it first.
    expect(log).toEqual(["init-start", "init-end", "dispose-start:init-finished=true"]);
    await startRejected;

    // Dispatches on the closed app fault as usual.
    const result = await app.dispatch("race.ping", { input: {} });
    expect(result).toMatchObject({ kind: "fault", error: { code: "APPLICATION_CLOSED" } });
  });

  it("close() during an in-flight FAILING start() still disposes; start() keeps its init error", async () => {
    const log: string[] = [];
    const adapter = PortA.adapter(
      { ping: () => true },
      {
        init: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("init boom");
        },
        dispose: () => {
          log.push("dispose");
        },
      },
    );
    const app = createApplication({
      features: [
        feature("raceFail", {
          operations: {
            ping: command({
              input: s.object({}),
              output: s.literal(true),
              effects: { a: PortA.ping },
              async execute({ effects }) {
                return effects.a({});
              },
            }),
          },
        }),
      ],
      adapters: [adapter],
      mode: "test",
    });

    const pendingStart = app.start();
    const startRejected = expect(pendingStart).rejects.toThrow("init boom");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.close(); // swallows the init rejection; the failed init is still disposed
    expect(log).toEqual(["dispose"]);
    await startRejected;
  });

  it("close() does not drain in-flight dispatches (documented: hosts drain first)", async () => {
    const log: string[] = [];
    const adapter = PortA.adapter(
      {
        ping: async () => {
          log.push("effect-start");
          await new Promise((resolve) => setTimeout(resolve, 30));
          log.push("effect-end");
          return true as const;
        },
      },
      {
        dispose: () => {
          log.push("dispose");
        },
      },
    );
    const app = createApplication({
      features: [
        feature("drain", {
          operations: {
            ping: command({
              input: s.object({}),
              output: s.literal(true),
              effects: { a: PortA.ping },
              async execute({ effects }) {
                return effects.a({});
              },
            }),
          },
        }),
      ],
      adapters: [adapter],
      mode: "test",
    });
    await app.start();

    const pending = app.dispatch("drain.ping", { input: {} });
    await new Promise((resolve) => setTimeout(resolve, 5)); // effect is mid-flight
    await app.close();
    // Dispose ran while the effect was still in flight; close() resolved first.
    expect(log).toEqual(["effect-start", "dispose"]);

    const result = await pending; // the in-flight dispatch still settles normally
    expect(result.kind).toBe("completed");
    expect(log).toEqual(["effect-start", "dispose", "effect-end"]);
  });

  it("close() keeps disposing after a throwing dispose and reports an AggregateError", async () => {
    const log: string[] = [];
    const adapterA = PortA.adapter(
      { ping: () => true },
      {
        dispose: () => {
          log.push("dispose:A");
        },
      },
    );
    const adapterB = PortB.adapter(
      { ping: () => true },
      {
        dispose: () => {
          throw new Error("dispose boom");
        },
      },
    );
    const app = createApplication({
      features: [lifecycleFeature],
      adapters: [adapterA, adapterB],
      mode: "test",
    });

    await expect(app.close()).rejects.toBeInstanceOf(AggregateError);
    // B threw first (reverse order), A was still disposed.
    expect(log).toEqual(["dispose:A"]);
    // The app is closed regardless of the dispose failure.
    const result = await app.dispatch("life.ping", { input: {} });
    expect(result).toMatchObject({ kind: "fault", error: { code: "APPLICATION_CLOSED" } });
    // Idempotent: the second close() reports the same rejection.
    await expect(app.close()).rejects.toBeInstanceOf(AggregateError);
  });
});
