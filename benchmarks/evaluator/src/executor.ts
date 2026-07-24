import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { relative, resolve, sep } from "node:path";

import type { LoadedTask } from "./load.js";
import { createEvaluationPlan } from "./plan.js";
import type {
  FixtureManifest,
  HiddenEvaluatorManifest,
  Implementation,
} from "./schemas.js";

export const EVALUATION_CHECK_NAMES = [
  "acceptance",
  "hidden-regression",
  "typecheck",
  "architecture",
  "prohibited-shortcuts",
  "task-specific",
] as const;

export type EvaluationCheckName = (typeof EVALUATION_CHECK_NAMES)[number];

export interface RunIdentityLike {
  readonly runId: string;
  readonly task: { readonly id: string; readonly version: number };
  readonly arm: Implementation;
}

export interface LifecycleContextLike {
  readonly identity: RunIdentityLike;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
}

export interface LifecycleCheck {
  readonly name: string;
  readonly status: "passed" | "failed" | "not_applicable";
  readonly durationMs: number;
  readonly details: string | null;
}

export interface EvaluationSummary {
  readonly checks: readonly LifecycleCheck[];
  readonly success: boolean;
  readonly failureCategory: string | null;
  readonly invalidRunReason: string | null;
}

/** Structurally compatible with @agentixdev/benchmark-harness. */
export interface BenchmarkLifecycleHooks {
  preflight(context: LifecycleContextLike): Promise<readonly LifecycleCheck[]>;
  evaluate(context: LifecycleContextLike): Promise<EvaluationSummary>;
}

export interface EvaluatorLifecycleHooks extends BenchmarkLifecycleHooks {
  readonly executionMode: "smoke";
  readonly confirmatoryReady: false;
}

export class ConfirmatoryHiddenEvaluatorUnavailableError extends Error {
  public constructor() {
    super(
      "Confirmatory evaluation is blocked until production black-box and answer driver bundles are implemented and frozen.",
    );
    this.name = "ConfirmatoryHiddenEvaluatorUnavailableError";
  }
}

export interface ProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly networkPolicy: "disabled";
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ConfinedProcessRunner {
  /** This attestation must be backed by the runner's sandbox, not environment variables alone. */
  readonly isolation: {
    readonly network: "disabled";
    readonly filesystem: "workspace-only";
  };
  /** Implementations must execute argv directly with shell interpolation disabled. */
  run(request: ProcessRequest): Promise<ProcessResult>;
}

type HiddenCheck = HiddenEvaluatorManifest["checks"][number];
export type BlackBoxCheck = Extract<HiddenCheck, { readonly kind: "black-box" }>;
export type AnswerRubricCheck = Extract<
  HiddenCheck,
  { readonly kind: "answer-rubric" }
>;

export interface DriverResult {
  readonly passed: boolean;
  readonly details: string | null;
}

export interface HiddenDriverContext<TCheck extends HiddenCheck> {
  readonly check: TCheck;
  readonly implementation: Implementation;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface BlackBoxDriver {
  run(context: HiddenDriverContext<BlackBoxCheck>): Promise<DriverResult>;
}

export interface AnswerDriver {
  run(
    context: HiddenDriverContext<AnswerRubricCheck> & { readonly answer: string },
  ): Promise<DriverResult>;
}

export interface EvaluatorExecutorOptions {
  readonly task: LoadedTask;
  readonly implementation: Implementation;
  readonly mode: "smoke" | "confirmatory";
  readonly allowedRunsRoot: string;
  readonly processRunner: ConfinedProcessRunner;
  readonly commandTimeoutMs: number;
  readonly blackBoxDriver?: BlackBoxDriver;
  readonly answerDriver?: AnswerDriver;
  readonly answerProvider?: (context: LifecycleContextLike) => Promise<string>;
}

interface SnapshotFile {
  readonly sha256: string;
  readonly text: string | null;
}

interface EvaluatorSnapshot {
  readonly files: ReadonlyMap<string, SnapshotFile>;
}

interface CheckAttempt {
  readonly check: EvaluationCheckName;
  readonly id: string;
  readonly status: "passed" | "failed" | "not_applicable";
  readonly durationMs: number;
  readonly details: string | null;
  readonly infrastructureReason?: string;
}

interface BaselineState {
  readonly workspacePath: string;
  readonly snapshot: EvaluatorSnapshot;
}

const elapsedMilliseconds = (startedAt: number): number =>
  Math.max(
    0,
    Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(performance.now() - startedAt)),
  );

