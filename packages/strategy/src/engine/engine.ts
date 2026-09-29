/**
 * The deterministic signal engine.
 *
 * Pipeline (all pure):
 *   AssetHistory -> per-component scores -> weighted aggregate direction
 *                -> rule-based regime -> rule-based confidence -> AssetSignal
 *
 * Honesty rules:
 * - missing components are excluded and *reduce* confidence (the engine says
 *   "I don't know" rather than inventing a value),
 * - stale data yields confidence 0 with regime "data-starved",
 * - degenerate/flat inputs yield confidence 0.
 * Determinism: identical inputs + config + `now` always produce the identical
 * signal. No randomness, no clocks (now is a parameter), no ML, no LLM.
 */

import type { AssetSymbol, Millis } from "@bot/domain";

import {
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  type ComponentWeights,
  type SignalEngineConfig,
} from "./config.js";
import type { AssetHistory } from "./history.js";
import {
  accelerationScore,
  bookImbalanceScore,
  dataFreshness,
  latestSampleAtOrBefore,
  momentumScore,
  rangePositionScore,
  realizedVolatilityPerMin,
  shortTermReturnScore,
  type Freshness,
  type Score,
} from "./components.js";

/** Market regime, derived purely from thresholds. */
export type MarketRegime = "quiet" | "normal" | "volatile" | "data-starved";

/** Confidence tier for downstream gating. */
export type ConfidenceTier = "untrustworthy" | "weak" | "moderate" | "strong";

/** The normalized signal (requirement): one per asset. */
export interface AssetSignal {
  /** BTC or ETH. */
  readonly asset: AssetSymbol;
  /** Evaluation time (UTC ms) — a parameter, never a clock read. */
  readonly timestamp: Millis;
  /** Aggregate direction in [-1, +1]: -1 = down pressure, +1 = up pressure. */
  readonly direction: number;
  /** Confidence in [0, 1]. */
  readonly confidence: number;
  /**
   * Model probability that the underlying is higher at the end of the current
   * 5-minute window than at its start, in [0, 1] (T1).
   *
   * UNVERIFIED as a calibrated probability: the raw score→probability map is
   * the symmetric affine transform `(1 + direction) / 2`. It is NOT fitted to
   * outcomes yet; `packages/calibration` (T2) will own the fitted mapping and
   * consumers must treat this number as an uncalibrated prior until a
   * calibration table is loaded.
   */
  readonly probabilityUp: number;
  /** Threshold-derived regime. */
  readonly regime: MarketRegime;
  /** Supporting metrics — every input the decision rested on. */
  readonly metrics: SignalMetrics;
}

export interface SignalMetrics {
  readonly freshness: Freshness;
  /** Per-component scores; components that could not be computed are absent. */
  readonly components: Partial<Record<ComponentKey, Score>>;
  /** Realized volatility (%/min) when computable. */
  readonly volatilityPerMin: number | undefined;
  /** Age of the newest spot sample, ms. */
  readonly dataAgeMs: number;
  /** Samples considered in the evaluation window. */
  readonly sampleCount: number;
  /** Book age, ms, when a book was attached. */
  readonly bookAgeMs: number | undefined;
  /**
   * Where `probabilityUp` came from: the raw score transform ("raw_score") or
   * the uninformed 0.5 default ("default", used when there is no usable data).
   */
  readonly probabilitySource: "raw_score" | "default";
}

export type ComponentKey =
  "momentum" | "shortTermReturn" | "acceleration" | "bookImbalance" | "rangePosition";

const WEIGHT_KEYS: readonly ComponentKey[] = [
  "momentum",
  "shortTermReturn",
  "acceleration",
  "bookImbalance",
  "rangePosition",
];

function weightOf(config: SignalEngineConfig, key: ComponentKey): number {
  const w: ComponentWeights = config.weights;
  switch (key) {
    case "momentum":
      return w.momentum;
    case "shortTermReturn":
      return w.shortTermReturn;
    case "acceleration":
      return w.acceleration;
    case "bookImbalance":
      return w.bookImbalance;
    case "rangePosition":
      return w.rangePosition;
  }
}

function clampDirection(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(-1, x));
}

