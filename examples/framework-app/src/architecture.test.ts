import { fileURLToPath } from "node:url";

import { checkArchitecture } from "@agentix/compiler";
import { associateOperationTest } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import { createOrder } from "./features/orders/operations.js";

export const createOrderArchitectureTest = associateOperationTest(
  createOrder,
  "orders.create.architecture",
);

const rootDir = fileURLToPath(new URL("..", import.meta.url));

describe("framework app architecture", () => {
  it("keeps feature dependencies public and ambient effects out of domain code", () => {
    expect(checkArchitecture({ rootDir })).toEqual([]);
  });
});
