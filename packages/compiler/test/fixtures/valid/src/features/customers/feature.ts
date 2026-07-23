import { defineFeature } from "@agentix/core";
import { customersContract } from "./contract.js";

export const customers = defineFeature({
  id: "customers",
  contract: customersContract,
  dependencies: [],
  operations: [],
  invariants: [],
});
