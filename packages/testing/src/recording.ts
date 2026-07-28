import type {
  AnyPort,
  AnyPortOperation,
  Infer,
  PortImplementation,
} from "@agentixdev/core";

export type Awaitable<T> = T | Promise<T>;

export type EffectHandler<Input = unknown, Output = unknown> = (
  input: Input,
) => Awaitable<Output>;

export interface ReturnedEffectCall {
  readonly sequence: number;
  readonly effectId: string;
  readonly input: unknown;
  readonly status: "returned";
  readonly output: unknown;
}

export interface ThrownEffectCall {
  readonly sequence: number;
  readonly effectId: string;
  readonly input: unknown;
  readonly status: "threw";
  readonly error: unknown;
}

export type RecordedEffectCall = ReturnedEffectCall | ThrownEffectCall;

export type RecordingPortImplementation<
  Ops extends Record<string, AnyPortOperation>,
> = {
  readonly [Name in keyof Ops]: Ops[Name] extends AnyPortOperation
    ? (input: Infer<Ops[Name]["input"]>) => Promise<Infer<Ops[Name]["output"]>>
    : never;
};

/**
 * Structurally a core BoundPortAdapter, so it can be passed directly to
 * `createApplication({ adapters: [...] })` while exposing its call log.
 */
export interface RecordingAdapter<Port extends AnyPort> {
  readonly descriptorType: "port-adapter";
  readonly portId: Port["id"];
  readonly operations: RecordingPortImplementation<Port["operations"]>;
  readonly calls: () => readonly RecordedEffectCall[];
  readonly reset: () => void;
}

/**
 * Wraps explicit plain-value port implementations (amendment A1: return values
 * or throw — no Outcome wrapping) and records their observable calls.
 */
export const createRecordingAdapter = <Port extends AnyPort>(
  port: Port,
  handlers: PortImplementation<Port["operations"]>,
): RecordingAdapter<Port> => {
  const calls: RecordedEffectCall[] = [];
  let nextSequence = 0;
  const operations = port.operations as Readonly<Record<string, AnyPortOperation>>;
  const handlerRecord = handlers as unknown as Readonly<
    Record<string, (input: unknown) => Awaitable<unknown>>
  >;

  const wrapped: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const name of Object.keys(operations)) {
    const descriptor = operations[name];
    const handler = handlerRecord[name];
    if (descriptor === undefined || typeof handler !== "function") {
      throw new TypeError(
        `Missing fake implementation for ${port.id}.${name}.`,
      );
    }
    const effectId = descriptor.id;
    wrapped[name] = async (input: unknown): Promise<unknown> => {
      const sequence = nextSequence;
      nextSequence += 1;
      try {
        const output = await handler(input);
        calls.push({ sequence, effectId, input, status: "returned", output });
        return output;
      } catch (error: unknown) {
        calls.push({ sequence, effectId, input, status: "threw", error });
        throw error;
      }
    };
  }

  return Object.freeze({
    descriptorType: "port-adapter" as const,
    portId: port.id as Port["id"],
    operations: Object.freeze(wrapped) as unknown as RecordingPortImplementation<
      Port["operations"]
    >,
    calls: () => calls.map((call) => ({ ...call })),
    reset: () => {
      calls.length = 0;
      nextSequence = 0;
    },
  });
};

export type ScriptedEffectStep<Output> =
  | { readonly status: "returned"; readonly output: Output }
  | { readonly status: "threw"; readonly error: unknown };

export interface ScriptedEffect<Input, Output> {
  readonly handler: EffectHandler<Input, Output>;
  readonly remaining: () => number;
  readonly reset: () => void;
}

/** Creates an effect handler with an explicit, resettable response script. */
export const createScriptedEffect = <Input, Output>(
  steps: readonly ScriptedEffectStep<Output>[],
): ScriptedEffect<Input, Output> => {
  let cursor = 0;

  return {
    handler: async () => {
      const step = steps[cursor];
      if (step === undefined) {
        throw new Error("The scripted effect has no remaining response.");
      }
      cursor += 1;
      if (step.status === "threw") {
        throw step.error;
      }
      return step.output;
    },
    remaining: () => steps.length - cursor,
    reset: () => {
      cursor = 0;
    },
  };
};
