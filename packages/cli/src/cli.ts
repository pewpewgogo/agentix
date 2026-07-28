import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { startMcpServer } from "./mcp.js";

import {
  CHANGE_CONTEXT_DEFAULT_BUDGET,
  checkIndexStaleness,
  computeAffected,
  createChangeContext,
  createOpenApiDocument,
  createOperationContext,
  createOperationDetail,
  generateIndex,
  planVerification,
  readIndex,
  stableJson,
  type AgentIndex,
  type ChangeContext,
  type CompilerDiagnostic,
  type GraphEdge,
  type IndexedHttp,
  type OperationContext,
} from "@agentixdev/compiler";

export const ExitCode = {
  success: 0,
  verificationFailure: 1,
  invalidInvocation: 2,
  internalFailure: 3,
} as const;

export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => ProcessResult;

export interface CliDependencies {
  readonly cwd?: string;
  readonly io?: CliIO;
  readonly runProcess?: ProcessRunner;
  /** Test seam for `agentix mcp`; defaults to the stdio MCP server. */
  readonly startMcpServer?: (rootDir: string) => Promise<void>;
}

interface ParsedArguments {
  readonly positional: readonly string[];
  readonly json: boolean;
  readonly compact: boolean;
  readonly dryRun: boolean;
  readonly full: boolean;
  readonly bearer: boolean;
  readonly help: boolean;
  readonly format?: string;
  readonly root?: string;
  readonly out?: string;
  readonly health?: string;
  readonly budget?: string;
}

class UsageError extends Error {}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const defaultRunner: ProcessRunner = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const usage = `Usage:
  agentix inspect <feature-or-operation> [--json [--compact]] [--root <directory>]
  agentix inspect <operation> --full [--json [--compact]] [--root <directory>]
  agentix context <operation> [--budget <bytes>] [--json [--compact]] [--root <directory>]
  agentix graph [<feature>] [--format text|json|dot] [--json [--compact]] [--root <directory>]
  agentix affected <feature-or-file> [--json [--compact]] [--root <directory>]
  agentix verify <feature-or-operation> [--json [--compact]] [--root <directory>]
  agentix openapi [--bearer] [--health <path>] [--out <file>] [--compact] [--root <directory>]
  agentix scaffold feature <name> [--dry-run] [--json [--compact]] [--root <directory>]
  agentix mcp [--root <directory>]
`;

const valueOptions = new Set(["--format", "--root", "--out", "--health", "--budget"]);

