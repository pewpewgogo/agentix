import { fileURLToPath } from "node:url";

import { checkArchitecture } from "@agentix/compiler";
import { describe, expect, it } from "vitest";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

describe("framework app architecture", () => {
  it("keeps feature dependencies public and ambient effects out of domain code", () => {
    expect(checkArchitecture({ rootDir })).toEqual([]);
  });
});
