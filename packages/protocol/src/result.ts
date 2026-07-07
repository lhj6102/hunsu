export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Option<T> =
  | { type: "some"; value: T }
  | { type: "none" };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function some<T>(value: T): Option<T> {
  return { type: "some", value };
}

export function none<T = never>(): Option<T> {
  return { type: "none" };
}

export function map<T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

export function flatMap<T, U, E>(result: Result<T, E>, transform: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? transform(result.value) : result;
}

export function fromNullable<T, E>(value: T | null | undefined, error: E): Result<T, E> {
  return value === null || value === undefined ? err(error) : ok(value);
}
