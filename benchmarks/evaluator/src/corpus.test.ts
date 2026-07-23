import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadBaseInventory, loadCorpus } from "./load.js";
import { materializeFixture } from "./materialize.js";
import { createEvaluationPlan } from "./plan.js";
import {
  PROHIBITED_SHORTCUTS,
  TASK_CATEGORIES,
  TaskSpecificationSchema,
} from "./schemas.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const temporaryDirectories: string[] = [];

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
    const applicationSource = (await Promise.all(
      applicationEntries.map((entry) =>
        readFile(join(repositoryRoot, entry.source), "utf8")
      ),
    )).join("\n");

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
