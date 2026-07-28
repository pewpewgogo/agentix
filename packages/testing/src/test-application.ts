import {
  createApplication,
  type AdapterCallOptions,
  type AnyBoundOperation,
  type AnyFeature,
  type AnyPortOperation,
  type Application,
  type ApplicationOperations,
  type BoundPortAdapter,
  type DispatchObserver,
  type Principal,
  type RuntimeMode,
  type Subscription,
} from "@agentixdev/core";

import {
  createDeterministicClock,
  createDeterministicIdGenerator,
  type DeterministicClock,
  type DeterministicIdGenerator,
} from "./deterministic.js";
import type { RecordedEffectCall } from "./recording.js";

/**
 * Replacement handler for one auto-bound port operation, keyed by its id.
 * Mirrors the core AdapterHandler shape: the second argument carries the
 * effect signal, and single-argument handlers stay assignable.
 */
export type TestOverrideHandler = (
  input: never,
  options: AdapterCallOptions,
) => unknown;

export interface TestApplicationDefinition<
  Features extends readonly AnyFeature[],
> {
  readonly features: Features;
  /**
   * Real adapters; ports they cover are never faked. Their calls ARE
   * recorded: each adapter is wrapped transparently (see TestCallLog), and
   * its init/dispose lifecycle hooks are forwarded unchanged so
   * `started()`/`app.close()` reach them.
   */
  readonly adapters?: readonly BoundPortAdapter[];
  /**
   * Handlers keyed by port-operation id (`"portId.opKey"`, e.g.
   * `"noteStorage.get"`). They replace the derived fake for that operation.
   */
  readonly overrides?: Readonly<Record<string, TestOverrideHandler>>;
  /** Defaults to "test". */
  readonly mode?: RuntimeMode;
  readonly authorize?: (
    principal: Principal | undefined,
    operation: AnyBoundOperation,
  ) => boolean;
  /** Forwarded to createApplication verbatim (opt-in instrumentation). */
  readonly observer?: DispatchObserver;
  /** Forwarded to createApplication verbatim (in-process event subscribers). */
  readonly subscribers?: readonly Subscription[];
}

/**
 * Call log of every port operation the test application bound: auto-bound
 * fakes, overrides, AND user-supplied adapters (wrapped transparently — the
 * wrapper records and returns the handler's resolved value as the SAME
 * reference, so wrapping never alters adapter behavior).
 */
export interface TestCallLog {
  all(): readonly RecordedEffectCall[];
  /** Calls recorded for one port operation id, e.g. `"noteStorage.save"`. */
  of(effectId: string): readonly RecordedEffectCall[];
  reset(): void;
}

export interface TestApplication<Features extends readonly AnyFeature[]> {
  readonly app: Application<ApplicationOperations<Features>>;
  readonly calls: TestCallLog;
  /** Backs every auto-bound `time` operation; starts at 2000-01-01T00:00:00Z, +1s per call. */
  readonly clock: DeterministicClock<string>;
  /** Backs every auto-bound `random` operation; yields "id-1", "id-2", ... */
  readonly ids: DeterministicIdGenerator;
  /**
   * Awaits `app.start()` (running every user-supplied adapter `init` hook in
   * registration order) and resolves to this same harness, so tests can write
   * `const { app } = await createTestApplication({...}).started()`. Auto-bound
   * fakes need no hooks; `app.close()` runs the `dispose` hooks in reverse
   * order.
   */
  started(): Promise<TestApplication<Features>>;
  /**
   * Fresh-app semantics without rebuilding the app: clears every auto-bound
   * store's records, the recorded call log, and resets the deterministic
   * clock and id sequences to their initial values.
   *
   * IMPORTANT: reset() does NOT touch user-supplied adapter state. Adapters
   * you pass in own their state (a memory Map, a database connection, ...);
   * the harness only wraps them for call recording and cannot — and will
   * not — reset them. Rebuild the harness (or reset the adapter yourself)
   * when a user adapter must start fresh.
   */
  reset(): void;
}

