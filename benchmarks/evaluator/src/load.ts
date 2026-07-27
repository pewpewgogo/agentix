import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ZodType } from "zod";

import {
  assertFileDigest,
  readVerifiedGitBlobs,
  resolveInside,
} from "./integrity.js";
import {
  BaseInventorySchema,
  CORPUS_CONFIGURATIONS,
  CorpusLockSchema,
  FixtureManifestSchema,
  HiddenEvaluatorManifestSchema,
  PROHIBITED_SHORTCUTS,
  TASK_CATEGORIES,
  TaskSpecificationSchema,
  type BaseInventory,
  type CorpusConfiguration,
  type CorpusLock,
  type CorpusVersion,
  type FixtureManifest,
  type HiddenEvaluatorManifest,
  type Implementation,
  type TaskSpecification,
} from "./schemas.js";

const parseJsonFile = async <T>(
  absolutePath: string,
  schema: ZodType<T>,
): Promise<T> => {
  const raw = await readFile(absolutePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause: unknown) {
    throw new SyntaxError(`Invalid JSON in ${absolutePath}`, { cause });
  }
  return schema.parse(value);
};

export interface LoadedArm {
  readonly fixture: FixtureManifest;
}

export interface LoadedTask {
  readonly specification: TaskSpecification;
  readonly arms: Readonly<Record<Implementation, LoadedArm>>;
  readonly hiddenEvaluator: HiddenEvaluatorManifest;
}

export interface LoadedCorpus {
  readonly tasks: readonly LoadedTask[];
  readonly lock: CorpusLock;
  readonly configuration: CorpusConfiguration;
}

const assertImplementationNeutral = (task: TaskSpecification): void => {
  const lower = task.userRequest.toLowerCase();
  const forbidden = [
    "framework-app",
    "plain-app",
    "@agentix",
    "feature capsule",
    "src/",
    ".ts",
  ];
  const leaked = forbidden.find((term) => lower.includes(term));
  if (leaked !== undefined) {
    throw new Error(`${task.id} userRequest leaks implementation detail '${leaked}'.`);
  }
};

const assertCompleteShortcutPolicy = (task: TaskSpecification): void => {
  const present = new Set(task.prohibitedShortcuts);
  const missing = PROHIBITED_SHORTCUTS.filter((shortcut) => !present.has(shortcut));
  if (missing.length > 0) {
    throw new Error(`${task.id} omits prohibited shortcuts: ${missing.join(", ")}`);
  }
};

const loadFixture = async (
  repositoryRoot: string,
  task: TaskSpecification,
  implementation: Implementation,
): Promise<FixtureManifest> => {
  const reference = task.fixture[implementation];
  const path = resolveInside(repositoryRoot, reference.manifest);
  await assertFileDigest(path, reference.sha256);
  const fixture = await parseJsonFile(path, FixtureManifestSchema);
  if (
    fixture.taskId !== task.id ||
    fixture.taskVersion !== task.version ||
    fixture.implementation !== implementation
  ) {
    throw new Error(`${task.id} ${implementation} fixture identity does not match its task.`);
  }
  return fixture;
};

const assertPairedFixture = (
  task: TaskSpecification,
  framework: FixtureManifest,
  plain: FixtureManifest,
): void => {
  if (
    framework.equivalence.contractId !== plain.equivalence.contractId ||
    JSON.stringify(framework.equivalence.scenarioIds) !==
      JSON.stringify(plain.equivalence.scenarioIds)
  ) {
    throw new Error(`${task.id} fixture arms do not declare equivalent scenarios.`);
  }
  if (
    framework.equivalence.counterpartManifest !== task.fixture.plain.manifest ||
    plain.equivalence.counterpartManifest !== task.fixture.framework.manifest
  ) {
    throw new Error(`${task.id} counterpart fixture references are not reciprocal.`);
  }
  if (framework.applicationSubdirectory === plain.applicationSubdirectory) {
    throw new Error(`${task.id} fixture arms unexpectedly share an application directory.`);
  }
};

const loadTask = async (
  repositoryRoot: string,
  path: string,
  configuration: CorpusConfiguration,
): Promise<LoadedTask> => {
  const specification = await parseJsonFile(path, TaskSpecificationSchema);
  assertImplementationNeutral(specification);
  assertCompleteShortcutPolicy(specification);

  if (!specification.evaluator.hiddenManifest.startsWith(configuration.hiddenPrefix)) {
    throw new Error(
      `${specification.id} hidden manifest is outside ${configuration.hiddenPrefix}.`,
    );
  }
  for (const implementation of ["framework", "plain"] as const) {
    const manifest = specification.fixture[implementation].manifest;
    if (!manifest.startsWith(configuration.fixturesPrefix)) {
      throw new Error(
        `${specification.id} ${implementation} fixture is outside ${configuration.fixturesPrefix}.`,
      );
    }
  }
  const hiddenPath = resolveInside(repositoryRoot, specification.evaluator.hiddenManifest);
  await assertFileDigest(hiddenPath, specification.evaluator.hiddenManifestSha256);
  const hiddenEvaluator = await parseJsonFile(
    hiddenPath,
    HiddenEvaluatorManifestSchema,
  );
  if (
    hiddenEvaluator.taskId !== specification.id ||
    hiddenEvaluator.taskVersion !== specification.version
  ) {
    throw new Error(`${specification.id} hidden evaluator identity does not match.`);
  }

  const [framework, plain] = await Promise.all([
    loadFixture(repositoryRoot, specification, "framework"),
    loadFixture(repositoryRoot, specification, "plain"),
  ]);
  assertPairedFixture(specification, framework, plain);
  if (
    framework.equivalence.contractId !== configuration.contractId ||
    plain.equivalence.contractId !== configuration.contractId
  ) {
    throw new Error(
      `${specification.id} fixtures must declare contract ${configuration.contractId}.`,
    );
  }

  return {
    specification,
    arms: {
      framework: { fixture: framework },
      plain: { fixture: plain },
    },
    hiddenEvaluator,
  };
};

