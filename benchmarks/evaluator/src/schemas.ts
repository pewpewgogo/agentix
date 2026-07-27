import { isAbsolute, posix } from "node:path";

import { z } from "zod";

export const IMPLEMENTATIONS = ["framework", "plain"] as const;
export const CORPUS_VERSIONS = ["v1", "v2"] as const;
export type CorpusVersion = (typeof CORPUS_VERSIONS)[number];

export const CORPUS_IDS = [
  "agentix-commerce-maintenance-v1",
  "agentix-commerce-maintenance-v2",
] as const;
export const CONTRACT_IDS = ["commerce-http-v1", "commerce-http-v2"] as const;

export interface CorpusConfiguration {
  readonly version: CorpusVersion;
  readonly corpusId: (typeof CORPUS_IDS)[number];
  readonly corpusVersion: 1 | 2;
  readonly taskDirectory: string;
  readonly lockPath: string;
  readonly fixturesPrefix: string;
  readonly hiddenPrefix: string;
  readonly contractId: (typeof CONTRACT_IDS)[number];
}

/**
 * v1 is the frozen two-arm record and stays the default everywhere. v2 is the
 * additive corpus targeting the current single-file framework layout.
 */
export const CORPUS_CONFIGURATIONS: Readonly<
  Record<CorpusVersion, CorpusConfiguration>
> = {
  v1: {
    version: "v1",
    corpusId: "agentix-commerce-maintenance-v1",
    corpusVersion: 1,
    taskDirectory: "benchmarks/tasks/v1",
    lockPath: "benchmarks/tasks/corpus.lock.json",
    fixturesPrefix: "benchmarks/fixtures/v1/",
    hiddenPrefix: "benchmarks/evaluator/hidden/v1/",
    contractId: "commerce-http-v1",
  },
  v2: {
    version: "v2",
    corpusId: "agentix-commerce-maintenance-v2",
    corpusVersion: 2,
    taskDirectory: "benchmarks/tasks/v2",
    lockPath: "benchmarks/tasks/corpus-v2.lock.json",
    fixturesPrefix: "benchmarks/fixtures/v2/",
    hiddenPrefix: "benchmarks/evaluator/hidden/v2/",
    contractId: "commerce-http-v2",
  },
};

export const TASK_CATEGORIES = [
  "simple-feature",
  "field-propagation",
  "cross-feature-rule",
  "external-service-adapter",
  "localized-defect",
  "misleading-non-local-cause",
  "authorization-change",
  "data-schema-migration",
  "compatible-operation-rename",
  "read-only-architecture-question",
] as const;

export const PROHIBITED_SHORTCUTS = [
  "hard-code-evaluator-output",
  "modify-evaluator-or-harness",
  "delete-or-disable-tests",
  "bypass-public-api",
  "network-or-prior-solution-access",
  "cross-arm-source-access",
  "fixture-specific-production-branch",
] as const;

export type Implementation = (typeof IMPLEMENTATIONS)[number];

const isNormalizedRepositoryPath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\0") &&
  !value.includes("\n") &&
  !value.includes("\r") &&
  !isAbsolute(value) &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  posix.normalize(value) === value &&
  value !== ".." &&
  !value.startsWith("../");

export const RepositoryPathSchema = z.string().refine(
  isNormalizedRepositoryPath,
  "Expected a normalized repository-relative path without '..' or control separators.",
);

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const GitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const CommandSchema = z.array(z.string().min(1)).min(1);
const ImplementationSchema = z.enum(IMPLEMENTATIONS);

export const FixtureReferenceSchema = z.strictObject({
  manifest: RepositoryPathSchema,
  sha256: Sha256Schema,
});

const PublicSurfaceSchema = z.strictObject({
  kind: z.enum(["http", "module", "command", "answer"]),
  identifier: z.string().min(1),
  behavior: z.string().min(1),
});

const WorkspacePublicEvaluatorSchema = z.strictObject({
  kind: z.literal("workspace"),
  commandByImplementation: z.strictObject({
    framework: CommandSchema,
    plain: CommandSchema,
  }),
  hiddenManifest: RepositoryPathSchema,
  hiddenManifestSha256: Sha256Schema,
});

const AnswerPublicEvaluatorSchema = z.strictObject({
  kind: z.literal("answer"),
  answerFormat: z.string().min(1),
  hiddenManifest: RepositoryPathSchema,
  hiddenManifestSha256: Sha256Schema,
});

export const TaskSpecificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^task-(?:0[1-9]|10)-[a-z0-9-]+$/u),
  version: z.number().int().positive(),
  category: z.enum(TASK_CATEGORIES),
  userRequest: z.string().min(40),
  publicAcceptanceCriteria: z.array(z.string().min(10)).min(2),
  expectedPublicSurfaces: z.array(PublicSurfaceSchema).min(1),
  fixture: z.strictObject({
    framework: FixtureReferenceSchema,
    plain: FixtureReferenceSchema,
  }),
  evaluator: z.discriminatedUnion("kind", [
    WorkspacePublicEvaluatorSchema,
    AnswerPublicEvaluatorSchema,
  ]),
  maximumSeconds: z.number().int().min(60).max(3_600),
  prohibitedShortcuts: z.array(z.enum(PROHIBITED_SHORTCUTS)).min(1),
  networkPolicy: z.literal("disabled"),
});

