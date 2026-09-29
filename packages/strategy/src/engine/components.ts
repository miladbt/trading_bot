/**
 * Pure deterministic signal components.
 *
 * Contract for every component: `(history, config, now) -> score` where score
 * is a number in [-1, 1] (positive = up pressure, negative = down pressure),
 * or `undefined` when the component cannot be computed honestly (insufficient
 * data, stale inputs). Undefined is meaningful: it removes the component from
 * the aggregate and lowers confidence.
 *
 * No component looks at anything but its inputs; none of them mutate state;
 * identical inputs always produce identical outputs (deterministic).
 */

import type { SignalEngineConfig } from "./config.js";
import type { AssetHistory, BookTop } from "./history.js";

export type Score = number; // [-1, 1]

/** tanh squashing: keeps the score bounded and symmetric around 0. */
export function squash(x: number, cap: number): Score {
  if (!Number.isFinite(x) || cap <= 0) return 0;
  return Math.tanh(x / cap);
}

/** Newest sample at or before `now`; undefined when history predates the window. */
export function latestSampleAtOrBefore(
  history: AssetHistory,
  now: number,
): { price: number; at: number } | undefined {
  let best: { price: number; at: number } | undefined;
  for (const s of history.samples) {
    const t = s.at as unknown as number;
    if (t <= now) {
      if (best === undefined || t >= best.at) {
        best = { price: Number(s.price), at: t };
      }
    }
  }
  return best;
}

/** Samples within the lookback window ending at `now` (inclusive). */
export function windowSamples(
  history: AssetHistory,
  now: number,
  lookbackMs: number,
): { price: number; at: number }[] {
  const out: { price: number; at: number }[] = [];
  for (const s of history.samples) {
    const t = s.at as unknown as number;
    if (t <= now && t > now - lookbackMs) {
      out.push({ price: Number(s.price), at: t });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Short-term price momentum: normalized slope of the window (price/min)
// ---------------------------------------------------------------------------

export function momentumScore(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): Score | undefined {
  const window = windowSamples(history, now, config.returnLookbackMs * 2);
  if (window.length < config.momentumMinSamples) return undefined;
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined || last.at <= first.at) return undefined;
  const slopePerMs = (last.price - first.price) / (last.at - first.at);
  const slopePerMin = slopePerMs * 60_000;
  return squash(slopePerMin, config.momentumSlopeCapPerMin);
}

// ---------------------------------------------------------------------------
// 2. Short-term return: simple return over the lookback window
// ---------------------------------------------------------------------------

export function shortTermReturnScore(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): Score | undefined {
  const window = windowSamples(history, now, config.returnLookbackMs);
  if (window.length < 2) return undefined;
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined || first.price <= 0) return undefined;
  const ret = (last.price - first.price) / first.price;
  return squash(ret, config.returnCapFraction);
}

// ---------------------------------------------------------------------------
// 3. Volatility: per-minute stdev of returns in the window (regime input)
// ---------------------------------------------------------------------------

/**
 * Per-minute standard deviation of consecutive sample returns inside the
 * volatility window. Returns undefined when fewer than 2 returns exist.
 * This feeds the regime classification and confidence gating; it contributes
 * no direction (volatility is direction-agnostic).
 */
export function realizedVolatilityPerMin(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): number | undefined {
  const window = windowSamples(history, now, config.volatilityLookbackMs);
  if (window.length < 3) return undefined;
  const returns: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1];
    const curr = window[i];
    if (prev === undefined || curr === undefined || prev.price <= 0) continue;
    const dtMin = (curr.at - prev.at) / 60_000;
    if (dtMin <= 0) continue;
    const logRet = Math.log(curr.price / prev.price) / dtMin;
    returns.push(logRet);
  }
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance)) * 100; // in %/min
}

// ---------------------------------------------------------------------------
// 4. Order-book imbalance: depth-weighted, optional
// ---------------------------------------------------------------------------

/**
 * (bidSize - askSize) / (bidSize + askSize) of the freshest book top.
 * Undefined when no book is attached or the book is older than maxBookAgeMs.
 */
export function bookImbalanceScore(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): Score | undefined {
  const book: BookTop | undefined = history.book;
  if (book === undefined) return undefined;
  const bookAt = book.at as unknown as number;
  if (now - bookAt > config.maxBookAgeMs) return undefined;
  const bidSize = Number(book.bidSize);
  const askSize = Number(book.askSize);
  if (!Number.isFinite(bidSize) || !Number.isFinite(askSize)) return undefined;
  const total = bidSize + askSize;
  if (total <= 0) return undefined;
  const imbalance = (bidSize - askSize) / total; // [-1, 1] naturally
  return squash(imbalance, config.imbalanceCap);
}

// ---------------------------------------------------------------------------
// 5. Price acceleration: second difference of the window's endpoints
// ---------------------------------------------------------------------------

/**
 * Acceleration proxy: (lateSlope - earlySlope) over the momentum window,
 * split into halves. Units: price/min². Undefined without enough samples.
 */
export function accelerationScore(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): Score | undefined {
  const window = windowSamples(history, now, config.returnLookbackMs * 2);
  if (window.length < 4) return undefined;
  const mid = Math.floor(window.length / 2);
  const earlyFirst = window[0];
  const earlyLast = window[mid - 1];
  const lateFirst = window[mid];
  const lateLast = window[window.length - 1];
  if (
    earlyFirst === undefined ||
    earlyLast === undefined ||
    lateFirst === undefined ||
    lateLast === undefined ||
    earlyLast.at <= earlyFirst.at ||
    lateLast.at <= lateFirst.at
  ) {
    return undefined;
  }
  const earlySlopePerMin =
    ((earlyLast.price - earlyFirst.price) / (earlyLast.at - earlyFirst.at)) * 60_000;
  const lateSlopePerMin =
    ((lateLast.price - lateFirst.price) / (lateLast.at - lateFirst.at)) * 60_000;
  const accelPerMin2 = (lateSlopePerMin - earlySlopePerMin) / 1; // per (half-window in minutes ~1)
  return squash(accelPerMin2, config.accelerationCapPerMin2);
}

// ---------------------------------------------------------------------------
// 6. Distance from recent local range: where price sits in its recent band
// ---------------------------------------------------------------------------

/**
 * Position of the latest price within [low, high] of the range window,
 * mapped to [-1, 1]: -1 = at/below the low, +1 = at/above the high, 0 = mid.
 * Undefined when the range is degenerate (flat market) or data is missing.
 */
export function rangePositionScore(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): Score | undefined {
  const window = windowSamples(history, now, config.rangeLookbackMs);
  if (window.length < 2) return undefined;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const s of window) {
    if (s.price < low) low = s.price;
    if (s.price > high) high = s.price;
  }
  const span = high - low;
  if (span <= config.zeroBand) return undefined; // degenerate range: no info
  const latest = window[window.length - 1];
  if (latest === undefined) return undefined;
  const position = (latest.price - low) / span - 0.5; // [-0.5, +0.5]
  return squash(position * 2, config.rangePositionCap);
}

// ---------------------------------------------------------------------------
// 7. Market-data freshness: a gate, not a direction
// ---------------------------------------------------------------------------

export type Freshness = "fresh" | "warn" | "stale";

export function dataFreshness(
  history: AssetHistory,
  config: SignalEngineConfig,
  now: number,
): Freshness {
  const latest = latestSampleAtOrBefore(history, now);
  if (latest === undefined) return "stale";
  const age = now - latest.at;
  if (age > config.maxDataAgeMs) return "stale";
  if (age > config.freshnessWarnMs) return "warn";
  return "fresh";
}
