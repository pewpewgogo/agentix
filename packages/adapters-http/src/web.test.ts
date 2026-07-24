import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("Web-only HTTP entrypoint", () => {
  it("has no transitive Node built-in imports", () => {
    const webSurface = [
      source("./web.ts"),
      source("./auth.ts"),
      source("./handler.ts"),
      source("./route.ts"),
    ].join("\n");

    expect(webSurface).not.toMatch(/from ["']node:/u);
    expect(source("./node.ts")).toMatch(/from ["']node:http["']/u);
  });
});
