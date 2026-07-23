import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("prints stable DOT and explainable affected output", () => {
    const cwd = copyFixture("valid");
    const graph = capture();
    const affected = capture();

    expect(runCli(["graph", "orders", "--format", "dot"], { cwd, io: graph.io }))
      .toBe(ExitCode.success);
    expect(graph.stdout.join("")).toContain(
      '"orders" -> "customers" [label="feature-dependency"]',
    );
    expect(runCli(["affected", "customers", "--json"], { cwd, io: affected.io }))
      .toBe(ExitCode.success);
    const parsed = JSON.parse(affected.stdout.join("")) as {
      readonly widened: boolean;
      readonly items: readonly { readonly id: string; readonly reasons: readonly unknown[] }[];
    };
    expect(parsed.widened).toBe(false);
    expect(parsed.items.find(({ id }) => id === "orders.create")?.reasons.length)
      .toBeGreaterThan(0);
  });

  it("runs a conservative verification plan and preserves process results in JSON", () => {
    const cwd = copyFixture("valid");
    const output = capture();
    const runner = vi.fn<ProcessRunner>(() => ({ status: 0, stdout: "ok\n", stderr: "" }));

    const exitCode = runCli(["verify", "orders.create", "--json"], {
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

    expect(runCli(["scaffold", "feature", "price-rules", "--dry-run", "--json"], {
      cwd,
      io: preview.io,
    })).toBe(ExitCode.success);
    expect(existsSync(join(cwd, "src/features/price-rules"))).toBe(false);

    expect(runCli(["scaffold", "feature", "price-rules"], { cwd, io: created.io }))
      .toBe(ExitCode.success);
    const featureFile = join(cwd, "src/features/price-rules/feature.ts");
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
        ...JSON.parse(preview.stdout.join("" )).files.map((file: string) => join(cwd, file)),
      ],
      { cwd, stdio: "pipe" },
    );
    expect(runCli(["scaffold", "feature", "price-rules"], { cwd, io: refused.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(refused.stderr.join("")).toContain("Refusing to overwrite");
  });

  it("uses a distinct invalid-invocation exit code", () => {
    const output = capture();
    expect(runCli(["unknown"], { cwd: copyFixture("valid"), io: output.io }))
      .toBe(ExitCode.invalidInvocation);
    expect(output.stderr.join("")).toContain("Unknown command");
  });
});
