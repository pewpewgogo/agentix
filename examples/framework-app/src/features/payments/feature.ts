import { defineFeature } from "@agentix/core";

import { Payments, paymentsContract } from "./contract.js";

export const payments = defineFeature({
  id: "payments",
  contract: paymentsContract,
  dependencies: [],
  operations: [],
  invariants: [],
  ports: [Payments],
});
