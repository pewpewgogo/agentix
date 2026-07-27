import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { ExitCode, runCli } from "./cli.js";

/** Tool-argument problems become isError results, never protocol faults. */
class ToolInputError extends Error {}

const readVersion = (): string => {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { readonly version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const requireString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`'${key}' must be a non-empty string.`);
  }
  return value;
};

const optionalString = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`'${key}' must be a non-empty string when provided.`);
  }
  return value;
};

const optionalBoolean = (args: Record<string, unknown>, key: string): boolean => {
  const value = args[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ToolInputError(`'${key}' must be a boolean when provided.`);
  }
  return value;
};

const optionalInteger = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ToolInputError(`'${key}' must be an integer when provided.`);
  }
  return value;
};

interface ToolDefinition {
  readonly tool: Tool;
  /** Maps validated tool arguments to the exact CLI invocation. */
  readonly argv: (args: Record<string, unknown>) => readonly string[];
}

/**
 * Every tool is a thin wrapper over the corresponding CLI command with
 * `--json --compact` forced, so tool results are byte-identical to what the
 * command prints. Descriptions are written for coding agents: what each
 * artifact costs, when to prefer which tool, and what runs subprocesses.
 */
const toolDefinitions: readonly ToolDefinition[] = [
  {
    tool: {
      name: "inspect",
      description:
        "Bounded summary of one Agentix artifact by id: a feature ('orders'), operation " +
        "('orders.create'), port ('customerStore'), port operation ('customerStore.get'), or " +
        "event ('orders.created'). Operation results are operation-context artifacts capped at " +
        "8 KiB with source excerpts, the affected closure, and a verification plan; anything cut " +
        "for the cap is listed under projection.omissions with an exact follow-up. Cheap - use " +
        "this first to orient. When you are about to EDIT an operation, call 'context' instead. " +
        "Set full=true (operations only) for the unbounded operation-detail.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Feature, operation, port, port-operation, or event id.",
          },
          full: {
            type: "boolean",
            description: "Unbounded operation-detail instead of the 8 KiB projection (operations only).",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    argv: (args) => [
      "inspect",
      requireString(args, "target"),
      ...(optionalBoolean(args, "full") ? ["--full"] : []),
    ],
  },
  {
    tool: {
      name: "context",
      description:
        "One-call change pack for one operation id ('orders.create'): the operation's full " +
        "declaration text, error/status table, effect port signatures, the primary associated " +
        "test source, the affected closure, pasteable typecheck/test commands, and the writes " +
        "recipe (the files a typical change edits, in order). Designed to REPLACE reading the " +
        "feature file and its test - call this instead of opening those files before an edit. " +
        "Compact JSON under a 16384-byte default budget; omissions carry exact follow-ups. Raise " +
        "budgetBytes only when the artifact reports omissions you need inlined.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "Operation id, e.g. 'orders.create'." },
          budgetBytes: {
            type: "integer",
            description: "Byte budget for the compact JSON artifact (default 16384).",
          },
        },
        required: ["operation"],
        additionalProperties: false,
      },
    },
    argv: (args) => {
      const budget = optionalInteger(args, "budgetBytes");
      return [
        "context",
        requireString(args, "operation"),
        ...(budget === undefined ? [] : ["--budget", String(budget)]),
      ];
    },
  },
  {
    tool: {
      name: "graph",
      description:
        "Dependency edges of the analyzed application as {schemaVersion, edges:[{from, to, kind, " +
        "reason}]}, optionally scoped to one feature id. Edge kinds: feature-dependency, " +
        "feature-operation, port-operation, operation-effect, operation-event, operation-test. " +
        "Cheap; use to understand coupling before planning a cross-feature change. Scope to a " +
        "feature on large applications - the unscoped graph grows with the whole codebase.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string", description: "Optional feature id to scope the edge list." },
        },
        additionalProperties: false,
      },
    },
    argv: (args) => {
      const feature = optionalString(args, "feature");
      return ["graph", ...(feature === undefined ? [] : [feature])];
    },
  },
  {
    tool: {
      name: "affected",
      description:
        "Conservative closure of a change to a feature id, operation id, or repo-relative file " +
        "path: every operation, consumer, and test that could be affected, each with reasons. " +
        "widened=true means static analysis had to widen to the whole workspace. Cheap; use it " +
        "to size a change before editing and to decide what to re-verify after.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Feature id, operation id, or repo-relative file path.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    argv: (args) => ["affected", requireString(args, "target")],
  },
  {
    tool: {
      name: "verify",
      description:
        "Plan AND run verification for a feature or operation id: architecture diagnostics " +
        "first, then the narrowest safe typecheck and test commands as npm subprocesses. SLOW " +
        "(seconds to minutes, CPU-bound) - run it after editing, never to explore. The JSON " +
        "report embeds every check's command, exit status, stdout, and stderr; a failed " +
        "verification returns that same report as an isError result.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Feature or operation id to verify." },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    argv: (args) => ["verify", requireString(args, "target")],
  },
  {
    tool: {
      name: "scaffold",
      description:
        "Write a new single-file feature skeleton: src/features/<name>.ts (schema + store port + " +
        "create/get operations with unified errors and HTTP routes) plus a colocated dispatch " +
        "test. Name must be lowercase kebab-case ('price-rules'). Refuses to overwrite existing " +
        "files. Set dryRun=true to preview the file list without writing. Returns the files and " +
        "pasteable next actions (register the feature, then inspect/verify it).",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Feature name in lowercase kebab-case." },
          dryRun: { type: "boolean", description: "Preview the files without writing them." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    argv: (args) => [
      "scaffold",
      "feature",
      requireString(args, "name"),
      ...(optionalBoolean(args, "dryRun") ? ["--dry-run"] : []),
    ],
  },
  {
    tool: {
      name: "openapi",
      description:
        "Deterministic OpenAPI 3.1 JSON for every operation with http metadata, mirroring the " +
        "HTTP adapter exactly (response envelope, error statuses, parameter mapping). bearer=true " +
        "documents bearer auth on permissioned operations; healthPath ('/healthz') documents the " +
        "liveness endpoint. The document spans the WHOLE API surface and can run tens of KiB - " +
        "prefer 'inspect'/'context' for single operations. Schemas that cannot be statically " +
        "evaluated degrade permissively and are reported in a second warnings content block.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          bearer: {
            type: "boolean",
            description: "Document bearer auth on permissioned operations (plus 401 responses).",
          },
          healthPath: {
            type: "string",
            description: "Absolute liveness path to document, e.g. '/healthz'.",
          },
        },
        additionalProperties: false,
      },
    },
    argv: (args) => {
      const health = optionalString(args, "healthPath");
      return [
        "openapi",
        ...(optionalBoolean(args, "bearer") ? ["--bearer"] : []),
        ...(health === undefined ? [] : ["--health", health]),
      ];
    },
  },
];