const parseArguments = (args: readonly string[]): ParsedArguments => {
  const positional: string[] = [];
  let json = false;
  let compact = false;
  let dryRun = false;
  let full = false;
  let bearer = false;
  let help = false;
  const values = new Map<string, string>();
  let parseOptions = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (parseOptions && argument === "--") {
      parseOptions = false;
    } else if (parseOptions && (argument === "--help" || argument === "-h")) {
      help = true;
    } else if (parseOptions && argument === "--json") {
      json = true;
    } else if (parseOptions && argument === "--compact") {
      compact = true;
    } else if (parseOptions && argument === "--full") {
      full = true;
    } else if (parseOptions && argument === "--bearer") {
      bearer = true;
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true;
    } else if (parseOptions && argument !== undefined && valueOptions.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${argument} requires a value.`);
      }
      values.set(argument, value);
      index += 1;
    } else if (parseOptions && argument?.startsWith("--") === true) {
      throw new UsageError(`Unknown option '${argument}'.`);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }
  const format = values.get("--format");
  const root = values.get("--root");
  const out = values.get("--out");
  const health = values.get("--health");
  const budget = values.get("--budget");
  return {
    positional,
    json,
    compact,
    dryRun,
    full,
    bearer,
    help,
    ...(format === undefined ? {} : { format }),
    ...(root === undefined ? {} : { root }),
    ...(out === undefined ? {} : { out }),
    ...(health === undefined ? {} : { health }),
    ...(budget === undefined ? {} : { budget }),
  };
};

const serializeJson = (value: unknown, compact: boolean): string => {
  return stableJson(value, { compact });
};

/**
 * Re-analysis per invocation stays the default trust path. The generated
 * index is used as a fast path ONLY when its deterministic source digest
 * still matches the working tree; anything stale, missing, or malformed
 * falls back to a fresh analysis that rewrites the artifact.
 */
const loadIndex = (rootDir: string): AgentIndex => {
  try {
    const cached = readIndex(rootDir);
    if (!checkIndexStaleness(cached, rootDir).stale) return cached;
  } catch {
    // Missing or unreadable cache: fall through to re-analysis.
  }
  return generateIndex({ rootDir, write: true }).index;
};

const diagnosticText = (diagnostic: CompilerDiagnostic): string =>
  `${diagnostic.source.file}:${diagnostic.source.line}:${diagnostic.source.column} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;

const inspectTarget = (
  index: AgentIndex,
  target: string,
  rootDir: string,
  full: boolean,
): unknown => {
  if (full) {
    const detail = createOperationDetail(index, target, rootDir);
    if (detail === undefined) {
      throw new UsageError("inspect --full requires an indexed operation target.");
    }
    return detail;
  }
  const feature = index.features.find((candidate) => candidate.id === target);
  if (feature !== undefined) {
    const affected = computeAffected(index, target, rootDir);
    return {
      schemaVersion: "2",
      kind: "feature",
      ...feature,
      affected,
      verification: planVerification(index, target, rootDir, affected),
    };
  }
  const operation = index.operations.find((candidate) => candidate.id === target);
  if (operation !== undefined) {
    return createOperationContext(index, target, rootDir);
  }
  const port = index.ports.find((candidate) => candidate.id === target);
  if (port !== undefined) {
    return { schemaVersion: "2", kind: "port", ...port };
  }
  for (const owner of index.ports) {
    const operation = owner.operations.find((candidate) => candidate.id === target);
    if (operation !== undefined) {
      return {
        schemaVersion: "2",
        artifactKind: "port-operation",
        port: owner.id,
        ...operation,
      };
    }
  }
  const event = index.events.find((candidate) => candidate.id === target);
  if (event !== undefined) {
    return { schemaVersion: "2", kind: "event", ...event };
  }
  throw new UsageError(`No indexed feature or operation matches '${target}'.`);
};

const formatInspect = (value: unknown): string => {
  const inspected = value as {
    readonly id: string;
    readonly kind: string;
    readonly artifactKind?: string;
    readonly source: { readonly file: string; readonly line: number };
    readonly exports?: readonly string[];
    readonly dependencies?: readonly string[];
    readonly consumers?: readonly string[];
    readonly operations?: readonly string[];
    readonly http?: IndexedHttp;
    readonly errors?: readonly { readonly code: string; readonly http?: number }[];
    readonly permissions?: readonly string[];
    readonly effects?: readonly { readonly name: string; readonly operationId?: string; readonly reference: string }[];
    readonly events?: readonly string[];
    readonly ensures?: readonly string[];
    readonly tests?: readonly string[];
    readonly verification?: { readonly scope: string; readonly reason: string };
    readonly analysis?: OperationContext["analysis"];
    readonly projection?: OperationContext["projection"];
  };
  const lines = [
    `${inspected.artifactKind === "port-operation" ? inspected.artifactKind : inspected.kind} ${inspected.id}`,
    `source: ${inspected.source.file}:${inspected.source.line}`,
  ];
  const list = (label: string, values: readonly string[] | undefined): void => {
    if (values !== undefined) lines.push(`${label}: ${values.length === 0 ? "-" : values.join(", ")}`);
  };
  list("exports", inspected.exports);
  list("dependencies", inspected.dependencies);
  list("consumers", inspected.consumers);
  list("operations", inspected.operations);
  if (inspected.http !== undefined) {
    lines.push(
      `http: ${inspected.http.method} ${inspected.http.path}${inspected.http.status === undefined ? "" : ` ${inspected.http.status}`}`,
    );
  }
  if (inspected.errors !== undefined) {
    list(
      "errors",
      inspected.errors.map((error) => `${error.code}${error.http === undefined ? "" : `(${error.http})`}`),
    );
  }
  list("permissions", inspected.permissions);
  if (inspected.effects !== undefined) {
    list(
      "effects",
      inspected.effects.map((effect) => `${effect.name}=${effect.operationId ?? effect.reference}`),
    );
  }
  list("events", inspected.events);
  list("ensures", inspected.ensures);
  list("tests", inspected.tests);
  if (inspected.analysis !== undefined) {
    const { project } = inspected.analysis;
    lines.push(
      `analysis: ${inspected.analysis.agentixValid ? "valid" : "invalid"}; ` +
      `${project.errors} error(s), ${project.warnings} warning(s), ` +
      `${project.unresolved} unresolved; typecheck ${inspected.analysis.typecheck}`,
    );
    lines.push(`source-digest: ${inspected.analysis.sourceDigest}`);
    for (const diagnostic of inspected.analysis.targetDiagnostics) {
      lines.push(`diagnostic: ${diagnostic.code} ${diagnostic.message}`);
    }
  }
  if (inspected.verification !== undefined) {
    lines.push(`verify: ${inspected.verification.scope} (${inspected.verification.reason})`);
  }
  if (inspected.projection?.truncated === true) {
    lines.push(
      `projection: truncated to ${inspected.projection.byteLimit} bytes; ` +
      `${inspected.projection.omissions.length} omission(s)`,
    );
    for (const omission of inspected.projection.omissions) {
      const expansion = omission.expand.kind === "source"
        ? `open ${omission.expand.source.file}:${omission.expand.source.line}`
        : `run from ${omission.expand.cwd}: ${
          omission.expand.argv.map(shellArgument).join(" ")
        }`;
      lines.push(
        `omitted: ${omission.path} (${omission.included}/${omission.total} included); ${expansion}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

const formatChangeContext = (context: ChangeContext): string => {
  const lines = [`change-context ${context.id}`, `source: ${context.source}`];
  if (context.http !== undefined) {
    lines.push(
      `http: ${context.http.method} ${context.http.path}${context.http.status === undefined ? "" : ` ${context.http.status}`}`,
    );
  }
  if (context.errors.length > 0) {
    lines.push(
      `errors: ${context.errors.map((error) => `${error.code}${error.http === undefined ? "" : `(${error.http})`}`).join(", ")}`,
    );
  }
  const list = (label: string, values: readonly string[] | undefined): void => {
    if (values !== undefined) lines.push(`${label}: ${values.length === 0 ? "-" : values.join(", ")}`);
  };
  list("permissions", context.permissions);
  list("events", context.events);
  list("ensures", context.ensures);
  list("exports", context.exports);
  list("effects", context.effects);
  for (const signature of context.portSignatures ?? []) lines.push(`port: ${signature}`);
  if (context.excerpt !== undefined) lines.push("excerpt:", context.excerpt);
  for (const test of context.tests) {
    if (test.source === undefined) lines.push(`test (see file): ${test.file}`);
    else lines.push(`test ${test.file}:`, test.source);
  }
  list("affected", context.affected);
  lines.push(`verify typecheck (${context.verification.scope}): ${context.verification.typecheck}`);
  lines.push(`verify tests: ${context.verification.tests}`);
  list("writes", context.writes);
  if (context.projection !== undefined) {
    lines.push(
      `projection: truncated to ${context.projection.byteLimit} bytes; ` +
      `${context.projection.omissions.length} omission(s)`,
    );
    for (const omission of context.projection.omissions) {
      const expansion = omission.expand.kind === "source"
        ? `open ${omission.expand.source.file}:${omission.expand.source.line}`
        : `run from ${omission.expand.cwd}: ${
          omission.expand.argv.map(shellArgument).join(" ")
        }`;
      lines.push(
        `omitted: ${omission.path} (${omission.included}/${omission.total} included); ${expansion}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

const readPackageInfo = (rootDir: string): { title: string; version: string } => {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(rootDir, "package.json"), "utf8"),
    ) as { readonly name?: unknown; readonly version?: unknown };
    return {
      title:
        typeof manifest.name === "string" && manifest.name.length > 0
          ? manifest.name
          : "Agentix application",
      version:
        typeof manifest.version === "string" && manifest.version.length > 0
          ? manifest.version
          : "0.0.0",
    };
  } catch {
    return { title: "Agentix application", version: "0.0.0" };
  }
};

const graphEdges = (index: AgentIndex, featureId?: string): readonly GraphEdge[] => {
  if (featureId === undefined) return index.edges;
  const feature = index.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) throw new UsageError(`No indexed feature matches '${featureId}'.`);
  const related = new Set([
    feature.id,
    ...feature.dependencies,
    ...feature.consumers,
    ...feature.operations,
    ...feature.events,
    ...feature.tests,
  ]);
  for (const port of index.ports) {
    if (port.feature === feature.id) {
      related.add(port.id);
      for (const operation of port.operations) related.add(operation.id);
    }
  }
  return index.edges.filter((edge) => related.has(edge.from) || related.has(edge.to));
};

const dotEscape = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const formatGraph = (
  edges: readonly GraphEdge[],
  format: "text" | "json" | "dot",
  compact = false,
): string => {
  if (format === "json") {
    return serializeJson({ schemaVersion: "2", edges }, compact);
  }
  if (format === "dot") {
    const lines = ["digraph agentix {"];
    for (const edge of edges) {
      lines.push(
        `  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}" [label="${dotEscape(edge.kind)}"];`,
      );
    }
    lines.push("}");
    return `${lines.join("\n")}\n`;
  }
  return `${edges
    .map((edge) => `${edge.from} -> ${edge.to} [${edge.kind}] ${edge.reason}`)
    .join("\n")}\n`;
};

interface FeatureNames {
  /** Feature binding, e.g. `priceRules` (reserved words get a suffix). */
  readonly camel: string;
  /** Entity schema/type name, e.g. `PriceRules`. */
  readonly pascal: string;
  /** Error-code prefix, e.g. `PRICE_RULES`. */
  readonly constant: string;
  /** Store port id, e.g. `priceRulesStorage`. */
  readonly storeId: string;
}

const featureName = (name: string): FeatureNames => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new UsageError("Feature name must be lowercase kebab-case.");
  }
  const pieces = name.split("-");
  const pascal = pieces.map((piece) => `${piece[0]?.toUpperCase()}${piece.slice(1)}`).join("");
  const candidate = `${pieces[0]}${pascal.slice(pieces[0]?.length ?? 0)}`;
  // JS reserved words plus every binding the emitted template already uses.
  const reservedBindings = new Set([
    "arguments", "await", "break", "case", "catch", "class", "const",
    "continue", "debugger", "default", "delete", "do", "else", "enum",
    "eval", "export", "extends", "false", "finally", "for", "function",
    "if", "implements", "import", "in", "instanceof", "interface", "let",
    "new", "null", "package", "private", "protected", "public", "return",
    "static", "super", "switch", "this", "throw", "true", "try", "typeof",
    "var", "void", "while", "with", "yield",
    "command", "createApp", "createApplication", "describe", "expect",
    "feature", "it", "port", "query", "s",
  ]);
  return {
    camel: reservedBindings.has(candidate) ? `${candidate}Feature` : candidate,
    pascal,
    constant: pieces.join("_").toUpperCase(),
    storeId: `${candidate}Storage`,
  };
};

