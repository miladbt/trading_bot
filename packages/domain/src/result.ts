/**
 * Result type for flows where failure is an expected outcome (e.g. parsing an
 * external DTO into a domain model). Constructors/validators throw
 * ValidationError instead — use `tryParse` to convert throwing parsers into
 * Results.
 */

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Convert a throwing parser into a Result-returning function. */
export function tryParse<T>(parse: () => T): Result<T, string> {
  try {
    return ok(parse());
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
