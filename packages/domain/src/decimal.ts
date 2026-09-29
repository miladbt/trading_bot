/**
 * Decimal-safe financial arithmetic.
 *
 * JavaScript `number` cannot represent values like 0.1 exactly; summing floats
 * accumulates error that is unacceptable for money. All financial values in the
 * domain use `Decimal`: a bigint storing the amount scaled by 10^8 (8 decimal
 * places — enough for USDC amounts and prices with generous headroom).
 *
 * Every function here is pure. `Decimal` is a branded bigint, so it can never
 * be confused with a raw float or a plain integer.
 */

import type { Brand } from "./brand.js";

/** Amount scaled by 10^8. Use the `dec` helpers; never construct directly. */
export type Decimal = Brand<bigint, "Decimal">;

export const SCALE = 8n;
export const SCALE_FACTOR = 10n ** SCALE; // 100_000_000

/** Maximum decimal places accepted when parsing a string. */
export const MAX_PARSE_DECIMALS = 12;

export class DecimalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalParseError";
  }
}

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === "bigint";
}

/**
 * Build a Decimal from an integer scaled amount. The intended escape hatch for
 * constructing Decimals from already-scaled bigints.
 */
export function decFromScaled(scaled: bigint): Decimal {
  return scaled as Decimal;
}

/** The zero Decimal. */
export function decZero(): Decimal {
  return 0n as Decimal;
}

/** The one Decimal (1.00000000). */
export function decOne(): Decimal {
  return SCALE_FACTOR as Decimal;
}

/** Parse a decimal string like "-12.5", "0.007", "1e-4". Throws DecimalParseError. */
export function decFromString(input: string): Decimal {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new DecimalParseError("empty decimal string");
  }
  let exp = 0n;
  let body = trimmed.toLowerCase();
  const eIdx = body.indexOf("e");
  if (eIdx >= 0) {
    const mantissa = body.slice(0, eIdx);
    const expPart = body.slice(eIdx + 1);
    if (expPart.startsWith("+") || expPart.startsWith("-") || expPart.length === 0) {
      // allow explicit sign, but BigInt() rejects "+"
      exp = expPart === "" ? 0n : BigInt(expPart.startsWith("+") ? expPart.slice(1) : expPart);
    } else {
      exp = BigInt(expPart);
    }
    body = mantissa;
  }
  let negative = false;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }
  const dot = body.indexOf(".");
  let whole = body;
  let frac = "";
  if (dot >= 0) {
    whole = body.slice(0, dot);
    frac = body.slice(dot + 1);
  }
  if (whole.length === 0 && frac.length === 0) {
    throw new DecimalParseError(`not a decimal: "${input}"`);
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
    throw new DecimalParseError(`not a decimal: "${input}"`);
  }
  if (frac.length > MAX_PARSE_DECIMALS) {
    throw new DecimalParseError(`too many decimal places (max ${MAX_PARSE_DECIMALS}): "${input}"`);
  }
  const digits = BigInt((whole === "" ? "0" : whole) + frac);
  // Scale to 8dp: shift left when the fraction is shorter, round half-up on
  // dropped digits when it is longer than the target scale.
  let scaled: bigint;
  if (frac.length <= Number(SCALE)) {
    scaled = digits * 10n ** (SCALE - BigInt(frac.length));
  } else {
    const drop = 10n ** BigInt(frac.length - Number(SCALE));
    const q = digits / drop;
    const r = digits % drop;
    scaled = r * 2n >= drop ? q + 1n : q;
  }
  // Apply the explicit exponent; negative exponents divide with half-up rounding.
  if (exp >= 0n) {
    scaled = scaled * 10n ** exp;
  } else {
    const divisor = 10n ** -exp;
    const q = scaled / divisor;
    const r = scaled % divisor;
    scaled = r * 2n >= divisor ? q + 1n : q;
  }
  if (negative) {
    scaled = -scaled;
  }
  return scaled as Decimal;
}

/** Build a Decimal from a small-integer count of units (e.g. shares as whole tokens). */
export function decFromInt(units: number | bigint): Decimal {
  return (BigInt(units) * SCALE_FACTOR) as Decimal;
}

/**
 * Build a Decimal from a JS number. Floats are inherently imprecise, so this is
 * provided only for boundaries where a float is unavoidable (tests, UI). It
 * rounds-half-even at 8 dp and throws on non-finite input.
 */
export function decFromNumber(value: number): Decimal {
  if (!Number.isFinite(value)) {
    throw new DecimalParseError(`not finite: ${value}`);
  }
  const scaled = value * Number(SCALE_FACTOR);
  const rounded = BigInt(Math.round(scaled));
  return rounded as Decimal;
}

/** Exact scaled bigint (e.g. for persistence). */
export function decToScaled(value: Decimal): bigint {
  return value;
}

/** Round-trip-safe string, e.g. "-12.50000000". */
export function decToString(value: Decimal): string {
  const scaled = value as bigint;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  const fracStr = frac.toString().padStart(Number(SCALE), "0");
  return `${negative ? "-" : ""}${whole}.${fracStr}`;
}

