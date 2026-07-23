/** A successful result from domain or effect execution. */
export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

/** An expected, typed failure from domain or effect execution. */
export interface Failure<E> {
  readonly ok: false;
  readonly error: E;
}

/** Expected failures are values. Unexpected exceptions stay on a separate path. */
export type Outcome<T, E> = Success<T> | Failure<E>;

export const ok = <T>(value: T): Outcome<T, never> =>
  Object.freeze({ ok: true, value });

export const err = <E>(error: E): Outcome<never, E> =>
  Object.freeze({ ok: false, error });

export const isOutcome = (value: unknown): value is Outcome<unknown, unknown> => {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate["ok"] === true
    ? "value" in candidate
    : candidate["ok"] === false && "error" in candidate;
};

export const matchOutcome = <T, E, A, B>(
  outcome: Outcome<T, E>,
  branches: {
    readonly ok: (value: T) => A;
    readonly err: (error: E) => B;
  },
): A | B =>
  outcome.ok ? branches.ok(outcome.value) : branches.err(outcome.error);
