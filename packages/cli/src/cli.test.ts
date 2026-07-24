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

const temporaryDirectories: string[] = [];

const copyFixture = (name: "valid" | "invalid"): string => {
  const temporary = mkdtempSync(join(tmpdir(), "agentix-cli-"));
  temporaryDirectories.push(temporary);
  const project = join(temporary, "project");
  cpSync(compilerFixture(name), project, { recursive: true });
  return project;
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
      readonly operations: readonly string[];
      readonly verification: { readonly scope: string };
    };
    expect(parsed).toMatchObject({
      id: "orders",
      kind: "feature",
      operations: ["orders.create"],
      verification: { scope: "workspace" },
    });
    expect(existsSync(join(cwd, ".agentix/index.json"))).toBe(true);
  });

  it("inspects one operation as bounded context with explicit compiler trust", () => {
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
      analysis: {
        agentixValid: true,
        complete: true,
        typecheck: "not-run",
        project: { errors: 0 },
      },
    });
    expect(parsed).not.toHaveProperty("features");
    expect(parsed).not.toHaveProperty("sourceManifest");
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

  it("reanalyzes source instead of trusting a forged generated index", () => {
    const cwd = copyFixture("valid");
    const first = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: first.io }))
      .toBe(ExitCode.success);
    const cachePath = join(cwd, ".agentix/index.json");
    const forged = JSON.parse(readFileSync(cachePath, "utf8")) as {
      operations: { id: string; permissions: string[] }[];
    };
    const operation = forged.operations.find(({ id }) => id === "orders.create");
    expect(operation).toBeDefined();
    if (operation === undefined) return;
    operation.permissions = ["forged:permission"];
    writeFileSync(cachePath, JSON.stringify(forged), "utf8");

    const second = capture();
    expect(runCli(["inspect", "orders.create", "--json"], { cwd, io: second.io }))
      .toBe(ExitCode.success);
    const inspected = JSON.parse(second.stdout.join("")) as {
      readonly permissions: readonly string[];
    };
    expect(inspected.permissions).toEqual(["orders:create"]);
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
      project: { errors: 5 },
    });
    expect(parsed.analysis.targetDiagnostics.map(({ code }) => code)).toContain(
      "architecture.ambient-fetch",
    );
  });

  it("makes bounded-context omissions visible in human output", () => {
    const cwd = copyFixture("valid");
    const operationsPath = join(cwd, "src/features/orders/operations.ts");
    writeFileSync(
      operationsPath,
      readFileSync(operationsPath, "utf8")
        .replace("Payments.operations.charge", "unknownEffect"),
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
    const operationsPath = join(cwd, "src/features/orders/operations.ts");
    writeFileSync(
      operationsPath,
      readFileSync(operationsPath, "utf8")
        .replace("Payments.operations.charge", "unknownEffect"),
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
      effects: [{ reference: "unknownEffect" }],
      verification: { target: "orders.create" },
    });
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
    expect(runCli(["graph", "orders", "--json", "--compact"], {
      cwd,
      io: compactGraph.io,
    })).toBe(ExitCode.success);
    expect(JSON.parse(compactGraph.stdout.join(""))).toMatchObject({
      schemaVersion: "1",
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

  it("follows a declared effect ID to its port operation source", () => {
    const cwd = copyFixture("valid");
    const output = capture();

    expect(runCli(["inspect", "payments.charge", "--json"], { cwd, io: output.io }))
      .toBe(ExitCode.success);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      artifactKind: "port-operation",
      kind: "external",
      port: "payments",
      id: "payments.charge",
      source: { file: "src/features/orders/ports.ts" },
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
      readonly passed: boolean;
      readonly plan: { readonly scope: string };
      readonly checks: readonly { readonly stdout: string }[];
    };
    expect(result).toMatchObject({ passed: true, plan: { scope: "workspace" } });
    expect(result.checks.map(({ stdout }) => stdout)).toEqual(["ok\n", "ok\n"]);
    expect(output.stdout.join("")).not.toContain("\n  ");
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

  it("previews, writes, and then refuses to overwrite a feature scaffold", () => {
    const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
    const cwd = mkdtempSync(join(packageDirectory, ".agentix-scaffold-"));
    temporaryDirectories.push(cwd);
    const preview = capture();
    const created = capture();
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
    expect(existsSync(join(cwd, "src/features/price-rules"))).toBe(false);

    expect(runCli(["scaffold", "feature", "price-rules"], { cwd, io: created.io }))
      .toBe(ExitCode.success);
    const featureFile = join(cwd, "src/features/price-rules/feature.ts");
    const previewResult = JSON.parse(preview.stdout.join("")) as {
      readonly files: readonly string[];
      readonly nextActions: readonly string[];
    };
    expect(previewResult.files).toEqual([
      "src/features/price-rules/contract.ts",
      "src/features/price-rules/feature.ts",
      "src/features/price-rules/price-rules.test.ts",
    ]);
    expect(preview.stdout.join("")).not.toContain("\n  ");
    expect(previewResult.nextActions).toContain(
      `cd ${cwd} && npm exec -- agentix verify price-rules --root .`,
    );
    expect(readFileSync(featureFile, "utf8")).toContain(
      'id: "price-rules"',
    );
    expect(readFileSync(join(cwd, "src/features/price-rules/contract.ts"), "utf8"))
      .toContain("defineFeatureContract");
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
        ...previewResult.files.map((file) => join(cwd, file)),
      ],
      { cwd, stdio: "pipe" },
    );
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
    const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
    const cwd = mkdtempSync(join(packageDirectory, ".agentix-scaffold-reserved-"));
    temporaryDirectories.push(cwd);
    const output = capture();

    expect(runCli(["scaffold", "feature", "class"], { cwd, io: output.io }))
      .toBe(ExitCode.success);
    const files = [
      "src/features/class/contract.ts",
      "src/features/class/feature.ts",
      "src/features/class/class.test.ts",
    ];
    expect(readFileSync(join(cwd, files[1] ?? ""), "utf8"))
      .toContain("export const classFeature = defineFeature");
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
  });

  it("uses a distinct invalid-invocation exit code", () => {
    const output = capture();
    expect(runCli(["unknown"], { cwd: copyFixture("valid"), io: output.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(output.stderr.join("")).toContain("Unknown command");
  });
});
