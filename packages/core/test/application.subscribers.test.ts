import { describe, expect, it, vi } from "vitest";

import {
  command,
  createApplication,
  event,
  feature,
  s,
  subscription,
  type DispatchObserver,
  type Subscription,
} from "../src/index.js";

const Payload = s.object({ id: s.string({ min: 1 }) });

const FirstEvent = event("subs.first", 1, Payload);
const SecondEvent = event("subs.second", 1, Payload);

const flows = feature("flows", {
  operations: {
    emitBoth: command({
      input: Payload,
      output: s.literal(true),
      emits: { first: FirstEvent, second: SecondEvent },
      async execute({ input, emit }) {
        emit.first({ id: input.id });
        emit.second({ id: input.id });
        return true as const;
      },
    }),
    emitNone: command({
      input: Payload,
      output: s.literal(true),
      async execute() {
        return true as const;
      },
    }),
  },
});

const makeApp = (
  subscribers: readonly Subscription[],
  options?: { mode?: "test" | "development"; observer?: DispatchObserver },
) =>
  createApplication({
    features: [flows],
    mode: options?.mode ?? "test",
    subscribers,
    ...(options?.observer === undefined ? {} : { observer: options.observer }),
  });

describe("event subscribers", () => {
  it("delivers sequentially: emission order, then registration order, awaited", async () => {
    const order: string[] = [];
    let firstHandlerDone = false;
    const app = makeApp([
      subscription(SecondEvent, async ({ id }) => {
        order.push(`second-a:${id}`);
      }),
      subscription(FirstEvent, async ({ id }) => {
        // Async gap: later handlers must still wait for this one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        firstHandlerDone = true;
        order.push(`first-a:${id}`);
      }),
      subscription(FirstEvent, ({ id }) => {
        expect(firstHandlerDone).toBe(true); // strictly sequential
        order.push(`first-b:${id}`);
      }),
    ]);

    const result = await app.dispatch("flows.emitBoth", { input: { id: "e1" } });
    expect(result.kind).toBe("completed");
    // Events in emission order; same-event subscribers in registration order.
    expect(order).toEqual(["first-a:e1", "first-b:e1", "second-a:e1"]);
  });

  it("awaits delivery before dispatch resolves and passes ctx.operationId", async () => {
    let seenContext: { operationId: string } | undefined;
    let delivered = false;
    const app = makeApp([
      subscription(FirstEvent, async (_payload, context) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seenContext = context;
        delivered = true;
      }),
    ]);
    await app.dispatch("flows.emitBoth", { input: { id: "e1" } });
    expect(delivered).toBe(true); // resolved only after the handler finished
    expect(seenContext).toEqual({ operationId: "flows.emitBoth" });
  });

  it("passes the validated, detached event payload", async () => {
    const payloads: Array<{ id: string }> = [];
    const app = makeApp([
      subscription(FirstEvent, (payload) => {
        payloads.push(payload);
      }),
    ]);
    const result = await app.dispatch("flows.emitBoth", { input: { id: "e1" } });
    expect(payloads).toEqual([{ id: "e1" }]);
    if (result.kind === "completed") {
      // Same detached snapshot the result carries.
      expect(payloads[0]).toBe(result.events[0]?.payload);
    }
  });

  it("isolates handler errors: dispatch stays completed with its events", async () => {
    const after: string[] = [];
    const app = makeApp([
      subscription(FirstEvent, () => {
        throw new Error("projection exploded");
      }),
      subscription(FirstEvent, () => {
        after.push("still-runs");
      }),
    ]);
    const result = await app.dispatch("flows.emitBoth", { input: { id: "e1" } });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.outcome).toEqual({ ok: true, value: true });
      expect(result.events.map((entry) => entry.eventId)).toEqual([
        "subs.first",
        "subs.second",
      ]);
    }
    expect(after).toEqual(["still-runs"]); // later subscribers unaffected
  });

  it("reports failures through observer.subscriberFailed with the token", async () => {
    const failures: Array<Record<string, unknown>> = [];
    const token = { span: "s1" };
    const boom = new Error("projection exploded");
    const app = makeApp(
      [
        subscription(FirstEvent, () => {
          throw boom;
        }),
      ],
      {
        observer: {
          dispatchStarted: () => token,
          subscriberFailed(ctx) {
            failures.push({ ...ctx });
          },
        },
      },
    );
    const result = await app.dispatch("flows.emitBoth", { input: { id: "e1" } });
    expect(result.kind).toBe("completed");
    expect(failures).toEqual([
      {
        operationId: "flows.emitBoth",
        eventId: "subs.first",
        error: boom,
        token,
      },
    ]);
  });

  it("falls back to console.error in development mode when no observer handles it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = [
      subscription(FirstEvent, () => {
        throw new Error("boom");
      }),
    ];

    const testApp = makeApp(failing, { mode: "test" });
    await testApp.dispatch("flows.emitBoth", { input: { id: "e1" } });
    expect(consoleError).not.toHaveBeenCalled();

    const devApp = makeApp(failing, { mode: "development" });
    await devApp.dispatch("flows.emitBoth", { input: { id: "e2" } });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("skips delivery when no events were emitted or the dispatch did not complete", async () => {
    const calls: string[] = [];
    const app = makeApp([
      subscription(FirstEvent, () => {
        calls.push("first");
      }),
    ]);

    await app.dispatch("flows.emitNone", { input: { id: "e1" } });
    expect(calls).toEqual([]);

    const rejected = await app.dispatch("flows.emitBoth", {
      input: { id: "" }, // fails min-length input validation
    });
    expect(rejected.kind).toBe("rejected");
    expect(calls).toEqual([]);
  });

  it("supports dispatching from a subscriber: nested dispatches run sequentially, awaited", async () => {
    const order: string[] = [];
    const failures: string[] = [];
    let depth = 0;
    let app: ReturnType<typeof makeApp>;
    const subscribers: Subscription[] = [
      subscription(FirstEvent, ({ id }) => {
        order.push(`thrower:${id}`);
        throw new Error("sync-boom"); // reported, never faults any dispatch
      }),
      subscription(FirstEvent, async ({ id }) => {
        order.push(`nested-start:${id}`);
        // Reentrant dispatch of a DIFFERENT operation from a subscriber.
        const nested = await app.dispatch("flows.emitNone", { input: { id: "n" } });
        order.push(`nested-end:${id}:${nested.kind}`);
      }),
      subscription(SecondEvent, async ({ id }) => {
        depth += 1;
        order.push(`recurse:${depth}:${id}`);
        // Reentrant dispatch of the SAME event-emitting operation, bounded.
        if (depth < 3) {
          await app.dispatch("flows.emitBoth", { input: { id: `d${depth}` } });
        }
      }),
    ];
    app = makeApp(subscribers, {
      observer: {
        subscriberFailed: ({ error }) => {
          failures.push((error as Error).message);
        },
      },
    });

    const result = await app.dispatch("flows.emitBoth", { input: { id: "root" } });
    expect(result.kind).toBe("completed");
    // Nested dispatches (including THEIR subscriber deliveries) are awaited
    // sequentially before the outer dispatch resolves — bounded recursion
    // terminates, deliveries never interleave.
    expect(order).toEqual([
      "thrower:root",
      "nested-start:root",
      "nested-end:root:completed",
      "recurse:1:root",
      "thrower:d1",
      "nested-start:d1",
      "nested-end:d1:completed",
      "recurse:2:d1",
      "thrower:d2",
      "nested-start:d2",
      "nested-end:d2:completed",
      "recurse:3:d2",
    ]);
    expect(failures).toEqual(["sync-boom", "sync-boom", "sync-boom"]);
  });

  it("rejects subscriber entries not built with subscription()", () => {
    expect(() =>
      createApplication({
        features: [flows],
        mode: "test",
        subscribers: [{ event: FirstEvent, handler: () => {} } as never],
      }),
    ).toThrow(TypeError);
  });
});
