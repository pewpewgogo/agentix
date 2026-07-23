import { isDeepStrictEqual } from "node:util";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface ReplayPrincipal {
  readonly id?: string;
  readonly permissions: readonly string[];
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export type ReplayEffectResult =
  | { readonly status: "returned"; readonly output: JsonValue }
  | { readonly status: "threw"; readonly error: JsonValue };

export interface ReplayEffect {
  readonly effectId: string;
  readonly input: JsonValue;
  readonly result: ReplayEffectResult;
}

export interface ReplayEvent {
  readonly eventId: string;
  readonly payload: JsonValue;
}

export interface ReplayRecord {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly operationKind: "command" | "query";
  readonly input: JsonValue;
  readonly principal: ReplayPrincipal;
  readonly effects: readonly ReplayEffect[];
  readonly expected: {
    readonly outcome: JsonValue;
    readonly events: readonly ReplayEvent[];
  };
}

export type ReplayRecordInput = Omit<ReplayRecord, "schemaVersion">;

const cloneJson = <Value extends JsonValue>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const cloneJsonData = <Value>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const deepFreeze = <Value>(value: Value): Readonly<Value> => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
};

function assertJson(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object>,
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw new TypeError(`${path} contains a non-finite number.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not JSON-serializable.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a cycle.`);
  }

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJson(item, `${path}[${index}]`, nextAncestors);
    });
    return;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects.`);
  }
  for (const [key, item] of Object.entries(value)) {
    assertJson(item, `${path}.${key}`, nextAncestors);
  }
}

export const defineReplayRecord = (
  input: ReplayRecordInput,
): ReplayRecord => parseReplayRecord({ schemaVersion: 1, ...input });

const recordAt = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const nonEmptyStringAt = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
};

/** Validates an unknown deserialized value and returns an immutable record. */
export const parseReplayRecord = (value: unknown): ReplayRecord => {
  assertJson(value, "replay", new Set());
  const record = recordAt(value, "replay");
  if (record["schemaVersion"] !== 1) {
    throw new TypeError("replay.schemaVersion must be 1.");
  }
  nonEmptyStringAt(record["operationId"], "replay.operationId");
  if (
    record["operationKind"] !== "command" &&
    record["operationKind"] !== "query"
  ) {
    throw new TypeError(
      'replay.operationKind must be either "command" or "query".',
    );
  }
  if (!("input" in record)) {
    throw new TypeError("replay.input is required.");
  }

  const principal = recordAt(record["principal"], "replay.principal");
  if (principal["id"] !== undefined) {
    nonEmptyStringAt(principal["id"], "replay.principal.id");
  }
  if (
    !Array.isArray(principal["permissions"]) ||
    !principal["permissions"].every(
      (permission) => typeof permission === "string",
    )
  ) {
    throw new TypeError("replay.principal.permissions must be a string array.");
  }
  if (principal["attributes"] !== undefined) {
    recordAt(principal["attributes"], "replay.principal.attributes");
  }

  if (!Array.isArray(record["effects"])) {
    throw new TypeError("replay.effects must be an array.");
  }
  record["effects"].forEach((effectValue, index) => {
    const effect = recordAt(effectValue, `replay.effects[${index}]`);
    nonEmptyStringAt(effect["effectId"], `replay.effects[${index}].effectId`);
    if (!("input" in effect)) {
      throw new TypeError(`replay.effects[${index}].input is required.`);
    }
    const result = recordAt(
      effect["result"],
      `replay.effects[${index}].result`,
    );
    if (result["status"] === "returned") {
      if (!("output" in result)) {
        throw new TypeError(
          `replay.effects[${index}].result.output is required.`,
        );
      }
    } else if (result["status"] === "threw") {
      if (!("error" in result)) {
        throw new TypeError(
          `replay.effects[${index}].result.error is required.`,
        );
      }
    } else {
      throw new TypeError(
        `replay.effects[${index}].result.status is invalid.`,
      );
    }
  });

  const expected = recordAt(record["expected"], "replay.expected");
  if (!("outcome" in expected)) {
    throw new TypeError("replay.expected.outcome is required.");
  }
  if (!Array.isArray(expected["events"])) {
    throw new TypeError("replay.expected.events must be an array.");
  }
  expected["events"].forEach((eventValue, index) => {
    const event = recordAt(eventValue, `replay.expected.events[${index}]`);
    nonEmptyStringAt(
      event["eventId"],
      `replay.expected.events[${index}].eventId`,
    );
    if (!("payload" in event)) {
      throw new TypeError(
        `replay.expected.events[${index}].payload is required.`,
      );
    }
  });

  return deepFreeze(cloneJsonData(value)) as unknown as ReplayRecord;
};

export class ReplayEffectError extends Error {
  public readonly detail: JsonValue;

  public constructor(detail: JsonValue) {
    super("A recorded effect threw during replay.");
    this.name = "ReplayEffectError";
    this.detail = detail;
  }
}

export interface ReplayContext {
  readonly input: JsonValue;
  readonly principal: ReplayPrincipal;
  readonly invokeEffect: (
    effectId: string,
    input: JsonValue,
  ) => Promise<JsonValue>;
}

export interface ReplayObservation {
  readonly outcome: JsonValue;
  readonly events: readonly ReplayEvent[];
}

export interface ReplayResult {
  readonly observation: ReplayObservation;
  readonly consumedEffects: number;
}

export class ReplayMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}

/**
 * Re-executes a record through a caller-provided operation runner. All effect
 * responses come from the record, and every call must match in order.
 */
export const replay = async (
  record: ReplayRecord,
  run: (context: ReplayContext) => Promise<ReplayObservation>,
): Promise<ReplayResult> => {
  let cursor = 0;

  const observation = await run({
    input: cloneJson(record.input),
    principal: cloneJson(record.principal as unknown as JsonValue) as unknown as ReplayPrincipal,
    async invokeEffect(effectId, input) {
      const expected = record.effects[cursor];
      if (expected === undefined) {
        throw new ReplayMismatchError(
          `Unexpected effect ${effectId}; the replay script is exhausted.`,
        );
      }
      if (expected.effectId !== effectId || !isDeepStrictEqual(expected.input, input)) {
        throw new ReplayMismatchError(
          `Effect ${cursor} does not match the replay record.`,
        );
      }
      cursor += 1;
      if (expected.result.status === "threw") {
        throw new ReplayEffectError(cloneJson(expected.result.error));
      }
      return cloneJson(expected.result.output);
    },
  });

  if (cursor !== record.effects.length) {
    throw new ReplayMismatchError(
      `Replay consumed ${cursor} of ${record.effects.length} recorded effects.`,
    );
  }
  if (!isDeepStrictEqual(observation, record.expected)) {
    throw new ReplayMismatchError(
      "Replay outcome or emitted events differ from the recorded expectation.",
    );
  }

  return { observation, consumedEffects: cursor };
};