const isInside = (root: string, candidate: string, allowRoot: boolean): boolean => {
  const fromRoot = relative(root, candidate);
  return (allowRoot && fromRoot === "") || (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !fromRoot.startsWith(sep)
  );
};

const assertWorkspace = async (
  allowedRunsRoot: string,
  workspacePath: string,
): Promise<string> => {
  const [root, workspace] = await Promise.all([
    realpath(resolve(allowedRunsRoot)),
    realpath(resolve(workspacePath)),
  ]);
  if (!isInside(root, workspace, false)) {
    throw new Error(`Workspace escapes the configured runs root: ${workspacePath}`);
  }
  return workspace;
};

const ignoredSnapshotDirectories = new Set([".git", "node_modules"]);

const snapshotWorkspace = async (workspacePath: string): Promise<EvaluatorSnapshot> => {
  const files = new Map<string, SnapshotFile>();

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ignoredSnapshotDirectories.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const repositoryPath = relative(workspacePath, absolute).replaceAll(sep, "/");
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (!isInside(workspacePath, target, true)) {
          throw new Error(`Workspace symlink escapes confinement: ${repositoryPath}`);
        }
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
      const content = await readFile(absolute);
      const text = /\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml)$/u.test(repositoryPath)
        ? content.toString("utf8")
        : null;
      files.set(repositoryPath, {
        sha256: createHash("sha256").update(content).digest("hex"),
        text,
      });
    }
  };

  await visit(workspacePath);
  return { files };
};

const changedPaths = (
  before: EvaluatorSnapshot,
  after: EvaluatorSnapshot,
): readonly string[] => {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths]
    .filter((path) => before.files.get(path)?.sha256 !== after.files.get(path)?.sha256)
    .sort();
};

const isTestPath = (path: string): boolean =>
  /(?:^|\/)test(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);

