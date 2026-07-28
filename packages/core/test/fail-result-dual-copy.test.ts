import { describe, expect, it } from "vitest";

/**
 * Regression (#15 repro): with two copies of @agentixdev/core in one process
 * (duplicated node_modules resolution, mismatched pins, non-deduped bundles)
 * a `fail(...)` produced by one copy must stay recognizable to the other
 * copy's dispatch. FAIL_RESULT is therefore the REGISTERED
 * Symbol.for("agentix.fail"), not an unregistered Symbol().
 *
 * The built package output is loaded twice via cache-busting query imports —
 * two distinct module instances of packages/core/dist (run `tsc -b
 * packages/core` first; the verification gates do).
 */
const distIndex = new URL("../dist/index.js", import.meta.url).href;

const loadCopy = async (copy: string): Promise<typeof import("../src/index.js")> =>
  (await import(
    /* @vite-ignore */ `${distIndex}?agentix-copy=${copy}`
  )) as typeof import("../src/index.js");

describe("FAIL_RESULT cross-copy identity", () => {
  it("uses the registered symbol and stays distinct per module copy", async () => {
    const copyA = await loadCopy("a");
    const copyB = await loadCopy("b");

    expect(copyA).not.toBe(copyB); // genuinely two module instances
    expect(copyA.FAIL_RESULT).toBe(Symbol.for("agentix.fail"));
    expect(copyB.FAIL_RESULT).toBe(copyA.FAIL_RESULT);
  });

  it("completes a declared failure across module copies (no INVALID_OUTPUT fault)", async () => {
    const copyA = await loadCopy("a");
    const copyB = await loadCopy("b");

    // Feature (and its injected fail) from copy A ...
    const notes = copyA.feature("dual-copy-notes", {
      operations: {
        get: copyA.query({
          input: copyA.s.object({ id: copyA.s.string() }),
          output: copyA.s.object({ id: copyA.s.string() }),
          errors: { NOTE_NOT_FOUND: { http: 404, details: { id: copyA.s.string() } } },
          async execute({ input, fail }) {
            return fail("NOTE_NOT_FOUND", { id: input.id });
          },
        }),
      },
    });

    // ... dispatched by copy B's application.
    const app = copyB.createApplication({ features: [notes], mode: "production" });
    await expect(
      app.dispatch("dual-copy-notes.get", { input: { id: "x" } }),
    ).resolves.toMatchObject({
      kind: "completed",
      outcome: {
        ok: false,
        error: { code: "NOTE_NOT_FOUND", details: { id: "x" } },
      },
    });
  });
});
