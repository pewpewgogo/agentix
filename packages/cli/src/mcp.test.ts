import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpServer } from "./mcp.js";
import { ExitCode, runCli, type CliIO } from "./index.js";

const compilerFixture = fileURLToPath(
  new URL("../../compiler/test/fixtures/valid", import.meta.url),
);

const temporaryDirectories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

const copyFixture = (): string => {
  // Dot-prefixed so stray copies inside the package never match test globs.
  const temporary = mkdtempSync(join(tmpdir(), ".agentix-mcp-"));
  temporaryDirectories.push(temporary);
  const project = join(temporary, "project");
  cpSync(compilerFixture, project, { recursive: true });
  return project;
};

const connect = async (rootDir: string): Promise<Client> => {
  const server = createMcpServer(rootDir);
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
};

const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

const textOf = (result: CallToolResult): string => {
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("Expected a text content block.");
  return first.text;
};

const capture = (): { readonly io: CliIO; readonly stderr: string[] } => {
  const stderr: string[] = [];
  return {
    stderr,
    io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
  };
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("agentix mcp server", () => {
  it("lists all seven CLI tools with agent-facing descriptions and schemas", async () => {
    const client = await connect(copyFixture());

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual([
      "affected", "context", "graph", "inspect", "openapi", "scaffold", "verify",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // Budget and cost notes are part of the contract for coding agents.
    expect(byName.get("inspect")?.description).toContain("8 KiB");
    expect(byName.get("inspect")?.inputSchema["required"]).toEqual(["target"]);
    expect(byName.get("context")?.description).toContain("16384");
    expect(byName.get("context")?.description).toContain("REPLACE reading");
    expect(byName.get("verify")?.description).toContain("SLOW");
    expect(byName.get("openapi")?.description).toContain("OpenAPI 3.1");
    expect(byName.get("scaffold")?.inputSchema["required"]).toEqual(["name"]);
  });

  it("returns the CLI's compact JSON artifacts from inspect and context", async () => {
    const client = await connect(copyFixture());

    const inspected = await callTool(client, "inspect", { target: "orders.create" });
    expect(inspected.isError).toBeUndefined();
    const inspectText = textOf(inspected);
    expect(inspectText).not.toContain("\n  ");
    expect(JSON.parse(inspectText)).toMatchObject({
      schemaVersion: "2",
      artifactKind: "operation-context",
      id: "orders.create",
      http: { method: "POST", path: "/orders", status: 201 },
    });

    const context = await callTool(client, "context", { operation: "orders.create" });
    expect(context.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(context)) as {
      readonly artifactKind: string;
      readonly excerpt: string;
      readonly writes: readonly string[];
    };
    expect(parsed).toMatchObject({
      schemaVersion: "2",
      artifactKind: "change-context",
      id: "orders.create",
    });
    expect(parsed.excerpt).toContain("create: command({");
    expect(parsed.writes).toEqual([
      "src/features/orders/feature.ts",
      "src/features/orders/orders.test.ts",
    ]);

    const graph = await callTool(client, "graph", { feature: "orders" });
    expect(JSON.parse(textOf(graph))).toMatchObject({ schemaVersion: "2" });
    const affected = await callTool(client, "affected", { target: "customers" });
    expect(JSON.parse(textOf(affected))).toMatchObject({ widened: false });
  });

  it("serves the OpenAPI document with bearer and health options", async () => {
    const client = await connect(copyFixture());

    const result = await callTool(client, "openapi", {
      bearer: true,
      healthPath: "/healthz",
    });

    expect(result.isError).toBeUndefined();
    const document = JSON.parse(textOf(result)) as {
      readonly openapi: string;
      readonly paths: Record<string, unknown>;
      readonly components: { readonly securitySchemes?: Record<string, unknown> };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual([
      "/customers", "/customers/{id}", "/healthz", "/orders",
    ]);
    expect(document.components.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
    });
  });

  it("returns isError results with the CLI's error text and keeps serving", async () => {
    const client = await connect(copyFixture());

    const unknownOperation = await callTool(client, "context", {
      operation: "orders.missing",
    });
    expect(unknownOperation.isError).toBe(true);
    expect(textOf(unknownOperation)).toContain("No indexed operation matches 'orders.missing'");

    const unknownTarget = await callTool(client, "inspect", { target: "nope.nothing" });
    expect(unknownTarget.isError).toBe(true);
    expect(textOf(unknownTarget)).toContain("No indexed feature or operation matches");

    const unknownTool = await callTool(client, "does-not-exist", {});
    expect(unknownTool.isError).toBe(true);
    expect(textOf(unknownTool)).toContain("Unknown tool 'does-not-exist'");
    expect(textOf(unknownTool)).toContain("inspect");

    const badArguments = await callTool(client, "inspect", { target: 7 });
    expect(badArguments.isError).toBe(true);
    expect(textOf(badArguments)).toContain("'target' must be a non-empty string");

    // The session survives every error path above.
    const alive = await callTool(client, "inspect", { target: "orders" });
    expect(alive.isError).toBeUndefined();
    expect(JSON.parse(textOf(alive))).toMatchObject({ id: "orders", kind: "feature" });
  });

  it("re-validates index staleness through the digest fast path per call", async () => {
    const rootDir = copyFixture();
    const client = await connect(rootDir);

    await callTool(client, "inspect", { target: "orders.create" });
    const cachePath = join(rootDir, ".agentix/index.json");
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      operations: { id: string; permissions: string[] }[];
    };
    const operation = cached.operations.find(({ id }) => id === "orders.create");
    expect(operation).toBeDefined();
    if (operation === undefined) return;
    operation.permissions = ["cached:permission"];
    writeFileSync(cachePath, JSON.stringify(cached), "utf8");

    // Unchanged sources: the digest matches, so the cached artifact is served.
    const second = await callTool(client, "inspect", { target: "orders.create" });
    expect((JSON.parse(textOf(second)) as { permissions: string[] }).permissions)
      .toEqual(["cached:permission"]);

    // A source edit mid-session makes the cache stale and forces re-analysis.
    const featureFile = join(rootDir, "src/features/orders/feature.ts");
    writeFileSync(featureFile, `${readFileSync(featureFile, "utf8")}\n// touched\n`, "utf8");
    const third = await callTool(client, "inspect", { target: "orders.create" });
    expect((JSON.parse(textOf(third)) as { permissions: string[] }).permissions)
      .toEqual(["orders:create"]);
  });

  it("starts from the CLI with the root fixed at server start", () => {
    const rootDir = copyFixture();
    const started: string[] = [];
    const output = capture();

    expect(runCli(["mcp", "--root", "project"], {
      cwd: join(rootDir, ".."),
      io: output.io,
      startMcpServer: async (fixedRoot) => {
        started.push(fixedRoot);
      },
    })).toBe(ExitCode.success);

    expect(started).toEqual([rootDir]);
    expect(output.stderr).toEqual([]);
  });

  it("rejects positional arguments and non-root flags for mcp", () => {
    const rootDir = copyFixture();
    const positional = capture();
    expect(runCli(["mcp", "extra"], {
      cwd: rootDir,
      io: positional.io,
      startMcpServer: async () => {},
    })).toBe(ExitCode.invalidInvocation);
    expect(positional.stderr.join("")).toContain("mcp accepts no positional arguments.");

    const flagged = capture();
    expect(runCli(["mcp", "--json"], {
      cwd: rootDir,
      io: flagged.io,
      startMcpServer: async () => {},
    })).toBe(ExitCode.invalidInvocation);
    expect(flagged.stderr.join("")).toContain("mcp accepts only --root.");
  });

  it("lists mcp in the usage text", () => {
    const stdout: string[] = [];
    expect(runCli(["--help"], {
      cwd: copyFixture(),
      io: { stdout: (text) => stdout.push(text), stderr: () => {} },
    })).toBe(ExitCode.success);
    expect(stdout.join("")).toContain("agentix mcp [--root <directory>]");
  });
});
