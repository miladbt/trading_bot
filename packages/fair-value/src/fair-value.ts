/**
 * Fair Value Engine (Strategy V2, `@bot/fair-value`).
 *
 * Estimates P(UP) for a 5-minute binary market with a **transparent,
 * bounded, additive** model, converts it into executable fair values after
 * fees and buffers, and defines the mispricing decision rule.
 *
 * Design rules (see docs/STRATEGY_V2.md):
 * - Every component is bounded; the sum is clamped to [0.001, 0.999].
 * - `P(DOWN) = 1 − P(UP)` exactly.
 * - Inputs the caller does not have (book depth, sub-anchor momentum) are
 *   DORMANT: they contribute 0 and are reported as unavailable. A dormant
 *   component never pretends to have data.
 * - Statistics are floats (allowed by AGENTS.md for analysis); the OUTPUT
 *   crosses back into the money path only through the caller's Decimal
 *   boundary (`decFromString(p.toFixed(8))`), the same one T1/T2 use.
 * - Pure and deterministic: no clocks, no I/O, no network, no orders.
 *
 * Resolution model: the underlying series is the Chainlink settlement chain
 * (Gamma settlement metadata), NOT an exchange feed — see
 * docs/RESOLUTION_AND_FEES.md for the verified citations. `priceToBeat` and
 * the anchor series come from that chain; ties resolve Up.
 */

import { brierScore, logLoss } from "@bot/calibration";

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

/** Weights and caps of the additive probability components. */
export interface FairValueConfig {
  /** Base (prior) probability of UP before evidence, in [0.001, 0.999]. */
  readonly base: number;
  /** Momentum component weight. */
  readonly wMomentum: number;
  /** Per-minute price change that saturates the momentum component. */
  readonly momentumCapPerMin: number;
  /** Anchor-distance component weight. */
  readonly wAnchor: number;
  /** Relative (fraction-of-price) distance from priceToBeat that saturates. */
  readonly anchorCapFraction: number;
  /** Volatility-acceleration component weight. */
  readonly wVolAccel: number;
  /** Change in per-minute stdev that saturates the acceleration component. */
  readonly volAccelCapPerMin2: number;
  /** Order-book imbalance component weight (dormant when no book). */
  readonly wBook: number;
  /** Normalized time-to-expiry component weight. 0 = inert default: any
   * nonzero time weight is a directional opinion when other evidence is
   * dormant, so research must opt in. */
  readonly wTime: number;
  /** Time-pressure normalization: normalized time remaining at saturation. */
  readonly timeSaturation: number;
  /** Probability floor (spec: 0.001). */
  readonly pFloor: number;
  /** Probability ceiling (spec: 0.999). */
  readonly pCeiling: number;
}

/**
 * Inert, symmetric defaults: the model starts neutral (base 0.5, weights
 * small) and must EARN edge through calibration and the gate, not through
 * hardcoded opinion.
 */
export const DEFAULT_FAIR_VALUE_CONFIG: FairValueConfig = {
  base: 0.5,
  wMomentum: 0.08,
  momentumCapPerMin: 0.002, // 0.2%/min saturates (BTC-scale)
  wAnchor: 0.1,
  anchorCapFraction: 0.0004, // 4 bps from the strike saturates
  wVolAccel: 0.04,
  volAccelCapPerMin2: 0.0005,
  wBook: 0.0, // dormant by default: no recorded depth exists yet
  wTime: 0.0, // inert by default (see doc above); research opt-in
  timeSaturation: 0.2,
  pFloor: 0.001,
  pCeiling: 0.999,
} as const;

// ---------------------------------------------------------------------------
// Inputs (dormancy is explicit)
// ---------------------------------------------------------------------------

/** A component that may be unavailable in the caller's data. */
export interface Dormant {
  /** False = the caller has no data for this component; it contributes 0. */
  readonly available: boolean;
  /** The component's signed evidence value (units depend on the component). */
  readonly value: number;
}

export const dormant: Dormant = { available: false, value: 0 };

/** Underlying-state evidence (Chainlink settlement chain, not an exchange). */
export interface UnderlyingEvidence {
  /** Relative distance from priceToBeat: (spot − strike) / strike. */
  readonly anchorDistFrac: Dormant;
  /** Per-minute realized drift over the anchor/observation window. */
  readonly momentumPerMin: Dormant;
  /** Per-minute² change in realized volatility (acceleration). */
  readonly volAccelPerMin2: Dormant;
}

/** Market-state evidence (dormant on schema-1 datasets: no recorded book). */
export interface MarketEvidence {
  /** Depth-weighted book imbalance in [−1, 1] (positive = bid-heavy). */
  readonly bookImbalance: Dormant;
}

export interface FairValueInput {
  /** Seconds since the window opened. */
  readonly elapsedSec: number;
  /** Seconds until settlement (≥ 0). */
  readonly remainingSec: number;
  readonly underlying: UnderlyingEvidence;
  readonly market: MarketEvidence;
  readonly config: FairValueConfig;
}

