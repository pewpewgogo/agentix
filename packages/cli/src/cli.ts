import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  computeAffected,
  createOperationContext,
  createOperationDetail,
  generateIndex,
  planVerification,
  stableJson,
  type AgentIndex,
  type CompilerDiagnostic,
  type GraphEdge,
  type OperationContext,
} from "@agentix/compiler";

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
}

interface ParsedArguments {
  readonly positional: readonly string[];
  readonly json: boolean;
  readonly compact: boolean;
  readonly dryRun: boolean;
  readonly full: boolean;
  readonly help: boolean;
  readonly format?: string;
  readonly root?: string;
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
  agentix graph [<feature>] [--format text|json|dot] [--json [--compact]] [--root <directory>]
  agentix affected <feature-or-file> [--json [--compact]] [--root <directory>]
  agentix verify <feature-or-operation> [--json [--compact]] [--root <directory>]
  agentix scaffold feature <name> [--dry-run] [--json [--compact]] [--root <directory>]
`;

const parseArguments = (args: readonly string[]): ParsedArguments => {
  const positional: string[] = [];
  let json = false;
  let compact = false;
  let dryRun = false;
  let full = false;
  let help = false;
  let format: string | undefined;
  let root: string | undefined;
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
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true;
    } else if (parseOptions && (argument === "--format" || argument === "--root")) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${argument} requires a value.`);
      }
      if (argument === "--format") format = value;
      else root = value;
      index += 1;
    } else if (parseOptions && argument?.startsWith("--") === true) {
      throw new UsageError(`Unknown option '${argument}'.`);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }
  return {
    positional,
    json,
    compact,
    dryRun,
    full,
    help,
    ...(format === undefined ? {} : { format }),
    ...(root === undefined ? {} : { root }),
  };
};

const serializeJson = (value: unknown, compact: boolean): string => {
  return stableJson(value, { compact });
};

const loadFreshIndex = (rootDir: string): AgentIndex =>
  // Generated indexes are disposable outputs, never trusted inputs to agent context.
  generateIndex({ rootDir, write: true }).index;

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
    return {
      schemaVersion: "1",
      kind: "feature",
      ...feature,
      affected: computeAffected(index, target, rootDir),
      verification: planVerification(index, target, rootDir),
    };
  }
  const operation = index.operations.find((candidate) => candidate.id === target);
  if (operation !== undefined) {
    return createOperationContext(index, target, rootDir);
  }
  const port = index.ports.find((candidate) => candidate.id === target);
  if (port !== undefined) {
    return { schemaVersion: "1", kind: "port", ...port };
  }
  for (const owner of index.ports) {
    const operation = owner.operations.find((candidate) => candidate.id === target);
    if (operation !== undefined) {
      return {
        schemaVersion: "1",
        artifactKind: "port-operation",
        port: owner.id,
        ...operation,
      };
    }
  }
  const event = index.events.find((candidate) => candidate.id === target);
  if (event !== undefined) {
    return { schemaVersion: "1", kind: "event", ...event };
  }
  const invariant = index.invariants.find((candidate) => candidate.id === target);
  if (invariant !== undefined) {
    return { schemaVersion: "1", kind: "invariant", ...invariant };
  }
  throw new UsageError(`No indexed feature or operation matches '${target}'.`);
};

