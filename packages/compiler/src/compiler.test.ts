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
  createOperationContext,
  createOperationDetail,
  generateIndex,
  OPERATION_CONTEXT_BYTE_LIMIT,
  planVerification,
  stableJson,
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

  it("serializes the same stable value without indentation for compact transport", () => {
    const value = { z: [3, { b: 2, a: 1 }], a: "first" };
    const pretty = stableJson(value);
    const compact = stableJson(value, { compact: true });

    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
    expect(compact).toBe('{"a":"first","z":[3,{"a":1,"b":2}]}\n');
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(pretty));
  });

  it("projects bounded, source-bound context for one operation", () => {
    const rootDir = fixture("valid");
    const index = analyzeProject({ rootDir });
    const first = createOperationContext(index, "orders.create", rootDir);
    const second = createOperationContext(index, "orders.create", rootDir);

    expect(first).toBeDefined();
    expect(stableJson(second)).toBe(stableJson(first));
    const json = stableJson(first);
    expect(Buffer.byteLength(json)).toBeLessThan(8 * 1024);
    expect(first).toMatchObject({
      artifactKind: "operation-context",
      id: "orders.create",
      projection: {
        byteLimit: OPERATION_CONTEXT_BYTE_LIMIT,
        truncated: false,
        omissions: [],
      },
      analysis: {
        agentixValid: true,
        complete: true,
        typecheck: "not-run",
        project: { errors: 0, warnings: 0, unresolved: 0 },
        targetDiagnostics: [],
      },
    });
    expect(first?.analysis.sourceDigest).toBe(index.sourceManifest.digest);
    expect(first).not.toHaveProperty("features");
    expect(first).not.toHaveProperty("ports");
    expect(first).not.toHaveProperty("edges");
    expect(first).not.toHaveProperty("likelyAffected");
    expect(first).not.toHaveProperty("sourceManifest.files");
  });

  it("summarizes widened and oversized context within a hard byte limit", () => {
    const rootDir = fixture("valid");
    const base = analyzeProject({ rootDir });
    const operation = base.operations[0];
    expect(operation).toBeDefined();
    if (operation === undefined) return;
    const repeated = (label: string, index: number): string =>
      `${label}.${index}.${"x".repeat(400)}`;
    const oversizedOperation = {
      ...operation,
      permissions: Array.from({ length: 100 }, (_, index) => repeated("permission", index)),
      errors: Array.from({ length: 100 }, (_, index) => repeated("error", index)),
      events: Array.from({ length: 100 }, (_, index) => repeated("event", index)),
      invariants: Array.from({ length: 100 }, (_, index) => repeated("invariant", index)),
      tests: Array.from({ length: 100 }, (_, index) => repeated("test", index)),
      effects: Array.from({ length: 100 }, (_, index) => ({
        name: repeated("effect", index),
        reference: repeated("Port.effect", index),
        operationId: repeated("port.effect", index),
        kind: "external" as const,
      })),
    };
    const oversized = {
      ...base,
      operations: [
        oversizedOperation,
        ...Array.from({ length: 100 }, (_, index) => ({
          ...operation,
          id: `orders.extra.${index}`,
          symbol: `extra${index}`,
        })),
      ],
      diagnostics: Array.from({ length: 40 }, (_, index) => ({
        code: `oversized.${index}`,
        severity: "error" as const,
        message: repeated("diagnostic", index),
        source: operation.source,
      })),
      unresolved: Array.from(
        { length: 100 },
        (_, index) => `orders.create unresolved ${repeated("edge", index)}`,
      ),
    };

    const context = createOperationContext(oversized, operation.id, rootDir);
    expect(context).toBeDefined();
    if (context === undefined) return;
    expect(Buffer.byteLength(stableJson(context))).toBeLessThanOrEqual(
      OPERATION_CONTEXT_BYTE_LIMIT,
    );
    expect(context.analysis.complete).toBe(false);
    expect(context.projection.truncated).toBe(true);
    expect(context.id).toBe(operation.id);
    expect(context.source).toEqual(operation.source);
    const workspacePlan = planVerification(oversized, "tsconfig.json", rootDir);
    expect(context.verification.typecheck).toEqual(workspacePlan.typecheck);
    expect(context.verification.tests).toEqual(workspacePlan.tests);
    expect(context.affected).toMatchObject({
      widened: true,
      totalItems: 108,
      items: [],
    });
    expect(context.projection.omissions).toContainEqual(expect.objectContaining({
      path: "affected.items",
      total: 108,
      included: 0,
    }));
    expect(context.projection.omissions).toContainEqual(expect.objectContaining({
      path: "permissions",
      total: 100,
      expand: {
        kind: "command",
        cwd: "application-root",
        argv: [
          "npm",
          "exec",
          "--",
          "agentix",
          "inspect",
          "--full",
          "--root",
          ".",
          "--json",
          "--",
          "orders.create",
        ],
      },
    }));
    const detail = createOperationDetail(oversized, operation.id, rootDir);
    expect(detail?.artifactKind).toBe("operation-detail");
    expect(detail?.permissions).toHaveLength(100);
    expect(detail?.analysis.targetUnresolved).toHaveLength(100);
  });

  it("makes target and project compiler failures visible in operation context", () => {
    const rootDir = fixture("invalid");
    const context = createOperationContext(
      analyzeProject({ rootDir }),
      "orders.unsafe",
      rootDir,
    );

    expect(context?.analysis).toMatchObject({
      agentixValid: false,
      complete: true,
      typecheck: "not-run",
      project: { errors: 5, warnings: 0, unresolved: 0 },
    });
    expect(context?.analysis.targetDiagnostics.map(({ code }) => code)).toEqual([
      "architecture.private-cross-feature-import",
      "operation.query-write-effect",
      "operation.query-emits-event",
      "architecture.ambient-fetch",
      "architecture.ambient-environment",
    ]);
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

  it("indexes explicit operation tests outside a feature directory", () => {
    const temporary = mkdtempSync(join(tmpdir(), "agentix-compiler-root-test-"));
    temporaryDirectories.push(temporary);
    cpSync(fixture("valid"), temporary, { recursive: true });
    writeFileSync(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      }),
      "utf8",
    );
    writeFileSync(
      join(temporary, "src/orders.acceptance.test.ts"),
      `import { associateOperationTest } from "@agentixdev/testing";\n` +
      `import { createOrder } from "./features/orders/operations.js";\n\n` +
      `export const acceptance = associateOperationTest(createOrder, "orders.acceptance");\n`,
      "utf8",
    );

    const operation = analyzeProject({ rootDir: temporary }).operations
      .find(({ id }) => id === "orders.create");
    expect(operation?.tests).toContain("src/orders.acceptance.test.ts");
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

  it("treats incompatible index schema and compiler versions as stale", () => {
    const rootDir = fixture("valid");
    const index = analyzeProject({ rootDir });

    expect(checkIndexStaleness({ ...index, schemaVersion: "0" as never }, rootDir))
      .toEqual({
        stale: true,
        reason: "The generated index uses an incompatible schema or compiler version.",
      });
    expect(checkIndexStaleness({ ...index, compilerVersion: "0.0.0" as never }, rootDir))
      .toEqual({
        stale: true,
        reason: "The generated index uses an incompatible schema or compiler version.",
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
