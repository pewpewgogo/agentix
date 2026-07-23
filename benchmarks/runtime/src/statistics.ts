export interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly p95: number;
  readonly max: number;
  readonly iqr: number;
  readonly samples: readonly number[];
}

/** R-7 quantile, matching the common linear-interpolation definition. */
export const quantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) throw new TypeError("A quantile needs at least one value.");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("Quantile probability must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new RangeError("Quantile index was outside the sample.");
  }
  return lower + (upper - lower) * (index - lowerIndex);
};

export const summarize = (values: readonly number[]): Distribution => {
  if (values.length === 0) throw new TypeError("A distribution needs samples.");
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Distribution samples must be finite.");
  }
  const samples = Object.freeze([...values].sort((left, right) => left - right));
  const q1 = quantile(samples, 0.25);
  const q3 = quantile(samples, 0.75);
  return Object.freeze({
    count: samples.length,
    min: samples[0]!,
    q1,
    median: quantile(samples, 0.5),
    q3,
    p95: quantile(samples, 0.95),
    max: samples[samples.length - 1]!,
    iqr: q3 - q1,
    samples,
  });
};
