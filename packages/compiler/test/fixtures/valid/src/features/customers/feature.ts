import { defineFeature } from "@agentixdev/core";
import { customersContract } from "./contract.js";

export const customers = defineFeature({
  id: "customers",
  contract: customersContract,
  dependencies: [],
  operations: [],
  invariants: [],
});