const focusedOrSkippedPattern =
  /\b(?:describe|it|test)\s*\.\s*(?:only|skip|todo)\s*\(|\b(?:xdescribe|xit|xtest)\s*\(/u;

const runTimed = async <T>(input: {
  readonly maximumMs: number;
  readonly outerSignal: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<{ readonly value?: T; readonly durationMs: number; readonly timedOut: boolean }> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input.outerSignal.aborted) abort();
  else input.outerSignal.addEventListener("abort", abort, { once: true });
  const start = performance.now();
  let rejectTimeout = (): void => undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = () => reject(new Error("Evaluator step timed out."));
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout();
  }, input.maximumMs);
  try {
    const value = await Promise.race([input.run(controller.signal), timeoutPromise]);
    return { value, durationMs: elapsedMilliseconds(start), timedOut: false };
  } catch (error: unknown) {
    if (controller.signal.aborted && !input.outerSignal.aborted) {
      return { durationMs: elapsedMilliseconds(start), timedOut: true };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.outerSignal.removeEventListener("abort", abort);
  }
};

const commandTuple = (command: readonly string[]): readonly [string, ...string[]] => {
  const [executable, ...arguments_] = command;
  if (executable === undefined || executable.length === 0) {
    throw new TypeError("Evaluator command has no executable.");
  }
  if (command.some((part) => part.includes("\0"))) {
    throw new TypeError("Evaluator command contains a NUL byte.");
  }
  return [executable, ...arguments_];
};

const commandDetails = (result: ProcessResult): string | null => {
  const output = [result.stderr.trim(), result.stdout.trim()]
    .filter((value) => value.length > 0)
    .join("\n")
    .slice(0, 4_000);
  return output.length === 0 ? null : output;
};

const aggregateChecks = (attempts: readonly CheckAttempt[]): readonly LifecycleCheck[] =>
  EVALUATION_CHECK_NAMES.map((name) => {
    const matching = attempts.filter((attempt) => attempt.check === name);
    if (matching.length === 0) {
      return {
        name,
        status: "failed" as const,
        durationMs: 0,
        details: "Required evaluator check was not planned.",
      };
    }
    const status = matching.some((attempt) => attempt.status === "failed")
      ? "failed" as const
      : matching.every((attempt) => attempt.status === "not_applicable")
        ? "not_applicable" as const
        : "passed" as const;
    const details = matching
      .filter((attempt) => attempt.details !== null)
      .map((attempt) => `[${attempt.id}] ${attempt.details}`)
      .join("\n");
    return {
      name,
      status,
      durationMs: matching.reduce((total, attempt) => total + attempt.durationMs, 0),
      details: details.length === 0 ? null : details,
    };
  });

const assertContextIdentity = (
  context: LifecycleContextLike,
  task: LoadedTask,
  implementation: Implementation,
): void => {
  if (
    context.identity.task.id !== task.specification.id ||
    context.identity.task.version !== task.specification.version ||
    context.identity.arm !== implementation
  ) {
    throw new Error("Lifecycle context does not match the loaded task arm.");
  }
};

const shortcutAttempt = (input: {
  readonly task: LoadedTask;
  readonly implementation: Implementation;
  readonly fixture: FixtureManifest;
  readonly baseline: EvaluatorSnapshot;
  readonly candidate: EvaluatorSnapshot;
}): CheckAttempt => {
  const start = performance.now();
  const violations: string[] = [];
  const changes = changedPaths(input.baseline, input.candidate);
  const policy = input.task.hiddenEvaluator.shortcutPolicy;

  for (const prefix of policy.forbiddenModifiedPrefixes) {
    const matching = changes.filter(
      (path) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (matching.length > 0) {
      violations.push(`forbidden paths changed: ${matching.join(", ")}`);
    }
  }
  if (policy.rejectDeletedTests) {
    const deletedTests = [...input.baseline.files.keys()]
      .filter((path) => isTestPath(path) && !input.candidate.files.has(path));
    if (deletedTests.length > 0) {
      violations.push(`tests deleted: ${deletedTests.join(", ")}`);
    }
  }
  if (policy.rejectFocusedOrSkippedTests) {
    const disabledTests = [...input.candidate.files.entries()]
      .filter(([path, file]) =>
        isTestPath(path) &&
        file.text !== null &&
        focusedOrSkippedPattern.test(file.text)
      )
      .map(([path]) => path);
    if (disabledTests.length > 0) {
      violations.push(`focused or skipped tests present: ${disabledTests.join(", ")}`);
    }
  }
  if (policy.rejectCrossArmSources) {
    const counterpart = input.implementation === "framework"
      ? "examples/plain-app/"
      : "examples/framework-app/";
    if ([...input.candidate.files.keys()].some((path) => path.startsWith(counterpart))) {
      violations.push(`counterpart source tree is present: ${counterpart}`);
    }
  }

  const leakedMarkers = [
    input.task.specification.id,
    ...input.task.hiddenEvaluator.checks.map((check) => check.id),
  ];
  const hardCodedFiles = changes.filter((path) => {
    const text = input.candidate.files.get(path)?.text;
    return text !== null && text !== undefined &&
      leakedMarkers.some((marker) => text.includes(marker));
  });
  if (hardCodedFiles.length > 0) {
    violations.push(`task/evaluator identifiers added to changed files: ${hardCodedFiles.join(", ")}`);
  }

  if (
    input.task.specification.category === "read-only-architecture-question" &&
    changes.length > 0
  ) {
    violations.push(`read-only task changed workspace files: ${changes.join(", ")}`);
  }

  return {
    check: "prohibited-shortcuts",
    id: "prohibited-shortcuts",
    status: violations.length === 0 ? "passed" : "failed",
    durationMs: elapsedMilliseconds(start),
    details: violations.length === 0 ? null : violations.join("; "),
  };
};

export const createEvaluatorLifecycleHooks = (
  options: EvaluatorExecutorOptions,
): EvaluatorLifecycleHooks => {
  if (options.mode === "confirmatory") {
    throw new ConfirmatoryHiddenEvaluatorUnavailableError();
  }
  if (!Number.isFinite(options.commandTimeoutMs) || options.commandTimeoutMs <= 0) {
    throw new RangeError("Evaluator command timeout must be positive and finite.");
  }
  if (
    options.processRunner.isolation.network !== "disabled" ||
    options.processRunner.isolation.filesystem !== "workspace-only"
  ) {
    throw new TypeError(
      "Evaluator process runner must attest disabled networking and workspace-only filesystem access.",
    );
  }

  const fixture = options.task.arms[options.implementation].fixture;
  const baselines = new Map<string, BaselineState>();

  const runCommand = async (input: {
    readonly check: EvaluationCheckName;
    readonly id: string;
    readonly command: readonly string[];
    readonly expectedExitCode: number;
    readonly context: LifecycleContextLike;
    readonly workspacePath: string;
    readonly maximumMs: number;
  }): Promise<CheckAttempt> => {
    const execution = await runTimed({
      maximumMs: Math.min(input.maximumMs, options.commandTimeoutMs),
      outerSignal: input.context.signal,
      run: (signal) => options.processRunner.run({
        argv: commandTuple(input.command),
        cwd: input.workspacePath,
        signal,
        timeoutMs: Math.min(input.maximumMs, options.commandTimeoutMs),
        networkPolicy: "disabled",
      }),
    });
    if (execution.timedOut || execution.value?.timedOut === true) {
      return {
        check: input.check,
        id: input.id,
        status: "failed",
        durationMs: execution.durationMs,
        details: "Evaluator command timed out.",
        infrastructureReason: "evaluator_timeout",
      };
    }
    const result = execution.value;
    if (result === undefined) {
      throw new Error("Evaluator command produced no result.");
    }
    return {
      check: input.check,
      id: input.id,
      status: result.exitCode === input.expectedExitCode ? "passed" : "failed",
      durationMs: execution.durationMs,
      details: result.exitCode === input.expectedExitCode
        ? null
        : `Expected exit ${input.expectedExitCode}, received ${String(result.exitCode)}.${
          commandDetails(result) === null ? "" : `\n${commandDetails(result)}`
        }`,
    };
  };

  return {
    executionMode: "smoke",
    confirmatoryReady: false,
    async preflight(context) {
      assertContextIdentity(context, options.task, options.implementation);
      const workspacePath = await assertWorkspace(
        options.allowedRunsRoot,
        context.workspacePath,
      );
      if (baselines.has(context.identity.runId)) {
        throw new Error(`Preflight already ran for ${context.identity.runId}.`);
      }
      const checks: LifecycleCheck[] = [];
      for (const [index, preflight] of fixture.preflight.entries()) {
        const attempt = await runCommand({
          check: "acceptance",
          id: `preflight-${index + 1}`,
          command: preflight.command,
          expectedExitCode: preflight.expectedExitCode,
          context,
          workspacePath,
          maximumMs: options.commandTimeoutMs,
        });
        checks.push({
          name: attempt.id,
          status: attempt.status,
          durationMs: attempt.durationMs,
          details: attempt.details,
        });
      }
      baselines.set(context.identity.runId, {
        workspacePath,
        snapshot: await snapshotWorkspace(workspacePath),
      });
      return checks;
    },

    async evaluate(context) {
      assertContextIdentity(context, options.task, options.implementation);
      const workspacePath = await assertWorkspace(
        options.allowedRunsRoot,
        context.workspacePath,
      );
      const baseline = baselines.get(context.identity.runId);
      if (baseline === undefined || baseline.workspacePath !== workspacePath) {
        throw new Error("Evaluation requires a matching successful preflight baseline.");
      }
      baselines.delete(context.identity.runId);
      const candidate = await snapshotWorkspace(workspacePath);
      const plan = createEvaluationPlan(
        options.task.specification,
        fixture,
        options.task.hiddenEvaluator,
      );
      const deadline = performance.now() + options.task.specification.maximumSeconds * 1_000;
      const remaining = (): number => Math.max(1, deadline - performance.now());
      const attempts: CheckAttempt[] = [];
      let answer: string | undefined;

      for (const step of plan.steps) {
        if (step.check === "prohibited-shortcuts") continue;
        if (step.applicability === "not_applicable") {
          attempts.push({
            check: step.check,
            id: step.id,
            status: "not_applicable",
            durationMs: 0,
            details: null,
          });
          continue;
        }
        if (step.check === "acceptance" && options.task.specification.evaluator.kind === "answer") {
          if (options.answerProvider === undefined) {
            attempts.push({
              check: "acceptance",
              id: step.id,
              status: "failed",
              durationMs: 0,
              details: "Required answer provider is not configured.",
              infrastructureReason: "required_answer_provider_missing",
            });
          } else {
            const execution = await runTimed({
              maximumMs: Math.min(remaining(), options.commandTimeoutMs),
              outerSignal: context.signal,
              run: () => options.answerProvider?.(context) ??
                Promise.reject(new Error("Answer provider disappeared.")),
            });
            answer = execution.value;
            attempts.push({
              check: "acceptance",
              id: step.id,
              status: answer !== undefined && answer.trim().length > 0
                ? "passed"
                : "failed",
              durationMs: execution.durationMs,
              details: execution.timedOut
                ? "Answer provider timed out."
                : answer !== undefined && answer.trim().length > 0
                  ? null
                  : "Agent answer is empty.",
              ...(execution.timedOut
                ? { infrastructureReason: "evaluator_timeout" }
                : {}),
            });
          }
          continue;
        }
        if (step.command !== undefined) {
          const expectedExitCode = step.definition?.kind === "regression-command"
            ? step.definition.expectedExitCode
            : 0;
          attempts.push(await runCommand({
            check: step.check,
            id: step.id,
            command: step.command,
            expectedExitCode,
            context,
            workspacePath,
            maximumMs: remaining(),
          }));
          continue;
        }
        if (step.definition?.kind === "black-box") {
          if (options.blackBoxDriver === undefined) {
            attempts.push({
              check: "task-specific",
              id: step.id,
              status: "failed",
              durationMs: 0,
              details: "Required black-box driver is not configured.",
              infrastructureReason: "required_black_box_driver_missing",
            });
            continue;
          }
          const execution = await runTimed({
            maximumMs: Math.min(remaining(), options.commandTimeoutMs),
            outerSignal: context.signal,
            run: (signal) => options.blackBoxDriver?.run({
              check: step.definition as BlackBoxCheck,
              implementation: options.implementation,
              workspacePath,
              signal,
              timeoutMs: Math.min(remaining(), options.commandTimeoutMs),
            }) ?? Promise.reject(new Error("Black-box driver disappeared.")),
          });
          attempts.push({
            check: "task-specific",
            id: step.id,
            status: execution.value?.passed === true ? "passed" : "failed",
            durationMs: execution.durationMs,
            details: execution.timedOut
              ? "Black-box driver timed out."
              : execution.value?.details ?? null,
            ...(execution.timedOut ? { infrastructureReason: "evaluator_timeout" } : {}),
          });
          continue;
        }
        if (step.definition?.kind === "answer-rubric") {
          if (options.answerDriver === undefined || answer === undefined) {
            attempts.push({
              check: "task-specific",
              id: step.id,
              status: "failed",
              durationMs: 0,
              details: "Required answer evaluator is not configured.",
              infrastructureReason: "required_answer_driver_missing",
            });
            continue;
          }
          const execution = await runTimed({
            maximumMs: Math.min(remaining(), options.commandTimeoutMs),
            outerSignal: context.signal,
            run: (signal) => options.answerDriver?.run({
              check: step.definition as AnswerRubricCheck,
              answer: answer ?? "",
              implementation: options.implementation,
              workspacePath,
              signal,
              timeoutMs: Math.min(remaining(), options.commandTimeoutMs),
            }) ?? Promise.reject(new Error("Answer driver disappeared.")),
          });
          attempts.push({
            check: "task-specific",
            id: step.id,
            status: execution.value?.passed === true ? "passed" : "failed",
            durationMs: execution.durationMs,
            details: execution.timedOut
              ? "Answer evaluator timed out."
              : execution.value?.details ?? null,
            ...(execution.timedOut ? { infrastructureReason: "evaluator_timeout" } : {}),
          });
          continue;
        }
        attempts.push({
          check: step.check,
          id: step.id,
          status: "failed",
          durationMs: 0,
          details: "Required evaluator step has no executable command or driver.",
          infrastructureReason: "required_evaluator_missing",
        });
      }

      attempts.push(shortcutAttempt({
        task: options.task,
        implementation: options.implementation,
        fixture,
        baseline: baseline.snapshot,
        candidate,
      }));
      const checks = aggregateChecks(attempts);
      const infrastructureReasons = attempts
        .flatMap((attempt) =>
          attempt.infrastructureReason === undefined
            ? []
            : [attempt.infrastructureReason]
        );
      const checksPassed = checks.every((check) =>
        check.status === "passed" || check.status === "not_applicable"
      );
      const invalidRunReason = infrastructureReasons[0] ??
        "production_hidden_evaluator_unavailable";
      const success = checksPassed && invalidRunReason === null;
      return {
        checks,
        success,
        failureCategory: checksPassed ? null : "evaluation_failure",
        invalidRunReason,
      };
    },
  };
};
