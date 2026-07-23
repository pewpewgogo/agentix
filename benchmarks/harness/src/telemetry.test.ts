import { describe, expect, it } from "vitest";

import { deriveProviderCost } from "./pricing.js";
import {
  createUnavailableProviderUsage,
  deriveAccountedTokens,
  reportedUsage,
  TelemetryRecorder,
  unavailableUsage,
  validateProviderUsage,
} from "./telemetry.js";
import type { PricingSnapshot, RawProviderUsage } from "./types.js";

const pricing: PricingSnapshot = {
  schemaVersion: 1,
  id: "pricing-v1",
  provider: "provider",
  model: "model-exact",
  serviceTier: "standard",
  currency: "USD",
  effectiveAt: "2040-01-01T00:00:00.000Z",
  unitTokens: 1_000_000,
  perUnit: {
    uncachedInput: 10,
    cachedInput: 2,
    output: 30,
    reasoning: null,
  },
};

describe("raw telemetry", () => {
  it("counts a known scripted event stream without guessing intent", () => {
    let time = 100;
    const recorder = new TelemetryRecorder(() => time++);
    recorder.emit({ type: "assistant_turn", turnId: "turn-1" });
    recorder.emit({
      type: "file_observation",
      path: "src/a.ts",
      source: "direct_read",
      bytesSurfaced: 10,
      linesSurfaced: 1,
    });
    recorder.emit({
      type: "file_observation",
      path: "src/a.ts",
      source: "search_result",
      bytesSurfaced: 5,
      linesSurfaced: 1,
    });
    recorder.emit({
      type: "file_observation",
      path: "README.md",
      source: "direct_read",
      bytesSurfaced: 20,
      linesSurfaced: 2,
    });
    recorder.emit({
      type: "file_observation",
      path: null,
      source: "compiler_diagnostic",
      bytesSurfaced: null,
      linesSurfaced: null,
    });
    recorder.emit({
      type: "tool_call",
      callId: "call-1",
      toolName: "exec",
      status: "failed",
      retryOfCallId: null,
    });
    recorder.emit({
      type: "command",
      commandId: "command-1",
      toolCallId: "call-1",
      argv: ["npm", "test"],
      cwd: ".",
      classification: "test",
      exitCode: 1,
      timedOut: false,
      durationMs: 20,
      retryOfCommandId: null,
    });
    recorder.emit({
      type: "tool_call",
      callId: "call-2",
      toolName: "exec",
      status: "succeeded",
      retryOfCallId: "call-1",
    });
    recorder.emit({
      type: "command",
      commandId: "command-2",
      toolCallId: "call-2",
      argv: ["npm", "test"],
      cwd: ".",
      classification: "test",
      exitCode: 0,
      timedOut: false,
      durationMs: 18,
      retryOfCommandId: "command-1",
    });
    recorder.emit({ type: "file_write", path: "src/a.ts", status: "succeeded" });

    expect(recorder.summarize()).toMatchObject({
      assistantTurns: 1,
      toolCalls: 2,
      toolCallsByType: { exec: 2 },
      failedToolCalls: 1,
      commands: 2,
      failedAttempts: 1,
      retries: 1,
      filesOpened: ["README.md", "src/a.ts"],
      uniqueSourceFilesOpened: ["src/a.ts"],
      repeatFileObservations: 1,
      unattributedFileObservations: 1,
    });
    expect(recorder.summarize().testCommands).toHaveLength(2);
  });

  it("uses null with reasons for unavailable counters and never estimates", () => {
    const usage = createUnavailableProviderUsage("scripted smoke has no provider");
    validateProviderUsage(usage);
    expect(usage.uncachedInputTokens).toEqual({
      value: null,
      availability: "unavailable",
      reason: "scripted smoke has no provider",
    });
    expect(
      deriveProviderCost({
        usage,
        pricing,
        provider: "provider",
        model: "model-exact",
        serviceTier: "standard",
      }),
    ).toMatchObject({ availability: "unavailable", amount: null });
    expect(() =>
      validateProviderUsage({
        ...usage,
        outputTokens: { value: 0, availability: "unavailable", reason: "hidden" },
      }),
    ).toThrow(/must be null/u);
  });

  it("derives cost only from complete matching raw counters and pricing", () => {
    const usage: RawProviderUsage = {
      uncachedInputTokens: reportedUsage(1_000),
      cachedInputTokens: reportedUsage(500),
      outputTokens: reportedUsage(200),
      reasoningTokens: unavailableUsage("included in output and not split out"),
      providerTotalTokens: reportedUsage(1_700),
      inputTokenRelation: "uncached_and_cached_disjoint",
      reasoningTokenRelation: "included_in_output",
      providerTotalRelation: "unknown",
      semantics: "Provider output includes reasoning tokens.",
    };
    expect(
      deriveProviderCost({
        usage,
        pricing,
        provider: "provider",
        model: "model-exact",
        serviceTier: "standard",
      }),
    ).toEqual({
      availability: "available",
      amount: 0.017,
      currency: "USD",
      pricingSnapshotId: "pricing-v1",
      formula:
        "uncached_input + cached_input + output; prices per 1000000 tokens",
    });
    expect(
      deriveProviderCost({
        usage,
        pricing,
        provider: "provider",
        model: "different-model",
        serviceTier: "standard",
      }),
    ).toMatchObject({ availability: "unavailable", amount: null });
  });

  it("accounts only non-overlapping components or an explicitly authoritative total", () => {
    const base: RawProviderUsage = {
      uncachedInputTokens: reportedUsage(1_000),
      cachedInputTokens: reportedUsage(500),
      outputTokens: reportedUsage(200),
      reasoningTokens: reportedUsage(100),
      providerTotalTokens: reportedUsage(1_725),
      inputTokenRelation: "uncached_and_cached_disjoint",
      reasoningTokenRelation: "included_in_output",
      providerTotalRelation: "unknown",
      semantics: "Synthetic counters with declared overlap semantics.",
    };

    expect(deriveAccountedTokens(base)).toEqual({
      availability: "available",
      value: 1_700,
      source: "non_overlapping_components",
      formula:
        "uncached_input + cached_input + output; reasoning included in output",
    });
    expect(
      deriveAccountedTokens({
        ...base,
        reasoningTokenRelation: "additional_to_output",
      }),
    ).toMatchObject({
      availability: "available",
      value: 1_800,
      source: "non_overlapping_components",
    });
    expect(
      deriveAccountedTokens({
        ...base,
        inputTokenRelation: "input_includes_cached",
      }),
    ).toMatchObject({ availability: "unavailable", value: null });
    const { inputTokenRelation: _inputTokenRelation, ...legacyAmbiguous } = base;
    expect(deriveAccountedTokens(legacyAmbiguous)).toMatchObject({
      availability: "unavailable",
      value: null,
    });
    expect(
      deriveAccountedTokens({
        ...base,
        inputTokenRelation: "input_includes_cached",
        providerTotalRelation: "authoritative_non_overlapping_total",
      }),
    ).toMatchObject({
      availability: "available",
      value: 1_725,
      source: "provider_total",
    });
    expect(
      deriveAccountedTokens({
        ...base,
        reasoningTokenRelation: "unknown",
        providerTotalRelation: "authoritative_non_overlapping_total",
      }),
    ).toMatchObject({
      availability: "available",
      value: 1_725,
      source: "provider_total",
    });
    expect(
      deriveAccountedTokens({
        ...base,
        reasoningTokenRelation: "unknown",
      }),
    ).toMatchObject({ availability: "unavailable", value: null, source: null });
    expect(
      deriveAccountedTokens({
        ...base,
        outputTokens: unavailableUsage("provider omitted the output split"),
        providerTotalRelation: "authoritative_non_overlapping_total",
      }),
    ).toMatchObject({
      availability: "available",
      value: 1_725,
      source: "provider_total",
    });
    expect(
      deriveAccountedTokens({
        ...base,
        outputTokens: unavailableUsage("provider omitted the output split"),
        providerTotalRelation: "unknown",
      }),
    ).toMatchObject({ availability: "unavailable", value: null });
  });
});
