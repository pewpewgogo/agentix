import { describe, expect, it } from "vitest";

import { canonicalJson, hashInstructionSet } from "./hash.js";

describe("standardized instruction hashes", () => {
  it("normalizes Unicode and line endings but preserves meaningful whitespace", () => {
    const base = {
      developer: "developer",
      user: "caf\u00e9",
      tools: ["read", "exec"],
      permissions: { network: false, write: true },
      limits: { seconds: 10 },
    } as const;
    const windows = hashInstructionSet({ ...base, system: "one\r\ntwo" });
    const unixDecomposed = hashInstructionSet({
      ...base,
      system: "one\ntwo",
      user: "cafe\u0301",
      permissions: { write: true, network: false },
    });
    expect(windows).toEqual(unixDecomposed);
    expect(
      hashInstructionSet({ ...base, system: "one\ntwo " }).bundle,
    ).not.toBe(windows.bundle);
  });

  it("canonicalizes object key order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
  });
});
