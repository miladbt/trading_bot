import { describe, expect, it } from "vitest";

import {
  accelerationScore,
  bookImbalanceScore,
  dataFreshness,
  latestSampleAtOrBefore,
  momentumScore,
  rangePositionScore,
  realizedVolatilityPerMin,
  shortTermReturnScore,
  squash,
  windowSamples,
} from "./components.js";
import { DEFAULT_SIGNAL_ENGINE_CONFIG as CFG } from "./config.js";
import {
  BTC_BOOK_LOPSIDED_SELL,
  BTC_BOOK_TIGHT,
  STEP,
  T0,
  attachBook,
  downtrend,
  flat,
  gappy,
  reversal,
  spike,
  uptrend,
  volatileSeries,
} from "./fixtures.js";

const NOW = T0 + 11 * STEP; // just past a 12-sample series

describe("squash", () => {
  it("bounds to [-1, 1] and is symmetric", () => {
    expect(squash(0, 10)).toBe(0);
    expect(squash(10, 10)).toBeCloseTo(Math.tanh(1), 12);
    expect(squash(-10, 10)).toBeCloseTo(-Math.tanh(1), 12);
    // extreme inputs saturate to ±1 (tanh limit)
    expect(squash(1e9, 10)).toBe(1);
    expect(squash(-1e9, 10)).toBe(-1);
    expect(squash(Number.NaN, 10)).toBe(0);
    expect(squash(5, 0)).toBe(0); // degenerate cap
  });
});

describe("window selection", () => {
  it("windowSamples returns only samples inside (now-lookback, now]", () => {
    // NOW = T0 + 11*STEP; a 30s window covers samples at T0+55s..T0+11s*
    const w = windowSamples(uptrend(), NOW, 30_000);
    expect(w).toHaveLength(6);
    expect(w[0]?.price).toBe(64_060); // T0 + 6*STEP (55s before NOW exclusive, 60s inclusive)
    expect(w[w.length - 1]?.price).toBe(64_110);
  });

  it("latestSampleAtOrBefore finds the newest sample not in the future", () => {
    // samples are 64000.00, 64010.00, ...; T0+5*STEP = 64050.00 sample
    expect(latestSampleAtOrBefore(uptrend(), T0 + 5 * STEP)?.price).toBe(64_050);
    expect(latestSampleAtOrBefore(uptrend(), T0 - 1)).toBeUndefined();
  });
});

describe("momentumScore", () => {
  it("is strongly positive on a steady uptrend", () => {
    // slope = +120 price/min over the 60s window, cap 50 -> tanh(2.4) ≈ 0.9836
    expect(momentumScore(uptrend(), CFG, NOW)).toBeGreaterThan(0.9);
  });

  it("is strongly negative on a downtrend", () => {
    expect(momentumScore(downtrend(), CFG, NOW)).toBeLessThan(-0.95);
  });

  it("is 0 on a flat series (slope zero)", () => {
    expect(momentumScore(flat(), CFG, NOW)).toBe(0);
  });

  it("returns undefined without enough samples", () => {
    expect(momentumScore(uptrend(2), CFG, T0 + STEP)).toBeUndefined();
  });
});

describe("shortTermReturnScore", () => {
  it("captures the return over the lookback window", () => {
    // 30s lookback: +6 samples * 10 = +60 over 64030 -> ~0.094%, cap 0.2%
    const up = shortTermReturnScore(uptrend(), CFG, NOW);
    expect(up).toBeGreaterThan(0.2);
    expect(up).toBeLessThan(0.6);
    expect(shortTermReturnScore(downtrend(), CFG, NOW)).toBeLessThan(0);
  });

  it("is exactly 0 for a flat series", () => {
    expect(shortTermReturnScore(flat(), CFG, NOW)).toBe(0);
  });
});

describe("realizedVolatilityPerMin", () => {
  it("is near zero on a flat series", () => {
    const v = realizedVolatilityPerMin(flat(), CFG, NOW);
    expect(v).toBeDefined();
    expect(v as number).toBeLessThan(0.01);
  });

  it("is high on a zig-zag series", () => {
    // ±400 swings every 5s -> per-minute log-return stdev ≈ 15.7 %/min
    const v = realizedVolatilityPerMin(volatileSeries(), CFG, NOW);
    expect(v).toBeDefined();
    expect(v as number).toBeGreaterThan(10);
  });

  it("is undefined when fewer than 3 samples exist", () => {
    expect(realizedVolatilityPerMin(uptrend(2), CFG, NOW)).toBeUndefined();
  });
});

describe("bookImbalanceScore", () => {
  it("is positive for a bid-heavy book and negative for an ask-heavy one", () => {
    const bidHeavy = attachBook(uptrend(), BTC_BOOK_TIGHT);
    const askHeavy = attachBook(uptrend(), BTC_BOOK_LOPSIDED_SELL);
    expect(bookImbalanceScore(bidHeavy, CFG, NOW)).toBeGreaterThan(0);
    expect(bookImbalanceScore(askHeavy, CFG, NOW)).toBeLessThan(0);
  });

  it("ignores books older than maxBookAgeMs", () => {
    const staleBook = { ...BTC_BOOK_TIGHT, at: T0 - 60_000 };
    expect(bookImbalanceScore(attachBook(uptrend(), staleBook), CFG, NOW)).toBeUndefined();
  });

  it("is undefined without a book", () => {
    expect(bookImbalanceScore(uptrend(), CFG, NOW)).toBeUndefined();
  });
});

describe("accelerationScore", () => {
  it("is negative on a spike (late slope below early slope)", () => {
    expect(accelerationScore(spike(), CFG, NOW)).toBeLessThan(-0.5);
  });

  it("is positive on a reversal (late slope above early slope)", () => {
    expect(accelerationScore(reversal(), CFG, NOW)).toBeGreaterThan(0.5);
  });

  it("is ~0 on a steady trend", () => {
    const a = accelerationScore(uptrend(), CFG, NOW);
    expect(a).toBeDefined();
    expect(Math.abs(a as number)).toBeLessThan(0.1);
  });
});

describe("rangePositionScore", () => {
  it("is positive when price sits at the top of its recent range", () => {
    expect(rangePositionScore(uptrend(), CFG, NOW)).toBeGreaterThan(0.9);
  });

  it("is negative when price sits at the bottom", () => {
    expect(rangePositionScore(downtrend(), CFG, NOW)).toBeLessThan(-0.9);
  });

  it("is undefined for a degenerate (flat) range", () => {
    expect(rangePositionScore(flat(), CFG, NOW)).toBeUndefined();
  });
});

describe("dataFreshness", () => {
  it("classifies fresh/warn/stale against config thresholds", () => {
    expect(dataFreshness(uptrend(), CFG, NOW)).toBe("fresh");
    // newest sample at NOW is 0s old; +3s age is warn (2s..5s)
    expect(dataFreshness(uptrend(), CFG, NOW + 3_000)).toBe("warn");
    expect(dataFreshness(uptrend(), CFG, NOW + 10_000)).toBe("stale");
  });

  it("gappy series go stale as the gap exceeds maxDataAgeMs", () => {
    // gappy(30_000): cluster ends at T0+2*STEP, isolated tick at +30s.
    // Evaluate just BEFORE the isolated tick: the newest sample is 30s old.
    const h = gappy(30_000);
    const last = h.samples[h.samples.length - 1];
    const isolatedAt = last === undefined ? T0 : (last.at as unknown as number);
    expect(dataFreshness(h, CFG, isolatedAt - 1)).toBe("stale");
    expect(dataFreshness(h, CFG, isolatedAt)).toBe("fresh");
  });
});
