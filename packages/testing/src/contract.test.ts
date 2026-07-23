import { describe, expect, it } from "vitest";

import {
  defineAdapterContract,
  runAdapterContract,
} from "./contract.js";

interface CustomerAdapter {
  readonly get: (input: { id: string }) => Promise<{ id: string } | undefined>;
  readonly save: (input: { id: string }) => Promise<{ saved: true }>;
}

const contract = defineAdapterContract<CustomerAdapter>({
  id: "customer-store.contract",
  cases: [
    {
      id: "missing customer",
      operation: "get",
      input: { id: "missing" },
      assert: (output) => {
        expect(output).toBeUndefined();
      },
    },
    {
      id: "save confirmation",
      operation: "save",
      input: { id: "customer-1" },
      assert: (output) => {
        expect(output).toEqual({ saved: true });
      },
    },
  ],
});

describe("adapter contracts", () => {
  it("runs the same cases against an adapter", async () => {
    const adapter: CustomerAdapter = {
      get: async () => undefined,
      save: async () => ({ saved: true }),
    };

    await expect(runAdapterContract(contract, adapter)).resolves.toEqual({
      contractId: "customer-store.contract",
      passedCases: ["missing customer", "save confirmation"],
    });
  });

  it("rejects duplicate case IDs", () => {
    expect(() =>
      defineAdapterContract<CustomerAdapter>({
        id: "duplicate",
        cases: [contract.cases[0]!, contract.cases[0]!],
      }),
    ).toThrow(/Duplicate/);
  });
});
