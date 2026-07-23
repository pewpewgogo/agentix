import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createUnavailableProviderUsage,
  validateProviderUsage,
} from "./telemetry.js";
import type {
  AgentAdapter,
  AgentAdapterResult,
  AgentArtifactInput,
  AgentEventInput,
  AgentRunContext,
  RawProviderUsage,
} from "./types.js";
import { resolveWorkspaceFile } from "./workspace.js";

export type ScriptedStep =
  | { readonly type: "event"; readonly event: AgentEventInput }
  | {
      readonly type: "write_file";
      readonly path: string;
      readonly content: string | Uint8Array;
    }
  | { readonly type: "wait"; readonly milliseconds: number };

export interface ScriptedAgentOptions {
  readonly id?: string;
  readonly steps?: readonly ScriptedStep[];
  readonly completionReason?: string;
  readonly usage?: RawProviderUsage;
  readonly artifacts?: readonly AgentArtifactInput[];
}

const abortError = (): Error => {
  const error = new Error("The scripted adapter run was aborted.");
  error.name = "AbortError";
  return error;
};

const wait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError("Scripted wait time must be nonnegative and finite.");
  }
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export class ScriptedAgentAdapter implements AgentAdapter {
  public readonly kind = "scripted" as const;
  public readonly configuration = {
    provider: "scripted",
    model: "scripted-v1",
    serviceTier: "local",
    reasoning: { mode: "deterministic-script" },
  } as const;
  public readonly id: string;
  readonly #steps: readonly ScriptedStep[];
  readonly #completionReason: string;
  readonly #usage: RawProviderUsage;
  readonly #artifacts: readonly AgentArtifactInput[];

  public constructor(options: ScriptedAgentOptions = {}) {
    this.id = options.id ?? "scripted-smoke-v1";
    this.#steps = options.steps ?? [];
    this.#completionReason = options.completionReason ?? "scripted_completion";
    this.#usage =
      options.usage ??
      createUnavailableProviderUsage(
        "The scripted smoke adapter does not expose provider token telemetry.",
      );
    validateProviderUsage(this.#usage);
    this.#artifacts = options.artifacts ?? [];
  }

  public async run(context: AgentRunContext): Promise<AgentAdapterResult> {
    for (const step of this.#steps) {
      if (context.signal.aborted) throw abortError();
      switch (step.type) {
        case "event":
          context.emit(step.event);
          break;
        case "write_file": {
          let path: string;
          try {
            path = resolveWorkspaceFile(context.workspacePath, step.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, step.content);
            context.emit({ type: "file_write", path: step.path, status: "succeeded" });
          } catch (error: unknown) {
            context.emit({ type: "file_write", path: step.path, status: "failed" });
            throw error;
          }
          break;
        }
        case "wait":
          await wait(step.milliseconds, context.signal);
          break;
      }
    }
    return {
      provider: this.configuration.provider,
      model: this.configuration.model,
      serviceTier: this.configuration.serviceTier,
      responseIds: [],
      completionReason: this.#completionReason,
      usage: this.#usage,
      artifacts: this.#artifacts.map((artifact) => ({ ...artifact })),
    };
  }
}