/**
 * v2 single-file feature template (modeled on the canonical notes.ts):
 * one feature file with schema + store port + command/query, plus one
 * colocated dispatch-level test.
 */
const scaffoldTemplates = (name: string): ReadonlyMap<string, string> => {
  const { camel, pascal, constant, storeId } = featureName(name);
  const featureFile = `import { command, feature, port, query, s } from "@agentixdev/core";

export const ${pascal} = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
});
export type ${pascal} = s.Infer<typeof ${pascal}>;

export const ${pascal}Storage = port.store("${storeId}", ${pascal});

export const ${camel} = feature("${name}", {
  operations: {
    create: command({
      input: ${pascal},
      output: ${pascal},
      errors: { ${constant}_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
      http: { method: "POST", path: "/${name}", status: 201 },
      effects: { load: ${pascal}Storage.get, save: ${pascal}Storage.save },
      async execute({ input, effects, fail }) {
        if (await effects.load(input.id)) {
          return fail("${constant}_ALREADY_EXISTS", { id: input.id });
        }
        return effects.save(input);
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: ${pascal},
      errors: { ${constant}_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/${name}/:id" },
      effects: { load: ${pascal}Storage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("${constant}_NOT_FOUND", { id: input.id });
      },
    }),
  },
});
`;
  const testFile = `import { createApplication } from "@agentixdev/core";
import { describe, expect, it } from "vitest";

import { ${camel}, ${pascal}Storage } from "./${name}.js";

const createApp = () =>
  createApplication({
    features: [${camel}],
    adapters: [${pascal}Storage.memory()],
    mode: "test",
  });

describe("${name}", () => {
  it("creates and reads an entry", async () => {
    const app = createApp();
    const created = await app.call("${name}.create", { id: "id-1", title: "First" });

    expect(created).toEqual({ ok: true, value: { id: "id-1", title: "First" } });
    expect(await app.call("${name}.get", { id: "id-1" })).toEqual(created);
  });

  it("returns stable duplicate and missing-entry failures", async () => {
    const app = createApp();
    await app.call("${name}.create", { id: "id-1", title: "First" });

    expect(await app.call("${name}.create", { id: "id-1", title: "Again" })).toEqual({
      ok: false,
      error: { code: "${constant}_ALREADY_EXISTS", details: { id: "id-1" } },
    });
    expect(await app.call("${name}.get", { id: "missing" })).toEqual({
      ok: false,
      error: { code: "${constant}_NOT_FOUND", details: { id: "missing" } },
    });
  });
});
`;
  return new Map([
    [`${name}.ts`, featureFile],
    [`${name}.test.ts`, testFile],
  ]);
};

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;

