import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { featureSegmentOf, repositoryPath } from "./files.js";
import type {
  AffectedItem,
  AffectedReason,
  AffectedResult,
  AgentIndex,
  DeclarationKind,
  VerificationPlan,
} from "./types.js";

interface NodeDescription {
  readonly id: string;
  readonly kind: DeclarationKind;
  readonly file?: string;
}

interface TraversalEdge {
  readonly to: string;
  readonly kind: AffectedReason["edge"];
  readonly reason: string;
}

const compare = (left: string, right: string): number => left.localeCompare(right);

const nodesFor = (index: AgentIndex): NodeDescription[] => [
  ...index.features.map((feature) => ({ id: feature.id, kind: "feature" as const, file: feature.source.file })),
  ...index.operations.map((operation) => ({ id: operation.id, kind: operation.kind, file: operation.source.file })),
  ...index.ports.map((port) => ({ id: port.id, kind: "port" as const, file: port.source.file })),
  ...index.ports.flatMap((port) =>
    port.operations.map((operation) => ({ id: operation.id, kind: "port" as const, file: operation.source.file })),
  ),
  ...index.events.map((event) => ({ id: event.id, kind: "event" as const, file: event.source.file })),
  ...index.tests.map((test) => ({ id: test.id, kind: "test" as const, file: test.source.file })),
];

const wholeWorkspace = (
  index: AgentIndex,
  target: string,
  message: string,
): AffectedResult => ({
  schemaVersion: "2",
  target,
  widened: true,
  items: nodesFor(index)
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      reasons: [
        {
          from: target,
          edge: "conservative-widening" as const,
          message,
        },
      ],
    }))
    .sort((left, right) => compare(left.id, right.id)),
  diagnostics: [message],
});

/**
 * Adjacency map for affected traversal, built once per computeAffected.
 * Dependency-like edges are reversed so traversal flows from a changed
 * declaration toward everything it can break.
 */
const adjacencyFor = (index: AgentIndex): Map<string, TraversalEdge[]> => {
  const adjacency = new Map<string, TraversalEdge[]>();
  const add = (from: string, edge: TraversalEdge): void => {
    const edges = adjacency.get(from) ?? [];
    edges.push(edge);
    adjacency.set(from, edges);
  };
  for (const edge of index.edges) {
    switch (edge.kind) {
      case "feature-dependency":
        add(edge.to, {
          to: edge.from,
          kind: edge.kind,
          reason: `${edge.to} feature file is consumed by ${edge.from}`,
        });
        break;
      case "operation-effect":
      case "operation-event":
        add(edge.to, { to: edge.from, kind: edge.kind, reason: edge.reason });
        break;
      case "feature-operation":
      case "port-operation":
      case "operation-test":
        add(edge.from, { to: edge.to, kind: edge.kind, reason: edge.reason });
        break;
    }
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => compare(left.to, right.to) || compare(left.kind, right.kind));
  }
  return adjacency;
};

