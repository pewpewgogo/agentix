export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Failure<E> {
  readonly ok: false;
  readonly error: E;
}

/** Expected application failures are values; unexpected defects may still throw. */
export type Result<T, E> = Success<T> | Failure<E>;

export const success = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

export const failure = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
});
