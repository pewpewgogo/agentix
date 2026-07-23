import type {
  DerivedCost,
  PricingSnapshot,
  RawProviderUsage,
} from "./types.js";
import { validateProviderUsage } from "./telemetry.js";

const unavailable = (
  reason: string,
  snapshot: PricingSnapshot | null,
): DerivedCost => ({
  availability: "unavailable",
  amount: null,
  currency: snapshot?.currency ?? null,
  pricingSnapshotId: snapshot?.id ?? null,
  reason,
});

export const deriveProviderCost = (input: {
  readonly usage: RawProviderUsage;
  readonly pricing: PricingSnapshot | null;
  readonly provider: string;
  readonly model: string;
  readonly serviceTier: string;
}): DerivedCost => {
  validateProviderUsage(input.usage);
  const pricing = input.pricing;
  if (pricing === null) return unavailable("No pricing snapshot was supplied.", null);
  if (
    pricing.provider !== input.provider ||
    pricing.model !== input.model ||
    pricing.serviceTier !== input.serviceTier
  ) {
    return unavailable("The pricing snapshot does not match the exact agent configuration.", pricing);
  }
  if (!Number.isSafeInteger(pricing.unitTokens) || pricing.unitTokens < 1) {
    throw new TypeError("Pricing unitTokens must be a positive integer.");
  }
  if (input.usage.inputTokenRelation !== "uncached_and_cached_disjoint") {
    return unavailable(
      "The provider did not establish that uncached and cached input counters are disjoint.",
      pricing,
    );
  }

  const requiredUsage = [
    ["uncached input", input.usage.uncachedInputTokens, pricing.perUnit.uncachedInput],
    ["cached input", input.usage.cachedInputTokens, pricing.perUnit.cachedInput],
    ["output", input.usage.outputTokens, pricing.perUnit.output],
  ] as const;
  for (const [name, usage, price] of requiredUsage) {
    if (usage.availability !== "reported") {
      return unavailable(`Raw ${name} token telemetry is unavailable.`, pricing);
    }
    if (price === null) {
      return unavailable(`The ${name} token price is unavailable.`, pricing);
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new TypeError(`The ${name} token price is invalid.`);
    }
  }
  if (input.usage.reasoningTokenRelation === "unknown") {
    return unavailable("The provider did not disclose whether reasoning tokens overlap output tokens.", pricing);
  }

  const uncached = input.usage.uncachedInputTokens.value;
  const cached = input.usage.cachedInputTokens.value;
  const output = input.usage.outputTokens.value;
  if (uncached === null || cached === null || output === null) {
    throw new Error("Validated required usage unexpectedly became null.");
  }
  let numerator =
    uncached * (pricing.perUnit.uncachedInput ?? 0) +
    cached * (pricing.perUnit.cachedInput ?? 0) +
    output * (pricing.perUnit.output ?? 0);
  let formula = "uncached_input + cached_input + output";

  if (input.usage.reasoningTokenRelation === "additional_to_output") {
    if (input.usage.reasoningTokens.availability !== "reported") {
      return unavailable("Additional reasoning-token telemetry is unavailable.", pricing);
    }
    if (pricing.perUnit.reasoning === null) {
      return unavailable("The additional reasoning-token price is unavailable.", pricing);
    }
    if (!Number.isFinite(pricing.perUnit.reasoning) || pricing.perUnit.reasoning < 0) {
      throw new TypeError("The reasoning token price is invalid.");
    }
    const reasoning = input.usage.reasoningTokens.value;
    if (reasoning === null) {
      throw new Error("Reported reasoning usage unexpectedly became null.");
    }
    numerator += reasoning * pricing.perUnit.reasoning;
    formula += " + additional_reasoning";
  }

  return {
    availability: "available",
    amount: numerator / pricing.unitTokens,
    currency: pricing.currency,
    pricingSnapshotId: pricing.id,
    formula: `${formula}; prices per ${pricing.unitTokens} tokens`,
  };
};
