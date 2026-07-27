import { describe, expect, it } from "vitest";

import {
  command,
  createApplication,
  event,
  feature,
  port,
  s,
  subscription,
} from "../src/index.js";

const Value = s.object({ id: s.string({ min: 1 }) });

const Steps = port("steps", {
  first: port.read({ input: s.object({}), output: s.literal(true) }),
  second: port.read({ input: s.object({}), output: s.literal(true) }),
});

const Finished = event("cancellation.finished", 1, Value);

const makeApp = (adapter: ReturnType<typeof Steps.adapter>, extras?: {
  subscribers?: Parameters<typeof createApplication>[0]["subscribers"];
}) =>
  createApplication({
    features: [
      feature("flow", {
        operations: {
          run: command({
            input: Value,
            output: s.literal(true),
            effects: { first: Steps.first, second: Steps.second },
            emits: { finished: Finished },
            async execute({ input, effects, emit }) {
              await effects.first({});
              await effects.second({});
              emit.finished({ id: input.id });
              return true as const;
            },
          }),
        },
      }),
    ],
    adapters: [adapter],
    mode: "test",
    ...(extras?.subscribers === undefined ? {} : { subscribers: extras.subscribers }),
  });

describe("dispatch cancellation", () => {
  it("faults with DISPATCH_ABORTED before input parse when already aborted", async () => {
    const calls: string[] = [];
    const adapter = Steps.adapter({
      first: () => {
        calls.push("first");
        return true;
      },
      second: () => {
        calls.push("second");
        return true;
      },
    });
    const app = makeApp(adapter);
    const controller = new AbortController();
    controller.abort();

    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      kind: "fault",
      operationId: "flow.run",
      error: { code: "DISPATCH_ABORTED" },
    });
    expect(calls).toEqual([]); // no adapter ever ran
  });

  it("faults with DISPATCH_ABORTED between effects and skips the next adapter", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const adapter = Steps.adapter({
      first: () => {
        calls.push("first");
        controller.abort(); // aborts while the first effect is in flight
        return true;
      },
      second: () => {
        calls.push("second");
        return true;
      },
    });
    const app = makeApp(adapter);

    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
      trace: true,
    });
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "DISPATCH_ABORTED" },
    });
    expect(calls).toEqual(["first"]);
    // The aborted second effect is visible in the trace as a fault entry.
    expect(result.trace?.at(-1)).toMatchObject({
      type: "effect",
      alias: "second",
      status: "fault",
      error: { code: "DISPATCH_ABORTED" },
    });
  });

  it("faults with DISPATCH_ABORTED when aborted after execution, before ensures", async () => {
    const controller = new AbortController();
    const adapter = Steps.adapter({
      first: () => true,
      second: () => {
        // Last effect completes, then the dispatch aborts before settling.
        controller.abort();
        return true;
      },
    });
    const app = makeApp(adapter);
    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
    });
    // The final checkpoint (before output validation/ensures) still observes it.
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "DISPATCH_ABORTED" },
    });
  });

  it("ignores aborts once the dispatch completed", async () => {
    const adapter = Steps.adapter({ first: () => true, second: () => true });
    const app = makeApp(adapter);
    const controller = new AbortController();
    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
    });
    expect(result.kind).toBe("completed");
    controller.abort(); // too late: nothing to retract
    expect(result.kind).toBe("completed");
  });

  it("ignores aborts fired during post-completion subscriber delivery", async () => {
    const controller = new AbortController();
    const delivered: string[] = [];
    const adapter = Steps.adapter({ first: () => true, second: () => true });
    const app = makeApp(adapter, {
      subscribers: [
        subscription(Finished, (payload) => {
          controller.abort(); // operation already completed; must be ignored
          delivered.push(payload.id);
        }),
      ],
    });
    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
    });
    expect(delivered).toEqual(["x"]);
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.events).toHaveLength(1);
    }
  });

  it("faults DISPATCH_ABORTED when a signal-honoring adapter rejects on abort (no timeout)", async () => {
    const controller = new AbortController();
    const adapter = Steps.adapter({
      first: (_input, { signal }) =>
        new Promise<true>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
          setTimeout(() => controller.abort(), 5); // abort while in flight
        }),
      second: () => true,
    });
    const app = makeApp(adapter);

    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
    });
    // The cooperating adapter's AbortError maps to DISPATCH_ABORTED, not the
    // EFFECT_FAILURE "application defect" bucket.
    expect(result).toMatchObject({
      kind: "fault",
      operationId: "flow.run",
      error: { code: "DISPATCH_ABORTED" },
    });
  });

  it("keeps EFFECT_FAILURE for adapter failures when the dispatch signal is not aborted", async () => {
    const controller = new AbortController();
    const adapter = Steps.adapter({
      first: () => {
        throw new Error("plain adapter boom");
      },
      second: () => true,
    });
    const app = makeApp(adapter);
    const result = await app.dispatch("flow.run", {
      input: { id: "x" },
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "EFFECT_FAILURE", effectId: "steps.first" },
    });
  });

  it("hands the dispatch signal to adapters as the optional second argument", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const adapter = Steps.adapter({
      first: (_input, { signal }) => {
        seen = signal;
        return true;
      },
      second: () => true,
    });
    const app = makeApp(adapter);
    await app.dispatch("flow.run", { input: { id: "x" }, signal: controller.signal });
    expect(seen).toBe(controller.signal); // no timeout: the dispatch signal itself
  });
});

