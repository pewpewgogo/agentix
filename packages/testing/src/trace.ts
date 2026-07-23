import { isDeepStrictEqual } from "node:util";

export interface EffectTraceLike {
  readonly type: "effect";
  readonly effectId: string;
}

export interface EventTraceLike {
  readonly type: "event";
  readonly eventId: string;
}

export type ExecutionTraceLike<
  Effect extends EffectTraceLike = EffectTraceLike,
  Event extends EventTraceLike = EventTraceLike,
> = readonly (Effect | Event)[];

export class TraceAssertionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TraceAssertionError";
  }
}

const inspect = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const assertEffectSequence = (
  trace: ExecutionTraceLike,
  expectedEffectIds: readonly string[],
): void => {
  const actual = trace
    .filter((entry): entry is EffectTraceLike => entry.type === "effect")
    .map(({ effectId }) => effectId);
  if (!isDeepStrictEqual(actual, expectedEffectIds)) {
    throw new TraceAssertionError(
      `Expected effect sequence ${inspect(expectedEffectIds)}, received ${inspect(actual)}.`,
    );
  }
};

export const assertEventSequence = (
  trace: ExecutionTraceLike,
  expectedEventIds: readonly string[],
): void => {
  const actual = trace
    .filter((entry): entry is EventTraceLike => entry.type === "event")
    .map(({ eventId }) => eventId);
  if (!isDeepStrictEqual(actual, expectedEventIds)) {
    throw new TraceAssertionError(
      `Expected event sequence ${inspect(expectedEventIds)}, received ${inspect(actual)}.`,
    );
  }
};

export const assertTraceEquals = <
  Effect extends EffectTraceLike,
  Event extends EventTraceLike,
>(
  actual: ExecutionTraceLike<Effect, Event>,
  expected: ExecutionTraceLike<Effect, Event>,
): void => {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new TraceAssertionError(
      `Execution trace mismatch. Expected ${inspect(expected)}, received ${inspect(actual)}.`,
    );
  }
};

export const assertNoEffects = (trace: ExecutionTraceLike): void => {
  const effects = trace.filter(({ type }) => type === "effect");
  if (effects.length !== 0) {
    throw new TraceAssertionError(
      `Expected no effects, received ${inspect(effects)}.`,
    );
  }
};

export const assertNoEvents = (trace: ExecutionTraceLike): void => {
  const events = trace.filter(({ type }) => type === "event");
  if (events.length !== 0) {
    throw new TraceAssertionError(
      `Expected no events, received ${inspect(events)}.`,
    );
  }
};