const formatInspect = (value: unknown): string => {
  const inspected = value as {
    readonly id: string;
    readonly kind: string;
    readonly artifactKind?: string;
    readonly source: { readonly file: string; readonly line: number };
    readonly dependencies?: readonly string[];
    readonly consumers?: readonly string[];
    readonly operations?: readonly string[];
    readonly permissions?: readonly string[];
    readonly effects?: readonly { readonly name: string; readonly operationId?: string; readonly reference: string }[];
    readonly events?: readonly string[];
    readonly invariants?: readonly string[];
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
  list("dependencies", inspected.dependencies);
  list("consumers", inspected.consumers);
  list("operations", inspected.operations);
  list("permissions", inspected.permissions);
  if (inspected.effects !== undefined) {
    list(
      "effects",
      inspected.effects.map((effect) => `${effect.name}=${effect.operationId ?? effect.reference}`),
    );
  }
  list("events", inspected.events);
  list("invariants", inspected.invariants);
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

const graphEdges = (index: AgentIndex, featureId?: string): readonly GraphEdge[] => {
  if (featureId === undefined) return index.edges;
  const feature = index.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) throw new UsageError(`No indexed feature matches '${featureId}'.`);
  const related = new Set([
    feature.id,
    ...feature.dependencies,
    ...feature.consumers,
    ...feature.operations,
    ...feature.invariants,
    ...feature.tests,
  ]);
  return index.edges.filter((edge) => related.has(edge.from) || related.has(edge.to));
};

const dotEscape = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const formatGraph = (
  edges: readonly GraphEdge[],
  format: "text" | "json" | "dot",
  compact = false,
): string => {
  if (format === "json") {
    return serializeJson({ schemaVersion: "1", edges }, compact);
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

const featureName = (name: string): { camel: string; pascal: string } => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new UsageError("Feature name must be lowercase kebab-case.");
  }
  const pieces = name.split("-");
  const pascal = pieces.map((piece) => `${piece[0]?.toUpperCase()}${piece.slice(1)}`).join("");
  const candidate = `${pieces[0]}${pascal.slice(pieces[0]?.length ?? 0)}`;
  const reservedBindings = new Set([
    "arguments", "await", "break", "case", "catch", "class", "const",
    "continue", "debugger", "default", "delete", "do", "else", "enum",
    "eval", "export", "extends", "false", "finally", "for", "function",
    "if", "implements", "import", "in", "instanceof", "interface", "let",
    "new", "null", "package", "private", "protected", "public", "return",
    "static", "super", "switch", "this", "throw", "true", "try", "typeof",
    "var", "void", "while", "with", "yield",
  ]);
  return {
    camel: reservedBindings.has(candidate) ? `${candidate}Feature` : candidate,
    pascal,
  };
};

const scaffoldTemplates = (name: string): ReadonlyMap<string, string> => {
  const { camel, pascal } = featureName(name);
  return new Map([
    [
      "contract.ts",
      `import { defineFeatureContract } from "@agentix/core";\n\nexport interface ${pascal}View {\n  readonly id: string;\n}\n\nexport const ${camel}Contract = defineFeatureContract({\n  id: "${name}",\n  exports: {},\n});\n`,
    ],
    [
      "feature.ts",
      `import { defineFeature } from "@agentix/core";\n\nimport { ${camel}Contract } from "./contract.js";\n\nexport const ${camel} = defineFeature({\n  id: "${name}",\n  contract: ${camel}Contract,\n  dependencies: [],\n  operations: [],\n  invariants: [],\n});\n`,
    ],
    [
      `${name}.test.ts`,
      `import { describe, expect, it } from "vitest";\n\nimport { ${camel} } from "./feature.js";\n\ndescribe("${name}", () => {\n  it("declares a stable feature id", () => {\n    expect(${camel}.id).toBe("${name}");\n  });\n});\n`,
    ],
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
  readonly schemaVersion: "1";
  readonly dryRun: boolean;
  readonly directory: string;
  readonly files: readonly string[];
  readonly nextActions: readonly string[];
} => {
  const templates = scaffoldTemplates(name);
  const directory = resolve(rootDir, "src/features", name);
  if (existsSync(directory)) {
    throw new UsageError(`Refusing to overwrite existing feature directory '${directory}'.`);
  }
  const files = [...templates.keys()].map((file) => `src/features/${name}/${file}`).sort();
  if (!dryRun) {
    mkdirSync(directory, { recursive: true });
    for (const [file, contents] of templates) {
      writeFileSync(resolve(directory, file), contents, { encoding: "utf8", flag: "wx" });
    }
  }
  return {
    schemaVersion: "1",
    dryRun,
    directory: `src/features/${name}`,
    files,
    nextActions: [
      `Register the feature from src/features/${name}/feature.ts in application assembly.`,
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
    if (parsed.compact && !parsed.json) {
      throw new UsageError("--compact requires --json.");
    }
    if (parsed.full && command !== "inspect") {
      throw new UsageError("--full is supported only by inspect.");
    }
    if (command === "scaffold") {
      if (positionals[0] !== "feature" || positionals[1] === undefined || positionals.length !== 2) {
        throw new UsageError("scaffold requires 'feature <name>'.");
      }
      const result = scaffold(rootDir, positionals[1], parsed.dryRun);
      io.stdout(
        parsed.json
          ? serializeJson(result, parsed.compact)
          : `${result.dryRun ? "Would create" : "Created"} ${result.directory}\n${result.files.map((file) => `  ${file}`).join("\n")}\nNext:\n${result.nextActions.map((action) => `  ${action}`).join("\n")}\n`,
      );
      return ExitCode.success;
    }

    const index = loadFreshIndex(rootDir);
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
      const plan = planVerification(index, target, rootDir);
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
        schemaVersion: "1",
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
