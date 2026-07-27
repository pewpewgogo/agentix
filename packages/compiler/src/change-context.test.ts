import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  analyzeProject,
  createChangeContext,
  stableJson,
  type AgentIndex,
} from "./index.js";

const fixture = (name: "valid" | "invalid"): string =>
  fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

let validIndexCache: AgentIndex | undefined;
const validIndex = (): AgentIndex => {
  validIndexCache ??= analyzeProject({ rootDir: fixture("valid") });
  return validIndexCache;
};

describe("change context", () => {
  it("packs one artifact with sources, tables, closure, plan, and recipe", () => {
    const context = createChangeContext(validIndex(), "orders.create", fixture("valid"));
    expect(context).toBeDefined();
    if (context === undefined) return;

    expect(context).toMatchObject({
      schemaVersion: "2",
      artifactKind: "change-context",
      id: "orders.create",
      source: "src/features/orders/feature.ts:17",
      http: { method: "POST", path: "/orders", status: 201 },
      permissions: ["orders:create"],
      events: ["orders.created"],
      ensures: ["chargedOnce"],
    });
    // Error/status table from the unified declarations.
    expect(context.errors).toEqual([
      { code: "CUSTOMER_NOT_FOUND" },
      { code: "ORDER_INVALID" },
      { code: "PAYMENT_FAILED", http: 402 },
    ]);
    // The full command() call text, line-preserving, de-indented.
    expect(context.excerpt).toContain("create: command({");
    expect(context.excerpt).toContain("async execute({ input, effects, emit, fail })");
    expect(context.excerpt).not.toMatch(/\n {2}/u);
    // Feature-file public contract and effect wiring with port signatures.
    expect(context.exports).toEqual(["OrderCreated", "Payments", "orders"]);
    expect(context.effects).toEqual([
      "chargePayment=payments.charge",
      "loadCustomer=customerStore.get",
    ]);
    expect(context.portSignatures?.some((signature) => signature.startsWith("charge: port.external("))).toBe(true);
    expect(context.portSignatures).toContain('port.store("customerStore", Customer)');
    // The primary (smallest) associated test embeds its full source.
    expect(context.tests).toHaveLength(1);
    expect(context.tests[0]?.file).toBe("src/features/orders/orders.test.ts");
    expect(context.tests[0]?.source).toContain(
      "associateOperationTest(orders.operations.create",
    );
    expect(context.affected).toContain("orders.create");
    expect(context.affected).toContain("src/features/orders/orders.test.ts");
    // Pasteable verification commands (workspace scope: fixture has no tsconfig).
    expect(context.verification).toEqual({
      scope: "workspace",
      typecheck: "npm exec -- tsc -b --pretty false",
      tests: "npm exec -- vitest run",
    });
    expect(context.writes).toEqual([
      "src/features/orders/feature.ts",
      "src/features/orders/orders.test.ts",
    ]);
    // Nothing was dropped, so there is no projection block.
    expect(context).not.toHaveProperty("projection");
  });

  it("is deterministic across repeated builds", () => {
    const first = createChangeContext(validIndex(), "customers.get", fixture("valid"));
    const second = createChangeContext(validIndex(), "customers.get", fixture("valid"));
    expect(stableJson(first)).toBe(stableJson(second));
  });

  it("degrades under a small budget with an exact omission ledger", () => {
    const context = createChangeContext(validIndex(), "orders.create", fixture("valid"), {
      budgetBytes: 1600,
    });
    expect(context).toBeDefined();
    if (context === undefined) return;

    const bytes = Buffer.byteLength(stableJson(context, { compact: true }));
    expect(bytes).toBeLessThanOrEqual(1600);
    // Identity, tables, verification, and the writes recipe survive.
    expect(context.id).toBe("orders.create");
    expect(context.verification.typecheck).toContain("tsc");
    expect(context.writes.length).toBeGreaterThan(0);
    // The dropped sources are listed with exact expansions.
    expect(context.projection?.truncated).toBe(true);
    const paths = context.projection?.omissions.map(({ path }) => path) ?? [];
    expect(paths).toContain("tests[].source");
    const testOmission = context.projection?.omissions.find(({ path }) => path === "tests[].source");
    expect(testOmission?.expand).toMatchObject({
      kind: "source",
      source: { file: "src/features/orders/orders.test.ts" },
    });
    expect(context.tests).toEqual([{ file: "src/features/orders/orders.test.ts" }]);
  });

  it("rejects budgets below the smallest projection", () => {
    expect(() =>
      createChangeContext(validIndex(), "orders.create", fixture("valid"), { budgetBytes: 64 }),
    ).toThrow(/raise --budget/u);
  });

  it("returns undefined for unknown operations", () => {
    expect(createChangeContext(validIndex(), "orders.missing", fixture("valid"))).toBeUndefined();
  });
});