function clampConfidence(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function clampProbability(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}

function classifyRegime(volPerMin: number | undefined, config: SignalEngineConfig): MarketRegime {
  if (volPerMin === undefined) return "data-starved";
  if (volPerMin > config.volatileRegimeThreshold) return "volatile";
  if (volPerMin < config.quietRegimeThreshold) return "quiet";
  return "normal";
}

function confidenceTier(confidence: number, config: SignalEngineConfig): ConfidenceTier {
  if (confidence <= 0) return "untrustworthy";
  if (confidence < config.weakScoreThreshold) return "weak";
  if (confidence < 0.5) return "moderate";
  return "strong";
}

/**
 * Compute the deterministic signal for one asset at time `now`.
 * Throws only on contract violations (non-finite prices, unordered history is
 * rejected at history construction).
 */
export function computeAssetSignal(
  history: AssetHistory,
  config: SignalEngineConfig = DEFAULT_SIGNAL_ENGINE_CONFIG,
  now: Millis,
): AssetSignal {
  const nowMs = now as unknown as number;

  const latest = latestSampleAtOrBefore(history, nowMs);
  if (latest === undefined || history.samples.length < config.minSamples) {
    return {
      asset: history.asset,
      timestamp: now,
      direction: 0,
      confidence: 0,
      probabilityUp: 0.5,
      regime: "data-starved",
      metrics: {
        freshness: "stale",
        components: {},
        volatilityPerMin: undefined,
        dataAgeMs: Number.POSITIVE_INFINITY,
        sampleCount: history.samples.length,
        bookAgeMs:
          history.book === undefined ? undefined : nowMs - (history.book.at as unknown as number),
        probabilitySource: "default",
      },
    };
  }

  const freshness = dataFreshness(history, config, nowMs);
  const dataAgeMs = nowMs - latest.at;

  if (freshness === "stale") {
    return {
      asset: history.asset,
      timestamp: now,
      direction: 0,
      confidence: 0,
      probabilityUp: 0.5,
      regime: "data-starved",
      metrics: {
        freshness,
        components: {},
        volatilityPerMin: undefined,
        dataAgeMs,
        sampleCount: history.samples.length,
        bookAgeMs:
          history.book === undefined ? undefined : nowMs - (history.book.at as unknown as number),
        probabilitySource: "default",
      },
    };
  }

  // -- components -----------------------------------------------------------
  const momentum = momentumScore(history, config, nowMs);
  const shortReturn = shortTermReturnScore(history, config, nowMs);
  const acceleration = accelerationScore(history, config, nowMs);
  const imbalance = bookImbalanceScore(history, config, nowMs);
  const rangePosition = rangePositionScore(history, config, nowMs);
  const volPerMin = realizedVolatilityPerMin(history, config, nowMs);

  const components: Partial<Record<ComponentKey, Score>> = {};
  if (momentum !== undefined) components["momentum"] = momentum;
  if (shortReturn !== undefined) components["shortTermReturn"] = shortReturn;
  if (acceleration !== undefined) components["acceleration"] = acceleration;
  if (imbalance !== undefined) components["bookImbalance"] = imbalance;
  if (rangePosition !== undefined) components["rangePosition"] = rangePosition;

  // -- weighted aggregate over available components --------------------------
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of WEIGHT_KEYS) {
    const score = components[key];
    if (score === undefined) continue;
    const w = weightOf(config, key);
    weightedSum += w * score;
    weightTotal += w;
  }
  const direction = weightTotal > 0 ? clampDirection(weightedSum / weightTotal) : 0;

  // -- confidence -------------------------------------------------------------
  const regime = classifyRegime(volPerMin, config);
  const availableRatio = weightTotal > 0 ? weightTotal / 1 : 0; // fraction of total weight
  const magnitude = Math.abs(direction);

  let confidence = availableRatio * (0.5 + 0.5 * magnitude);
  if (regime === "volatile") confidence *= config.volatileConfidenceScale;
  if (freshness === "warn") confidence *= 0.8;
  confidence = clampConfidence(confidence);
  if (magnitude < config.weakScoreThreshold) {
    confidence = Math.min(confidence, config.weakScoreThreshold);
  }

  return {
    asset: history.asset,
    timestamp: now,
    direction,
    confidence,
    probabilityUp: clampProbability((1 + direction) / 2),
    regime,
    metrics: {
      freshness,
      components,
      volatilityPerMin: volPerMin,
      dataAgeMs,
      sampleCount: history.samples.length,
      bookAgeMs:
        history.book === undefined ? undefined : nowMs - (history.book.at as unknown as number),
      probabilitySource: "raw_score",
    },
  };
}

/** Compute signals for multiple assets; pure fan-out. */
export function computeSignals(
  histories: readonly AssetHistory[],
  config: SignalEngineConfig | undefined,
  now: Millis,
): readonly AssetSignal[] {
  return histories.map((h) => computeAssetSignal(h, config ?? DEFAULT_SIGNAL_ENGINE_CONFIG, now));
}

export { confidenceTier };