// Structural store-detection heuristic, kept ONLY as a documented fallback.
// Detection now uses the exact `preset === "store"` tag that port.store()
// stamps on its four operations; a hand-built port that merely looks like a
// store (get/save/delete/list with read/write kinds) is NOT memory-faked.
// The retired heuristic was:
//   const STORE_OP_KINDS: Readonly<Record<string, "read" | "write">> =
//     Object.freeze({ get: "read", save: "write", delete: "write", list: "read" });
//   if (STORE_OP_KINDS[operation.opKey] === operation.kind) {
//     return storeHandler(operation);
//   }

const projectToOutput = (operation: AnyPortOperation, value: unknown): unknown => {
  const parsed = operation.output.safeParse(value);
  return parsed.success ? parsed.data : value;
};

const clockValueFor = (operation: AnyPortOperation, iso: string): unknown => {
  const parsed = operation.output.safeParse(iso);
  if (parsed.success) return parsed.data;
  // Some time ports want epoch milliseconds instead of an ISO string.
  const millis = new Date(iso).getTime();
  const parsedMillis = operation.output.safeParse(millis);
  return parsedMillis.success ? parsedMillis.data : iso;
};

type RecordableHandler = (
  input: unknown,
  options: AdapterCallOptions,
) => unknown;

/**
 * Builds an application where every port operation reachable from the given
 * features is bound: user adapters win (wrapped for call recording, hooks
 * forwarded); uncovered operations get recording fakes (`port.store` presets
 * -> in-memory Map, time -> deterministic clock, random -> deterministic
 * ids); anything else throws until overridden.
 */
export const createTestApplication = <
  const Features extends readonly AnyFeature[],
