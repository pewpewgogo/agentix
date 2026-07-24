import { defineFeature } from "@agentixdev/core";

import { Payments, paymentsContract } from "./contract.js";

export const payments = defineFeature({
  id: "payments",
  contract: paymentsContract,
  dependencies: [],
  operations: [],
  invariants: [],
  ports: [Payments],
});
