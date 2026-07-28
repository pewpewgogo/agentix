import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeProject,
  checkArchitecture,
  checkIndexStaleness,
  compareStrings,
  computeAffected,
  createOperationContext,
  createOperationDetail,
  featureSegmentOf,
  generateIndex,
  OPERATION_CONTEXT_BYTE_LIMIT,
  planVerification,
  stableJson,
} from "./index.js";

const fixture = (name: "valid" | "invalid"): string =>
  fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

const temporaryDirectories: string[] = [];

const temporaryFixture = (name: "valid" | "invalid"): string => {
  const temporary = mkdtempSync(join(tmpdir(), "agentix-compiler-"));
  temporaryDirectories.push(temporary);
  cpSync(fixture(name), temporary, { recursive: true });
  return temporary;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("agent index compiler", () => {
  it("extracts v2 single-file and directory features with derived ids", () => {
    const index = analyzeProject({ rootDir: fixture("valid") });

    expect(index.diagnostics).toEqual([]);
    expect(index.unresolved).toEqual([]);
    expect(index).not.toHaveProperty("likelyAffected");
    expect(index.features.map(({ id }) => id)).toEqual(["customers", "orders"]);
    expect(index.features[0]?.consumers).toEqual(["orders"]);
    expect(index.features[1]?.dependencies).toEqual(["customers"]);
    // The feature file is the public contract; export {} declarations count.
    // Codepoint order (locale-independent): uppercase before lowercase.
    expect(index.features[0]?.exports).toEqual([
      "Customer",
      "CustomerStore",
      "customers",
      "customersContractVersion",
    ]);
    expect(index.operations.map(({ id }) => id)).toEqual([
      "customers.create",
      "customers.get",
      "orders.create",
    ]);
    expect(index.operations[2]).toMatchObject({
      id: "orders.create",
      key: "create",
      symbol: "orders.operations.create",
      kind: "command",
      feature: "orders",
      permissions: ["orders:create"],
      effects: [
        { name: "chargePayment", operationId: "payments.charge", kind: "external" },
        { name: "loadCustomer", operationId: "customerStore.get", kind: "read" },
      ],
      events: ["orders.created"],
      ensures: ["chargedOnce"],
      tests: ["src/features/orders/orders.test.ts"],
    });
    // Standalone `const create = command(...)` referenced by shorthand resolves.
    expect(index.operations[0]).toMatchObject({
      id: "customers.create",
      kind: "command",
      effects: [
        { name: "load", operationId: "customerStore.get", kind: "read" },
        { name: "save", operationId: "customerStore.save", kind: "write" },
      ],
    });
    expect(index.events).toMatchObject([
      { id: "orders.created", version: 1, feature: "orders" },
    ]);
    expect(index.sourceManifest.files.every(({ file }) => !file.startsWith("/"))).toBe(true);
  });

  it("expands port.store into its four operations and keys explicit port ops", () => {
    const index = analyzeProject({ rootDir: fixture("valid") });

    expect(index.ports.map(({ id }) => id)).toEqual(["customerStore", "payments"]);
    expect(index.ports[0]?.operations.map(({ id, kind }) => `${id}:${kind}`)).toEqual([
      "customerStore.delete:write",
      "customerStore.get:read",
      "customerStore.list:read",
      "customerStore.save:write",
    ]);
    expect(index.ports[0]?.operations[0]?.signature).toContain('port.store("customerStore", Customer)');
    expect(index.ports[1]?.operations).toMatchObject([
      { id: "payments.charge", name: "charge", kind: "external" },
    ]);
    expect(index.ports[1]?.operations[0]?.signature).toContain("port.external");
  });

  it("derives unified error metadata and http routes with error statuses", () => {
    const index = analyzeProject({ rootDir: fixture("valid") });
    const create = index.operations.find(({ id }) => id === "orders.create");
    const get = index.operations.find(({ id }) => id === "customers.get");

    const idDetails = { type: "object", fields: { id: { type: "string" } } };
    const reasonDetails = { type: "object", fields: { reason: { type: "string" } } };
    expect(create?.errors).toEqual([
      { code: "CUSTOMER_NOT_FOUND", details: "{ id: s.string() }", detailsDescription: idDetails },
      {
        code: "ORDER_INVALID",
        details: "s.object({ reason: s.string() })",
        detailsDescription: reasonDetails,
      },
      {
        code: "PAYMENT_FAILED",
        http: 402,
        details: "{ reason: s.string() }",
        detailsDescription: reasonDetails,
      },
    ]);
    expect(create?.http).toEqual({
      method: "POST",
      path: "/orders",
      status: 201,
      errorStatus: { PAYMENT_FAILED: 402 },
    });
    expect(get?.http).toEqual({
      method: "GET",
      path: "/customers/:id",
      errorStatus: { CUSTOMER_NOT_FOUND: 404 },
    });
  });

  it("embeds bounded source excerpts for schemas, execute, and port operations", () => {
    const rootDir = fixture("valid");
    const index = analyzeProject({ rootDir });
    const create = index.operations.find(({ id }) => id === "orders.create");

    expect(create?.input?.text).toBe("OrderDraft");
    expect(create?.input?.declaration).toContain("OrderDraft = s.object(");
    expect(create?.input?.source?.file).toBe("src/features/orders/model.ts");
    expect(create?.executeSignature).toBe("async execute({ input, effects, emit, fail })");

    const context = createOperationContext(index, "orders.create", rootDir);
    expect(context?.excerpts?.input).toContain("OrderDraft = s.object(");
    expect(context?.excerpts?.execute).toBe("async execute({ input, effects, emit, fail })");
    expect(context?.excerpts?.errors).toContainEqual({
      code: "PAYMENT_FAILED",
      text: "{ reason: s.string() }",
    });
    expect(context?.excerpts?.effects).toContainEqual(
      expect.objectContaining({ name: "chargePayment" }),
    );
  });

  it("caps every source excerpt at 1 KiB", () => {
    const temporary = temporaryFixture("valid");
    const fields = Array.from({ length: 80 }, (_, index) => `f${index}: s.string({ min: 1 })`);
    writeFileSync(
      join(temporary, "src/features/bulk.ts"),
      `import { feature, query, s } from "@agentixdev/core";\n\n` +
      `export const Bulk = s.object({ ${fields.join(", ")} });\n\n` +
      `export const bulk = feature("bulk", {\n` +
      `  operations: {\n` +
      `    read: query({ input: Bulk, output: Bulk, async execute({ input }) { return input; } }),\n` +
      `  },\n` +
      `});\n`,
      "utf8",
    );

    const operation = analyzeProject({ rootDir: temporary }).operations
      .find(({ id }) => id === "bulk.read");
    expect(operation?.input?.declaration?.length).toBe(1024);
    expect(operation?.input?.declaration?.endsWith("…")).toBe(true);
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
      schemaVersion: "2",
      artifactKind: "operation-context",
      id: "orders.create",
      key: "create",
      errors: [
        { code: "CUSTOMER_NOT_FOUND" },
        { code: "ORDER_INVALID" },
        { code: "PAYMENT_FAILED", http: 402 },
      ],
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
      errors: Array.from({ length: 100 }, (_, index) => ({
        code: repeated("error", index),
        http: 500,
        details: repeated("details", index),
      })),
      events: Array.from({ length: 100 }, (_, index) => repeated("event", index)),
      ensures: Array.from({ length: 100 }, (_, index) => repeated("ensure", index)),
      tests: Array.from({ length: 100 }, (_, index) => repeated("test", index)),
      input: { text: repeated("input", 0), declaration: repeated("input-decl", 0) },
      executeSignature: repeated("execute", 0),
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
          id: `customers.extra${index}`,
          key: `extra${index}`,
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
        (_, index) => `${operation.id} unresolved ${repeated("edge", index)}`,
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
    const affected = computeAffected(oversized, operation.id, rootDir);
    expect(affected.widened).toBe(true);
    expect(context.affected).toMatchObject({
      widened: true,
      totalItems: affected.items.length,
      items: [],
    });
    expect(context.affected.totalItems).toBeGreaterThan(100);
    expect(context).not.toHaveProperty("excerpts");
    expect(context.projection.omissions).toContainEqual(expect.objectContaining({
      path: "affected.items",
      included: 0,
    }));
    expect(context.projection.omissions).toContainEqual(expect.objectContaining({
      path: "excerpts",
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
          operation.id,
        ],
      },
    }));
    const detail = createOperationDetail(oversized, operation.id, rootDir);
    expect(detail?.artifactKind).toBe("operation-detail");
    expect(detail?.schemaVersion).toBe("2");
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
      project: { errors: 7, warnings: 0, unresolved: 0 },
    });
    expect(context?.analysis.targetDiagnostics.map(({ code }) => code)).toEqual([
      "architecture.private-cross-feature-import",
      "operation.query-write-effect",
      "operation.query-emits-event",
      "architecture.ambient-fetch",
      "architecture.ambient-time",
      "architecture.ambient-randomness",
      "architecture.ambient-environment",
    ]);
  });

  it("still bans ambient effects and private imports inside v2 feature files", () => {
    const diagnostics = checkArchitecture({ rootDir: fixture("invalid") });
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "architecture.private-cross-feature-import",
      "operation.query-write-effect",
      "operation.query-emits-event",
      "architecture.ambient-fetch",
      "architecture.ambient-time",
      "architecture.ambient-randomness",
      "architecture.ambient-environment",
    ]);
  });

  it("explains transitive consumers, derived operations, and tests", () => {
    const affected = computeAffected(
      analyzeProject({ rootDir: fixture("valid") }),
      "customers",
      fixture("valid"),
    );

    expect(affected.widened).toBe(false);
    expect(affected.items.map(({ id }) => id)).toEqual([
      "customers",
      "customers.create",
      "customers.get",
      "orders",
      "orders.create",
      "src/features/customers.test.ts",
      "src/features/orders/orders.test.ts",
    ]);
    expect(affected.items.every(({ reasons }) => reasons.length > 0)).toBe(true);
  });

  it("traverses from a port operation to every declaring operation", () => {
    const affected = computeAffected(
      analyzeProject({ rootDir: fixture("valid") }),
      "customerStore.get",
      fixture("valid"),
    );

    expect(affected.widened).toBe(false);
    // Codepoint order (locale-independent): "customerS" < "customers".
    expect(affected.items.map(({ id }) => id)).toEqual([
      "customerStore.get",
      "customers.create",
      "customers.get",
      "orders.create",
      "src/features/customers.test.ts",
      "src/features/orders/orders.test.ts",
    ]);
  });

  it("widens shared and unowned changes instead of claiming a narrow scope", () => {
    const index = analyzeProject({ rootDir: fixture("valid") });
    const affected = computeAffected(index, "tsconfig.json", fixture("valid"));

    expect(affected.widened).toBe(true);
    expect(affected.items.map(({ id }) => id)).toContain("orders.create");
    expect(affected.diagnostics[0]).toContain("entire workspace");
  });

  it("maps a single-file feature path and a capsule source to their owners", () => {
    const rootDir = fixture("valid");
    const index = analyzeProject({ rootDir });

    const byFeatureFile = computeAffected(index, "src/features/customers.ts", rootDir);
    expect(byFeatureFile.widened).toBe(false);
    expect(byFeatureFile.items.map(({ id }) => id)).toContain("orders.create");
    expect(byFeatureFile.items.map(({ id }) => id)).toContain("customerStore.get");

    const byCapsuleFile = computeAffected(index, "src/features/orders/model.ts", rootDir);
    expect(byCapsuleFile.widened).toBe(false);
    expect(byCapsuleFile.items.map(({ id }) => id)).toEqual([
      "orders",
      "orders.create",
      "src/features/orders/orders.test.ts",
    ]);
  });

  it("scopes unresolved-edge widening to the owning feature's subgraph", () => {
    const temporary = temporaryFixture("valid");
    writeFileSync(
      join(temporary, "src/features/billing.ts"),
      `import { feature, query, s } from "@agentixdev/core";\n\n` +
      `export const billing = feature("billing", {\n` +
      `  operations: {\n` +
      `    list: query({ input: s.object({}), output: s.object({}), async execute() { return {}; } }),\n` +
      `  },\n` +
      `});\n`,
      "utf8",
    );
    writeFileSync(
      join(temporary, "src/features/orders/dynamic.ts"),
      `export const load = (name: string) => import(name);\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });
    expect(index.unresolved.some((entry) => entry.includes("dynamic.ts"))).toBe(true);

    const affected = computeAffected(index, "billing", temporary);
    expect(affected.widened).toBe(false);
    expect(affected.items.map(({ id }) => id)).toEqual([
      "billing",
      "billing.list",
      "orders",
      "orders.create",
      "src/features/orders/orders.test.ts",
    ]);
    const orders = affected.items.find(({ id }) => id === "orders");
    expect(orders?.reasons[0]?.edge).toBe("conservative-widening");
  });

  it("widens globally when unresolved edges cannot be attributed to a feature", () => {
    const temporary = temporaryFixture("valid");
    writeFileSync(
      join(temporary, "src/features/broken.ts"),
      `import { feature } from "@agentixdev/core";\n\n` +
      `const dynamicId = "broken" as string;\n` +
      `export const broken = feature(dynamicId, { operations: {} });\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });
    const affected = computeAffected(index, "customers", temporary);
    expect(affected.widened).toBe(true);
    expect(affected.diagnostics[0]).toContain("outside any indexed feature");
  });

  it("plans narrow verification for root-tsconfig applications", () => {
    const temporary = temporaryFixture("valid");
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

    const index = analyzeProject({ rootDir: temporary });
    const plan = planVerification(index, "orders.create", temporary);

    expect(plan.scope).toBe("project");
    expect(plan.typecheck).toEqual(["npm", "exec", "--", "tsc", "-b", ".", "--pretty", "false"]);
    expect(plan.testFiles).toEqual(["src/features/orders/orders.test.ts"]);
    expect(plan.tests).toEqual([
      "npm",
      "exec",
      "--",
      "vitest",
      "run",
      "src/features/orders/orders.test.ts",
    ]);
  });

  it("re-anchors narrow test filters when the vitest config sits above the app", () => {
    const monorepo = mkdtempSync(join(tmpdir(), "agentix-compiler-"));
    temporaryDirectories.push(monorepo);
    const application = join(monorepo, "apps", "shop");
    cpSync(fixture("valid"), application, { recursive: true });
    writeFileSync(join(monorepo, "vitest.config.ts"), "export default {};\n", "utf8");
    writeFileSync(
      join(application, "tsconfig.json"),
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

    const index = analyzeProject({ rootDir: application });
    const plan = planVerification(index, "orders.create", application);

    expect(plan.scope).toBe("project");
    expect(plan.testFiles).toEqual(["src/features/orders/orders.test.ts"]);
    expect(plan.tests).toEqual([
      "npm",
      "exec",
      "--",
      "vitest",
      "run",
      "--root",
      "../..",
      "apps/shop/src/features/orders/orders.test.ts",
    ]);
  });

  it("keeps app-relative test filters when the vitest config sits at the app root", () => {
    const monorepo = mkdtempSync(join(tmpdir(), "agentix-compiler-"));
    temporaryDirectories.push(monorepo);
    const application = join(monorepo, "apps", "shop");
    cpSync(fixture("valid"), application, { recursive: true });
    // A workspace-root config exists, but the nearer app-local config wins.
    writeFileSync(join(monorepo, "vitest.config.ts"), "export default {};\n", "utf8");
    writeFileSync(join(application, "vitest.config.ts"), "export default {};\n", "utf8");
    writeFileSync(
      join(application, "tsconfig.json"),
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

    const index = analyzeProject({ rootDir: application });
    const plan = planVerification(index, "orders.create", application);

    expect(plan.scope).toBe("project");
    expect(plan.tests).toEqual([
      "npm",
      "exec",
      "--",
      "vitest",
      "run",
      "src/features/orders/orders.test.ts",
    ]);
  });

  it("indexes explicit operation tests outside a feature directory", () => {
    const temporary = temporaryFixture("valid");
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
      `import { orders } from "./features/orders/feature.js";\n\n` +
      `export const acceptance = associateOperationTest(orders.operations.create, "orders.acceptance");\n`,
      "utf8",
    );

    const operation = analyzeProject({ rootDir: temporary }).operations
      .find(({ id }) => id === "orders.create");
    expect(operation?.tests).toContain("src/orders.acceptance.test.ts");
  });

  it("detects index staleness from a deterministic source manifest", () => {
    const temporary = temporaryFixture("valid");
    const index = analyzeProject({ rootDir: temporary });
    const featureFile = join(temporary, "src/features/customers.ts");
    writeFileSync(featureFile, `${readFileSync(featureFile, "utf8")}\nexport type Changed = true;\n`);

    expect(checkIndexStaleness(index, temporary)).toEqual({
      stale: true,
      reason: "The deterministic source manifest differs from the generated index.",
    });
  });

  it("treats incompatible index schema and compiler versions as stale", () => {
    const rootDir = fixture("valid");
    const index = analyzeProject({ rootDir });

    expect(checkIndexStaleness(index, rootDir)).toEqual({ stale: false });
    expect(checkIndexStaleness({ ...index, schemaVersion: "1" as never }, rootDir))
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

  it("diagnoses spread and computed operation members instead of dropping them", () => {
    const temporary = temporaryFixture("valid");
    writeFileSync(
      join(temporary, "src/features/alpha.ts"),
      `import { command, feature, port, query, s } from "@agentixdev/core";\n\n` +
      `export const Note = s.object({ id: s.string({ min: 1 }) });\n` +
      `export const NoteStorage = port.store("noteStorage2", Note);\n\n` +
      `const extraOps = {\n` +
      `  archive: command({ input: s.object({}), output: s.boolean(), async execute() { return true; } }),\n` +
      `};\n\n` +
      `export const alpha = feature("alpha", {\n` +
      `  operations: {\n` +
      `    ...extraOps,\n` +
      `    create: command({ input: s.object({}), output: s.boolean(), async execute() { return true; } }),\n` +
      `    ["publish"]: command({ input: s.object({}), output: s.boolean(), async execute() { return true; } }),\n` +
      `    get: query({ input: s.object({}), output: s.boolean(), async execute() { return true; } }),\n` +
      `  },\n` +
      `});\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });

    // One diagnostic for the spread, one for the computed key — never silence.
    const violations = index.diagnostics.filter(
      ({ code, source }) =>
        code === "metadata.static-operation-required" && source.file === "src/features/alpha.ts",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every(({ severity }) => severity === "error")).toBe(true);
    const unresolved = index.unresolved.filter((entry) =>
      entry.includes("non-static operation member in feature 'alpha'"),
    );
    expect(unresolved).toHaveLength(2);
    const operationIds = index.operations.map(({ id }) => id);
    expect(operationIds).toContain("alpha.create");
    expect(operationIds).toContain("alpha.get");
    expect(operationIds).not.toContain("alpha.archive");
    expect(operationIds).not.toContain("alpha.publish");
    // The unresolved entries widen alpha's subgraph conservatively.
    const affected = computeAffected(index, "alpha.get", temporary);
    expect(affected.items.map(({ id }) => id)).toContain("alpha");
    expect(affected.items.map(({ id }) => id)).toContain("alpha.create");
  });

  it("diagnoses spread port operations instead of dropping them", () => {
    const temporary = temporaryFixture("valid");
    writeFileSync(
      join(temporary, "src/features/gadgets.ts"),
      `import { feature, port, s } from "@agentixdev/core";\n\n` +
      `const extra = {\n` +
      `  ping: port.external({ input: s.object({}), output: s.object({}) }),\n` +
      `};\n\n` +
      `export const Gadgets = port("gadgetStore", {\n` +
      `  ...extra,\n` +
      `  poke: port.write({ input: s.object({}), output: s.object({}) }),\n` +
      `});\n\n` +
      `export const gadgets = feature("gadgets", { operations: {} });\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });

    expect(index.diagnostics).toContainEqual(expect.objectContaining({
      code: "metadata.static-operation-required",
      severity: "error",
      source: expect.objectContaining({ file: "src/features/gadgets.ts" }),
    }));
    expect(
      index.unresolved.some((entry) => entry.includes("non-static port operation in 'gadgetStore'")),
    ).toBe(true);
    const gadgetOps = index.ports.find(({ id }) => id === "gadgetStore")?.operations;
    expect(gadgetOps?.map(({ id }) => id)).toEqual(["gadgetStore.poke"]);
  });

  it("widens the owning feature's subgraph when effects or emits hide behind a spread", () => {
    const temporary = temporaryFixture("valid");
    writeFileSync(
      join(temporary, "src/features/alpha.ts"),
      `import { command, event, feature, port, s } from "@agentixdev/core";\n\n` +
      `export const Note = s.object({ id: s.string({ min: 1 }) });\n` +
      `export const NoteStorage = port.store("noteStorage", Note);\n` +
      `export const NoteCreated = event("alpha.note-created", 1, Note);\n\n` +
      `const loadSave = { load: NoteStorage.get, save: NoteStorage.save };\n` +
      `const announcements = { created: NoteCreated };\n\n` +
      `export const alpha = feature("alpha", {\n` +
      `  events: [NoteCreated],\n` +
      `  operations: {\n` +
      `    create: command({\n` +
      `      input: Note,\n` +
      `      output: Note,\n` +
      `      effects: { ...loadSave },\n` +
      `      emits: { ...announcements },\n` +
      `      async execute({ input, effects }) { return effects.save(input); },\n` +
      `    }),\n` +
      `  },\n` +
      `});\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });

    expect(index.diagnostics).toContainEqual(expect.objectContaining({
      code: "metadata.static-effect-required",
      severity: "warning",
    }));
    expect(index.diagnostics).toContainEqual(expect.objectContaining({
      code: "metadata.static-emit-required",
      severity: "warning",
    }));
    expect(index.unresolved.some((entry) =>
      entry.includes("unresolved effects spread in operation 'alpha.create'"),
    )).toBe(true);
    expect(index.unresolved.some((entry) =>
      entry.includes("unresolved emits spread in operation 'alpha.create'"),
    )).toBe(true);

    // The spread hides the operation-effect edge, so the port operation alone
    // no longer proves a narrow closure: alpha's whole subgraph is included.
    const affected = computeAffected(index, "noteStorage.save", temporary);
    const items = affected.items.map(({ id }) => id);
    expect(items).toContain("noteStorage.save");
    expect(items).toContain("alpha");
    expect(items).toContain("alpha.create");
    const alphaItem = affected.items.find(({ id }) => id === "alpha");
    expect(alphaItem?.reasons.some(({ edge }) => edge === "conservative-widening")).toBe(true);
  });

  it("errors when a file declares more than one feature", () => {
    const temporary = temporaryFixture("valid");
    writeFileSync(
      join(temporary, "src/features/pair.ts"),
      `import { command, feature, s } from "@agentixdev/core";\n\n` +
      `export const first = feature("first", {\n` +
      `  operations: {\n` +
      `    create: command({ input: s.object({}), output: s.boolean(), async execute() { return true; } }),\n` +
      `  },\n` +
      `});\n\n` +
      `export const second = feature("second", {\n` +
      `  operations: {\n` +
      `    create: command({ input: s.object({}), output: s.boolean(), async execute() { return true; } }),\n` +
      `  },\n` +
      `});\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });

    // Both features stay indexed, but the file carries a verify-failing error.
    expect(index.features.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["first", "second"]),
    );
    expect(index.operations.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["first.create", "second.create"]),
    );
    const violation = index.diagnostics.find(
      ({ code }) => code === "architecture.one-feature-per-file",
    );
    expect(violation).toMatchObject({
      severity: "error",
      source: expect.objectContaining({ file: "src/features/pair.ts" }),
    });
    expect(violation?.message).toContain("'second'");
    expect(violation?.message).toContain("'first'");
    expect(checkArchitecture({ rootDir: temporary }).map(({ code }) => code))
      .toContain("architecture.one-feature-per-file");
  });

  it("maps dotted single-file siblings to the first-dot feature segment", () => {
    expect(featureSegmentOf("src/features/notes.ts")).toBe("notes");
    expect(featureSegmentOf("src/features/notes.test.ts")).toBe("notes");
    expect(featureSegmentOf("src/features/notes.integration.test.ts")).toBe("notes");
    expect(featureSegmentOf("src/features/notes.helpers.ts")).toBe("notes");
    expect(featureSegmentOf("src/features/notes/anything.ts")).toBe("notes");
    expect(featureSegmentOf("src/other/notes.ts")).toBeUndefined();
  });

  it("associates dotted colocated tests and allows same-feature helper imports", () => {
    const temporary = temporaryFixture("valid");
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
      join(temporary, "src/features/notes.helpers.ts"),
      `export const normalizeTitle = (title: string): string => title.trim();\n`,
      "utf8",
    );
    writeFileSync(
      join(temporary, "src/features/notes.ts"),
      `import { command, feature, s } from "@agentixdev/core";\n` +
      `import { normalizeTitle } from "./notes.helpers.js";\n\n` +
      `export const notes = feature("notes", {\n` +
      `  operations: {\n` +
      `    create: command({ input: s.object({ title: s.string() }), output: s.string(), async execute({ input }) { return normalizeTitle(input.title); } }),\n` +
      `  },\n` +
      `});\n`,
      "utf8",
    );
    writeFileSync(
      join(temporary, "src/features/notes.test.ts"),
      `import { notes } from "./notes.js";\n\nexport const covered = notes.operations.create;\n`,
      "utf8",
    );
    writeFileSync(
      join(temporary, "src/features/notes.integration.test.ts"),
      `import { notes } from "./notes.js";\n\nexport const integration = notes.operations.create;\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });

    // (b) importing your own dotted helper is NOT a cross-feature import.
    expect(index.diagnostics.filter(
      ({ code }) => code === "architecture.private-cross-feature-import",
    )).toEqual([]);
    expect(index.unresolved).toEqual([]);

    // (a) the dotted test file binds to feature "notes", not a phantom
    // "notes.integration" feature with zero operations.
    const integration = index.tests.find(
      ({ id }) => id === "src/features/notes.integration.test.ts",
    );
    expect(integration?.features).toEqual(["notes"]);
    expect(integration?.operations).toEqual(["notes.create"]);

    const affected = computeAffected(index, "notes.create", temporary);
    expect(affected.widened).toBe(false);
    expect(affected.items.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "src/features/notes.integration.test.ts",
      "src/features/notes.test.ts",
    ]));

    const plan = planVerification(index, "notes.create", temporary);
    expect(plan.scope).toBe("project");
    expect(plan.testFiles).toEqual([
      "src/features/notes.integration.test.ts",
      "src/features/notes.test.ts",
    ]);
  });

  it("orders strings by code unit, independent of the process locale", () => {
    // localeCompare would give a < B and é < z; codepoint order must not.
    expect(compareStrings("a", "B")).toBeGreaterThan(0);
    expect(compareStrings("B", "a")).toBeLessThan(0);
    expect(compareStrings("é", "z")).toBeGreaterThan(0);
    expect(compareStrings("z", "é")).toBeLessThan(0);
    expect(compareStrings("same", "same")).toBe(0);
    expect(["é", "z", "a", "B"].sort(compareStrings)).toEqual(["B", "a", "z", "é"]);
    expect(stableJson({ "é": 1, a: 2, B: 3 }, { compact: true }))
      .toBe('{"B":3,"a":2,"é":1}\n');
  });

  it("anchors dash-leading test filters so vitest cannot parse them as flags", () => {
    const temporary = temporaryFixture("valid");
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
      join(temporary, "--shard.test.ts"),
      `import { associateOperationTest } from "@agentixdev/testing";\n` +
      `import { orders } from "./src/features/orders/feature.js";\n\n` +
      `export const sharded = associateOperationTest(orders.operations.create, "orders.sharded");\n`,
      "utf8",
    );

    const index = analyzeProject({ rootDir: temporary });
    const plan = planVerification(index, "orders.create", temporary);

    expect(plan.scope).toBe("project");
    // testFiles ids stay unchanged; only the vitest argv gets the ./ anchor.
    expect(plan.testFiles).toEqual([
      "--shard.test.ts",
      "src/features/orders/orders.test.ts",
    ]);
    expect(plan.tests).toEqual([
      "npm",
      "exec",
      "--",
      "vitest",
      "run",
      "./--shard.test.ts",
      "src/features/orders/orders.test.ts",
    ]);
  });

  it("uses declared package verification scripts for a workspace scope", () => {
    const temporary = temporaryFixture("valid");
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
