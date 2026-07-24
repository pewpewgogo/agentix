import { defineFeature } from "@agentixdev/core";

import {
  CustomerClock,
  CustomerStorage,
  customersContract,
} from "./contract.js";
import { createCustomer, getCustomer } from "./operations.js";

export const customers = defineFeature({
  id: "customers",
  contract: customersContract,
  dependencies: [],
  operations: [createCustomer, getCustomer],
  invariants: [],
  events: [],
  ports: [CustomerStorage, CustomerClock],
});
