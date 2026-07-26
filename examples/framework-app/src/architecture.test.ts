import { fileURLToPath } from "node:url";

import { checkArchitecture } from "@agentix/compiler";
import { associateOperationTest } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import { orders } from "./features/orders.js";

export const createOrderArchitectureTest = associateOperationTest(
  orders.operations.create,
  "orders.create.architecture",
);

const rootDir = fileURLToPath(new URL("..", import.meta.url));

describe("framework app architecture", () => {
  it("keeps feature dependencies public and ambient effects out of domain code", () => {
    expect(checkArchitecture({ rootDir })).toEqual([]);
  });
});