export const loadBaseInventory = async (
  repositoryRoot: string,
  fixture: FixtureManifest,
): Promise<BaseInventory> => {
  const path = resolveInside(repositoryRoot, fixture.baseInventory.manifest);
  await assertFileDigest(path, fixture.baseInventory.sha256);
  return parseJsonFile(path, BaseInventorySchema);
};

export const loadCorpus = async (
  repositoryRoot: string,
  version: CorpusVersion = "v1",
): Promise<LoadedCorpus> => {
  const configuration = CORPUS_CONFIGURATIONS[version];
  const taskDirectory = resolveInside(repositoryRoot, configuration.taskDirectory);
  const names = (await readdir(taskDirectory))
    .filter((name) => name.endsWith(".task.json"))
    .sort();
  if (names.length !== 10) {
    throw new Error(`Expected exactly 10 task specifications, received ${names.length}.`);
  }

  const tasks = await Promise.all(
    names.map((name) =>
      loadTask(repositoryRoot, join(taskDirectory, name), configuration)
    ),
  );
  const ids = new Set(tasks.map(({ specification }) => specification.id));
  const categories = new Set(tasks.map(({ specification }) => specification.category));
  if (ids.size !== 10 || categories.size !== TASK_CATEGORIES.length) {
    throw new Error("Task IDs and categories must each be unique across the ten-task corpus.");
  }
  for (const category of TASK_CATEGORIES) {
    if (!categories.has(category)) {
      throw new Error(`Task corpus is missing category ${category}.`);
    }
  }

  const lockPath = resolveInside(repositoryRoot, configuration.lockPath);
  const lock = await parseJsonFile(lockPath, CorpusLockSchema);
  if (
    lock.corpusId !== configuration.corpusId ||
    lock.corpusVersion !== configuration.corpusVersion
  ) {
    throw new Error(
      `Corpus lock identity ${lock.corpusId}@${lock.corpusVersion} does not match the requested ${configuration.corpusId}@${configuration.corpusVersion}.`,
    );
  }
  const lockedPaths = new Set<string>();
  for (const file of lock.files) {
    if (lockedPaths.has(file.path)) {
      throw new Error(`Corpus lock contains duplicate path ${file.path}.`);
    }
    lockedPaths.add(file.path);
    await assertFileDigest(resolveInside(repositoryRoot, file.path), file.sha256);
  }

  const requiredLockedPaths = new Set<string>([
    ...names.map((name) =>
      relative(repositoryRoot, join(taskDirectory, name)).replaceAll("\\", "/")
    ),
  ]);
  for (const task of tasks) {
    requiredLockedPaths.add(task.specification.fixture.framework.manifest);
    requiredLockedPaths.add(task.specification.fixture.plain.manifest);
    requiredLockedPaths.add(task.specification.evaluator.hiddenManifest);
    for (const arm of Object.values(task.arms)) {
      requiredLockedPaths.add(arm.fixture.baseInventory.manifest);
      for (const file of arm.fixture.overlay.files) {
        requiredLockedPaths.add(file.source);
      }
    }
  }
  const missingLockedPaths = [...requiredLockedPaths]
    .filter((path) => !lockedPaths.has(path))
    .sort();
  if (missingLockedPaths.length > 0) {
    throw new Error(
      `Corpus lock omits required artifacts: ${missingLockedPaths.join(", ")}`,
    );
  }

  const firstFixture = tasks[0]?.arms.framework.fixture;
  if (firstFixture === undefined) {
    throw new Error("Task corpus unexpectedly has no framework fixture.");
  }
  const canonicalBaseReference = firstFixture.baseInventory;
  for (const task of tasks) {
    for (const arm of Object.values(task.arms)) {
      if (
        arm.fixture.baseInventory.manifest !== canonicalBaseReference.manifest ||
        arm.fixture.baseInventory.sha256 !== canonicalBaseReference.sha256
      ) {
        throw new Error(
          `All ${configuration.version} fixture arms must use the same frozen base inventory.`,
        );
      }
    }
  }
  const inventory = await loadBaseInventory(repositoryRoot, firstFixture);
  for (const entry of inventory.entries) {
    if (entry.source.startsWith("benchmarks/evaluator/hidden/")) {
      throw new Error(`Base inventory includes hidden evaluator source ${entry.source}.`);
    }
  }
  await readVerifiedGitBlobs(
    repositoryRoot,
    inventory.sourceRevision.commit,
    inventory.entries.map((entry) => ({
      repositoryPath: entry.source,
      expectedSha256: entry.sha256,
    })),
  );
  for (const implementation of ["framework", "plain"] as const) {
    const targets = new Set<string>();
    for (const entry of inventory.entries) {
      if (
        !entry.audiences.includes("shared") &&
        !entry.audiences.includes(implementation)
      ) {
        continue;
      }
      if (targets.has(entry.target)) {
        throw new Error(
          `Base inventory has duplicate ${implementation} target ${entry.target}.`,
        );
      }
      targets.add(entry.target);
    }
    const counterpart = implementation === "framework" ? "examples/plain-app" : "examples/framework-app";
    if ([...targets].some((target) => target.startsWith(`${counterpart}/`))) {
      throw new Error(`${implementation} inventory includes its counterpart source tree.`);
    }
  }
  return { tasks, lock, configuration };
};
