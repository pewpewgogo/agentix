import type { PortDescriptor, PortImplementation } from "@agentix/core";

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

type OperationImplementation<
  Port extends PortDescriptor,
  Name extends keyof PortImplementation<Port>,
> = Extract<PortImplementation<Port>[Name], (input: never) => unknown>;

export type RecordingPortImplementation<Port extends PortDescriptor> = {
  readonly [Name in keyof PortImplementation<Port>]: (
    input: Parameters<OperationImplementation<Port, Name>>[0],
  ) => Promise<Awaited<ReturnType<OperationImplementation<Port, Name>>>>;
};

export interface RecordingAdapter<Port extends PortDescriptor> {
  readonly portId: string;
  readonly operations: RecordingPortImplementation<Port>;
  readonly calls: () => readonly RecordedEffectCall[];
  readonly reset: () => void;
}

/**
 * Wraps explicit port implementations and records their observable calls.
 * The returned `operations` value can be passed to the core adapter binding.
 */
export const createRecordingAdapter = <
  Port extends PortDescriptor,
>(
  port: Port,
  handlers: PortImplementation<Port>,
): RecordingAdapter<Port> => {
  const calls: RecordedEffectCall[] = [];
  let nextSequence = 0;
  const operationNames = Object.keys(port.operations) as (keyof Port["operations"] &
    string)[];
  const handlerRecord = handlers as unknown as Readonly<
    Record<string, (input: unknown) => Awaitable<unknown>>
  >;

  const wrapped = Object.fromEntries(
    operationNames.map((name) => {
      const descriptor = port.operations[name];
      const handler = handlerRecord[name];
      if (descriptor === undefined || handler === undefined) {
        throw new TypeError(
          `Missing fake implementation for ${port.id}.${String(name)}.`,
        );
      }

      const implementation = async (input: unknown): Promise<unknown> => {
        const sequence = nextSequence;
        nextSequence += 1;
        try {
          const output = await handler(input);
          calls.push({
            sequence,
            effectId: descriptor.id,
            input,
            status: "returned",
            output,
          });
          return output;
        } catch (error: unknown) {
          calls.push({
            sequence,
            effectId: descriptor.id,
            input,
            status: "threw",
            error,
          });
          throw error;
        }
      };

      return [name, implementation] as const;
    }),
  ) as RecordingPortImplementation<Port>;

  return {
    portId: port.id,
    operations: wrapped,
    calls: () => calls.map((call) => ({ ...call })),
    reset: () => {
      calls.length = 0;
      nextSequence = 0;
    },
  };
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
