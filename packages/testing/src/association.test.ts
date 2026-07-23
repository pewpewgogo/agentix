import { describe, expect, it } from "vitest";

import {
  associateOperationTest,
  defineOperationTest,
} from "./association.js";

const createOrder = { id: "orders.create", kind: "command" } as const;

describe("operation test associations", () => {
  it("keeps the operation reference visible to source analysis", () => {
    expect(
      defineOperationTest({
        id: "orders.create.unit",
        operation: createOrder,
      }),
    ).toEqual({
      kind: "operation-test",
      id: "orders.create.unit",
      operation: createOrder,
    });
    expect(associateOperationTest(createOrder)).toMatchObject({
      id: "orders.create.test",
      operation: createOrder,
    });
  });

  it("requires an explicit non-empty association ID", () => {
    expect(() =>
      defineOperationTest({ id: "", operation: createOrder }),
    ).toThrow(/requires an ID/);
  });
});
