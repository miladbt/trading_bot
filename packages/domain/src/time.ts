/**
 * Time representation. The bot trades 5-minute markets; every timestamp is UTC.
 * - `Millis`: epoch milliseconds (number brand).
 * - `UtcIso`: ISO-8601 string with mandatory `Z` suffix.
 *
 * All functions are pure and never use the local timezone.
 */

import type { Millis, UtcIso } from "./brand.js";
import { ValidationError } from "./errors.js";

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function millis(ms: number): Millis {
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw new ValidationError(`millis must be an integer, got ${ms}`);
  }
  return ms as Millis;
}

export function utcIso(value: string): UtcIso {
  if (!ISO_UTC_RE.test(value)) {
    throw new ValidationError(`not a UTC ISO-8601 timestamp: "${value}"`);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new ValidationError(`invalid date: "${value}"`);
  }
  return value as UtcIso;
}

/** Current time. The only non-pure function in the domain (explicitly marked). */
export function nowMillis(): Millis {
  return Date.now() as Millis;
}

export function millisToUtcIso(ms: Millis): UtcIso {
  return new Date(ms).toISOString() as UtcIso;
}

export function utcIsoToMillis(iso: UtcIso): Millis {
  return Date.parse(iso) as Millis;
}

/** Whole minutes between two instants (b - a); truncates toward zero. */
export function minutesBetween(a: Millis, b: Millis): number {
  return Math.trunc((b - a) / 60_000);
}

/** Whole seconds between two instants (b - a); truncates toward zero. */
export function secondsBetween(a: Millis, b: Millis): number {
  return Math.trunc((b - a) / 1000);
}

export function isBefore(a: Millis, b: Millis): boolean {
  return a < b;
}

export function isAfter(a: Millis, b: Millis): boolean {
  return a > b;
}