// ---------------------------------------------------------------------------
// Bounded additive probability model
// ---------------------------------------------------------------------------

/** The probability estimate plus the full per-component audit trail. */
export interface FairValueEstimate {
  /** Clamped probability that the window closes UP, in [0.001, 0.999]. */
  readonly pUp: number;
  /** Exactly 1 − pUp (computed AFTER clamping). */
  readonly pDown: number;
  /** Which components carried real data this call. */
  readonly available: {
    readonly momentum: boolean;
    readonly anchor: boolean;
    readonly volAccel: boolean;
    readonly book: boolean;
    readonly time: boolean;
  };
  /** Raw (pre-clamp) additive sum — for diagnostics and tests. */
  readonly rawSum: number;
}

/** Squash evidence to [−1, 1] with a linear-then-constant cap (deterministic, transparent). */
function capped(value: number, cap: number): number {
  if (!Number.isFinite(value) || cap <= 0) return 0;
  if (value >= cap) return 1;
  if (value <= -cap) return -1;
  return value / cap;
}

/**
 * Compute P(UP). Throws on structurally impossible inputs (negative time,
 * elapsed beyond remaining, non-finite base) — fail closed, fail loud.
 */
export function fairValueEstimate(input: FairValueInput): FairValueEstimate {
  const { config } = input;
  if (
    !Number.isFinite(config.base) ||
    config.base < config.pFloor ||
    config.base > config.pCeiling
  ) {
    throw new RangeError("fairValue: base probability outside [pFloor, pCeiling]");
  }
  if (config.pFloor <= 0 || config.pCeiling >= 1 || config.pFloor >= config.pCeiling) {
    throw new RangeError("fairValue: pFloor/pCeiling must satisfy 0 < floor < ceiling < 1");
  }
  if (!Number.isFinite(input.elapsedSec) || input.elapsedSec < 0) {
    throw new RangeError("fairValue: elapsedSec must be finite and non-negative");
  }
  if (!Number.isFinite(input.remainingSec) || input.remainingSec < 0) {
    throw new RangeError("fairValue: remainingSec must be finite and non-negative");
  }

  // -- momentum: trend persistence (per-minute drift) --
  const mom = input.underlying.momentumPerMin;
  const momentumAvail = mom.available && Number.isFinite(mom.value);
  const momentumComponent = momentumAvail
    ? config.wMomentum * capped(mom.value, config.momentumCapPerMin)
    : 0;

  // -- anchor: distance from the strike (priceToBeat); positive = above --
  const anch = input.underlying.anchorDistFrac;
  const anchorAvail = anch.available && Number.isFinite(anch.value);
  const anchorComponent = anchorAvail
    ? config.wAnchor * capped(anch.value, config.anchorCapFraction)
    : 0;

  // -- volatility acceleration (proxy; sub-minute series not yet recorded) --
  const va = input.underlying.volAccelPerMin2;
  const volAccelAvail = va.available && Number.isFinite(va.value);
  const volAccelComponent = volAccelAvail
    ? config.wVolAccel * capped(va.value, config.volAccelCapPerMin2)
    : 0;

  // -- order-book imbalance (dormant until real books are recorded) --
  const book = input.market.bookImbalance;
  const bookAvail = book.available && Number.isFinite(book.value);
  const bookComponent = bookAvail ? config.wBook * Math.max(-1, Math.min(1, book.value)) : 0;

  // -- time pressure: evidence decays as expiry approaches (avoid stale-opinion
  //    gambling in the final seconds); bounded by construction --
  const timeAvail = input.remainingSec > 0 && Number.isFinite(input.elapsedSec);
  const normRemaining = timeAvail
    ? input.remainingSec / (input.remainingSec + input.elapsedSec)
    : 0;
  const timeComponent = timeAvail
    ? config.wTime * (capped(normRemaining, config.timeSaturation) * 2 - 1)
    : 0;

  const rawSum =
    config.base +
    momentumComponent +
    anchorComponent +
    volAccelComponent +
    bookComponent +
    timeComponent;
  const pUp = Math.min(config.pCeiling, Math.max(config.pFloor, rawSum));

  return {
    pUp,
    pDown: 1 - pUp,
    available: {
      momentum: momentumAvail,
      anchor: anchorAvail,
      volAccel: volAccelAvail,
      book: bookAvail,
      time: timeAvail,
    },
    rawSum,
  };
}

// ---------------------------------------------------------------------------
// Buffers and mispricing
// ---------------------------------------------------------------------------

/** Execution-cost buffers subtracted from fair value before comparisons. */
export interface BufferConfig {
  /** Expected slippage buffer (probability units per share). */
  readonly slippage: number;
  /** Adverse-selection buffer (probability units per share). */
  readonly adverse: number;
  /** Execution-uncertainty buffer (probability units per share). */
  readonly uncertainty: number;
  /** Market-impact slope k: impact = k · clamp(size/depth, 0, 1). Dormant without depth. */
  readonly impactSlope: number;
}

export const DEFAULT_BUFFERS: BufferConfig = {
  slippage: 0.003,
  adverse: 0.003,
  uncertainty: 0.003,
  impactSlope: 0.01,
} as const;

