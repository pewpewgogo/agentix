import { defineCommerceAcceptance } from "@agentixdev/shared-contract/acceptance";

import { createPlainSystem } from "./system.js";

defineCommerceAcceptance("plain TypeScript commerce app", createPlainSystem);
