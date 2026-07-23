import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeProject,
  checkArchitecture,
  checkIndexStaleness,
  computeAffected,
  generateIndex,
  planVerification,
} from "./index.js";

const fixture = (name: "valid" | "invalid"): string =>
  fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("agent index compiler", () => {
  it("extracts statically declared metadata without loading application modules", () => {
    const index = analyzeProject({ rootDir: fixture("valid") });

    expect(index.diagnostics).toEqual([]);
    expect(index.unresolved).toEqual([]);
    expect(index.features.map(({ id }) => id)).toEqual(["customers", "orders"]);
    expect(index.features[0]?.consumers).toEqual(["orders"]);
    expect(index.features[1]?.contract.exports).toEqual([
      "ordersContract",
      "OrderView",
    ]);
    expect(index.operations).toMatchObject([
      {
        id: "orders.create",
        kind: "command",
        permissions: ["orders:create"],
        effects: [
          {
            name: "chargePayment",
            operationId: "payments.charge",
            kind: "external",
          },
        ],
        events: ["orders.created"],
        invariants: ["orders.customer-exists"],
        tests: ["src/features/orders/orders.agent-test.ts"],
      },
    ]);
    expect(index.sourceManifest.files.every(({ file }) => !file.startsWith("/"))).toBe(true);
    expect(index.likelyAffected.find(({ target }) => target === "customers")?.operations)
      .toEqual([
        {
          id: "orders.create",
          reason: "owned by transitive consumer 'orders'",
        },
      ]);
  });

  it("emits byte-identical, machine-independent JSON for unchanged sources", () => {
    const first = generateIndex({ rootDir: fixture("valid") });
    const second = generateIndex({ rootDir: fixture("valid") });

    expect(second.json).toBe(first.json);
    expect(first.json).not.toContain(fixture("valid"));
    expect(first.json.endsWith("\n")).toBe(true);
  });

  it("detects private feature imports, ambient effects, and invalid queries", () => {
    const diagnostics = checkArchitecture({ rootDir: fixture("invalid") });
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "architecture.private-cross-feature-import",
      "operation.query-write-effect",
      "operation.query-emits-event",
      "architecture.ambient-fetch",
      "architecture.ambient-environment",
    ]);
  });

  it("explains transitive consumers, preserving operations, and tests", () => {
    const affected = computeAffected(
      analyzeProject({ rootDir: fixture("valid") }),
      "customers",
      fixture("valid"),
    );

    expect(affected.widened).toBe(false);
    expect(affected.items.map(({ id }) => id)).toEqual([
      "customers",
      "orders",
      "orders.create",
      "orders.customer-exists",
      "src/features/orders/orders.agent-test.ts",
    ]);
    expect(affected.items.every(({ reasons }) => reasons.length > 0)).toBe(true);
  });

  it("widens shared and unowned changes instead of claiming a narrow scope", () => {
    const index = analyzeProject({ rootDir: fixture("valid") });
    const affected = computeAffected(index, "tsconfig.json", fixture("valid"));

    expect(affected.widened).toBe(true);
    expect(affected.items.map(({ id }) => id)).toContain("orders.create");
    expect(affected.diagnostics[0]).toContain("entire workspace");
  });

  it("maps an ordinary capsule source file to its owning feature", () => {
    const rootDir = fixture("valid");
    const affected = computeAffected(
      analyzeProject({ rootDir }),
      "src/features/orders/contract.ts",
      rootDir,
    );

    expect(affected.widened).toBe(false);
    expect(affected.items.map(({ id }) => id)).toEqual([
      "orders",
      "orders.create",
      "orders.customer-exists",
      "src/features/orders/orders.agent-test.ts",
    ]);
  });

  it("detects index staleness from a deterministic source manifest", () => {
    const temporary = mkdtempSync(join(tmpdir(), "agentix-compiler-"));
    temporaryDirectories.push(temporary);
    cpSync(fixture("valid"), temporary, { recursive: true });
    const index = analyzeProject({ rootDir: temporary });
    const contract = join(temporary, "src/features/orders/contract.ts");
    writeFileSync(contract, `${readFileSync(contract, "utf8")}\nexport type Changed = true;\n`);

    expect(checkIndexStaleness(index, temporary)).toEqual({
      stale: true,
      reason: "The deterministic source manifest differs from the generated index.",
    });
  });

  it("uses declared package verification scripts for a workspace scope", () => {
    const temporary = mkdtempSync(join(tmpdir(), "agentix-compiler-"));
    temporaryDirectories.push(temporary);
    cpSync(fixture("valid"), temporary, { recursive: true });
    writeFileSync(
      join(temporary, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "vitest run --root ../.." } }),
    );

    const plan = planVerification(
      analyzeProject({ rootDir: temporary }),
      "orders.create",
      temporary,
    );

    expect(plan.scope).toBe("workspace");
    expect(plan.typecheck).toEqual(["npm", "run", "typecheck"]);
    expect(plan.tests).toEqual(["npm", "test"]);
  });
});
