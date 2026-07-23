import { performance } from "node:perf_hooks";

import { canonicalJson } from "./hash.js";
import type {
  AccountedTokens,
  AgentEvent,
  AgentEventInput,
  InteractionSummary,
  RawProviderUsage,
  RawUsageField,
  TestCommandObservation,
} from "./types.js";
import { isSourcePath, normalizeWorkspacePath } from "./workspace.js";

export const reportedUsage = (value: number): RawUsageField => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Reported token counters must be nonnegative integers.");
  }
  return { value, availability: "reported", reason: null };
};

export const unavailableUsage = (reason: string): RawUsageField => {
  if (reason.trim().length === 0) {
    throw new TypeError("Unavailable usage requires an explicit reason.");
  }
  return { value: null, availability: "unavailable", reason };
};

export const createUnavailableProviderUsage = (
  reason: string,
): RawProviderUsage => ({
  uncachedInputTokens: unavailableUsage(reason),
  cachedInputTokens: unavailableUsage(reason),
  outputTokens: unavailableUsage(reason),
  reasoningTokens: unavailableUsage(reason),
  providerTotalTokens: unavailableUsage(reason),
  inputTokenRelation: "unknown",
  reasoningTokenRelation: "unknown",
  providerTotalRelation: "unknown",
  semantics: "No provider token counters were exposed; no values were estimated.",
});

const validateField = (name: string, field: RawUsageField): void => {
  if (field.availability === "reported") {
    if (
      field.reason !== null ||
      field.value === null ||
      !Number.isSafeInteger(field.value) ||
      field.value < 0
    ) {
      throw new TypeError(`${name} is not a valid raw reported counter.`);
    }
    return;
  }
  if (field.value !== null || field.reason === null || field.reason.trim().length === 0) {
    throw new TypeError(`${name} must be null with an unavailability reason.`);
  }
};

export const validateProviderUsage = (usage: RawProviderUsage): void => {
  validateField("uncachedInputTokens", usage.uncachedInputTokens);
  validateField("cachedInputTokens", usage.cachedInputTokens);
  validateField("outputTokens", usage.outputTokens);
  validateField("reasoningTokens", usage.reasoningTokens);
  validateField("providerTotalTokens", usage.providerTotalTokens);
  if (
    usage.inputTokenRelation !== undefined &&
    usage.inputTokenRelation !== "uncached_and_cached_disjoint" &&
    usage.inputTokenRelation !== "input_includes_cached" &&
    usage.inputTokenRelation !== "unknown"
  ) {
    throw new TypeError("Unknown input-token accounting relation.");
  }
  if (
    usage.reasoningTokenRelation !== "included_in_output" &&
    usage.reasoningTokenRelation !== "additional_to_output" &&
    usage.reasoningTokenRelation !== "unknown"
  ) {
    throw new TypeError("Unknown reasoning-token accounting relation.");
  }
  if (
    usage.providerTotalRelation !== "authoritative_non_overlapping_total" &&
    usage.providerTotalRelation !== "unknown"
  ) {
    throw new TypeError("Unknown provider-total accounting relation.");
  }
  if (usage.semantics.trim().length === 0) {
    throw new TypeError("Provider usage semantics must be recorded.");
  }
};

const reportedValue = (field: RawUsageField): number | null =>
  field.availability === "reported" ? field.value : null;

export const deriveAccountedTokens = (
  usage: RawProviderUsage,
): AccountedTokens => {
  validateProviderUsage(usage);
  const uncachedInput = reportedValue(usage.uncachedInputTokens);
  const cachedInput = reportedValue(usage.cachedInputTokens);
  const output = reportedValue(usage.outputTokens);
  const componentsAvailable =
    usage.inputTokenRelation === "uncached_and_cached_disjoint" &&
    uncachedInput !== null && cachedInput !== null && output !== null;

  if (componentsAvailable && usage.reasoningTokenRelation === "included_in_output") {
    return {
      availability: "available",
      value: uncachedInput + cachedInput + output,
      source: "non_overlapping_components",
      formula: "uncached_input + cached_input + output; reasoning included in output",
    };
  }
  const reasoning = reportedValue(usage.reasoningTokens);
  if (
    componentsAvailable &&
    usage.reasoningTokenRelation === "additional_to_output" &&
    reasoning !== null
  ) {
    return {
      availability: "available",
      value: uncachedInput + cachedInput + output + reasoning,
      source: "non_overlapping_components",
      formula: "uncached_input + cached_input + output + additional_reasoning",
    };
  }

  const providerTotal = reportedValue(usage.providerTotalTokens);
  if (
    usage.providerTotalRelation === "authoritative_non_overlapping_total" &&
    providerTotal !== null
  ) {
    return {
      availability: "available",
      value: providerTotal,
      source: "provider_total",
      formula: "authoritative provider-reported non-overlapping total",
    };
  }
  return {
    availability: "unavailable",
    value: null,
    source: null,
    reason:
      "Input, output, or reasoning overlap is incomplete or ambiguous and no authoritative provider total is available.",
  };
};

