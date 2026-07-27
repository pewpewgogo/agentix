import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  API,
  PINNED_TYPESCRIPT_VERSION,
  SymbolFlags,
  UNSTABLE_SYNC_API_SHAPE,
  assertUnstableApiShape,
} from "./ts.js";

describe("typescript unstable API guard", () => {
  it("loads the pinned unstable sync API", () => {
    expect(typeof API).toBe("function");
    expect(typeof SymbolFlags.Alias).toBe("number");
  });

  it("keeps the pinned version aligned with the exact package.json dependency", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["typescript"]).toBe(PINNED_TYPESCRIPT_VERSION);
    expect(PINNED_TYPESCRIPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("matches the installed TypeScript release", async () => {
    const { version } = await import("typescript");
    expect(version).toBe(PINNED_TYPESCRIPT_VERSION);
  });

  it("accepts a module that provides every required symbol", () => {
    expect(() =>
      assertUnstableApiShape(
        "typescript/unstable/sync",
        { API: class {}, SymbolFlags: { Alias: 2097152 } },
        UNSTABLE_SYNC_API_SHAPE,
      ),
    ).not.toThrow();
  });

  it("throws an actionable error naming a missing top-level symbol", () => {
    const simulated = { SymbolFlags: { Alias: 2097152 } };
    expect(() =>
      assertUnstableApiShape("typescript/unstable/sync", simulated, UNSTABLE_SYNC_API_SHAPE),
    ).toThrowError(
      new RegExp(
        String.raw`^@agentix/compiler could not load the unstable TypeScript compiler API ` +
          String.raw`"typescript/unstable/sync": missing or renamed symbols: API\. ` +
          String.raw`This @agentix/compiler build supports exactly typescript@${PINNED_TYPESCRIPT_VERSION}\. ` +
          String.raw`Install that release \(npm install --save-exact typescript@${PINNED_TYPESCRIPT_VERSION}\)`,
        "u",
      ),
    );
  });

  it("throws when a nested symbol is renamed", () => {
    const simulated = { API: class {}, SymbolFlags: { AliasedSymbol: 2097152 } };
    expect(() =>
      assertUnstableApiShape("typescript/unstable/sync", simulated, UNSTABLE_SYNC_API_SHAPE),
    ).toThrowError(/missing or renamed symbols: SymbolFlags\.Alias\./u);
  });

  it("lists every missing symbol in one message", () => {
    expect(() => assertUnstableApiShape("typescript/unstable/sync", {}, UNSTABLE_SYNC_API_SHAPE))
      .toThrowError(/missing or renamed symbols: API, SymbolFlags, SymbolFlags\.Alias\./u);
  });
});