export type TaskSpecification = z.infer<typeof TaskSpecificationSchema>;

const InventoryEntrySchema = z.strictObject({
  source: RepositoryPathSchema,
  target: RepositoryPathSchema,
  audiences: z.array(z.enum(["shared", ...IMPLEMENTATIONS])).min(1),
  sha256: Sha256Schema,
  executable: z.boolean(),
});

export const BaseInventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.literal("agentix-commerce-app-base"),
  version: z.number().int().positive(),
  hashAlgorithm: z.literal("sha256"),
  sourceRevision: z.strictObject({
    kind: z.literal("repository-tree-inventory"),
    label: z.string().min(1),
    commit: GitCommitSchema,
  }),
  entries: z.array(InventoryEntrySchema).min(1),
});

export type BaseInventory = z.infer<typeof BaseInventorySchema>;

const OverlayEditSchema = z.strictObject({
  path: RepositoryPathSchema,
  find: z.string().min(1),
  replace: z.string(),
  expectedOccurrences: z.number().int().positive(),
});

const OverlayFileSchema = z.strictObject({
  source: RepositoryPathSchema,
  target: RepositoryPathSchema,
  sha256: Sha256Schema,
  executable: z.boolean(),
});

const EvaluationCommandsSchema = z.strictObject({
  typecheck: CommandSchema,
  regression: CommandSchema,
  architecture: CommandSchema.nullable(),
});

export const FixtureManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.string().regex(/^task-(?:0[1-9]|10)-[a-z0-9-]+$/u),
  taskVersion: z.number().int().positive(),
  fixtureVersion: z.number().int().positive(),
  implementation: ImplementationSchema,
  applicationSubdirectory: RepositoryPathSchema,
  baseInventory: z.strictObject({
    manifest: RepositoryPathSchema,
    sha256: Sha256Schema,
  }),
  overlay: z.strictObject({
    edits: z.array(OverlayEditSchema),
    files: z.array(OverlayFileSchema),
  }),
  preflight: z.array(
    z.strictObject({
      command: CommandSchema,
      expectedExitCode: z.number().int().min(0).max(255),
      purpose: z.string().min(10),
    }),
  ).min(1),
  evaluationCommands: EvaluationCommandsSchema,
  equivalence: z.strictObject({
    contractId: z.enum(CONTRACT_IDS),
    counterpartManifest: RepositoryPathSchema,
    scenarioIds: z.array(z.string().min(1)).min(1),
  }),
  agentWorkspace: z.strictObject({
    excludedPrefixes: z.array(RepositoryPathSchema).min(1),
  }),
});

export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

const HiddenCheckBaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  implementations: z.array(ImplementationSchema).min(1),
});

const BlackBoxCheckSchema = HiddenCheckBaseSchema.extend({
  kind: z.literal("black-box"),
  driver: z.enum(["commerce-http", "migration-cli"]),
  scenario: z.string().min(10),
  assertions: z.array(z.string().min(5)).min(1),
}).strict();

const RegressionCheckSchema = HiddenCheckBaseSchema.extend({
  kind: z.literal("regression-command"),
  commandByImplementation: z.strictObject({
    framework: CommandSchema,
    plain: CommandSchema,
  }),
  expectedExitCode: z.number().int().min(0).max(255),
}).strict();

const AnswerRubricCheckSchema = HiddenCheckBaseSchema.extend({
  kind: z.literal("answer-rubric"),
  requiredConceptsByImplementation: z.strictObject({
    framework: z.array(z.string().min(3)).min(1),
    plain: z.array(z.string().min(3)).min(1),
  }),
  forbiddenClaims: z.array(z.string().min(3)),
  requireNoWorkspaceChanges: z.literal(true),
}).strict();

export const HiddenEvaluatorManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.string().regex(/^task-(?:0[1-9]|10)-[a-z0-9-]+$/u),
  taskVersion: z.number().int().positive(),
  evaluatorVersion: z.number().int().positive(),
  checks: z.array(z.discriminatedUnion("kind", [
    BlackBoxCheckSchema,
    RegressionCheckSchema,
    AnswerRubricCheckSchema,
  ])).min(2),
  shortcutPolicy: z.strictObject({
    forbiddenModifiedPrefixes: z.array(RepositoryPathSchema).min(1),
    rejectDeletedTests: z.literal(true),
    rejectFocusedOrSkippedTests: z.literal(true),
    rejectNetworkUse: z.literal(true),
    rejectCrossArmSources: z.literal(true),
  }),
});

export type HiddenEvaluatorManifest = z.infer<
  typeof HiddenEvaluatorManifestSchema
>;

export const CorpusLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusId: z.enum(CORPUS_IDS),
  corpusVersion: z.union([z.literal(1), z.literal(2)]),
  hashAlgorithm: z.literal("sha256"),
  files: z.array(z.strictObject({
    path: RepositoryPathSchema,
    sha256: Sha256Schema,
  })).min(1),
});

export type CorpusLock = z.infer<typeof CorpusLockSchema>;
