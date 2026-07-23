import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HARNESS_SCHEMA_VERSION,
  ScriptedAgentAdapter,
  readImmutableRunResult,
  runBenchmark,
} from "../../harness/src/index.js";
import {
  createEvaluatorLifecycleHooks,
  type BlackBoxDriver,
  type ConfinedProcessRunner,
  type ProcessRequest,
} from "./executor.js";
import { loadCorpus } from "./load.js";
import { materializeFixture } from "./materialize.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

/**
 * This runner is deliberately a smoke double: it proves lifecycle wiring while
 * spawning no process. Its structural isolation attestation must never be used
 * for confirmatory evaluation, which the evaluator rejects independently.
 */
class SmokeOnlyConfinedRunner implements ConfinedProcessRunner {
  public readonly smokeOnly = true;
  public readonly isolation = {
    network: "disabled" as const,
    filesystem: "workspace-only" as const,
  };
  public readonly requests: ProcessRequest[] = [];

  public async run(request: ProcessRequest) {
    this.requests.push(request);
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  }
}

const smokeOnlyBlackBoxDriver: BlackBoxDriver = {
  async run() {
    return { passed: true, details: "smoke-only driver invocation" };
  },
};

describe("evaluator and harness integration smoke", () => {
  it("materializes a frozen arm, runs a fresh scripted workspace, and writes an ineligible immutable result", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Network access is forbidden in the integration smoke.");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const temporaryRoot = await mkdtemp(join(tmpdir(), "agentix-evaluator-harness-"));
    temporaryDirectories.push(temporaryRoot);
    const fixtureSourcesRoot = join(temporaryRoot, "fixture-sources");
    const fixtureName = "task-05-framework-v1";
    const fixtureSource = join(fixtureSourcesRoot, fixtureName);
    const workspaceRunsRoot = join(temporaryRoot, "agent-workspaces");
    const resultsRoot = join(temporaryRoot, "immutable-results");
    await mkdir(fixtureSourcesRoot, { recursive: true });

    const corpus = await loadCorpus(repositoryRoot);
    const task = corpus.tasks.find(
      ({ specification }) => specification.id === "task-05-localized-defect",
    );
    expect(task).toBeDefined();
    if (task === undefined) return;
    const fixture = task.arms.framework.fixture;
    await materializeFixture(repositoryRoot, fixtureSource, fixture);

    const frozenDefectPath = join(
      fixtureSource,
      "examples/framework-app/src/features/products/operations.ts",
    );
    expect(await readFile(frozenDefectPath, "utf8")).toContain(
      "value.trim().length <= 79",
    );

    const confinedRunner = new SmokeOnlyConfinedRunner();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: workspaceRunsRoot,
      processRunner: confinedRunner,
      commandTimeoutMs: 1_000,
      blackBoxDriver: smokeOnlyBlackBoxDriver,
    });
    expect(hooks.confirmatoryReady).toBe(false);

    const runId = "integration-smoke-task-05-framework-r1";
    const output = await runBenchmark({
      mode: "smoke",
      identity: {
        schemaVersion: HARNESS_SCHEMA_VERSION,
        runId,
        task: {
          schemaVersion: HARNESS_SCHEMA_VERSION,
          id: task.specification.id,
          version: task.specification.version,
        },
        arm: "framework",
        repetition: 1,
        scheduleSeed: "integration-smoke-seed-v1",
        fixtureRevision: task.specification.fixture.framework.sha256,
        evaluatorRevision: task.specification.evaluator.hiddenManifestSha256,
        analysisRevision: "not-applicable-smoke-v1",
      },
      fixture: {
        fixturesRoot: fixtureSourcesRoot,
        relativePath: fixtureName,
      },
      workspaceRunsRoot,
      resultsRoot,
      instructions: {
        system: "Local deterministic integration smoke. No provider calls.",
        developer: "Use only the scripted adapter and injected smoke doubles.",
        user: task.specification.userRequest,
        tools: [],
        permissions: { network: false },
        limits: { seconds: 5 },
      },
      adapter: new ScriptedAgentAdapter({
        id: "evaluator-harness-integration-smoke-v1",
        steps: [],
      }),
      hooks,
      timeoutMs: 5_000,
      pricing: null,
      environment: {
        containerImage: null,
        hostClass: "local-test",
        packageManager: "npm-offline-smoke",
        dependencyCachePolicy: "not-used-smoke-double",
        networkPolicy: "disabled",
        toolVersions: { node: process.version },
      },
    });

    expect(output.workspacePath).not.toBe(fixtureSource);
    expect(await readFile(join(
      output.workspacePath,
      "examples/framework-app/src/features/products/operations.ts",
    ), "utf8")).toContain("value.trim().length <= 79");
    expect(
      output.record.completionStatus,
      JSON.stringify(output.record.preflight, null, 2),
    ).toBe("completed");
    expect(output.record.provider).toBe("scripted");
    expect(output.record.responseIds).toEqual([]);
    expect(output.record.patch.totalFilesModified).toBe(0);
    expect(output.record.preflight).toHaveLength(fixture.preflight.length);
    expect(output.record.preflight.every(({ status }) => status === "passed"))
      .toBe(true);
    expect(output.record.preflight.every(({ durationMs }) =>
      Number.isSafeInteger(durationMs) && durationMs >= 0
    )).toBe(true);
    expect(output.record.evaluation.checks.every(({ status }) =>
      status === "passed" || status === "not_applicable"
    )).toBe(true);
    expect(output.record.evaluation.success).toBe(false);
    expect(output.record.evaluation.invalidRunReason)
      .toBe("production_hidden_evaluator_unavailable");
    expect(output.record.finalSuccess).toBe(false);
    expect(confinedRunner.smokeOnly).toBe(true);
    expect(confinedRunner.requests.length).toBeGreaterThan(0);
    expect(confinedRunner.requests.every(({ networkPolicy }) =>
      networkPolicy === "disabled"
    )).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const immutable = await readImmutableRunResult(resultsRoot, runId);
    expect(immutable.finalSuccess).toBe(false);
    expect(immutable.evaluation.invalidRunReason)
      .toBe("production_hidden_evaluator_unavailable");
    expect(immutable.identity.fixtureRevision)
      .toBe(task.specification.fixture.framework.sha256);
  });
});