const normalizeTargetFile = (rootDir: string | undefined, target: string): string => {
  if (rootDir === undefined) return target.replaceAll("\\", "/").replace(/^\.\//u, "");
  const absolute = isAbsolute(target) ? target : resolve(rootDir, target);
  return repositoryPath(rootDir, absolute);
};

/**
 * Partition unresolved entries (formatted `file:line: reason`) into features
 * whose static edges are incomplete versus entries that cannot be attributed
 * to an indexed feature (those force workspace-wide verification).
 */
const partitionUnresolved = (
  index: AgentIndex,
): { features: Set<string>; global: string[] } => {
  const featureBySegment = new Map<string, string>();
  for (const feature of index.features) {
    const segment = featureSegmentOf(feature.source.file);
    if (segment !== undefined) featureBySegment.set(segment, feature.id);
  }
  const features = new Set<string>();
  const global: string[] = [];
  for (const entry of index.unresolved) {
    const separator = entry.indexOf(":");
    const file = separator === -1 ? entry : entry.slice(0, separator);
    const segment = featureSegmentOf(file);
    const feature = segment === undefined ? undefined : featureBySegment.get(segment);
    if (feature === undefined) {
      global.push(entry);
    } else {
      features.add(feature);
    }
  }
  return { features, global };
};

export const computeAffected = (
  index: AgentIndex,
  target: string,
  rootDir?: string,
): AffectedResult => {
  const unresolved = partitionUnresolved(index);
  if (unresolved.global.length > 0) {
    return wholeWorkspace(
      index,
      target,
      `Unresolved static edges outside any indexed feature force workspace verification: ${unresolved.global.join("; ")}`,
    );
  }
  const normalizedFile = normalizeTargetFile(rootDir, target);
  if (
    /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]*)?\.json|vitest\.config\.[cm]?ts)$/u.test(normalizedFile) ||
    /(?:^|\/)packages\/(?:core|compiler)\//u.test(normalizedFile)
  ) {
    return wholeWorkspace(
      index,
      target,
      `Shared configuration or framework source '${normalizedFile}' may affect the entire workspace.`,
    );
  }

  const nodes = nodesFor(index);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let selected = nodes.filter((node) => node.id === target);
  if (selected.length === 0) {
    selected = nodes.filter(
      (node) => node.file === normalizedFile || node.file?.startsWith(`${normalizedFile}/`) === true,
    );
  }
  if (selected.length === 0) {
    const segment = featureSegmentOf(normalizedFile);
    if (segment !== undefined) {
      selected = nodes.filter(
        (node) =>
          node.kind === "feature" &&
          featureSegmentOf(node.file ?? "") === segment,
      );
    }
  }
  if (selected.length === 0) {
    const manifestKnowsFile = index.sourceManifest.files.some((entry) => entry.file === normalizedFile);
    if (manifestKnowsFile || target.includes("/") || target.includes("\\")) {
      return wholeWorkspace(
        index,
        target,
        `Source '${normalizedFile}' has no statically owned declaration, so a narrow closure cannot be proven safe.`,
      );
    }
    return {
      schemaVersion: "2",
      target,
      widened: false,
      items: [],
      diagnostics: [`No indexed feature, operation, or source matches '${target}'.`],
    };
  }

  const adjacency = adjacencyFor(index);
  const reasons = new Map<string, AffectedReason[]>();
  const queue: string[] = [];
  const seed = (id: string, reason: AffectedReason): void => {
    const existing = reasons.get(id);
    if (existing === undefined) {
      reasons.set(id, [reason]);
      queue.push(id);
    } else if (!existing.some((candidate) => candidate.from === reason.from && candidate.edge === reason.edge)) {
      existing.push(reason);
    }
  };
  for (const node of selected.sort((left, right) => compare(left.id, right.id))) {
    seed(node.id, { from: target, edge: "selected", message: `${node.id} matches '${target}'.` });
  }
  // Unresolved static edges widen conservatively, scoped to the owning
  // feature's reachable subgraph instead of the whole workspace.
  for (const feature of [...unresolved.features].sort(compare)) {
    seed(feature, {
      from: target,
      edge: "conservative-widening",
      message: `Feature '${feature}' has unresolved static edges, so its subgraph is conservatively included.`,
    });
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const edge of adjacency.get(current) ?? []) {
      seed(edge.to, { from: current, edge: edge.kind, message: edge.reason });
    }
  }

  const items: AffectedItem[] = [...reasons]
    .map(([id, itemReasons]): AffectedItem => ({
      id,
      kind: byId.get(id)?.kind ?? "workspace",
      reasons: itemReasons.sort(
        (left, right) => compare(left.from, right.from) || compare(left.edge, right.edge),
      ),
    }))
    .sort((left, right) => compare(left.id, right.id));
  return { schemaVersion: "2", target, widened: false, items, diagnostics: [] };
};

