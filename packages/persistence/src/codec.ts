/**
 * Persistence codecs: the exactness contract for everything on disk.
 *
 * - **Money/shares**: domain `Decimal` (BigInt, scale 1e8) serialized via
 *   `decToScaled` as an integer string — the canonical, round-trip-exact form.
 *   JavaScript `number` NEVER appears in a financial field, in either
 *   direction (persistence or recovery). Fixed-point strings are also
 *   accepted on input for schema-version tolerance.
 * - **Time**: `Millis` (UTC epoch ms) as an integer string; ISO-8601 UTC
 *   strings are accepted on input. No local-time strings anywhere.
 * - **Schema**: every file carries `schemaVersion`; readers validate the major
 *   version and refuse unknown ones (see MIGRATIONS.md).
 */

import { decFromScaled, decFromString, decToScaled, type Decimal, type Millis } from "@bot/domain";

/** The single schema version this build writes and accepts. */
export const SCHEMA_VERSION = 1 as const;

export interface Envelope {
  readonly schemaVersion: number;
}

/** Serialize a Decimal exactly: scaled BigInt rendered as an integer string. */
export function encodeDecimal(value: Decimal): string {
  return decToScaled(value).toString();
}

/**
 * Parse a persisted Decimal exactly. Accepts the canonical scaled-integer
 * string (as written by `encodeDecimal`) or an 8-dp fixed-point string;
 * rejects anything that is not exact (floats cannot sneak in as strings are
 * parsed by the domain, never by `parseFloat`/`Number`).
 */
export function decodeDecimal(raw: string): Decimal {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return decFromScaled(BigInt(trimmed));
  }
  // Fixed-point string ("0.45000000") — exact domain parse, no float.
  return decFromString(trimmed);
}

/** Serialize UTC epoch ms as an integer string. */
export function encodeMillis(value: Millis): string {
  return String(value);
}

/**
 * Parse persisted epoch ms (integer string) or ISO-8601 UTC string. Epoch ms
 * fits exactly in a double, so the number brand is safe here.
 */
export function decodeMillis(raw: string): Millis {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`persistence: timestamp out of safe range "${raw}"`);
    }
    return value as Millis;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`persistence: invalid timestamp "${raw}"`);
  }
  return parsed as Millis;
}

/** Validate an envelope's schema version (major-version fail closed). */
export function assertSchemaVersion(envelope: unknown): void {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("schemaVersion" in envelope) ||
    typeof (envelope as Envelope).schemaVersion !== "number"
  ) {
    throw new Error("persistence: missing schemaVersion");
  }
  const version = (envelope as Envelope).schemaVersion;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `persistence: unsupported schemaVersion ${String(version)} (this build writes ${SCHEMA_VERSION})`,
    );
  }
}

/** Deterministic JSON: stable key order for top-level objects. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        out[k] = record[k];
      }
      return out;
    }
    return val;
  });
}
