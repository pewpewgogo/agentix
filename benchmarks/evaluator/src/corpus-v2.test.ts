import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readVerifiedGitBlobs } from "./integrity.js";
import { loadBaseInventory, loadCorpus } from "./load.js";
import { materializeFixture } from "./materialize.js";
import { createEvaluationPlan } from "./plan.js";
import { PROHIBITED_SHORTCUTS, TASK_CATEGORIES } from "./schemas.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentix-fixture-v2-test-"));
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

describe("frozen v2 benchmark corpus", () => {
  it("loads ten paired v2 tasks without disturbing the v1 default", async () => {
    const v2 = await loadCorpus(repositoryRoot, "v2");
    expect(v2.lock.corpusId).toBe("agentix-commerce-maintenance-v2");
    expect(v2.lock.corpusVersion).toBe(2);
    expect(v2.tasks).toHaveLength(10);
    expect(v2.tasks.map(({ specification }) => specification.category)).toEqual(
      TASK_CATEGORIES,
    );
    for (const task of v2.tasks) {
      expect(task.specification.version).toBe(1);
      expect(task.specification.prohibitedShortcuts).toEqual(PROHIBITED_SHORTCUTS);
      expect(task.arms.framework.fixture.equivalence.contractId).toBe("commerce-http-v2");
      expect(task.arms.plain.fixture.equivalence.contractId).toBe("commerce-http-v2");
      expect(task.specification.fixture.framework.manifest.startsWith(
        "benchmarks/fixtures/v2/",
      )).toBe(true);
      expect(task.specification.evaluator.hiddenManifest.startsWith(
        "benchmarks/evaluator/hidden/v2/",
      )).toBe(true);
      expect(task.hiddenEvaluator.checks.length).toBeGreaterThanOrEqual(2);
    }

    const v1 = await loadCorpus(repositoryRoot);
    expect(v1.lock.corpusId).toBe("agentix-commerce-maintenance-v1");
    expect(v1.configuration.version).toBe("v1");
  });

  it("pins the v2 single-file inventory to its frozen commit", async () => {
    const corpus = await loadCorpus(repositoryRoot, "v2");
    const fixture = corpus.tasks[0]?.arms.framework.fixture;
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const inventory = await loadBaseInventory(repositoryRoot, fixture);

    expect(inventory.version).toBe(2);
    expect(inventory.sourceRevision.commit).toBe(
      "4745d33c07b2c4a9cefddf1e0ee53b46566af730",
    );
    const sources = inventory.entries.map((entry) => entry.source);
    expect(sources).toContain("examples/framework-app/src/features/products.ts");
    expect(sources).toContain("examples/framework-app/src/adapters.ts");
    expect(sources).toContain("examples/plain-app/src/system.ts");
    expect(sources.some((source) => source.includes("/contract.ts") &&
      source.startsWith("examples/framework-app/"))).toBe(false);
    expect(sources.some((source) => source.startsWith("examples/pg-notes/"))).toBe(false);
    expect(sources.some((source) => source.startsWith("benchmarks/"))).toBe(false);
  });

  it("materializes v2 defect overlays and per-arm profiles", async () => {
    const corpus = await loadCorpus(repositoryRoot, "v2");
    const localized = corpus.tasks.find(
      ({ specification }) => specification.id === "task-05-localized-defect",
    );
    const misleading = corpus.tasks.find(
      ({ specification }) => specification.id === "task-06-misleading-symptom",
    );
    expect(localized).toBeDefined();
    expect(misleading).toBeDefined();
    if (localized === undefined || misleading === undefined) return;

    const frameworkDefect = await temporaryDirectory();
    await materializeFixture(
      repositoryRoot,
      frameworkDefect,
      localized.arms.framework.fixture,
    );
    const productsModule = await readFile(
      join(frameworkDefect, "examples/framework-app/src/features/products.ts"),
      "utf8",
    );
    expect(productsModule).toContain("max: 79");
    expect(productsModule).not.toContain("max: 80");
    const workspaceManifest = JSON.parse(
      await readFile(join(frameworkDefect, "package.json"), "utf8"),
    ) as { readonly name: string; readonly workspaces: readonly string[] };
    expect(workspaceManifest.name).toBe("agentix-research");
    expect(workspaceManifest.workspaces).toContain("examples/framework-app");
    await expect(stat(join(frameworkDefect, "package-lock.json"))).resolves.toBeDefined();
    await expect(stat(join(frameworkDefect, "examples/plain-app"))).rejects.toThrow();
    await expect(stat(join(frameworkDefect, "benchmarks"))).rejects.toThrow();

    const misleadingDefect = await temporaryDirectory();
    await materializeFixture(
      repositoryRoot,
      misleadingDefect,
      misleading.arms.framework.fixture,
    );
    const adaptersModule = await readFile(
      join(misleadingDefect, "examples/framework-app/src/adapters.ts"),
      "utf8",
    );
    expect(adaptersModule).toContain("order.quantity <= 6");
  });

  it("freezes missing behavior rather than completed v2 solutions", async () => {
    const corpus = await loadCorpus(repositoryRoot, "v2");
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

  it("plans the same six-check evaluation for v2 arms", async () => {
    const corpus = await loadCorpus(repositoryRoot, "v2");
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
      expect(frameworkPlan.steps.find((step) => step.check === "architecture")?.applicability)
        .toBe("required");
      expect(plainPlan.steps.find((step) => step.check === "architecture")?.applicability)
        .toBe("not_applicable");
      expect(frameworkPlan.steps.at(-1)?.check).toBe("prohibited-shortcuts");
    }
  });
});