/** Lossy conversion to JS number for display/serialization boundaries only. */
export function decToNumber(value: Decimal): number {
  return Number(value) / Number(SCALE_FACTOR);
}

/** True when the value is exactly zero. */
export function decIsZero(value: Decimal): boolean {
  return (value as bigint) === 0n;
}

/** True when value > 0. */
export function decIsPositive(value: Decimal): boolean {
  return (value as bigint) > 0n;
}

/** True when value < 0. */
export function decIsNegative(value: Decimal): boolean {
  return (value as bigint) < 0n;
}

export function decCompare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const av = a as bigint;
  const bv = b as bigint;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export function decEquals(a: Decimal, b: Decimal): boolean {
  return (a as bigint) === (b as bigint);
}

export function decMin(a: Decimal, b: Decimal): Decimal {
  return decCompare(a, b) <= 0 ? a : b;
}

export function decMax(a: Decimal, b: Decimal): Decimal {
  return decCompare(a, b) >= 0 ? a : b;
}

export function decAdd(a: Decimal, b: Decimal): Decimal {
  return ((a as bigint) + (b as bigint)) as Decimal;
}

export function decSub(a: Decimal, b: Decimal): Decimal {
  return ((a as bigint) - (b as bigint)) as Decimal;
}

export function decNeg(a: Decimal): Decimal {
  return -(a as bigint) as Decimal;
}

export function decAbs(a: Decimal): Decimal {
  return ((a as bigint) < 0n ? -(a as bigint) : a) as Decimal;
}

export interface RationalDivisionResult {
  /** Truncated-toward-zero quotient of a/b, scaled at 8 dp. */
  quotient: Decimal;
  /**
   * Remainder expressed in the dividend's units (8 dp, truncated):
   * `a == b * quotient + remainder` holds to within 1e-8.
   */
  remainder: Decimal;
}

/**
 * Exact division: quotient is truncated toward zero. Note the extra SCALE_FACTOR
 * multiplication: both inputs are scaled, so quotient = (a * SCALE) / b keeps
 * the result scaled (the input scales cancel, the output must be re-scaled).
 */
export function decDivMod(a: Decimal, b: Decimal): RationalDivisionResult {
  if ((b as bigint) === 0n) {
    throw new DecimalParseError("division by zero");
  }
  const av = a as bigint;
  const bv = b as bigint;
  const negative = av < 0n !== bv < 0n;
  const absA = av < 0n ? -av : av;
  const absB = bv < 0n ? -bv : bv;
  const scaledA = absA * SCALE_FACTOR;
  const q = scaledA / absB;
  const r = scaledA % absB;
  return {
    quotient: (negative ? -q : q) as Decimal,
    // r is in SCALE^2 units of the value remainder; express it at 8 dp.
    remainder: (r / SCALE_FACTOR) as Decimal,
  };
}

/** Truncated division (toward zero). */
export function decDivTrunc(a: Decimal, b: Decimal): Decimal {
  return decDivMod(a, b).quotient;
}

/**
 * Rounded division: round half away from zero, so half-cent decisions are
 * explicit rather than silent truncation. Works for any sign combination.
 */
export function decDivRound(a: Decimal, b: Decimal): Decimal {
  if ((b as bigint) === 0n) {
    throw new DecimalParseError("division by zero");
  }
  const av = a as bigint;
  const bv = b as bigint;
  const negative = av < 0n !== bv < 0n;
  const absA = av < 0n ? -av : av;
  const absB = bv < 0n ? -bv : bv;
  const scaledA = absA * SCALE_FACTOR;
  const q = scaledA / absB;
  const r = scaledA % absB;
  const bump = r * 2n >= absB ? 1n : 0n;
  return (negative ? -(q + bump) : q + bump) as Decimal;
}

/**
 * Multiply two Decimals, keeping the full-precision result scaled at 8 dp by
 * dividing out one scale factor. Exact when the product of scaled values is a
 * multiple of SCALE_FACTOR; otherwise truncates toward zero (use decMulRound
 * for half-up rounding).
 */
export function decMulTrunc(a: Decimal, b: Decimal): Decimal {
  return (((a as bigint) * (b as bigint)) / SCALE_FACTOR) as Decimal;
}

/** Multiply two Decimals with round-half-away-from-zero at 8 dp. */
export function decMulRound(a: Decimal, b: Decimal): Decimal {
  const product = (a as bigint) * (b as bigint);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const q = abs / SCALE_FACTOR;
  const r = abs % SCALE_FACTOR;
  const bump = r * 2n >= SCALE_FACTOR ? 1n : 0n;
  const result = negative ? -(q + bump) : q + bump;
  return result as Decimal;
}

/** Percentage of a value: pct 0.5 means 50%, so result = value * pct / 1. */
export function decPctOf(value: Decimal, pct: Decimal): Decimal {
  return decMulTrunc(value, pct);
}