describe("effect timeouts", () => {
  const Timed = port("timed", {
    slow: port.external({
      input: s.object({}),
      output: s.literal(true),
      timeoutMs: 25,
    }),
  });

  const timedApp = (
    impl: (input: unknown, options: { signal: AbortSignal }) => Promise<true> | true,
  ) =>
    createApplication({
      features: [
        feature("timedFlow", {
          operations: {
            run: command({
              input: s.object({}),
              output: s.literal(true),
              effects: { slow: Timed.slow },
              async execute({ effects }) {
                await effects.slow({});
                return true as const;
              },
            }),
          },
        }),
      ],
      adapters: [Timed.adapter({ slow: impl })],
      mode: "test",
    });

  it("faults with EFFECT_TIMEOUT and aborts the adapter's signal", async () => {
    let adapterSignal: AbortSignal | undefined;
    let adapterAborted = false;
    const app = timedApp(
      (_input, { signal }) =>
        new Promise<true>((resolve) => {
          adapterSignal = signal;
          signal.addEventListener("abort", () => {
            adapterAborted = true;
            resolve(true); // resolves late; the dispatch already timed out
          });
        }),
    );

    const result = await app.dispatch("timedFlow.run", { input: {}, trace: true });
    expect(result).toMatchObject({
      kind: "fault",
      operationId: "timedFlow.run",
      error: { code: "EFFECT_TIMEOUT", effectId: "timed.slow" },
    });
    expect(adapterAborted).toBe(true);
    expect(adapterSignal?.aborted).toBe(true);
    expect(result.trace?.at(-1)).toMatchObject({
      type: "effect",
      effectId: "timed.slow",
      status: "fault",
      error: { code: "EFFECT_TIMEOUT" },
    });
  });

  it("swallows a late adapter rejection after the timeout fired", async () => {
    const app = timedApp(
      (_input, { signal }) =>
        new Promise<true>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("late abort throw"));
          });
        }),
    );
    const result = await app.dispatch("timedFlow.run", { input: {} });
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "EFFECT_TIMEOUT" },
    });
    // Give the abandoned rejection a tick; an unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("completes normally when the adapter beats the timeout", async () => {
    const app = timedApp((_input, { signal }) => {
      expect(signal.aborted).toBe(false);
      return true;
    });
    const result = await app.dispatch("timedFlow.run", { input: {} });
    expect(result.kind).toBe("completed");
  });

  it("propagates a dispatch abort to the timeout-linked adapter signal", async () => {
    const controller = new AbortController();
    const Long = port("long", {
      slow: port.external({
        input: s.object({}),
        output: s.literal(true),
        timeoutMs: 5_000, // never reached in this test
      }),
    });
    let seenDispatchSignal = false;
    const adapter = Long.adapter({
      slow: (_input, { signal }) =>
        new Promise<true>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            seenDispatchSignal = true;
            reject(new Error("aborted by dispatch"));
          });
          controller.abort();
        }),
    });
    const app = createApplication({
      features: [
        feature("longFlow", {
          operations: {
            run: command({
              input: s.object({}),
              output: s.literal(true),
              effects: { slow: Long.slow },
              async execute({ effects }) {
                await effects.slow({});
                return true as const;
              },
            }),
          },
        }),
      ],
      adapters: [adapter],
      mode: "test",
    });

    const result = await app.dispatch("longFlow.run", {
      input: {},
      signal: controller.signal,
    });
    // A signal-honoring adapter failing under an aborted dispatch signal is
    // cooperation, not an application defect: DISPATCH_ABORTED, never
    // EFFECT_FAILURE.
    expect(result).toMatchObject({
      kind: "fault",
      error: { code: "DISPATCH_ABORTED" },
    });
    expect(seenDispatchSignal).toBe(true);
  });

  it("links a fresh signal per timeout-guarded call (unlike untimed effects)", async () => {
    // Untimed effects receive the dispatch signal or the shared singleton
    // (identity-asserted in application.observer.test.ts); timeout-guarded
    // calls get a fresh linked signal every time.
    const seen: AbortSignal[] = [];
    const app = timedApp((_input, { signal }) => {
      seen.push(signal);
      return true;
    });
    await app.dispatch("timedFlow.run", { input: {} });
    await app.dispatch("timedFlow.run", { input: {} });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
