import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ExitCode, runCli, type CliIO, type ProcessRunner } from "./index.js";

const compilerFixture = (name: "valid" | "invalid"): string =>
  fileURLToPath(new URL(`../../compiler/test/fixtures/${name}`, import.meta.url));

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

const temporaryDirectories: string[] = [];

const copyFixture = (name: "valid" | "invalid", parent = tmpdir()): string => {
  // Dot-prefixed so stray copies inside the package never match test globs.
  const temporary = mkdtempSync(join(parent, ".agentix-cli-"));
  temporaryDirectories.push(temporary);
  const project = join(temporary, "project");
  cpSync(compilerFixture(name), project, { recursive: true });
  return project;
};

const compileScaffold = (cwd: string, files: readonly string[]): void => {
  execFileSync(
    fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      ...files.map((file) => join(cwd, file)),
    ],
    { cwd, stdio: "pipe" },
  );
};

const capture = (): {
  readonly io: CliIO;
  readonly stdout: string[];
  readonly stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("agentix CLI", () => {
  it("prints complete global or subcommand help without an error exit", () => {
    for (const args of [["--help"], ["inspect", "--help"]]) {
      const output = capture();
      expect(runCli(args, { cwd: copyFixture("valid"), io: output.io }))
        .toBe(ExitCode.success);
      expect(output.stderr).toEqual([]);
      const help = output.stdout.join("");
      expect(help).toContain(
        "inspect <feature-or-operation> [--json [--compact]] [--root <directory>]",
      );
      expect(help).toContain(
        "inspect <operation> --full [--json [--compact]] [--root <directory>]",
      );
    }
  });

  it("inspects a feature as deterministic structured JSON", () => {
    const cwd = copyFixture("valid");
    const output = capture();

    const exitCode = runCli(["inspect", "orders", "--json"], {
      cwd,
      io: output.io,
    });

    expect(exitCode).toBe(ExitCode.success);
    expect(output.stderr).toEqual([]);
    const parsed = JSON.parse(output.stdout.join("")) as {
      readonly id: string;
      readonly kind: string;
      readonly schemaVersion: string;
      readonly exports: readonly string[];
      readonly dependencies: readonly string[];
      readonly events: readonly string[];
      readonly operations: readonly string[];
      readonly verification: { readonly scope: string };
    };
    expect(parsed).toMatchObject({
      id: "orders",
      kind: "feature",
      schemaVersion: "2",
      dependencies: ["customers"],
      events: ["orders.created"],
      operations: ["orders.create"],
      verification: { scope: "workspace" },
    });
    expect(parsed.exports).toContain("orders");
    expect(parsed).not.toHaveProperty("invariants");
    expect(existsSync(join(cwd, ".agentix/index.json"))).toBe(true);
  });

  it("inspects one operation as bounded v2 context with source excerpts", () => {
    const cwd = copyFixture("valid");
    const output = capture();

    const exitCode = runCli(["inspect", "orders.create", "--json"], {
      cwd,
      io: output.io,
    });

    expect(exitCode).toBe(ExitCode.success);
    expect(output.stderr).toEqual([]);
    const json = output.stdout.join("");
    expect(Buffer.byteLength(json)).toBeLessThan(8 * 1024);
    const parsed = JSON.parse(json) as {
      readonly id: string;
      readonly artifactKind: string;
      readonly errors: readonly { readonly code: string; readonly http?: number }[];
      readonly http: { readonly errorStatus: Record<string, number> };
      readonly ensures: readonly string[];
      readonly excerpts: {
        readonly input?: string;
        readonly execute?: string;
      };
      readonly analysis: {
        readonly agentixValid: boolean;
        readonly complete: boolean;
        readonly typecheck: string;
        readonly project: { readonly errors: number };
      };
    };
    expect(parsed).toMatchObject({
      id: "orders.create",
      artifactKind: "operation-context",
      schemaVersion: "2",
      errors: [
        { code: "CUSTOMER_NOT_FOUND" },
        { code: "ORDER_INVALID" },
        { code: "PAYMENT_FAILED", http: 402 },
      ],
      http: {
        method: "POST",
        path: "/orders",
        status: 201,
        errorStatus: { PAYMENT_FAILED: 402 },
      },
      ensures: ["chargedOnce"],
      analysis: {
        agentixValid: true,
        complete: true,
        typecheck: "not-run",
        project: { errors: 0 },
      },
    });
    expect(parsed.excerpts.input).toContain("OrderDraft = s.object(");
    expect(parsed.excerpts.execute).toBe("async execute({ input, effects, emit, fail })");
    expect(parsed).not.toHaveProperty("features");
    expect(parsed).not.toHaveProperty("sourceManifest");
  });

  it("formats operations and features for humans with v2 metadata", () => {
    const cwd = copyFixture("valid");
    const operation = capture();
    const feature = capture();

    expect(runCli(["inspect", "orders.create"], { cwd, io: operation.io }))
      .toBe(ExitCode.success);
    const operationText = operation.stdout.join("");
    expect(operationText).toContain("command orders.create");
    expect(operationText).toContain("source: src/features/orders/feature.ts");
    expect(operationText).toContain("http: POST /orders 201");
    expect(operationText).toContain(
      "errors: CUSTOMER_NOT_FOUND, ORDER_INVALID, PAYMENT_FAILED(402)",
    );
    expect(operationText).toContain(
      "effects: chargePayment=payments.charge, loadCustomer=customerStore.get",
    );
    expect(operationText).toContain("ensures: chargedOnce");
    expect(operationText).toContain("verify: workspace");

    expect(runCli(["inspect", "orders"], { cwd, io: feature.io }))
      .toBe(ExitCode.success);
    const featureText = feature.stdout.join("");
    expect(featureText).toContain("feature orders");
    expect(featureText).toContain("dependencies: customers");
    expect(featureText).toContain("events: orders.created");
  });

  it("emits compact deterministic JSON without changing the artifact", () => {
    const cwd = copyFixture("valid");
    const pretty = capture();
    const compact = capture();

    expect(runCli(["inspect", "orders.create", "--json"], {
      cwd,
      io: pretty.io,
    })).toBe(ExitCode.success);
    expect(runCli(["inspect", "orders.create", "--json", "--compact"], {
      cwd,
      io: compact.io,
    })).toBe(ExitCode.success);

    const prettyJson = pretty.stdout.join("");
    const compactJson = compact.stdout.join("");
    expect(JSON.parse(compactJson)).toEqual(JSON.parse(prettyJson));
    expect(compactJson.endsWith("\n")).toBe(true);
    expect(compactJson).not.toContain("\n  ");
    expect(Buffer.byteLength(compactJson)).toBeLessThan(Buffer.byteLength(prettyJson));
  });

  it("rejects compact output without JSON", () => {
    const output = capture();

    expect(runCli(["inspect", "orders.create", "--compact"], {
      cwd: copyFixture("valid"),
      io: output.io,
    })).toBe(ExitCode.invalidInvocation);
    expect(output.stderr.join("")).toContain("--compact requires --json.");
  });

  it("uses the generated index as a fast path only while source digests match", () => {
    const cwd = copyFixture("valid");
    const first = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: first.io }))
      .toBe(ExitCode.success);
    const cachePath = join(cwd, ".agentix/index.json");
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      operations: { id: string; permissions: string[] }[];
    };
    const operation = cached.operations.find(({ id }) => id === "orders.create");
    expect(operation).toBeDefined();
    if (operation === undefined) return;
    operation.permissions = ["cached:permission"];
    writeFileSync(cachePath, JSON.stringify(cached), "utf8");

    // Digest still matches the sources, so the cached artifact is served.
    const second = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: second.io }))
      .toBe(ExitCode.success);
    expect((JSON.parse(second.stdout.join("")) as {
      readonly permissions: readonly string[];
    }).permissions).toEqual(["cached:permission"]);

    // Any source change makes the cache stale and forces re-analysis.
    const featureFile = join(cwd, "src/features/orders/feature.ts");
    writeFileSync(featureFile, `${readFileSync(featureFile, "utf8")}\n// touched\n`, "utf8");
    const third = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: third.io }))
      .toBe(ExitCode.success);
    expect((JSON.parse(third.stdout.join("")) as {
      readonly permissions: readonly string[];
    }).permissions).toEqual(["orders:create"]);
    const refreshed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      operations: { id: string; permissions: string[] }[];
    };
    expect(refreshed.operations.find(({ id }) => id === "orders.create")?.permissions)
      .toEqual(["orders:create"]);
  });

  it("regenerates the index when the cached artifact is malformed", () => {
    const cwd = copyFixture("valid");
    const first = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: first.io }))
      .toBe(ExitCode.success);
    writeFileSync(join(cwd, ".agentix/index.json"), "{not json", "utf8");

    const second = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: second.io }))
      .toBe(ExitCode.success);
    expect((JSON.parse(second.stdout.join("")) as {
      readonly permissions: readonly string[];
    }).permissions).toEqual(["orders:create"]);
  });

  it("exposes compiler failures when inspecting an invalid operation", () => {
    const cwd = copyFixture("invalid");
    const output = capture();

    const exitCode = runCli(["inspect", "orders.unsafe", "--json"], {
      cwd,
      io: output.io,
    });

    expect(exitCode).toBe(ExitCode.success);
    const parsed = JSON.parse(output.stdout.join("")) as {
      readonly analysis: {
        readonly agentixValid: boolean;
        readonly typecheck: string;
        readonly project: { readonly errors: number };
        readonly targetDiagnostics: readonly { readonly code: string }[];
      };
    };
    expect(parsed.analysis).toMatchObject({
      agentixValid: false,
      typecheck: "not-run",
      project: { errors: 7 },
    });
    expect(parsed.analysis.targetDiagnostics.map(({ code }) => code)).toContain(
      "architecture.ambient-fetch",
    );
  });

  it("makes bounded-context omissions visible in human output", () => {
    const cwd = copyFixture("valid");
    writeFileSync(
      join(cwd, "src/features/broken.ts"),
      `import { feature } from "@agentixdev/core";\n\n` +
      `const dynamicId = "broken" as string;\n` +
      `export const broken = feature(dynamicId, { operations: {} });\n`,
      "utf8",
    );
    const output = capture();

    expect(runCli(["inspect", "orders.create"], { cwd, io: output.io }))
      .toBe(ExitCode.success);
    expect(output.stdout.join("")).toContain("projection: truncated to 8192 bytes");
    expect(output.stdout.join("")).toContain("omitted: affected.items");
    expect(output.stdout.join("")).toContain(
      "npm exec -- agentix affected --root . --json -- orders.create",
    );
  });

  it("expands omitted per-operation detail without reading the project index", () => {
    const cwd = copyFixture("valid");
    const featurePath = join(cwd, "src/features/orders/feature.ts");
    writeFileSync(
      featurePath,
      readFileSync(featurePath, "utf8")
        .replace("chargePayment: Payments.charge", "chargePayment: unknownEffect"),
      "utf8",
    );
    const output = capture();

    expect(runCli([
      "inspect",
      "orders.create",
      "--full",
      "--json",
    ], { cwd, io: output.io })).toBe(ExitCode.success);
    const detail = JSON.parse(output.stdout.join("")) as {
      readonly artifactKind: string;
      readonly effects: readonly { readonly reference: string }[];
      readonly analysis: { readonly targetUnresolved: readonly string[] };
      readonly verification: { readonly target: string };
    };
    expect(detail).toMatchObject({
      artifactKind: "operation-detail",
      schemaVersion: "2",
      verification: { target: "orders.create" },
    });
    expect(detail.effects).toContainEqual(
      expect.objectContaining({ reference: "unknownEffect" }),
    );
    expect(detail.analysis.targetUnresolved).toHaveLength(1);
  });

  it("prints stable DOT and explainable affected output", () => {
    const cwd = copyFixture("valid");
    const graph = capture();
    const compactGraph = capture();
    const affected = capture();

    expect(runCli(["graph", "orders", "--format", "dot"], { cwd, io: graph.io }))
      .toBe(ExitCode.success);
    expect(graph.stdout.join("")).toContain(
      '"orders" -> "customers" [label="feature-dependency"]',
    );
    expect(graph.stdout.join("")).toContain('[label="port-operation"]');
    expect(runCli(["graph", "orders", "--json", "--compact"], {
      cwd,
      io: compactGraph.io,
    })).toBe(ExitCode.success);
    expect(JSON.parse(compactGraph.stdout.join(""))).toMatchObject({
      schemaVersion: "2",
    });
    expect(compactGraph.stdout.join("")).not.toContain("\n  ");
    expect(runCli(["affected", "customers", "--json", "--compact"], {
      cwd,
      io: affected.io,
    }))
      .toBe(ExitCode.success);
    const parsed = JSON.parse(affected.stdout.join("")) as {
      readonly widened: boolean;
      readonly items: readonly { readonly id: string; readonly reasons: readonly unknown[] }[];
    };
    expect(parsed.widened).toBe(false);
    expect(affected.stdout.join("")).not.toContain("\n  ");
    expect(parsed.items.find(({ id }) => id === "orders.create")?.reasons.length)
      .toBeGreaterThan(0);
  });

  it("inspects ports, port operations, and events as v2 artifacts", () => {
    const cwd = copyFixture("valid");
    const port = capture();
    const portOperation = capture();
    const event = capture();

    expect(runCli(["inspect", "customerStore", "--json"], { cwd, io: port.io }))
      .toBe(ExitCode.success);
    const store = JSON.parse(port.stdout.join("")) as {
      readonly operations: readonly { readonly id: string }[];
    };
    expect(store).toMatchObject({
      schemaVersion: "2",
      kind: "port",
      id: "customerStore",
    });
    expect(store.operations.map(({ id }) => id)).toEqual([
      "customerStore.delete",
      "customerStore.get",
      "customerStore.list",
      "customerStore.save",
    ]);

    expect(runCli(["inspect", "payments.charge", "--json"], {
      cwd,
      io: portOperation.io,
    })).toBe(ExitCode.success);
    expect(JSON.parse(portOperation.stdout.join(""))).toMatchObject({
      schemaVersion: "2",
      artifactKind: "port-operation",
      kind: "external",
      port: "payments",
      id: "payments.charge",
      source: { file: "src/features/orders/feature.ts" },
    });

    expect(runCli(["inspect", "orders.created", "--json"], { cwd, io: event.io }))
      .toBe(ExitCode.success);
    expect(JSON.parse(event.stdout.join(""))).toMatchObject({
      schemaVersion: "2",
      kind: "event",
      id: "orders.created",
      version: 1,
      feature: "orders",
    });
  });

  it("runs a conservative verification plan and preserves process results in JSON", () => {
    const cwd = copyFixture("valid");
    const output = capture();
    const runner = vi.fn<ProcessRunner>(() => ({ status: 0, stdout: "ok\n", stderr: "" }));

    const exitCode = runCli(["verify", "orders.create", "--json", "--compact"], {
      cwd,
      io: output.io,
      runProcess: runner,
    });

    expect(exitCode).toBe(ExitCode.success);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[0]).toBe("npm");
    const result = JSON.parse(output.stdout.join("")) as {
      readonly schemaVersion: string;
      readonly passed: boolean;
      readonly plan: { readonly scope: string };
      readonly checks: readonly { readonly stdout: string }[];
    };
    expect(result).toMatchObject({
      schemaVersion: "2",
      passed: true,
      plan: { scope: "workspace" },
    });
    expect(result.checks.map(({ stdout }) => stdout)).toEqual(["ok\n", "ok\n"]);
    expect(output.stdout.join("")).not.toContain("\n  ");
  });

  it("executes the narrow plan for root-tsconfig apps with selected tests", () => {
    const cwd = copyFixture("valid");
    writeFileSync(
      join(cwd, "tsconfig.json"),
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
    const output = capture();
    const runner = vi.fn<ProcessRunner>(() => ({ status: 0, stdout: "", stderr: "" }));

    const exitCode = runCli(["verify", "orders.create", "--json"], {
      cwd,
      io: output.io,
      runProcess: runner,
    });

    expect(exitCode).toBe(ExitCode.success);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[0]).toBe("npm");
    expect(runner.mock.calls[0]?.[1]).toEqual([
      "exec", "--", "tsc", "-b", ".", "--pretty", "false",
    ]);
    expect(runner.mock.calls[1]?.[0]).toBe("npm");
    expect(runner.mock.calls[1]?.[1]).toEqual([
      "exec", "--", "vitest", "run", "src/features/orders/orders.test.ts",
    ]);
    expect(runner.mock.calls[0]?.[2]).toBe(cwd);
    const result = JSON.parse(output.stdout.join("")) as {
      readonly passed: boolean;
      readonly plan: {
        readonly scope: string;
        readonly testFiles: readonly string[];
      };
    };
    expect(result.passed).toBe(true);
    expect(result.plan.scope).toBe("project");
    expect(result.plan.testFiles).toEqual(["src/features/orders/orders.test.ts"]);
  });

  it("fails verification before subprocesses when architecture errors exist", () => {
    const cwd = copyFixture("invalid");
    const output = capture();
    const runner = vi.fn<ProcessRunner>();

    const exitCode = runCli(["verify", "orders.unsafe"], {
      cwd,
      io: output.io,
      runProcess: runner,
    });

    expect(exitCode).toBe(ExitCode.verificationFailure);
    expect(runner).not.toHaveBeenCalled();
    expect(output.stderr.join("")).toContain("architecture.private-cross-feature-import");
  });

  it("scaffolds a compilable single-file feature the index immediately sees", () => {
    // Package-local copy so tsc resolves @agentixdev/core through the workspace.
    const cwd = copyFixture("valid", packageDirectory);
    const preview = capture();
    const created = capture();
    const inspected = capture();
    const refused = capture();

    expect(runCli([
      "scaffold",
      "feature",
      "price-rules",
      "--dry-run",
      "--json",
      "--compact",
    ], {
      cwd,
      io: preview.io,
    })).toBe(ExitCode.success);
    expect(existsSync(join(cwd, "src/features/price-rules.ts"))).toBe(false);

    expect(runCli(["scaffold", "feature", "price-rules"], { cwd, io: created.io }))
      .toBe(ExitCode.success);
    const previewResult = JSON.parse(preview.stdout.join("")) as {
      readonly schemaVersion: string;
      readonly files: readonly string[];
      readonly nextActions: readonly string[];
    };
    expect(previewResult.schemaVersion).toBe("2");
    expect(previewResult.files).toEqual([
      "src/features/price-rules.test.ts",
      "src/features/price-rules.ts",
    ]);
    expect(preview.stdout.join("")).not.toContain("\n  ");
    expect(previewResult.nextActions).toContain(
      `cd ${cwd} && npm exec -- agentix verify price-rules --root .`,
    );
    const featureSource = readFileSync(join(cwd, "src/features/price-rules.ts"), "utf8");
    expect(featureSource).toContain('feature("price-rules"');
    expect(featureSource).toContain('port.store("priceRulesStorage"');
    expect(featureSource).not.toContain("defineFeature");
    expect(readFileSync(join(cwd, "src/features/price-rules.test.ts"), "utf8"))
      .toContain('app.call("price-rules.create"');
    compileScaffold(cwd, previewResult.files);

    expect(runCli(["inspect", "price-rules", "--json"], { cwd, io: inspected.io }))
      .toBe(ExitCode.success);
    const indexed = JSON.parse(inspected.stdout.join("")) as {
      readonly operations: readonly string[];
      readonly tests: readonly string[];
    };
    expect(indexed).toMatchObject({ id: "price-rules", kind: "feature" });
    expect(indexed.operations).toEqual(["price-rules.create", "price-rules.get"]);
    expect(indexed.tests).toContain("src/features/price-rules.test.ts");

    expect(runCli(["scaffold", "feature", "price-rules"], { cwd, io: refused.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(refused.stderr.join("")).toContain("Refusing to overwrite");
  });

  it("prints pasteable next actions for a selected application root", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentix-scaffold-root-"));
    temporaryDirectories.push(cwd);
    const output = capture();

    expect(runCli([
      "scaffold",
      "feature",
      "shipping",
      "--root",
      "application with spaces",
      "--dry-run",
      "--json",
    ], { cwd, io: output.io })).toBe(ExitCode.success);
    const result = JSON.parse(output.stdout.join("")) as {
      readonly nextActions: readonly string[];
    };
    const root = join(cwd, "application with spaces");
    expect(result.nextActions).toContain(
      `cd '${root}' && npm exec -- agentix inspect shipping --root .`,
    );
    expect(result.nextActions).toContain(
      `cd '${root}' && npm exec -- agentix verify shipping --root .`,
    );
  });

  it("scaffolds reserved feature IDs with valid TypeScript bindings", () => {
    const cwd = mkdtempSync(join(packageDirectory, ".agentix-scaffold-reserved-"));
    temporaryDirectories.push(cwd);
    const output = capture();

    expect(runCli(["scaffold", "feature", "class"], { cwd, io: output.io }))
      .toBe(ExitCode.success);
    const files = [
      "src/features/class.test.ts",
      "src/features/class.ts",
    ];
    expect(readFileSync(join(cwd, "src/features/class.ts"), "utf8"))
      .toContain('export const classFeature = feature("class"');
    compileScaffold(cwd, files);
  });

  it("uses a distinct invalid-invocation exit code", () => {
    const output = capture();
    expect(runCli(["unknown"], { cwd: copyFixture("valid"), io: output.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(output.stderr.join("")).toContain("Unknown command");
  });

  it("packs a change context with both sources, tables, plan, and recipe", () => {
    const cwd = copyFixture("valid");
    const json = capture();
    const human = capture();

    expect(runCli(["context", "orders.create", "--json", "--compact"], {
      cwd,
      io: json.io,
    })).toBe(ExitCode.success);
    expect(json.stderr).toEqual([]);
    const context = JSON.parse(json.stdout.join("")) as {
      readonly artifactKind: string;
      readonly excerpt: string;
      readonly exports: readonly string[];
      readonly effects: readonly string[];
      readonly portSignatures: readonly string[];
      readonly tests: readonly { readonly file: string; readonly source?: string }[];
      readonly affected: readonly string[];
      readonly verification: { readonly typecheck: string; readonly tests: string };
      readonly writes: readonly string[];
    };
    expect(context).toMatchObject({
      schemaVersion: "2",
      artifactKind: "change-context",
      id: "orders.create",
    });
    expect(context.excerpt).toContain("create: command({");
    expect(context.tests[0]?.source).toContain("associateOperationTest");
    expect(context.verification.typecheck).toContain("tsc");
    expect(context.writes).toEqual([
      "src/features/orders/feature.ts",
      "src/features/orders/orders.test.ts",
    ]);

    expect(runCli(["context", "orders.create"], { cwd, io: human.io }))
      .toBe(ExitCode.success);
    const text = human.stdout.join("");
    expect(text).toContain("change-context orders.create");
    expect(text).toContain("excerpt:");
    expect(text).toContain("verify typecheck (workspace): npm exec -- tsc -b --pretty false");
    expect(text).toContain("writes: src/features/orders/feature.ts");
  });

  it("validates context targets and budgets", () => {
    const cwd = copyFixture("valid");
    const unknown = capture();
    expect(runCli(["context", "orders.missing", "--json"], { cwd, io: unknown.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(unknown.stderr.join("")).toContain("No indexed operation matches");

    const badBudget = capture();
    expect(runCli(["context", "orders.create", "--budget", "0"], { cwd, io: badBudget.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(badBudget.stderr.join("")).toContain("--budget must be a positive integer");

    const misplaced = capture();
    expect(runCli(["verify", "orders.create", "--budget", "512"], { cwd, io: misplaced.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(misplaced.stderr.join("")).toContain("--budget is supported only by context");
  });

  it("emits a deterministic OpenAPI 3.1 document with bearer and health options", () => {
    const cwd = copyFixture("valid");
    const first = capture();
    const second = capture();

    expect(runCli([
      "openapi", "--bearer", "--health", "/healthz", "--compact",
    ], { cwd, io: first.io })).toBe(ExitCode.success);
    expect(first.stderr).toEqual([]);
    expect(runCli([
      "openapi", "--bearer", "--health", "/healthz", "--compact",
    ], { cwd, io: second.io })).toBe(ExitCode.success);
    expect(first.stdout.join("")).toBe(second.stdout.join(""));

    const document = JSON.parse(first.stdout.join("")) as {
      readonly openapi: string;
      readonly paths: Record<string, Record<string, {
        readonly operationId?: string;
        readonly security?: unknown;
        readonly responses: Record<string, unknown>;
      }>>;
      readonly components: {
        readonly securitySchemes?: Record<string, unknown>;
        readonly responses: Record<string, unknown>;
      };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual([
      "/customers", "/customers/{id}", "/healthz", "/orders",
    ]);
    expect(document.components.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(document.paths["/orders"]?.["post"]?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/customers"]?.["post"]?.security).toBeUndefined();
    expect(document.paths["/healthz"]?.["get"]?.responses["200"]).toBeDefined();
  });

  it("writes the OpenAPI document to --out and scopes openapi-only flags", () => {
    const cwd = copyFixture("valid");
    const output = capture();

    expect(runCli(["openapi", "--out", "openapi.json"], { cwd, io: output.io }))
      .toBe(ExitCode.success);
    expect(output.stdout.join("")).toContain("Wrote OpenAPI 3.1 document to ");
    const written = JSON.parse(readFileSync(join(cwd, "openapi.json"), "utf8")) as {
      readonly openapi: string;
    };
    expect(written.openapi).toBe("3.1.0");

    const misplaced = capture();
    expect(runCli(["inspect", "orders.create", "--bearer"], { cwd, io: misplaced.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(misplaced.stderr.join(""))
      .toContain("--bearer, --health, and --out are supported only by openapi");

    const badHealth = capture();
    expect(runCli(["openapi", "--health", "healthz"], { cwd, io: badHealth.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(badHealth.stderr.join("")).toContain("--health must be an absolute path");
  });

  it("replaces the direct feature+test reads for the sandbox notes app", () => {
    // ACCEPTANCE: `agentix context notes.create --json --compact` must cost
    // no more bytes than reading the feature file and the dispatch test
    // directly, while embedding BOTH sources — it replaces those reads.
    const sandboxRoot = fileURLToPath(
      new URL("../../../sandbox/notes-app", import.meta.url),
    );
    const output = capture();

    expect(runCli(["context", "notes.create", "--json", "--compact"], {
      cwd: sandboxRoot,
      io: output.io,
    })).toBe(ExitCode.success);
    const json = output.stdout.join("");
    const directBytes =
      Buffer.byteLength(readFileSync(join(sandboxRoot, "src/features/notes.ts"))) +
      Buffer.byteLength(readFileSync(join(sandboxRoot, "src/notes.dispatch.test.ts")));
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(directBytes);

    const context = JSON.parse(json) as {
      readonly excerpt: string;
      readonly tests: readonly { readonly file: string; readonly source?: string }[];
      readonly writes: readonly string[];
      readonly projection?: unknown;
    };
    // Feature-file source: the operation's full command() declaration.
    expect(context.excerpt).toContain("create: command({");
    expect(context.excerpt).toContain('fail("NOTE_ALREADY_EXISTS", { id: input.id })');
    // Test-file source: the primary associated suite, embedded in full.
    const primary = context.tests.find(({ source }) => source !== undefined);
    expect(primary?.file).toBe("src/notes.dispatch.test.ts");
    expect(primary?.source).toContain("associateOperationTest(notes.operations.create)");
    expect(primary?.source).toContain('app.call("notes.create"');
    expect(context.writes).toEqual([
      "src/features/notes.ts",
      "src/notes.dispatch.test.ts",
    ]);
    // Nothing was omitted: the artifact fits its default budget outright.
    expect(context.projection).toBeUndefined();
  });
});
