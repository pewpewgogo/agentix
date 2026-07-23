import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runBenchmark, type BenchmarkRunOptions } from "./runner.js";
import { ScriptedAgentAdapter } from "./scripted-adapter.js";
import {
  HARNESS_SCHEMA_VERSION,
  type AgentAdapter,
  type BenchmarkLifecycleHooks,
  type RunIdentity,
} from "./types.js";

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentix-runner-"));
  const fixtures = join(root, "fixtures");
  const fixture = join(fixtures, "fixture-v1");
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(join(fixture, "src", "value.ts"), "export const value = 1;\n");
  return {
    root,
    fixtures,
    workspaces: join(root, "workspaces"),
    results: join(root, "results"),
  };
};

const identity = (runId: string): RunIdentity => ({
  schemaVersion: HARNESS_SCHEMA_VERSION,
  runId,
  task: { schemaVersion: HARNESS_SCHEMA_VERSION, id: "task-01", version: 1 },
  arm: "framework",
  repetition: 1,
  scheduleSeed: "committed-seed",
  fixtureRevision: "fixture-v1",
  evaluatorRevision: "evaluator-v1",
  analysisRevision: "analysis-v1",
});

const hooks: BenchmarkLifecycleHooks = {
  async preflight() {
    return [
      { name: "fixture", status: "passed", durationMs: 1, details: null },
    ];
  },
  async evaluate({ workspacePath }) {
    const content = await readFile(join(workspacePath, "src", "value.ts"), "utf8");
    const success = content.includes("value = 2");
    return {
      checks: [
        {
          name: "external-evaluator",
          status: success ? "passed" : "failed",
          durationMs: 1,
          details: null,
        },
      ],
      success,
      failureCategory: success ? null : "acceptance failure",
      invalidRunReason: null,
    };
  },
};

const options = async (
  runId: string,
  adapter: AgentAdapter,
): Promise<BenchmarkRunOptions> => {
  const paths = await setup();
  return {
    mode: "smoke",
    identity: identity(runId),
    fixture: { fixturesRoot: paths.fixtures, relativePath: "fixture-v1" },
    workspaceRunsRoot: paths.workspaces,
    resultsRoot: paths.results,
    instructions: {
      system: "system\r\nline",
      developer: "developer",
      user: "change value",
      tools: ["read", "write", "exec"],
      permissions: { network: false },
      limits: { seconds: 10 },
    },
    adapter,
    hooks,
    timeoutMs: 1_000,
    pricing: null,
    environment: {
      containerImage: null,
      hostClass: "test",
      packageManager: "npm-test",
      dependencyCachePolicy: "none",
      networkPolicy: "disabled",
      toolVersions: { typescript: "test-version" },
    },
  };
};

describe("benchmark runner", () => {
  it("runs a fully instrumented scripted smoke without any model call", async () => {
    const adapter = new ScriptedAgentAdapter({
      steps: [
        { type: "event", event: { type: "assistant_turn", turnId: "turn-1" } },
        {
          type: "event",
          event: {
            type: "file_observation",
            path: "src/value.ts",
            source: "direct_read",
            bytesSurfaced: 24,
            linesSurfaced: 1,
          },
        },
        {
          type: "event",
          event: {
            type: "tool_call",
            callId: "test-1",
            toolName: "exec",
            status: "failed",
            retryOfCallId: null,
          },
        },
        {
          type: "event",
          event: {
            type: "command",
            commandId: "command-1",
            toolCallId: "test-1",
            argv: ["npm", "test"],
            cwd: ".",
            classification: "test",
            exitCode: 1,
            timedOut: false,
            durationMs: 10,
            retryOfCommandId: null,
          },
        },
        {
          type: "write_file",
          path: "src/value.ts",
          content: "export const value = 2;\n",
        },
        {
          type: "event",
          event: {
            type: "tool_call",
            callId: "test-2",
            toolName: "exec",
            status: "succeeded",
            retryOfCallId: "test-1",
          },
        },
        {
          type: "event",
          event: {
            type: "command",
            commandId: "command-2",
            toolCallId: "test-2",
            argv: ["npm", "test"],
            cwd: ".",
            classification: "test",
            exitCode: 0,
            timedOut: false,
            durationMs: 8,
            retryOfCommandId: "command-1",
          },
        },
      ],
      artifacts: [
        { name: "script/transcript.json", mediaType: "application/json", data: "{}" },
      ],
    });
    const result = await runBenchmark(await options("run-smoke", adapter));

    expect(result.record).toMatchObject({
      mode: "smoke",
      completionStatus: "completed",
      provider: "scripted",
      finalSuccess: true,
      evaluation: { success: true },
      interaction: {
        assistantTurns: 1,
        toolCalls: 2,
        failedToolCalls: 1,
        commands: 2,
        failedAttempts: 1,
        retries: 1,
        filesOpened: ["src/value.ts"],
        uniqueSourceFilesOpened: ["src/value.ts"],
      },
      patch: {
        totalFilesModified: 1,
        linesAdded: 1,
        linesDeleted: 1,
      },
      cost: { availability: "unavailable", amount: null },
    });
    expect(result.record.usage.outputTokens.value).toBeNull();
    expect(result.record.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("records timeout and external abort while still running the evaluator", async () => {
    const timeoutResult = await runBenchmark({
      ...(await options(
        "run-timeout",
        new ScriptedAgentAdapter({ steps: [{ type: "wait", milliseconds: 100 }] }),
      )),
      timeoutMs: 5,
    });
    expect(timeoutResult.record.completionStatus).toBe("timeout");
    expect(timeoutResult.record.finalSuccess).toBe(false);
    expect(timeoutResult.record.usage.outputTokens.value).toBeNull();
    expect(timeoutResult.record.evaluation.checks).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const abortedResult = await runBenchmark({
      ...(await options(
        "run-aborted",
        new ScriptedAgentAdapter({ steps: [{ type: "wait", milliseconds: 100 }] }),
      )),
      signal: controller.signal,
    });
    expect(abortedResult.record.completionStatus).toBe("preflight_failed");
    expect(abortedResult.record.agentOutcome).toMatchObject({
      status: "not_run",
      shutdownConfirmed: true,
    });
  });

  it("requires explicit approval before any external provider adapter is invoked", async () => {
    const run = vi.fn<AgentAdapter["run"]>();
    const external: AgentAdapter = {
      id: "external-test",
      kind: "external_provider",
      configuration: {
        provider: "external-test",
        model: "exact-test-model-v1",
        serviceTier: "test",
        reasoning: { effort: "test" },
      },
      run,
    };
    await expect(runBenchmark(await options("run-external", external))).rejects.toThrow(
      /explicit approval gate/u,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
