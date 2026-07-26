import {
  createApplication,
  type AnyBoundOperation,
  type AnyFeature,
  type AnyPortOperation,
  type Application,
  type ApplicationOperations,
  type BoundPortAdapter,
  type Principal,
  type RuntimeMode,
} from "@agentix/core";

import {
  createDeterministicClock,
  createDeterministicIdGenerator,
  type DeterministicClock,
  type DeterministicIdGenerator,
} from "./deterministic.js";
import type { RecordedEffectCall } from "./recording.js";

/** Replacement handler for one auto-bound port operation, keyed by its id. */
export type TestOverrideHandler = (input: never) => unknown;

export interface TestApplicationDefinition<
  Features extends readonly AnyFeature[],
> {
  readonly features: Features;
  /** Real adapters; ports they cover are never faked (and never recorded). */
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
}

/** Call log of every auto-bound (fake or overridden) port operation. */
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
}

/** Store preset op keys and the effect kind each must carry to be memory-backed. */
const STORE_OP_KINDS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  get: "read",
  save: "write",
  delete: "write",
  list: "read",
});

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

/**
 * Builds an application where every port operation reachable from the given
 * features is bound: user adapters win; uncovered operations get recording
 * fakes (store presets -> in-memory Map, time -> deterministic clock,
 * random -> deterministic ids); anything else throws until overridden.
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
    (effectId: string, handler: (input: unknown) => unknown) =>
    async (input: unknown): Promise<unknown> => {
      const sequence = nextSequence;
      nextSequence += 1;
      try {
        const output = await handler(input);
        recorded.push({ sequence, effectId, input, status: "returned", output });
        return output;
      } catch (error: unknown) {
        recorded.push({ sequence, effectId, input, status: "threw", error });
        throw error;
      }
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

  const fakeFor = (
    operation: AnyPortOperation,
  ): ((input: unknown) => unknown) => {
    const override = overrides[operation.id];
    if (override !== undefined) {
      return override as (input: unknown) => unknown;
    }
    if (operation.kind === "time") {
      return () => clockValueFor(operation, clock.now());
    }
    if (operation.kind === "random") {
      return () => projectToOutput(operation, ids.next());
    }
    if (STORE_OP_KINDS[operation.opKey] === operation.kind) {
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
      operations[opKey] = record(operation.id, fakeFor(operation));
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
    adapters: [...(definition.adapters ?? []), ...fakeAdapters],
    mode: definition.mode ?? "test",
    ...(definition.authorize === undefined
      ? {}
      : { authorize: definition.authorize }),
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

  return Object.freeze({ app, calls, clock, ids });
};