const scaffold = (
  rootDir: string,
  name: string,
  dryRun: boolean,
): {
  readonly schemaVersion: "2";
  readonly dryRun: boolean;
  readonly feature: string;
  readonly files: readonly string[];
  readonly nextActions: readonly string[];
} => {
  const templates = scaffoldTemplates(name);
  const { camel, pascal } = featureName(name);
  const directory = resolve(rootDir, "src/features");
  if (existsSync(resolve(directory, name))) {
    throw new UsageError(
      `Refusing to overwrite existing feature directory 'src/features/${name}'.`,
    );
  }
  for (const file of templates.keys()) {
    if (existsSync(resolve(directory, file))) {
      throw new UsageError(
        `Refusing to overwrite existing feature source 'src/features/${file}'.`,
      );
    }
  }
  const files = [...templates.keys()].map((file) => `src/features/${file}`).sort();
  if (!dryRun) {
    mkdirSync(directory, { recursive: true });
    for (const [file, contents] of templates) {
      writeFileSync(resolve(directory, file), contents, { encoding: "utf8", flag: "wx" });
    }
  }
  return {
    schemaVersion: "2",
    dryRun,
    feature: name,
    files,
    nextActions: [
      `Register ${camel} from src/features/${name}.ts in createApplication({ features: [..., ${camel}], adapters: [..., ${pascal}Storage.memory()] }).`,
      `cd ${shellArgument(rootDir)} && npm exec -- agentix inspect ${name} --root .`,
      `cd ${shellArgument(rootDir)} && npm exec -- agentix verify ${name} --root .`,
    ],
  };
};

