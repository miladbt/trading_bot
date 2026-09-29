/**
 * Signal engine configuration. Every threshold is configurable (requirement:
 * "make all thresholds configurable") and every default is a round,
 * documented value chosen to be inert rather than predictive — the engine
 * must not encode overfitted market opinions.
 */

import { decFromString, type Decimal } from "@bot/domain";

/** Which components participate and their aggregate weights. */
export interface ComponentWeights {
  /** Weight of the short-term momentum score (trend persistence). */
  readonly momentum: number;
  /** Weight of the short-term return score. */
  readonly shortTermReturn: number;
  /** Weight of the price-acceleration score. */
  readonly acceleration: number;
  /** Weight of the order-book imbalance score. */
  readonly bookImbalance: number;
  /** Weight of the range-position score (distance from recent local range). */
  readonly rangePosition: number;
}

export const DEFAULT_WEIGHTS: ComponentWeights = {
  momentum: 0.3,
  shortTermReturn: 0.25,
  acceleration: 0.15,
  bookImbalance: 0.2,
  rangePosition: 0.1,
} as const;

export interface SignalEngineConfig {
  /** Weights per component; combined into a weighted mean by the engine. */
  readonly weights: ComponentWeights;

  // -- momentum (slope of the price series over the window, per minute) -----
  /** Momentum score saturates (|score| = 1) at this slope (price/min). */
  readonly momentumSlopeCapPerMin: number;
  /** Minimum window (samples) for momentum to be computed at all. */
  readonly momentumMinSamples: number;

  // -- short-term return ----------------------------------------------------
  /** Return over `returnLookbackMs` that saturates the score (fraction). */
  readonly returnCapFraction: number;
  readonly returnLookbackMs: number;

  // -- volatility (regime + gating, never a direction) -----------------------
  /** Window for realized volatility over per-sample returns. */
  readonly volatilityLookbackMs: number;
  /** Per-minute stdev above which the regime is "volatile". */
  readonly volatileRegimeThreshold: number;
  /** Per-minute stdev below which the regime is "quiet" (between = "normal"). */
  readonly quietRegimeThreshold: number;
  /** Confidence multiplier applied to a volatile regime. */
  readonly volatileConfidenceScale: number;

  // -- order-book imbalance --------------------------------------------------
  /** |imbalance| that saturates the score (0..1, depth-weighted). */
  readonly imbalanceCap: number;
  /** Book older than this is ignored (freshness gate), ms. */
  readonly maxBookAgeMs: number;

  // -- acceleration ----------------------------------------------------------
  /** Acceleration (price/min²) that saturates the score. */
  readonly accelerationCapPerMin2: number;

  // -- distance from recent local range ---------------------------------------
  /** Range window for high/low; also the normalization band. */
  readonly rangeLookbackMs: number;
  /** Position beyond the recent band that saturates the score (0.5 = at edge). */
  readonly rangePositionCap: number;

  // -- freshness --------------------------------------------------------------
  /** Spot data older than this gates the signal to UNTRUSTWORTHY. */
  readonly maxDataAgeMs: number;
  /** Spot data older than this mutes the freshness component's contribution. */
  readonly freshnessWarnMs: number;

  // -- confidence --------------------------------------------------------------
  /** Weighted score magnitude below this is considered "weak". */
  readonly weakScoreThreshold: number;
  /** Minimum number of samples required for any signal at all. */
  readonly minSamples: number;

  /** Decimal epsilon for range checks (tiny but non-zero band). */
  readonly zeroBand: Decimal;
}

/**
 * Inert defaults: symmetric, generous thresholds. With synthetic series these
 * produce near-zero scores; nothing here predicts, it only measures.
 */
export const DEFAULT_SIGNAL_ENGINE_CONFIG: SignalEngineConfig = {
  weights: DEFAULT_WEIGHTS,

  momentumSlopeCapPerMin: 50,
  momentumMinSamples: 3,

  returnCapFraction: 0.002, // 0.2% saturates
  returnLookbackMs: 30_000,

  volatilityLookbackMs: 60_000,
  volatileRegimeThreshold: 1.0, // 1% per-minute stdev
  quietRegimeThreshold: 0.1,
  volatileConfidenceScale: 0.7,

  imbalanceCap: 0.5,
  maxBookAgeMs: 5_000,

  accelerationCapPerMin2: 100,

  rangeLookbackMs: 120_000,
  rangePositionCap: 0.5,

  maxDataAgeMs: 5_000,
  freshnessWarnMs: 2_000,

  weakScoreThreshold: 0.05,
  minSamples: 5,

  zeroBand: decFromString("0.00000001"),
} as const;
