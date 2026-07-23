import { defineCommerceAcceptance } from "@agentix/shared-contract/acceptance";

import { createFrameworkSystem } from "./application.js";

defineCommerceAcceptance("framework commerce app", createFrameworkSystem);
