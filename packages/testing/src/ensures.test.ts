import { describe, expect, it } from "vitest";
import { command, feature, s } from "@agentix/core";
import { integer, record } from "fast-check";

import {
  EnsureViolationError,
  assertEnsures,
  checkEnsures,
  checkEnsuresProperty,
} from "./ensures.js";

const accounts = feature("accounts", {
  operations: {
    deposit: command({
      input: s.object({ amount: s.number({ min: 0 }) }),
      output: s.object({ balance: s.number() }),
      ensures: {
        nonNegativeBalance: {
          check: ({ output }) => output.balance >= 0,
        },
      },
      execute: ({ input }) => ({ balance: input.amount }),
    }),
  },
});

const deposit = accounts.operations.deposit;

describe("ensure helpers", () => {
  it("checks and asserts declared ensures against explicit contexts", () => {
    expect(
      checkEnsures(deposit, { input: { amount: 1 }, output: { balance: 1 } }),
    ).toEqual([]);
    expect(
      checkEnsures(deposit, { input: { amount: 1 }, output: { balance: -1 } }),
    ).toEqual(["nonNegativeBalance"]);
    expect(() =>
      assertEnsures(deposit, { input: { amount: 1 }, output: { balance: -1 } }),
    ).toThrow(EnsureViolationError);
    expect(() =>
      assertEnsures(deposit, { input: { amount: 1 }, output: { balance: -1 } }),
    ).toThrow(/accounts\.deposit violated ensures: nonNegativeBalance/);
  });

  it("runs deterministic property checks", () => {
    expect(() =>
      checkEnsuresProperty({
        operation: deposit,
        contexts: record({
          input: record({ amount: integer({ min: 0, max: 1_000 }) }),
          output: record({ balance: integer({ min: 0, max: 1_000 }) }),
        }),
        parameters: { seed: 10, numRuns: 20 },
      }),
    ).not.toThrow();
  });
});
