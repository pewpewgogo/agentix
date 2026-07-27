import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { computeAffected, planVerification } from "./affected.js";
import { compareStrings as compare, dedentText, stableJson } from "./files.js";
import type {
  AffectedResult,
  AgentIndex,
  ChangeContext,
  ChangeContextTest,
  IndexedOperation,
  OperationContextOmission,
  VerificationPlan,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* One-artifact change surface for a single operation.                */
/*                                                                    */
/* Designed to REPLACE reading the feature file and its primary test  */
/* directly: it embeds the operation declaration and the smallest     */
/* associated test suite, and stays cheaper than those two reads.     */
/* Bounded by a byte budget measured on the compact stable-JSON       */
/* serialization; budget-forced drops land in projection.omissions.   */
/* ------------------------------------------------------------------ */

export const CHANGE_CONTEXT_DEFAULT_BUDGET = 16 * 1024;

export interface ChangeContextOptions {
  readonly budgetBytes?: number;
}

interface ChangeContextLevel {
  readonly embedTest: boolean;
  readonly includeExcerpt: boolean;
  readonly affectedLimit: number;
  readonly listLimit: number;
}

const levels: readonly ChangeContextLevel[] = [
  { embedTest: true, includeExcerpt: true, affectedLimit: 32, listLimit: 64 },
  { embedTest: false, includeExcerpt: true, affectedLimit: 8, listLimit: 16 },
  { embedTest: false, includeExcerpt: false, affectedLimit: 0, listLimit: 8 },
];

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;

const shellJoin = (argv: readonly string[]): string =>
  argv.map(shellArgument).join(" ");

const affectedExpansion = (
  operation: IndexedOperation,
): OperationContextOmission["expand"] => ({
  kind: "command",
  cwd: "application-root",
  argv: [
    "npm", "exec", "--", "agentix", "affected", "--root", ".", "--json", "--", operation.id,
  ],
});

const detailExpansion = (
  operation: IndexedOperation,
): OperationContextOmission["expand"] => ({
  kind: "command",
  cwd: "application-root",
  argv: [
    "npm", "exec", "--", "agentix", "inspect", "--full", "--root", ".", "--json", "--", operation.id,
  ],
});

interface TestFileInfo {
  readonly id: string;
  readonly bytes: number | undefined;
}

const testFileInfos = (
  rootDir: string,
  operation: IndexedOperation,
): readonly TestFileInfo[] =>
  operation.tests.map((id) => {
    try {
      return { id, bytes: statSync(resolve(rootDir, id)).size };
    } catch {
      return { id, bytes: undefined };
    }
  });

/** The primary test is the smallest readable suite (ties: first id). */
const primaryTestOf = (infos: readonly TestFileInfo[]): string | undefined => {
  let primary: TestFileInfo | undefined;
  for (const info of infos) {
    if (info.bytes === undefined) continue;
    if (
      primary === undefined ||
      info.bytes < (primary.bytes as number) ||
      (info.bytes === primary.bytes && compare(info.id, primary.id) < 0)
    ) {
      primary = info;
    }
  }
  return primary?.id;
};

const buildLevel = (
  index: AgentIndex,
  operation: IndexedOperation,
  rootDir: string,
  affected: AffectedResult,
  plan: VerificationPlan,
  budgetBytes: number,
  level: ChangeContextLevel,
): ChangeContext => {
  const omissions: OperationContextOmission[] = [];
  const capped = <T>(
    values: readonly T[],
    limit: number,
    path: string,
    expand: OperationContextOmission["expand"],
  ): readonly T[] => {
    const included = values.slice(0, limit);
    if (included.length < values.length) {
      omissions.push({ path, total: values.length, included: included.length, expand });
    }
    return included;
  };

  const detail = detailExpansion(operation);
  const feature = index.features.find((candidate) => candidate.id === operation.feature);

  // Tests: every associated suite is listed; the primary one embeds its
  // full (de-indented) source so the artifact replaces reading it.
  const infos = testFileInfos(rootDir, operation);
  const primary = primaryTestOf(infos);
  const listedInfos = capped(infos, level.listLimit, "tests", detail);
  const tests: ChangeContextTest[] = listedInfos.map((info) => {
    if (!level.embedTest || info.id !== primary) return { file: info.id };
    try {
      return {
        file: info.id,
        source: dedentText(readFileSync(resolve(rootDir, info.id), "utf8")),
      };
    } catch {
      return { file: info.id };
    }
  });
  if (!level.embedTest && primary !== undefined) {
    const location = index.tests.find((test) => test.id === primary)?.source ??
      { file: primary, line: 1, column: 1 };
    omissions.push({
      path: "tests[].source",
      total: 1,
      included: 0,
      expand: { kind: "source", source: location },
    });
  }

  const excerpt = level.includeExcerpt ? operation.declarationText : undefined;
  if (!level.includeExcerpt || operation.declarationText === undefined) {
    omissions.push({
      path: "excerpt",
      total: 1,
      included: 0,
      expand: { kind: "source", source: operation.source },
    });
  }

  const affectedIds = affected.widened
    ? capped(affected.items.map(({ id }) => id), 0, "affected", affectedExpansion(operation))
    : capped(
        affected.items.map(({ id }) => id),
        level.affectedLimit,
        "affected",
        affectedExpansion(operation),
      );

  const portSignatures = new Set<string>();
  for (const effect of operation.effects) {
    if (effect.operationId === undefined) continue;
    for (const port of index.ports) {
      for (const portOperation of port.operations) {
        if (portOperation.id === effect.operationId && portOperation.signature !== undefined) {
          portSignatures.add(portOperation.signature);
        }
      }
    }
  }

  const primaryFirstWrites = [
    operation.source.file,
    ...(primary === undefined ? [] : [primary]),
  ];

  const context: ChangeContext = {
    schemaVersion: "2",
    artifactKind: "change-context",
    id: operation.id,
    source: `${operation.source.file}:${operation.source.line}`,
    ...(operation.http === undefined
      ? {}
      : {
          http: {
            method: operation.http.method,
            path: operation.http.path,
            ...(operation.http.status === undefined ? {} : { status: operation.http.status }),
          },
        }),
    errors: capped(
      operation.errors.map((error) => ({
        code: error.code,
        ...(error.http === undefined ? {} : { http: error.http }),
      })),
      level.listLimit,
      "errors",
      detail,
    ),
    ...(operation.permissions.length === 0
      ? {}
      : { permissions: capped(operation.permissions, level.listLimit, "permissions", detail) }),
    ...(operation.events.length === 0
      ? {}
      : { events: capped(operation.events, level.listLimit, "events", detail) }),
    ...(operation.ensures.length === 0
      ? {}
      : { ensures: capped(operation.ensures, level.listLimit, "ensures", detail) }),
    ...(excerpt === undefined ? {} : { excerpt }),
    exports: capped(feature?.exports ?? [], level.listLimit, "exports", detail),
    effects: capped(
      operation.effects.map((effect) => `${effect.name}=${effect.operationId ?? effect.reference}`),
      level.listLimit,
      "effects",
      detail,
    ),
    ...(portSignatures.size === 0
      ? {}
      : {
          portSignatures: capped(
            [...portSignatures].sort(compare),
            level.listLimit,
            "portSignatures",
            detail,
          ),
        }),
    tests,
    affected: affectedIds,
    verification: {
      scope: plan.scope,
      typecheck: shellJoin(plan.typecheck),
      tests: shellJoin(plan.tests),
    },
    writes: primaryFirstWrites,
  };
  if (omissions.length === 0) return context;
  return {
    ...context,
    projection: { byteLimit: budgetBytes, truncated: true, omissions },
  };
};

export const createChangeContext = (
  index: AgentIndex,
  target: string,
  rootDir: string,
  options: ChangeContextOptions = {},
): ChangeContext | undefined => {
  const operation = index.operations.find((candidate) => candidate.id === target);
  if (operation === undefined) return undefined;
  const budgetBytes = options.budgetBytes ?? CHANGE_CONTEXT_DEFAULT_BUDGET;

  // One affected computation per invocation, shared with the plan.
  const affected = computeAffected(index, operation.id, rootDir);
  const plan = planVerification(index, operation.id, rootDir, affected);

  let smallest: number | undefined;
  for (const level of levels) {
    const context = buildLevel(index, operation, rootDir, affected, plan, budgetBytes, level);
    const bytes = Buffer.byteLength(stableJson(context, { compact: true }));
    if (bytes <= budgetBytes) return context;
    smallest = bytes;
  }
  throw new Error(
    `Change context for '${operation.id}' cannot fit ${budgetBytes} bytes ` +
      `(smallest projection is ${smallest} bytes); raise --budget.`,
  );
};