>(
  definition: TestApplicationDefinition<Features>,
): TestApplication<Features> => {
  const clock = createDeterministicClock({ stepMs: 1_000 });
  const ids = createDeterministicIdGenerator();

  const recorded: RecordedEffectCall[] = [];
  let nextSequence = 0;
  const record =
    (effectId: string, handler: RecordableHandler) =>
    async (input: unknown, options: AdapterCallOptions): Promise<unknown> => {
      const sequence = nextSequence;
      nextSequence += 1;
      try {
        // Transparent wrapping: `options` (with the effect signal) is passed
        // through unchanged, and the handler's resolved value is recorded and
        // returned as the SAME reference. A handler that rejects because its
        // signal aborted (timeoutMs / dispatch abort) is recorded as "threw"
        // at its original sequence position, even when it settles after the
        // dispatch already faulted.
        const output = await handler(input, options);
        recorded.push({ sequence, effectId, input, status: "returned", output });
        return output;
      } catch (error: unknown) {
        recorded.push({ sequence, effectId, input, status: "threw", error });
        throw error;
      }
    };

  /** Wraps a user adapter for call recording; identity and hooks preserved. */
  const wrapUserAdapter = (adapter: BoundPortAdapter): BoundPortAdapter => {
    const operations: Record<string, (input: never) => unknown> = {};
    for (const opKey of Object.keys(adapter.operations)) {
      const handler = adapter.operations[opKey] as unknown as RecordableHandler;
      operations[opKey] = record(
        `${adapter.portId}.${opKey}`,
        handler,
      ) as unknown as (input: never) => unknown;
    }
    return Object.freeze({
      descriptorType: "port-adapter" as const,
      portId: adapter.portId,
      operations: Object.freeze(operations),
      ...(adapter.init === undefined ? {} : { init: adapter.init }),
      ...(adapter.dispose === undefined ? {} : { dispose: adapter.dispose }),
    });
  };

  const coveredPorts = new Set<string>();
  for (const adapter of definition.adapters ?? []) {
    coveredPorts.add(adapter.portId);
  }

  // Every port operation reachable from operation effects, minus covered ports.
  const uncoveredByPort = new Map<string, Map<string, AnyPortOperation>>();
  const uncoveredOpIds = new Set<string>();
  const features: readonly AnyFeature[] = definition.features;
  for (const feature of features) {
    for (const key of Object.keys(feature.operations)) {
      const operation = feature.operations[key];
      if (operation === undefined) continue;
      for (const effect of Object.values(operation.effects)) {
        if (coveredPorts.has(effect.portId)) continue;
        let ops = uncoveredByPort.get(effect.portId);
        if (ops === undefined) {
          ops = new Map();
          uncoveredByPort.set(effect.portId, ops);
        }
        ops.set(effect.opKey, effect);
        uncoveredOpIds.add(effect.id);
      }
    }
  }

  const overrides = definition.overrides ?? {};
  for (const key of Object.keys(overrides)) {
    if (!uncoveredOpIds.has(key)) {
      const known = [...uncoveredOpIds]
        .sort()
        .map((id) => JSON.stringify(id))
        .join(", ");
      throw new TypeError(
        `createTestApplication override ${JSON.stringify(key)} does not match an auto-bound port operation. ` +
          (uncoveredOpIds.size === 0
            ? "Every reachable port operation is already covered by an adapter."
            : `Override keys must be one of: ${known}.`),
      );
    }
  }

  const stores = new Map<string, Map<unknown, unknown>>();
  const storeHandler = (
    operation: AnyPortOperation,
  ): ((input: unknown) => unknown) => {
    let records = stores.get(operation.portId);
    if (records === undefined) {
      records = new Map();
      stores.set(operation.portId, records);
    }
    const store = records;
    switch (operation.opKey) {
      case "get":
        return (key) => store.get(key);
      case "save":
        return (value) => {
          store.set((value as { readonly id: unknown }).id, value);
          return value;
        };
      case "delete":
        return (key) => store.delete(key);
      default:
        return () => [...store.values()];
    }
  };

  const fakeFor = (operation: AnyPortOperation): RecordableHandler => {
    const override = overrides[operation.id];
    if (override !== undefined) {
      return override as RecordableHandler;
    }
    if (operation.kind === "time") {
      return () => clockValueFor(operation, clock.now());
    }
    if (operation.kind === "random") {
      return () => projectToOutput(operation, ids.next());
    }
    // Exact detection: only operations minted by port.store() carry the
    // `preset === "store"` tag (see the retired structural heuristic above).
    if (operation.preset === "store") {
      return storeHandler(operation);
    }
    return () => {
      throw new Error(
        `No test fake is derivable for port operation "${operation.id}" (kind "${operation.kind}"). ` +
          `Pass overrides: { "${operation.id}": (input) => output } to createTestApplication, ` +
          `or bind an adapter for port "${operation.portId}".`,
      );
    };
  };

  const fakeAdapters: BoundPortAdapter[] = [];
  for (const [portId, ops] of uncoveredByPort) {
    const operations: Record<string, (input: never) => unknown> = {};
    for (const [opKey, operation] of ops) {
      operations[opKey] = record(
        operation.id,
        fakeFor(operation),
      ) as unknown as (input: never) => unknown;
    }
    fakeAdapters.push(
      Object.freeze({
        descriptorType: "port-adapter" as const,
        portId,
        operations: Object.freeze(operations),
      }),
    );
  }

  const app = createApplication({
    features: definition.features,
    adapters: [
      ...(definition.adapters ?? []).map(wrapUserAdapter),
      ...fakeAdapters,
    ],
    mode: definition.mode ?? "test",
    ...(definition.authorize === undefined
      ? {}
      : { authorize: definition.authorize }),
    ...(definition.observer === undefined
      ? {}
      : { observer: definition.observer }),
    ...(definition.subscribers === undefined
      ? {}
      : { subscribers: definition.subscribers }),
  });

  const calls: TestCallLog = Object.freeze({
    all: () => recorded.map((call) => ({ ...call })),
    of: (effectId: string) =>
      recorded
        .filter((call) => call.effectId === effectId)
        .map((call) => ({ ...call })),
    reset: () => {
      recorded.length = 0;
      nextSequence = 0;
    },
  });

  const harness: TestApplication<Features> = Object.freeze({
    app,
    calls,
    clock,
    ids,
    started: async (): Promise<TestApplication<Features>> => {
      await app.start();
      return harness;
    },
    // Fresh-app semantics for everything the harness owns. User-supplied
    // adapter state is deliberately NOT touched — see TestApplication.reset.
    reset: (): void => {
      for (const records of stores.values()) records.clear();
      recorded.length = 0;
      nextSequence = 0;
      clock.reset();
      ids.reset();
    },
  });
  return harness;
};
