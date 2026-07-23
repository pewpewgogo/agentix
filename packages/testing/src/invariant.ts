import type { Infer, InvariantDescriptor } from "@agentix/core";
import { assert, property } from "fast-check";
import type { Arbitrary, Parameters } from "fast-check";

export class InvariantViolationError extends Error {
  public readonly invariantId: string;
  public readonly evidence: unknown;

  public constructor(invariantId: string, evidence: unknown) {
    super(`Invariant ${invariantId} did not hold.`);
    this.name = "InvariantViolationError";
    this.invariantId = invariantId;
    this.evidence = evidence;
  }
}

export const checkInvariant = <Invariant extends InvariantDescriptor>(
  invariant: Invariant,
  evidence: Infer<Invariant["evidence"]>,
): boolean => invariant.check(invariant.evidence.parse(evidence));

export const assertInvariant = <Invariant extends InvariantDescriptor>(
  invariant: Invariant,
  evidence: Infer<Invariant["evidence"]>,
): void => {
  if (!checkInvariant(invariant, evidence)) {
    throw new InvariantViolationError(invariant.id, evidence);
  }
};

export interface CheckInvariantPropertyOptions<
  Invariant extends InvariantDescriptor,
> {
  readonly invariant: Invariant;
  readonly evidence: Arbitrary<Infer<Invariant["evidence"]>>;
  /** Defaults are fixed so a package test is reproducible without ambient RNG. */
  readonly parameters?: Parameters<[Infer<Invariant["evidence"]>]>;
}

/** Runs a reproducible fast-check property over schema-validated evidence. */
export const checkInvariantProperty = <Invariant extends InvariantDescriptor>(
  options: CheckInvariantPropertyOptions<Invariant>,
): void => {
  assert(
    property(options.evidence, (evidence) =>
      checkInvariant(options.invariant, evidence),
    ),
    {
      seed: 20_260_723,
      numRuns: 100,
      ...options.parameters,
    },
  );
};
