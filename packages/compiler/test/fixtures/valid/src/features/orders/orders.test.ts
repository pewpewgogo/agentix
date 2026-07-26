import { associateOperationTest } from "@agentix/testing";
import { orders } from "./feature.js";

export const createTest = associateOperationTest(orders.operations.create, "orders.create.test");
