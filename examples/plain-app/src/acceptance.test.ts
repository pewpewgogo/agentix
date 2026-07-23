import { defineCommerceAcceptance } from "@agentix/shared-contract/acceptance";

import { createPlainSystem } from "./system.js";

defineCommerceAcceptance("plain TypeScript commerce app", createPlainSystem);