const vitestConfigNames = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
];

/**
 * Nearest directory at or above rootDir holding a Vitest (or Vite) config.
 * Vitest resolves its config upward the same way, so when the nearest config
 * sits above the application the test command must re-anchor `--root` there
 * or the app-relative file filters match nothing.
 */
const nearestVitestConfigDirectory = (rootDir: string): string | undefined => {
  let directory = resolve(rootDir);
  for (;;) {
    if (vitestConfigNames.some((name) => existsSync(resolve(directory, name)))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const nearestProject = (rootDir: string, sourceFile: string): string | undefined => {
  const root = resolve(rootDir);
  let directory = dirname(resolve(root, sourceFile));
  while (directory.startsWith(root)) {
    if (existsSync(resolve(directory, "tsconfig.json"))) return directory;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
};

const declaredPackageScript = (
  rootDir: string,
  name: "test" | "typecheck",
): readonly string[] | undefined => {
  const packageFile = resolve(rootDir, "package.json");
  if (!existsSync(packageFile)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(packageFile, "utf8")) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    return typeof manifest.scripts?.[name] === "string"
      ? name === "test"
        ? ["npm", "test"]
        : ["npm", "run", "typecheck"]
      : undefined;
  } catch {
    return undefined;
  }
};

/** Workspace-scope verification plan without recomputing the affected closure. */
export const workspaceVerificationPlan = (
  target: string,
  rootDir: string,
  reason: string,
): VerificationPlan => ({
  schemaVersion: "2",
  target,
  scope: "workspace",
  reason,
  typecheck:
    declaredPackageScript(rootDir, "typecheck") ??
    ["npm", "exec", "--", "tsc", "-b", "--pretty", "false"],
  tests:
    declaredPackageScript(rootDir, "test") ??
    ["npm", "exec", "--", "vitest", "run"],
  testFiles: [],
});

export const planVerification = (
  index: AgentIndex,
  target: string,
  rootDir: string,
  affected: AffectedResult = computeAffected(index, target, rootDir),
): VerificationPlan => {
  const selectedTests = affected.items
    .filter((item) => item.kind === "test")
    .map((item) => item.id)
    .sort(compare);
  const targetSource =
    index.operations.find((operation) => operation.id === target)?.source.file ??
    index.features.find((feature) => feature.id === target)?.source.file;
  const project = targetSource === undefined ? undefined : nearestProject(rootDir, targetSource);
  const narrow =
    !affected.widened &&
    affected.diagnostics.length === 0 &&
    project !== undefined &&
    selectedTests.length > 0;
  if (!narrow) {
    return workspaceVerificationPlan(
      target,
      rootDir,
      affected.diagnostics[0] ??
        "Project references and associated tests do not prove a narrower scope safe.",
    );
  }
  // When the nearest Vitest config sits above the application, filters stay
  // rootDir-relative in testFiles but the command re-anchors `--root` at the
  // config directory with config-relative filters, because Vitest matches
  // filters against paths from the config's root, not the invocation cwd.
  const configDirectory = nearestVitestConfigDirectory(rootDir);
  const configAbove =
    configDirectory !== undefined && configDirectory !== resolve(rootDir);
  const testArguments = configAbove
    ? [
        "--root",
        repositoryPath(rootDir, configDirectory),
        ...selectedTests.map(
          (test) => `${repositoryPath(configDirectory, resolve(rootDir))}/${test}`,
        ),
      ]
    : selectedTests;
  return {
    schemaVersion: "2",
    target,
    scope: "project",
    reason: "A referenced TypeScript project and explicit associated tests cover the affected closure.",
    typecheck: [
      "npm",
      "exec",
      "--",
      "tsc",
      "-b",
      repositoryPath(rootDir, project) || ".",
      "--pretty",
      "false",
    ],
    tests: ["npm", "exec", "--", "vitest", "run", ...testArguments],
    testFiles: selectedTests,
  };
};
