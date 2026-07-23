import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { BenchmarkLifecycleHooks as HarnessLifecycleHooks } from "../../harness/src/types.js";

import {
  EVALUATION_CHECK_NAMES,
  createEvaluatorLifecycleHooks,
  type BlackBoxDriver,
  type ConfinedProcessRunner,
  type LifecycleContextLike,
  type ProcessRequest,
} from "./executor.js";
import { loadCorpus, type LoadedTask } from "./load.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const temporaryDirectories: string[] = [];

const setupWorkspace = async (): Promise<{
  readonly runsRoot: string;
  readonly workspacePath: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "agentix-evaluator-executor-"));
  temporaryDirectories.push(root);
  const runsRoot = join(root, "runs");
  const workspacePath = join(runsRoot, "run-1");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(
    join(workspacePath, "src/value.test.ts"),
    "import { it } from 'vitest';\nit('works', () => undefined);\n",
    "utf8",
  );
  await writeFile(join(workspacePath, "src/value.ts"), "export const value = 1;\n");
  return { runsRoot, workspacePath };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

const contextFor = (
  task: LoadedTask,
  implementation: "framework" | "plain",
  workspacePath: string,
): LifecycleContextLike => ({
  identity: {
    runId: `${task.specification.id}-${implementation}-1`,
    task: { id: task.specification.id, version: task.specification.version },
    arm: implementation,
  },
  workspacePath,
  signal: new AbortController().signal,
});

class RecordingRunner implements ConfinedProcessRunner {
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

const passingBlackBox: BlackBoxDriver = {
  async run() {
    return { passed: true, details: null };
  },
};

const taskById = async (id: string): Promise<LoadedTask> => {
  const corpus = await loadCorpus(repositoryRoot);
  const task = corpus.tasks.find(({ specification }) => specification.id === id);
  if (task === undefined) throw new Error(`Missing test task ${id}`);
  return task;
};

describe("evaluator lifecycle executor", () => {
  it("cannot turn injected always-pass drivers into confirmatory evidence", async () => {
    const task = await taskById("task-01-simple-feature");
    const runner = new RecordingRunner();
    expect(() => createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "confirmatory",
      allowedRunsRoot: "/tmp",
      processRunner: runner,
      commandTimeoutMs: 1_000,
      blackBoxDriver: passingBlackBox,
    })).toThrow(/Confirmatory evaluation is blocked/u);
  });

  it("returns one real lifecycle result for every frozen check name", async () => {
    const task = await taskById("task-01-simple-feature");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const runner = new RecordingRunner();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: runner,
      commandTimeoutMs: 1_000,
      blackBoxDriver: passingBlackBox,
    });
    const harnessCompatible: HarnessLifecycleHooks = hooks;
    expect(harnessCompatible).toBe(hooks);
    const context = contextFor(task, "framework", workspacePath);

    const preflight = await hooks.preflight(context);
    const summary = await hooks.evaluate(context);

