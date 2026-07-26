import { associateOperationTest } from "@agentix/testing";
import { first } from "./pair.js";

export const createTest = associateOperationTest(first.operations.create, "first.create.test");
