import type { AnyBoundOperation, EnsureContext, Infer } from "@agentixdev/core";
import { assert, property } from "fast-check";
import type { Arbitrary, Parameters as FcParameters } from "fast-check";

/** The typed `{ input, output }` context an operation's ensures receive. */
export type EnsureContextOf<Operation extends AnyBoundOperation> = EnsureContext<
  Infer<Operation["input"]>,
  Infer<Operation["output"]>
>;

export class EnsureViolationError extends Error {
  public readonly operationId: string;
  public readonly violated: readonly string[];
  public readonly context: EnsureContext<unknown, unknown>;

  public constructor(
    operationId: string,
    violated: readonly string[],
    context: EnsureContext<unknown, unknown>,
  ) {
    super(`Operation ${operationId} violated ensures: ${violated.join(", ")}.`);
    this.name = "EnsureViolationError";
    this.operationId = operationId;
    this.violated = Object.freeze([...violated]);
    this.context = context;
  }
}

/**
 * Runs the operation's declared `ensures` checks against an explicit context
 * (useful because production dispatch skips them). Returns violated names.
 */
export const checkEnsures = <Operation extends AnyBoundOperation>(
  operation: Operation,
  context: EnsureContextOf<Operation>,
): readonly string[] => {
  const violated: string[] = [];
  for (const name of Object.keys(operation.ensures)) {
    const ensure = operation.ensures[name];
    if (ensure === undefined) continue;
    if (!ensure.check(context)) {
      violated.push(name);
    }
  }
  return violated;
};

export const assertEnsures = <Operation extends AnyBoundOperation>(
  operation: Operation,
  context: EnsureContextOf<Operation>,
): void => {
  const violated = checkEnsures(operation, context);
  if (violated.length > 0) {
    throw new EnsureViolationError(operation.id, violated, context);
  }
};

export interface CheckEnsuresPropertyOptions<
  Operation extends AnyBoundOperation,
> {
  readonly operation: Operation;
  readonly contexts: Arbitrary<EnsureContextOf<Operation>>;
  /** Defaults are fixed so a package test is reproducible without ambient RNG. */
  readonly parameters?: FcParameters<[EnsureContextOf<Operation>]>;
}

/** Runs a reproducible fast-check property over generated ensure contexts. */
export const checkEnsuresProperty = <Operation extends AnyBoundOperation>(
  options: CheckEnsuresPropertyOptions<Operation>,
): void => {
  assert(
    property(
      options.contexts,
      (context) => checkEnsures(options.operation, context).length === 0,
    ),
    {
      seed: 20_260_723,
      numRuns: 100,
      ...options.parameters,
    },
  );
};
