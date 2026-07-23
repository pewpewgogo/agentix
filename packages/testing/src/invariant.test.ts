import { describe, expect, it } from "vitest";
import { defineInvariant, schema } from "@agentix/core";
import { integer, record } from "fast-check";

import {
  InvariantViolationError,
  assertInvariant,
  checkInvariant,
  checkInvariantProperty,
} from "./invariant.js";

const nonNegativeBalance = defineInvariant({
  id: "accounts.non-negative-balance",
  dependsOn: [],
  evidence: schema.object({ balance: schema.number() }),
  check: ({ balance }) => balance >= 0,
});

describe("invariant helpers", () => {
  it("checks and asserts schema-validated evidence", () => {
    expect(checkInvariant(nonNegativeBalance, { balance: 1 })).toBe(true);
    expect(() =>
      assertInvariant(nonNegativeBalance, { balance: -1 }),
    ).toThrow(InvariantViolationError);
  });

  it("runs deterministic property checks", () => {
    expect(() =>
      checkInvariantProperty({
        invariant: nonNegativeBalance,
        evidence: record({ balance: integer({ min: 0, max: 1_000 }) }),
        parameters: { seed: 10, numRuns: 20 },
      }),
    ).not.toThrow();
  });
});