const requireNonnegative = (name: string, value: number | null): void => {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be null or a nonnegative finite number.`);
  }
};

const validateEvent = (event: AgentEventInput): AgentEventInput => {
  switch (event.type) {
    case "assistant_turn":
      if (event.turnId.trim().length === 0) throw new TypeError("Empty turn ID.");
      return { ...event };
    case "tool_call":
      if (event.callId.trim().length === 0 || event.toolName.trim().length === 0) {
        throw new TypeError("Tool events require call and tool IDs.");
      }
      return { ...event };
    case "command":
      if (
        event.commandId.trim().length === 0 ||
        event.argv.length === 0 ||
        !Number.isFinite(event.durationMs) ||
        event.durationMs < 0
      ) {
        throw new TypeError("Invalid command event.");
      }
      return { ...event, argv: [...event.argv] };
    case "file_observation":
      requireNonnegative("bytesSurfaced", event.bytesSurfaced);
      requireNonnegative("linesSurfaced", event.linesSurfaced);
      return {
        ...event,
        path: event.path === null ? null : normalizeWorkspacePath(event.path),
      };
    case "file_write":
      return { ...event, path: normalizeWorkspacePath(event.path) };
  }
};

export class TelemetryRecorder {
  readonly #events: AgentEvent[] = [];
  readonly #startedAt: number;
  readonly #clock: () => number;

  public constructor(clock: () => number = () => performance.now()) {
    this.#clock = clock;
    this.#startedAt = clock();
  }

  public emit(event: AgentEventInput): void {
    const validated = validateEvent(event);
    this.#events.push({
      ...validated,
      sequence: this.#events.length + 1,
      elapsedMs: Math.max(0, this.#clock() - this.#startedAt),
    });
  }

  public summarize(): InteractionSummary {
    return summarizeAgentEvents(this.#events);
  }
}

export const summarizeAgentEvents = (
  events: readonly AgentEvent[],
): InteractionSummary => {
    const toolCalls = events.filter(
      (event): event is Extract<AgentEvent, { readonly type: "tool_call" }> =>
        event.type === "tool_call",
    );
    const commands = events.filter(
      (event): event is Extract<AgentEvent, { readonly type: "command" }> =>
        event.type === "command",
    );
    const observations = events.filter(
      (
        event,
      ): event is Extract<AgentEvent, { readonly type: "file_observation" }> =>
        event.type === "file_observation",
    );
    const writes = events.filter(
      (event): event is Extract<AgentEvent, { readonly type: "file_write" }> =>
        event.type === "file_write",
    );
    const failedToolIds = new Set(
      toolCalls
        .filter(({ status }) => status === "failed")
        .map(({ callId }) => callId),
    );
    const failedCommandsNotRepresentedByTool = commands.filter(
      (command) =>
        (command.exitCode !== 0 || command.timedOut) &&
        (command.toolCallId === null || !failedToolIds.has(command.toolCallId)),
    ).length;
    const failedWrites = writes.filter(({ status }) => status === "failed").length;
    const opened = observations.flatMap(({ path }) => (path === null ? [] : [path]));
    const filesOpened = [...new Set(opened)].sort();
    const testCommands: TestCommandObservation[] = commands
      .filter(({ classification }) => classification === "test")
      .map(({ commandId, argv, cwd, exitCode, timedOut, durationMs }) => ({
        commandId,
        argv: [...argv],
        cwd,
        exitCode,
        timedOut,
        durationMs,
      }));
    const toolCallsByType: Record<string, number> = {};
    for (const { toolName } of toolCalls) {
      toolCallsByType[toolName] = (toolCallsByType[toolName] ?? 0) + 1;
    }
    const retryToolIds = new Set(
      toolCalls
        .filter(({ retryOfCallId }) => retryOfCallId !== null)
        .map(({ callId }) => callId),
    );
    const commandRetriesWithoutToolRetry = commands.filter(
      ({ retryOfCommandId, toolCallId }) =>
        retryOfCommandId !== null &&
        (toolCallId === null || !retryToolIds.has(toolCallId)),
    ).length;

    return {
      assistantTurns: events.filter(({ type }) => type === "assistant_turn")
        .length,
      toolCalls: toolCalls.length,
      toolCallsByType,
      failedToolCalls: failedToolIds.size,
      commands: commands.length,
      testCommands,
      failedAttempts:
        failedToolIds.size + failedCommandsNotRepresentedByTool + failedWrites,
      retries: retryToolIds.size + commandRetriesWithoutToolRetry,
      filesOpened,
      uniqueSourceFilesOpened: filesOpened.filter(isSourcePath),
      repeatFileObservations: opened.length - filesOpened.length,
      unattributedFileObservations: observations.filter(({ path }) => path === null)
        .length,
      events: events.map((event) => ({ ...event })),
    };
};

export const validateInteractionSummary = (
  summary: InteractionSummary,
): void => {
  let previousElapsed = 0;
  for (const [index, event] of summary.events.entries()) {
    if (
      event.sequence !== index + 1 ||
      !Number.isFinite(event.elapsedMs) ||
      event.elapsedMs < previousElapsed
    ) {
      throw new TypeError("Interaction events must have contiguous sequence and monotonic elapsed time.");
    }
    previousElapsed = event.elapsedMs;
    const { sequence: _sequence, elapsedMs: _elapsedMs, ...input } = event;
    validateEvent(input as AgentEventInput);
  }
  if (canonicalJson(summary) !== canonicalJson(summarizeAgentEvents(summary.events))) {
    throw new TypeError("Interaction summary does not match its raw event stream.");
  }
};