const requireTarget = (values: readonly string[], command: string): string => {
  const [target, ...extra] = values;
  if (target === undefined || extra.length > 0) {
    throw new UsageError(`${command} requires exactly one target.`);
  }
  return target;
};

export const runCli = (
  argv: readonly string[],
  dependencies: CliDependencies = {},
): number => {
  const io = dependencies.io ?? defaultIO;
  const runner = dependencies.runProcess ?? defaultRunner;
  try {
    const parsed = parseArguments(argv);
    const [command, ...positionals] = parsed.positional;
    const rootDir = resolve(dependencies.cwd ?? process.cwd(), parsed.root ?? ".");
    if (parsed.help || command === undefined || command === "help") {
      io.stdout(usage);
      return ExitCode.success;
    }
    // openapi output is always JSON, so --compact needs no --json there.
    if (parsed.compact && !parsed.json && command !== "openapi") {
      throw new UsageError("--compact requires --json.");
    }
    if (parsed.full && command !== "inspect") {
      throw new UsageError("--full is supported only by inspect.");
    }
    if (
      (parsed.bearer || parsed.health !== undefined || parsed.out !== undefined) &&
      command !== "openapi"
    ) {
      throw new UsageError("--bearer, --health, and --out are supported only by openapi.");
    }
    if (parsed.budget !== undefined && command !== "context") {
      throw new UsageError("--budget is supported only by context.");
    }
    if (command === "mcp") {
      if (positionals.length > 0) {
        throw new UsageError("mcp accepts no positional arguments.");
      }
      if (parsed.json || parsed.dryRun || parsed.format !== undefined) {
        throw new UsageError("mcp accepts only --root.");
      }
      const start = dependencies.startMcpServer ?? startMcpServer;
      // The server owns the process from here: it keeps running on stdio
      // until the client closes the pipe, so runCli reports startup success.
      void start(rootDir).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`Internal agentix error: ${message}\n`);
        process.exitCode = ExitCode.internalFailure;
      });
      return ExitCode.success;
    }
    if (command === "scaffold") {
      if (positionals[0] !== "feature" || positionals[1] === undefined || positionals.length !== 2) {
        throw new UsageError("scaffold requires 'feature <name>'.");
      }
      const result = scaffold(rootDir, positionals[1], parsed.dryRun);
      io.stdout(
        parsed.json
          ? serializeJson(result, parsed.compact)
          : `${result.dryRun ? "Would create" : "Created"} feature ${result.feature}\n${result.files.map((file) => `  ${file}`).join("\n")}\nNext:\n${result.nextActions.map((action) => `  ${action}`).join("\n")}\n`,
      );
      return ExitCode.success;
    }

    const index = loadIndex(rootDir);
    if (command === "inspect") {
      const target = requireTarget(positionals, "inspect");
      const inspected = inspectTarget(index, target, rootDir, parsed.full);
      io.stdout(
        parsed.json
          ? serializeJson(inspected, parsed.compact)
          : formatInspect(inspected),
      );
      return ExitCode.success;
    }
    if (command === "context") {
      const target = requireTarget(positionals, "context");
      let budgetBytes = CHANGE_CONTEXT_DEFAULT_BUDGET;
      if (parsed.budget !== undefined) {
        budgetBytes = Number(parsed.budget);
        if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
          throw new UsageError("--budget must be a positive integer (bytes).");
        }
      }
      const context = createChangeContext(index, target, rootDir, { budgetBytes });
      if (context === undefined) {
        throw new UsageError(`No indexed operation matches '${target}'.`);
      }
      io.stdout(
        parsed.json
          ? serializeJson(context, parsed.compact)
          : formatChangeContext(context),
      );
      return ExitCode.success;
    }
    if (command === "openapi") {
      if (positionals.length > 0) {
        throw new UsageError("openapi accepts no positional arguments.");
      }
      if (parsed.health !== undefined && !parsed.health.startsWith("/")) {
        throw new UsageError("--health must be an absolute path starting with '/'.");
      }
      const info = readPackageInfo(rootDir);
      const { document, warnings } = createOpenApiDocument(index, {
        title: info.title,
        version: info.version,
        bearer: parsed.bearer,
        ...(parsed.health === undefined ? {} : { health: parsed.health }),
      });
      for (const warning of warnings) io.stderr(`openapi: ${warning}\n`);
      const json = serializeJson(document, parsed.compact);
      if (parsed.out === undefined) {
        io.stdout(json);
      } else {
        const outputFile = resolve(dependencies.cwd ?? process.cwd(), parsed.out);
        writeFileSync(outputFile, json, "utf8");
        io.stdout(
          `Wrote OpenAPI 3.1 document to ${outputFile} (${Buffer.byteLength(json)} bytes).\n`,
        );
      }
      return ExitCode.success;
    }
    if (command === "graph") {
      if (positionals.length > 1) throw new UsageError("graph accepts at most one feature.");
      const format = parsed.json ? "json" : parsed.format ?? "text";
      if (format !== "text" && format !== "json" && format !== "dot") {
        throw new UsageError("graph --format must be text, json, or dot.");
      }
      io.stdout(formatGraph(graphEdges(index, positionals[0]), format, parsed.compact));
      return ExitCode.success;
    }
    if (command === "affected") {
      const target = requireTarget(positionals, "affected");
      const affected = computeAffected(index, target, rootDir);
      if (affected.items.length === 0 && affected.diagnostics.length > 0) {
        throw new UsageError(affected.diagnostics[0] ?? `No match for '${target}'.`);
      }
      io.stdout(
        parsed.json
          ? serializeJson(affected, parsed.compact)
          : `${affected.widened ? "scope: workspace (widened)\n" : ""}${affected.items
              .map((item) => `${item.id} [${item.kind}] <- ${item.reasons.map((reason) => reason.message).join("; ")}`)
              .join("\n")}\n`,
      );
      return ExitCode.success;
    }
    if (command === "verify") {
      const target = requireTarget(positionals, "verify");
      if (
        !index.features.some((feature) => feature.id === target) &&
        !index.operations.some((operation) => operation.id === target)
      ) {
        throw new UsageError(`No indexed feature or operation matches '${target}'.`);
      }
      // One affected computation per invocation, shared with the plan.
      const affected = computeAffected(index, target, rootDir);
      const plan = planVerification(index, target, rootDir, affected);
      const architectureErrors = index.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      );
      const checks: { command: readonly string[]; status: number; stdout: string; stderr: string }[] = [];
      if (architectureErrors.length === 0) {
        for (const commandLine of [plan.typecheck, plan.tests]) {
          const [executable, ...args] = commandLine;
          if (executable === undefined) continue;
          const result = runner(executable, args, rootDir);
          checks.push({ command: commandLine, ...result });
          if (!parsed.json) {
            if (result.stdout.length > 0) io.stdout(result.stdout);
            if (result.stderr.length > 0) io.stderr(result.stderr);
          }
          if (result.status !== 0) break;
        }
      }
      const passed = architectureErrors.length === 0 && checks.length === 2 && checks.every(({ status }) => status === 0);
      const result = {
        schemaVersion: "2",
        target,
        passed,
        plan,
        diagnostics: architectureErrors,
        checks,
      };
      if (parsed.json) {
        io.stdout(serializeJson(result, parsed.compact));
      } else {
        for (const diagnostic of architectureErrors) io.stderr(`${diagnosticText(diagnostic)}\n`);
        io.stdout(`verify ${target}: ${passed ? "passed" : "failed"} (${plan.scope})\n`);
      }
      return passed ? ExitCode.success : ExitCode.verificationFailure;
    }
    throw new UsageError(`Unknown command '${command}'.`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n${usage}`);
      return ExitCode.invalidInvocation;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Internal agentix error: ${message}\n`);
    return ExitCode.internalFailure;
  }
};