export interface BufferInput {
  /** Order size in shares (informational; dormant without depth). */
  readonly sizeShares: number;
  /** Visible depth at/near the touch in shares; undefined = dormant. */
  readonly visibleDepthShares: number | undefined;
  readonly buffers: BufferConfig;
}

/** Total buffer (probability units). Impact part is 0 when depth is unknown. */
export function totalBuffer(input: BufferInput): number {
  const b = input.buffers;
  let impact = 0;
  if (
    input.visibleDepthShares !== undefined &&
    Number.isFinite(input.visibleDepthShares) &&
    input.visibleDepthShares > 0 &&
    Number.isFinite(input.sizeShares) &&
    input.sizeShares > 0
  ) {
    const take = Math.min(1, input.sizeShares / input.visibleDepthShares);
    impact = b.impactSlope * take;
  }
  return b.slippage + b.adverse + b.uncertainty + impact;
}

/**
 * Mispricing per side after fee and buffers, in probability units.
 *   mis_up   = pUp − (askUp + fee(askUp)) − buffer
 *   mis_down = pDown − (askDown + fee(askDown)) − buffer
 * Taker fee = C · rate · p · (1 − p) — the verified crypto schedule
 * (docs/RESOLUTION_AND_FEES.md). Positive = the ask is too cheap = buy.
 */
export interface MispricingInput {
  readonly pUp: number;
  readonly askUp: number;
  readonly askDown: number;
  /** Verified taker fee rate (e.g. 0.07). */
  readonly takerFeeRate: number;
  readonly buffer: number;
}

export interface MispricingResult {
  readonly mispricingUp: number;
  readonly mispricingDown: number;
  readonly feeUp: number;
  readonly feeDown: number;
}

export function mispricing(input: MispricingInput): MispricingResult {
  const assertOpenUnit = (v: number, name: string): number => {
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      throw new RangeError(`mispricing: ${name} must be in (0, 1)`);
    }
    return v;
  };
  const pUp = assertOpenUnit(input.pUp, "pUp");
  const askUp = assertOpenUnit(input.askUp, "askUp");
  const askDown = assertOpenUnit(input.askDown, "askDown");
  if (!Number.isFinite(input.takerFeeRate) || input.takerFeeRate < 0) {
    throw new RangeError("mispricing: takerFeeRate must be finite and non-negative");
  }
  if (!Number.isFinite(input.buffer) || input.buffer < 0) {
    throw new RangeError("mispricing: buffer must be finite and non-negative");
  }

  const fee = (p: number): number => input.takerFeeRate * p * (1 - p);
  const feeUp = fee(askUp);
  const feeDown = fee(askDown);
  return {
    mispricingUp: pUp - (askUp + feeUp) - input.buffer,
    mispricingDown: 1 - pUp - (askDown + feeDown) - input.buffer,
    feeUp,
    feeDown,
  };
}

// ---------------------------------------------------------------------------
// Model-quality gate (the hard rule of Strategy V2)
// ---------------------------------------------------------------------------

/** Gate thresholds; defaults encode "beats the coin flip, with slack". */
export interface GateConfig {
  /** Required strict upper bound on Brier (coin flip = 0.25). */
  readonly maxBrier: number;
  /** Required strict upper bound on log loss (coin flip = ln 2 ≈ 0.6931). */
  readonly maxLogLoss: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  maxBrier: 0.23,
  maxLogLoss: Math.LN2 - 0.02,
} as const;

export interface GateObservation {
  readonly predicted: number;
  readonly outcome: 0 | 1;
}

export type GateVerdict = "open" | "closed" | "insufficient";

export interface GateEvaluation {
  readonly verdict: GateVerdict;
  readonly brier: number | undefined;
  readonly logLoss: number | undefined;
  readonly sampleCount: number;
  readonly reason: string;
}

/** Minimum observations before the gate may open (small-N honesty). */
export const MIN_GATE_SAMPLES = 50;

/**
 * Evaluate whether the model beats the coin-flip baseline out of sample.
 * Fewer than MIN_GATE_SAMPLES observations → "insufficient" (fail closed).
 */
export function evaluateGate(
  observations: readonly GateObservation[],
  config: GateConfig,
): GateEvaluation {
  if (observations.length < MIN_GATE_SAMPLES) {
    return {
      verdict: "insufficient",
      brier: undefined,
      logLoss: undefined,
      sampleCount: observations.length,
      reason: `insufficient samples (${observations.length} < ${MIN_GATE_SAMPLES})`,
    };
  }
  const b = brierScore(observations);
  const ll = logLoss(observations);
  const beatsBrier = b < config.maxBrier;
  const beatsLogLoss = ll < config.maxLogLoss;
  return {
    verdict: beatsBrier && beatsLogLoss ? "open" : "closed",
    brier: b,
    logLoss: ll,
    sampleCount: observations.length,
    reason:
      beatsBrier && beatsLogLoss ? "beats coin-flip baseline" : "does not beat coin-flip baseline",
  };
}
