/**
 * Binary-option delta model (T6).
 *
 * A 5-minute "Up" token is a cash-or-nothing binary call on the underlying:
 * it pays 1 USDC per share iff the window-end price is at/above the strike
 * (the window-start price). Its value under Black-Scholes with zero carry
 * (r = 0; irrelevant over a 5-minute horizon) and lognormal dynamics is
 *
 *   V(S) = N(d2),   d2 = [ln(S/K) - 0.5 σ² T] / (σ √T)
 *
 * and its delta with respect to the underlying is
 *
 *   ∂V/∂S = φ(d2) / (S σ √T)
 *
 * where N is the standard normal CDF and φ its density. A "Down" token is
 * (1 - Up) and carries the negative delta, so a net residual of
 * (upShares - downShares) has total spot-delta (upShares - downShares) × ∂V/∂S
 * and a delta-equivalent notional of shares × φ(d2) / (σ √T) USDC (the S
 * cancels: tokens-per-dollar × dollars).
 *
 * Properties that matter near expiry (tested):
 * - the delta is bell-shaped in ln(S/K): maximal at-the-money, → 0 both deep
 *   in-the-money and deep out-of-the-money (the mark-based exposure model
 *   overstates risk in both tails);
 * - at-the-money the delta grows like 1/√T — the classic binary "delta spike"
 *   as expiry approaches (pin risk);
 * - at expiry (T = 0) the delta is a Dirac delta at the strike: 0 away from
 *   it, undefined at it. We return 0 for the settled state — there is nothing
 *   left to hedge once the window has closed.
 *
 * Float boundary: normal-CDF evaluation is floating-point mathematics with no
 * BigInt equivalent. This module is therefore a MODEL step whose outputs are
 * converted to exact `Decimal` at the hedging-engine boundary
 * (`decFromString(x.toFixed(8))`) before any USDC arithmetic; all money math
 * downstream stays in Decimal per AGENTS.md rule 1. Pure and deterministic:
 * no clocks, no randomness, no I/O.
 */

/** Milliseconds in a year (365.25 days, Julian year — the vol convention). */
export const MS_PER_YEAR = 31_557_600_000;

// Abramowitz & Stegun 26.2.17 (erf rational approximation, |ε| ≤ 1.5e-7).
const ERF_P = 0.3275911;
const ERF_A1 = 0.254829592;
const ERF_A2 = -0.284496736;
const ERF_A3 = 1.421413741;
const ERF_A4 = -1.453152027;
const ERF_A5 = 1.061405429;

/**
 * Gauss error function erf(x), pure and deterministic. Accurate to ~1.5e-7
 * (Abramowitz & Stegun 26.2.17); adequate for a sizing model whose output is
 * quantized to 8 decimal places anyway.
 */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  if (ax >= 6) return sign; // erf(6) ≈ 1 − 2e-17
  const t = 1 / (1 + ERF_P * ax);
  const poly = ((((ERF_A5 * t + ERF_A4) * t + ERF_A3) * t + ERF_A2) * t + ERF_A1) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Standard normal CDF Φ(x) = 0.5 (1 + erf(x/√2)). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Standard normal PDF φ(x) = e^(−x²/2) / √(2π). */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Inputs of the binary delta model (all plain numbers; model-domain). */
export interface BinaryDeltaInput {
  /** Current underlying spot price, USDC (> 0). */
  readonly spot: number;
  /** Strike = the window's start price / priceToBeat, USDC (> 0). */
  readonly strike: number;
  /** Annualized volatility of the underlying as a fraction (> 0, e.g. 0.6). */
  readonly annualizedVol: number;
  /** Time to expiry in milliseconds (>= 0). */
  readonly msToExpiry: number;
}

/** Validated, derived intermediates of the model. */
export interface BinaryDeltaTerms {
  /** Time to expiry in Julian years. */
  readonly yearsToExpiry: number;
  /** σ√T (fractional standard deviation over the remaining window). */
  readonly sigmaSqrtT: number;
  /** The Black-Scholes d2 = [ln(S/K) − 0.5σ²T] / (σ√T). */
  readonly d2: number;
}

function requirePositive(name: string, x: number): void {
  if (!Number.isFinite(x) || x <= 0) {
    throw new RangeError(`binary-delta: ${name} must be a positive finite number`);
  }
}

/** Validate inputs and derive (T, σ√T, d2). Throws on out-of-domain values. */
export function binaryDeltaTerms(input: BinaryDeltaInput): BinaryDeltaTerms {
  requirePositive("spot", input.spot);
  requirePositive("strike", input.strike);
  requirePositive("annualizedVol", input.annualizedVol);
  if (!Number.isFinite(input.msToExpiry) || input.msToExpiry < 0) {
    throw new RangeError("binary-delta: msToExpiry must be a non-negative finite number");
  }
  if (input.msToExpiry === 0) {
    // Settled: terms are undefined (T = 0); callers must special-case.
    return { yearsToExpiry: 0, sigmaSqrtT: 0, d2: Number.POSITIVE_INFINITY };
  }
  const yearsToExpiry = input.msToExpiry / MS_PER_YEAR;
  const sigmaSqrtT = input.annualizedVol * Math.sqrt(yearsToExpiry);
  const d2 =
    (Math.log(input.spot / input.strike) - 0.5 * input.annualizedVol ** 2 * yearsToExpiry) /
    sigmaSqrtT;
  return { yearsToExpiry, sigmaSqrtT, d2 };
}

/**
 * Delta of one Up-token share with respect to the underlying spot:
 * ∂V/∂S = φ(d2) / (S σ √T). Zero at expiry (settled — see module docs).
 * Units: token-probability per USDC of spot.
 */
export function binaryUpDelta(input: BinaryDeltaInput): number {
  if (input.msToExpiry === 0) return 0;
  const { sigmaSqrtT, d2 } = binaryDeltaTerms(input);
  return normalPdf(d2) / (input.spot * sigmaSqrtT);
}

/**
 * Model probability that the window closes Up, N(d2) — the same terms as the
 * delta. Useful for cross-checks and backtest diagnostics; ~0.5 at-the-money.
 */
export function binaryUpProbability(input: BinaryDeltaInput): number {
  if (input.msToExpiry === 0) {
    // Settled: deterministic step in the limit (undefined exactly at strike).
    return input.spot > input.strike ? 1 : input.spot < input.strike ? 0 : 0.5;
  }
  const { d2 } = binaryDeltaTerms(input);
  return normalCdf(d2);
}

/**
 * Delta-equivalent USDC notional of a net residual position:
 * |shares| × φ(d2) / (σ √T). This is the spot-notional whose small-move P&L
 * matches the binary's (tokens-per-dollar × dollars; the spot cancels).
 * Returns 0 for a settled market (msToExpiry = 0).
 */
export function binaryDeltaNotionalUsdc(
  input: BinaryDeltaInput & { readonly shares: number },
): number {
  if (input.msToExpiry === 0) return 0;
  if (!Number.isFinite(input.shares)) {
    throw new RangeError("binary-delta: shares must be a finite number");
  }
  const { sigmaSqrtT, d2 } = binaryDeltaTerms(input);
  return Math.abs(input.shares) * (normalPdf(d2) / sigmaSqrtT);
}
