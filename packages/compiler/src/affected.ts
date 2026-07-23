import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { repositoryPath } from "./files.js";
import type {
  AffectedItem,
  AffectedReason,
  AffectedResult,
  AgentIndex,
  DeclarationKind,
  GraphEdge,
  VerificationPlan,
} from "./types.js";

interface NodeDescription {
  readonly id: string;
  readonly kind: DeclarationKind;
  readonly file?: string;
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
  ...index.invariants.map((invariant) => ({ id: invariant.id, kind: "invariant" as const, file: invariant.source.file })),
  ...index.tests.map((test) => ({ id: test.id, kind: "test" as const, file: test.source.file })),
];

const wholeWorkspace = (
  index: AgentIndex,
  target: string,
  message: string,
): AffectedResult => ({
  schemaVersion: "1",
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

const traversalEdges = (index: AgentIndex): GraphEdge[] => {
  const edges: GraphEdge[] = [];
  for (const edge of index.edges) {
    if (edge.kind === "feature-dependency") {
      edges.push({
        ...edge,
        from: edge.to,
        to: edge.from,
        reason: `${edge.to} public contract is consumed by ${edge.from}`,
      });
      continue;
    }
    if (
      edge.kind === "operation-effect" ||
      edge.kind === "operation-event" ||
      edge.kind === "operation-invariant" ||
      edge.kind === "invariant-dependency"
    ) {
      edges.push({ ...edge, from: edge.to, to: edge.from });
    }
    if (
      edge.kind === "feature-operation" ||
      edge.kind === "operation-test" ||
      edge.kind === "operation-invariant"
    ) {
      edges.push(edge);
    }
  }
  return edges.sort(
    (left, right) =>
      compare(left.from, right.from) ||
      compare(left.to, right.to) ||
      compare(left.kind, right.kind),
  );
};

const normalizeTargetFile = (rootDir: string | undefined, target: string): string => {
  if (rootDir === undefined) return target.replaceAll("\\", "/").replace(/^\.\//u, "");
  const absolute = isAbsolute(target) ? target : resolve(rootDir, target);
  return repositoryPath(rootDir, absolute);
};

export const computeAffected = (
  index: AgentIndex,
  target: string,
  rootDir?: string,
): AffectedResult => {
  if (index.unresolved.length > 0) {
    return wholeWorkspace(
      index,
      target,
      `Unresolved static edges force workspace verification: ${index.unresolved.join("; ")}`,
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
    const segment = /(?:^|\/)src\/features\/([^/]+)(?:\/|$)/u.exec(normalizedFile)?.[1];
    if (segment !== undefined) {
      selected = nodes.filter(
        (node) =>
          node.kind === "feature" &&
          /(?:^|\/)src\/features\/([^/]+)(?:\/|$)/u.exec(node.file ?? "")?.[1] === segment,
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
      schemaVersion: "1",
      target,
      widened: false,
      items: [],
      diagnostics: [`No indexed feature, operation, or source matches '${target}'.`],
    };
  }

  const reasons = new Map<string, AffectedReason[]>();
  const queue: string[] = [];
  for (const node of selected.sort((left, right) => compare(left.id, right.id))) {
    reasons.set(node.id, [
      { from: target, edge: "selected", message: `${node.id} matches '${target}'.` },
    ]);
    queue.push(node.id);
  }
  const edges = traversalEdges(index);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const edge of edges.filter((candidate) => candidate.from === current)) {
      const reason: AffectedReason = {
        from: current,
        edge: edge.kind,
        message: edge.reason,
      };
      const existing = reasons.get(edge.to);
      if (existing === undefined) {
        reasons.set(edge.to, [reason]);
        queue.push(edge.to);
      } else if (!existing.some((candidate) => candidate.from === reason.from && candidate.edge === reason.edge)) {
        existing.push(reason);
      }
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
  return { schemaVersion: "1", target, widened: false, items, diagnostics: [] };
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

export const planVerification = (
  index: AgentIndex,
  target: string,
  rootDir: string,
): VerificationPlan => {
  const affected = computeAffected(index, target, rootDir);
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
    resolve(project) !== resolve(rootDir) &&
    selectedTests.length > 0;
  if (!narrow) {
    return {
      schemaVersion: "1",
      target,
      scope: "workspace",
      reason:
        affected.diagnostics[0] ??
        "Project references and associated tests do not prove a narrower scope safe.",
      typecheck:
        declaredPackageScript(rootDir, "typecheck") ??
        ["npm", "exec", "--", "tsc", "-b", "--pretty", "false"],
      tests:
        declaredPackageScript(rootDir, "test") ??
        ["npm", "exec", "--", "vitest", "run"],
      testFiles: [],
    };
  }
  return {
    schemaVersion: "1",
    target,
    scope: "project",
    reason: "A single referenced TypeScript project and explicit associated tests cover the affected closure.",
    typecheck: [
      "npm",
      "exec",
      "--",
      "tsc",
      "-b",
      repositoryPath(rootDir, project),
      "--pretty",
      "false",
    ],
    tests: ["npm", "exec", "--", "vitest", "run", ...selectedTests],
    testFiles: selectedTests,
  };
};