    expect(preflight).toHaveLength(3);
    expect(summary.checks.map(({ name }) => name)).toEqual(EVALUATION_CHECK_NAMES);
    expect(summary.checks.every(({ status }) => status === "passed")).toBe(true);
    expect(summary.success).toBe(false);
    expect(summary.invalidRunReason).toBe("production_hidden_evaluator_unavailable");
    expect(runner.requests.length).toBeGreaterThanOrEqual(6);
    const canonicalWorkspace = await realpath(workspacePath);
    expect(runner.requests.every(({ cwd }) => cwd === canonicalWorkspace)).toBe(true);
    expect(runner.requests.every(({ argv }) => Array.isArray(argv))).toBe(true);
    expect(runner.requests.every(({ networkPolicy }) => networkPolicy === "disabled"))
      .toBe(true);
  });

  it("marks plain architecture explicitly not applicable", async () => {
    const task = await taskById("task-01-simple-feature");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "plain",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: new RecordingRunner(),
      commandTimeoutMs: 1_000,
      blackBoxDriver: passingBlackBox,
    });
    const context = contextFor(task, "plain", workspacePath);

    await hooks.preflight(context);
    const summary = await hooks.evaluate(context);

    expect(summary.checks.find(({ name }) => name === "architecture")?.status)
      .toBe("not_applicable");
    expect(summary.success).toBe(false);
    expect(summary.invalidRunReason).toBe("production_hidden_evaluator_unavailable");
  });

  it("fails closed with an invalid-run reason when a required driver is absent", async () => {
    const task = await taskById("task-01-simple-feature");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: new RecordingRunner(),
      commandTimeoutMs: 1_000,
    });
    const context = contextFor(task, "framework", workspacePath);

    await hooks.preflight(context);
    const summary = await hooks.evaluate(context);

    expect(summary.success).toBe(false);
    expect(summary.invalidRunReason).toBe("required_black_box_driver_missing");
    expect(summary.checks.find(({ name }) => name === "task-specific")?.status)
      .toBe("failed");
  });

  it("runs answer acceptance and rubric through injected providers", async () => {
    const task = await taskById("task-10-architecture-question");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: new RecordingRunner(),
      commandTimeoutMs: 1_000,
      async answerProvider() {
        return "The clock is explicitly injected at composition and replaced in tests.";
      },
      answerDriver: {
        async run({ answer, check }) {
          return {
            passed: answer.includes("injected") && check.requireNoWorkspaceChanges,
            details: null,
          };
        },
      },
    });
    const context = contextFor(task, "framework", workspacePath);

    await hooks.preflight(context);
    const summary = await hooks.evaluate(context);

    expect(summary.success).toBe(false);
    expect(summary.invalidRunReason).toBe("production_hidden_evaluator_unavailable");
    expect(summary.checks.find(({ name }) => name === "acceptance")?.status)
      .toBe("passed");
    expect(summary.checks.find(({ name }) => name === "task-specific")?.status)
      .toBe("passed");
  });

  it("detects forbidden paths, test deletion, focused tests, and cross-arm source", async () => {
    const task = await taskById("task-01-simple-feature");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: new RecordingRunner(),
      commandTimeoutMs: 1_000,
      blackBoxDriver: passingBlackBox,
    });
    const context = contextFor(task, "framework", workspacePath);
    await hooks.preflight(context);

    await unlink(join(workspacePath, "src/value.test.ts"));
    await writeFile(
      join(workspacePath, "src/focused.test.ts"),
      "import { it } from 'vitest';\nit.only('focused', () => undefined);\n",
    );
    await mkdir(join(workspacePath, "benchmarks/evaluator"), { recursive: true });
    await writeFile(join(workspacePath, "benchmarks/evaluator/leak.ts"), "export {};\n");
    await mkdir(join(workspacePath, "examples/plain-app"), { recursive: true });
    await writeFile(join(workspacePath, "examples/plain-app/leak.ts"), "export {};\n");

    const summary = await hooks.evaluate(context);
    const shortcut = summary.checks.find(({ name }) => name === "prohibited-shortcuts");
    expect(shortcut?.status).toBe("failed");
    expect(shortcut?.details).toContain("forbidden paths changed");
    expect(shortcut?.details).toContain("tests deleted");
    expect(shortcut?.details).toContain("focused or skipped tests");
    expect(shortcut?.details).toContain("counterpart source tree");
  });

  it("rejects any workspace change for the read-only task", async () => {
    const task = await taskById("task-10-architecture-question");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "plain",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: new RecordingRunner(),
      commandTimeoutMs: 1_000,
      async answerProvider() {
        return "A source-grounded answer.";
      },
      answerDriver: {
        async run() {
          return { passed: true, details: null };
        },
      },
    });
    const context = contextFor(task, "plain", workspacePath);
    await hooks.preflight(context);
    await writeFile(join(workspacePath, "src/value.ts"), "export const value = 2;\n");

    const summary = await hooks.evaluate(context);

    expect(summary.success).toBe(false);
    expect(summary.checks.find(({ name }) => name === "prohibited-shortcuts")?.details)
      .toContain("read-only task changed workspace files");
  });

  it("rejects unattested runners and workspaces outside the configured runs root", async () => {
    const task = await taskById("task-01-simple-feature");
    const invalidRunner = {
      isolation: { network: "unrestricted", filesystem: "workspace-only" },
      async run() {
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ConfinedProcessRunner;
    expect(() => createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: "/tmp",
      processRunner: invalidRunner,
      commandTimeoutMs: 1_000,
      blackBoxDriver: passingBlackBox,
    })).toThrow(/disabled networking/u);

    const { runsRoot } = await setupWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "agentix-evaluator-outside-"));
    temporaryDirectories.push(outside);
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: new RecordingRunner(),
      commandTimeoutMs: 1_000,
      blackBoxDriver: passingBlackBox,
    });
    await expect(
      hooks.preflight(contextFor(task, "framework", outside)),
    ).rejects.toThrow(/escapes the configured runs root/u);
  });

  it("bounds a process runner that does not settle", async () => {
    const task = await taskById("task-01-simple-feature");
    const { runsRoot, workspacePath } = await setupWorkspace();
    const stuckRunner: ConfinedProcessRunner = {
      isolation: { network: "disabled", filesystem: "workspace-only" },
      async run() {
        return new Promise(() => undefined);
      },
    };
    const hooks = createEvaluatorLifecycleHooks({
      task,
      implementation: "framework",
      mode: "smoke",
      allowedRunsRoot: runsRoot,
      processRunner: stuckRunner,
      commandTimeoutMs: 10,
      blackBoxDriver: passingBlackBox,
    });

    const preflight = await hooks.preflight(
      contextFor(task, "framework", workspacePath),
    );

    expect(preflight.every(({ status }) => status === "failed")).toBe(true);
    expect(preflight.every(({ details }) => details?.includes("timed out") === true))
      .toBe(true);
  });
});
