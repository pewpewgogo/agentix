import type { Distribution, WilsonInterval } from "./types.js";

export const quantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) throw new TypeError("A quantile needs values.");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("Probability must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (index - lowerIndex);
};

export const distribution = (values: readonly number[]): Distribution | null => {
  if (values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("Metric values must be finite and non-negative.");
  }
  const sorted = Object.freeze([...values].sort((left, right) => left - right));
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return Object.freeze({
    count: sorted.length,
    min: sorted[0]!,
    q1,
    median: quantile(sorted, 0.5),
    q3,
    max: sorted[sorted.length - 1]!,
    iqr: q3 - q1,
    values: sorted,
  });
};

export const wilson95 = (successes: number, total: number): WilsonInterval | null => {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) ||
      successes < 0 || total < 0 || successes > total) {
    throw new RangeError("Wilson counts must be valid non-negative integers.");
  }
  if (total === 0) return null;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const halfWidth = z * Math.sqrt(
    (proportion * (1 - proportion) + (z * z) / (4 * total)) / total,
  ) / denominator;
  return Object.freeze({
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    confidence: 0.95,
  });
};
