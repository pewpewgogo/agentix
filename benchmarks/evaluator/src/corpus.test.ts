import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readVerifiedGitBlob, readVerifiedGitBlobs, sha256 } from "./integrity.js";
import { loadBaseInventory, loadCorpus } from "./load.js";
import { materializeFixture } from "./materialize.js";
import { createEvaluationPlan } from "./plan.js";
import {
  FixtureManifestSchema,
  PROHIBITED_SHORTCUTS,
  TASK_CATEGORIES,
  TaskSpecificationSchema,
} from "./schemas.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentix-fixture-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("frozen benchmark corpus", () => {
  it("loads exactly one strict, paired task for every preregistered category", async () => {
    const corpus = await loadCorpus(repositoryRoot);

    expect(corpus.tasks).toHaveLength(10);
    expect(corpus.tasks.map(({ specification }) => specification.category)).toEqual(
      TASK_CATEGORIES,
    );
    expect(new Set(corpus.tasks.map(({ specification }) => specification.id)).size)
      .toBe(10);

    for (const task of corpus.tasks) {
      expect(task.specification.version).toBe(1);
      expect(task.specification.networkPolicy).toBe("disabled");
      expect(task.specification.prohibitedShortcuts).toEqual(PROHIBITED_SHORTCUTS);
      expect(task.arms.framework.fixture.equivalence.scenarioIds).toEqual(
        task.arms.plain.fixture.equivalence.scenarioIds,
      );
      expect(task.hiddenEvaluator.checks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("builds public, hidden, correctness, architecture, and shortcut phases", async () => {
    const corpus = await loadCorpus(repositoryRoot);

    for (const task of corpus.tasks) {
      const frameworkPlan = createEvaluationPlan(
        task.specification,
        task.arms.framework.fixture,
        task.hiddenEvaluator,
      );
      const plainPlan = createEvaluationPlan(
        task.specification,
        task.arms.plain.fixture,
        task.hiddenEvaluator,
      );

      expect(frameworkPlan.networkPolicy).toBe("disabled");
      expect(frameworkPlan.steps.some((step) => step.check === "task-specific")).toBe(true);
      expect(frameworkPlan.steps.some((step) => step.check === "hidden-regression")).toBe(true);
      expect(frameworkPlan.steps.some((step) => step.check === "typecheck")).toBe(true);
      expect(frameworkPlan.steps.find((step) => step.check === "architecture")?.applicability)
        .toBe("required");
      expect(frameworkPlan.steps.at(-1)?.check).toBe("prohibited-shortcuts");
      expect(plainPlan.steps.find((step) => step.check === "architecture")?.applicability)
        .toBe("not_applicable");
      expect(
        plainPlan.steps
          .filter((step) =>
            step.check === "hidden-regression" || step.check === "task-specific"
          )
          .every((step) => step.visibility === "evaluator-only"),
      ).toBe(true);

      expect(frameworkPlan.steps[0]?.check).toBe("acceptance");
      expect(frameworkPlan.steps[0]?.visibility).toBe("agent-visible");
      if (task.specification.evaluator.kind === "answer") {
        expect(task.specification.category).toBe("read-only-architecture-question");
        expect(frameworkPlan.steps[0]?.command).toBeUndefined();
      }
    }
  });

  it("keeps hidden definitions and counterpart sources out of materialized workspaces", async () => {
    const corpus = await loadCorpus(repositoryRoot);
    const task = corpus.tasks.find(
      ({ specification }) => specification.id === "task-05-localized-defect",
    );
    expect(task).toBeDefined();
    if (task === undefined) return;

    for (const implementation of ["framework", "plain"] as const) {
      const destination = await temporaryDirectory();
      const fixture = task.arms[implementation].fixture;
      const result = await materializeFixture(repositoryRoot, destination, fixture);
      const counterpart = implementation === "framework"
        ? "examples/plain-app"
        : "examples/framework-app";

      expect(result.files.some((path) => path.startsWith(`${counterpart}/`))).toBe(false);
      await expect(stat(join(destination, counterpart))).rejects.toThrow();
      await expect(stat(join(destination, "benchmarks/evaluator/hidden"))).rejects.toThrow();
      await expect(stat(join(destination, fixture.applicationSubdirectory))).resolves.toBeDefined();
    }
  });

  it("materializes exact defect and data overlays without embedding a solution", async () => {
    const corpus = await loadCorpus(repositoryRoot);
    const localized = corpus.tasks.find(
      ({ specification }) => specification.id === "task-05-localized-defect",
    );
    const misleading = corpus.tasks.find(
      ({ specification }) => specification.id === "task-06-misleading-symptom",
    );
    const migration = corpus.tasks.find(
      ({ specification }) => specification.id === "task-08-schema-migration",
    );
    expect(localized).toBeDefined();
    expect(misleading).toBeDefined();
    expect(migration).toBeDefined();
    if (localized === undefined || misleading === undefined || migration === undefined) return;

    const localizedDirectory = await temporaryDirectory();
    await materializeFixture(
      repositoryRoot,
      localizedDirectory,
      localized.arms.plain.fixture,
    );
    const productSource = await readFile(
      join(localizedDirectory, "examples/plain-app/src/features/products/product.ts"),
      "utf8",
    );
    expect(productSource.match(/\.max\(79\)/gu)).toHaveLength(2);
    expect(productSource).not.toContain(".max(80)");

    const misleadingDirectory = await temporaryDirectory();
    await materializeFixture(
      repositoryRoot,
      misleadingDirectory,
      misleading.arms.framework.fixture,
    );
    const applicationSource = await readFile(
      join(misleadingDirectory, "examples/framework-app/src/application.ts"),
      "utf8",
    );
    expect(applicationSource).toContain("storedOrder.quantity <= 6");
    expect(applicationSource).not.toContain("storedOrder.quantity <= 7");

    const migrationDirectory = await temporaryDirectory();
    await materializeFixture(
      repositoryRoot,
      migrationDirectory,
      migration.arms.framework.fixture,
    );
    const migrationInput = JSON.parse(
      await readFile(
        join(migrationDirectory, "migration-inputs/products.v1.json"),
        "utf8",
      ),
    ) as { readonly schemaVersion: number };
    expect(migrationInput.schemaVersion).toBe(1);
  });

  it("refuses nonempty destinations and excluded overlay targets", async () => {
    const corpus = await loadCorpus(repositoryRoot);
    const fixture = corpus.tasks[0]?.arms.framework.fixture;
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    const nonempty = await temporaryDirectory();
    await writeFile(join(nonempty, "sentinel"), "keep", "utf8");
    await expect(materializeFixture(repositoryRoot, nonempty, fixture)).rejects.toThrow(
      /must be empty/u,
    );

    const excluded = await temporaryDirectory();
    const source = "benchmarks/fixtures/v1/task-08-schema-migration/data/products.v1.json";
    const sourceLock = corpus.lock.files.find((file) => file.path === source);
    expect(sourceLock).toBeDefined();
    if (sourceLock === undefined) return;
    const unsafeFixture = {
      ...fixture,
      overlay: {
        edits: fixture.overlay.edits,
        files: [{
          source,
          target: "benchmarks/evaluator/hidden/leak.json",
          sha256: sourceLock.sha256,
          executable: false,
        }],
      },
    };
    await expect(
      materializeFixture(repositoryRoot, excluded, unsafeFixture),
    ).rejects.toThrow(/excluded content/u);
  });

  it("uses a hash-verified inventory with disjoint arm source trees", async () => {
    const corpus = await loadCorpus(repositoryRoot);
    const fixture = corpus.tasks[0]?.arms.framework.fixture;
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const inventory = await loadBaseInventory(repositoryRoot, fixture);

    const frameworkSources = inventory.entries
      .filter((entry) => entry.audiences.includes("framework"))
      .map((entry) => entry.source);
    const plainSources = inventory.entries
      .filter((entry) => entry.audiences.includes("plain"))
      .map((entry) => entry.source);
    expect(frameworkSources.some((path) => path.startsWith("examples/plain-app/")))
      .toBe(false);
    expect(plainSources.some((path) => path.startsWith("examples/framework-app/")))
      .toBe(false);
    expect(inventory.entries.some((entry) =>
      entry.source.startsWith("benchmarks/evaluator/hidden/"))).toBe(false);
    expect(inventory.sourceRevision.commit).toBe(
      "5fd027e0399440179859094490b2fa6110f1b30e",
    );
  });

  it("materializes inventory bytes from the frozen commit, not the working tree", async () => {
    const sourceRepository = await temporaryDirectory();
    const frozenSource = "export const source = 'frozen';\n";
    const workingTreeSource = "export const source = 'working-tree';\n";
    await execFileAsync("git", ["init", "--quiet", sourceRepository]);
    await writeFile(join(sourceRepository, "source.ts"), frozenSource, "utf8");
    await execFileAsync("git", ["-C", sourceRepository, "add", "source.ts"]);
    await execFileAsync("git", [
      "-C",
      sourceRepository,
      "-c",
      "user.name=Agentix Corpus Test",
      "-c",
      "user.email=corpus-test@agentix.invalid",
      "commit",
      "--quiet",
      "-m",
      "Freeze source",
    ]);
    const { stdout: commitOutput } = await execFileAsync(
      "git",
      ["-C", sourceRepository, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    const commit = commitOutput.trim();
    const baseInventory = {
      schemaVersion: 1,
      id: "agentix-commerce-app-base",
      version: 1,
      hashAlgorithm: "sha256",
      sourceRevision: {
        kind: "repository-tree-inventory",
        label: "test-frozen-source",
        commit,
      },
      entries: [{
        source: "source.ts",
        target: "app/source.ts",
        audiences: ["framework"],
        sha256: sha256(frozenSource),
        executable: false,
      }],
    };
    const baseInventoryContent = `${JSON.stringify(baseInventory, null, 2)}\n`;
    await writeFile(
      join(sourceRepository, "base.repository.json"),
      baseInventoryContent,
      "utf8",
    );
    await writeFile(join(sourceRepository, "source.ts"), workingTreeSource, "utf8");

    const fixture = FixtureManifestSchema.parse({
      schemaVersion: 1,
      taskId: "task-01-simple-feature",
      taskVersion: 1,
      fixtureVersion: 1,
      implementation: "framework",
      applicationSubdirectory: "app",
      baseInventory: {
        manifest: "base.repository.json",
        sha256: sha256(baseInventoryContent),
      },
      overlay: { edits: [], files: [] },
      preflight: [{
        command: ["true"],
        expectedExitCode: 0,
        purpose: "Verify the synthetic fixture.",
      }],
      evaluationCommands: {
        typecheck: ["true"],
        regression: ["true"],
        architecture: null,
      },
      equivalence: {
        contractId: "commerce-http-v1",
        counterpartManifest: "plain.fixture.json",
        scenarioIds: ["synthetic-scenario"],
      },
      agentWorkspace: {
        excludedPrefixes: ["benchmarks/evaluator/hidden"],
      },
    });
    const destination = join(sourceRepository, "materialized");
    await materializeFixture(sourceRepository, destination, fixture);

    await expect(readFile(join(destination, "app/source.ts"), "utf8"))
      .resolves.toBe(frozenSource);
    await expect(readFile(join(sourceRepository, "source.ts"), "utf8"))
      .resolves.toBe(workingTreeSource);
    await expect(
      readVerifiedGitBlob(sourceRepository, commit, "../source.ts", sha256(frozenSource)),
    ).rejects.toThrow(/Unsafe repository-relative Git path/u);
    await expect(
      readVerifiedGitBlob(
        sourceRepository,
        commit,
        "source.ts\nHEAD:source.ts",
        sha256(frozenSource),
      ),
    ).rejects.toThrow(/Unsafe repository-relative Git path/u);
    await expect(
      readVerifiedGitBlob(sourceRepository, "HEAD", "source.ts", sha256(frozenSource)),
    ).rejects.toThrow(/full lowercase Git commit SHA/u);
    await expect(
      readVerifiedGitBlob(sourceRepository, commit, "source.ts", sha256("wrong")),
    ).rejects.toThrow(/Integrity mismatch for Git blob/u);
  });

  it("freezes missing behavior and defects, not completed task solutions", async () => {
    const corpus = await loadCorpus(repositoryRoot);
    const fixture = corpus.tasks[0]?.arms.framework.fixture;
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const inventory = await loadBaseInventory(repositoryRoot, fixture);
    const applicationEntries = inventory.entries.filter((entry) =>
      entry.source.startsWith("examples/") && entry.source.endsWith(".ts")
    );
    const frozenSources = await readVerifiedGitBlobs(
      repositoryRoot,
      inventory.sourceRevision.commit,
      applicationEntries.map((entry) => ({
        repositoryPath: entry.source,
        expectedSha256: entry.sha256,
      })),
    );
    const applicationSource = applicationEntries.map((entry) => {
      const source = frozenSources.get(entry.source);
      if (source === undefined) throw new Error(`Frozen source read omitted ${entry.source}.`);
      return source.toString("utf8");
    }).join("\n");

    for (const absentSolutionMarker of [
      "/promotions",
      "REPEAT_PURCHASE",
      "FRAUD_REJECTED",
      "catalog:write",
      "migrate:products",
      "/purchases",
    ]) {
      expect(applicationSource).not.toContain(absentSolutionMarker);
    }
  });
});

describe("task schema leakage controls", () => {
  it("rejects implementation-specific user wording and unknown hidden fields", async () => {
    const corpus = await loadCorpus(repositoryRoot);
    const original = corpus.tasks[0]?.specification;
    expect(original).toBeDefined();
    if (original === undefined) return;

    expect(() => TaskSpecificationSchema.parse({
      ...original,
      hiddenExpectedAnswer: "solution",
    })).toThrow();
  });
});