const textResult = (text: string, isError: boolean): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Runs one CLI invocation against the fixed root and converts its exit code
 * and streams into a tool result. `runCli` already funnels every failure into
 * an exit code, so a tool call can never take the server down; the outer
 * catch is a final guarantee.
 */
const runToolCommand = (argv: readonly string[], rootDir: string): CallToolResult => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let status: number;
  try {
    status = runCli([...argv, "--json", "--compact"], {
      cwd: rootDir,
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Internal agentix error: ${message}`, true);
  }
  const out = stdout.join("").trimEnd();
  const err = stderr.join("").trimEnd();
  if (status === ExitCode.success) {
    const result = textResult(out.length > 0 ? out : "(no output)", false);
    // openapi degradation warnings arrive on stderr with a zero exit code.
    if (err.length > 0) result.content.push({ type: "text", text: err });
    return result;
  }
  const text = [out, err].filter((part) => part.length > 0).join("\n");
  return textResult(text.length > 0 ? text : `agentix exited with status ${status}.`, true);
};

/**
 * Builds the `agentix mcp` stdio server for one application root. The root is
 * fixed for the session at construction; every tool call re-runs the CLI,
 * which re-validates `.agentix/index.json` staleness through the digest fast
 * path and re-analyzes when sources changed.
 */
export const createMcpServer = (rootDir: string): Server => {
  const server = new Server(
    { name: "agentix", version: readVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        `Agentix static-analysis tools for the application at ${rootDir}. ` +
        "Results are the CLI's compact JSON artifacts (schemaVersion 2), served from a " +
        "digest-checked index that re-analyzes automatically when sources change. Typical " +
        "flow: inspect to orient, context before editing an operation (it replaces reading " +
        "the feature and test files), affected to size a change, verify after editing.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDefinitions.map((definition) => definition.tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const definition = toolDefinitions.find(
      (candidate) => candidate.tool.name === request.params.name,
    );
    if (definition === undefined) {
      return textResult(
        `Unknown tool '${request.params.name}'. Available tools: ` +
          `${toolDefinitions.map(({ tool }) => tool.name).join(", ")}.`,
        true,
      );
    }
    let argv: readonly string[];
    try {
      argv = definition.argv(request.params.arguments ?? {});
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error;
      return textResult(`Invalid arguments for '${request.params.name}': ${error.message}`, true);
    }
    return runToolCommand(argv, rootDir);
  });
  return server;
};

/** Connects the server for `rootDir` to stdio; resolves once it is serving. */
export const startMcpServer = async (rootDir: string): Promise<void> => {
  await createMcpServer(rootDir).connect(new StdioServerTransport());
};
