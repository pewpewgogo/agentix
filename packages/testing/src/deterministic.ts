export interface DeterministicClockOptions<T> {
  readonly start?: string | number | Date;
  readonly stepMs?: number;
  readonly project: (instant: Date) => T;
}

export interface DeterministicClock<T> {
  /** Returns the current value and advances by the configured step. */
  readonly now: () => T;
  /** Returns the current value without advancing the clock. */
  readonly peek: () => T;
  readonly advanceBy: (milliseconds: number) => void;
  readonly set: (instant: string | number | Date) => void;
  readonly reset: () => void;
  readonly calls: () => number;
}

const DEFAULT_INSTANT = "2000-01-01T00:00:00.000Z";

const millisecondsFor = (instant: string | number | Date): number => {
  const milliseconds =
    instant instanceof Date ? instant.getTime() : new Date(instant).getTime();

  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("A deterministic clock instant must be a valid date.");
  }

  return milliseconds;
};

export function createDeterministicClock(
  options?: Omit<DeterministicClockOptions<string>, "project">,
): DeterministicClock<string>;
export function createDeterministicClock<T>(
  options: DeterministicClockOptions<T>,
): DeterministicClock<T>;
export function createDeterministicClock<T>(
  options:
    | DeterministicClockOptions<T>
    | Omit<DeterministicClockOptions<string>, "project"> = {},
): DeterministicClock<T | string> {
  const initial = millisecondsFor(options.start ?? DEFAULT_INSTANT);
  const stepMs = options.stepMs ?? 0;

  if (!Number.isFinite(stepMs)) {
    throw new TypeError("A deterministic clock step must be finite.");
  }

  const project =
    "project" in options
      ? options.project
      : (instant: Date): string => instant.toISOString();

  let current = initial;
  let callCount = 0;

  const valueAtCurrentInstant = (): T | string => project(new Date(current));

  return {
    now() {
      const value = valueAtCurrentInstant();
      current += stepMs;
      callCount += 1;
      return value;
    },
    peek: valueAtCurrentInstant,
    advanceBy(milliseconds) {
      if (!Number.isFinite(milliseconds)) {
        throw new TypeError("A deterministic clock advance must be finite.");
      }
      current += milliseconds;
    },
    set(instant) {
      current = millisecondsFor(instant);
    },
    reset() {
      current = initial;
      callCount = 0;
    },
    calls: () => callCount,
  };
}

export interface DeterministicIdGeneratorOptions {
  readonly prefix?: string;
  readonly start?: number;
  readonly padding?: number;
  /** Optional exact values. Once exhausted, generated values continue. */
  readonly values?: readonly string[];
}

export interface DeterministicIdGenerator {
  readonly next: () => string;
  readonly peek: () => string;
  readonly reset: () => void;
  readonly calls: () => number;
}

export const createDeterministicIdGenerator = (
  options: DeterministicIdGeneratorOptions = {},
): DeterministicIdGenerator => {
  const prefix = options.prefix ?? "id-";
  const initial = options.start ?? 1;
  const padding = options.padding ?? 0;
  const exactValues = [...(options.values ?? [])];

  if (!Number.isSafeInteger(initial)) {
    throw new TypeError("A deterministic ID start must be a safe integer.");
  }
  if (!Number.isSafeInteger(padding) || padding < 0) {
    throw new TypeError(
      "A deterministic ID padding value must be a non-negative safe integer.",
    );
  }

  let generated = initial;
  let callCount = 0;

  const valueFor = (index: number, counter: number): string =>
    exactValues[index] ?? `${prefix}${String(counter).padStart(padding, "0")}`;

  return {
    next() {
      const value = valueFor(callCount, generated);
      callCount += 1;
      if (callCount > exactValues.length) {
        generated += 1;
      }
      return value;
    },
    peek: () => valueFor(callCount, generated),
    reset() {
      generated = initial;
      callCount = 0;
    },
    calls: () => callCount,
  };
};
