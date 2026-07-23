import { definePort, portOperation } from "@agentix/core";

export const Payments = definePort({
  id: "payments",
  operations: {
    charge: portOperation({
      id: "payments.charge",
      kind: "external",
      input: undefined,
      output: undefined,
      errors: {},
    }),
  },
});
