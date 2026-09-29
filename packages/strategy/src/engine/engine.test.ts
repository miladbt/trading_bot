import { describe, expect, it } from "vitest";

import { millis } from "@bot/domain";

import { computeAssetSignal, computeSignals, confidenceTier, type AssetSignal } from "./engine.js";
import { DEFAULT_SIGNAL_ENGINE_CONFIG as CFG, type SignalEngineConfig } from "./config.js";
import { createAssetHistory } from "./history.js";
import {
  BTC_BOOK_TIGHT,
  STEP,
  T0,
  attachBook,
  downtrend,
  flat,
  gappy,
  uptrend,
  volatileSeries,
} from "./fixtures.js";

const NOW = millis(T0 + 11 * STEP);

describe("computeAssetSignal — shape and contract", () => {
  it("returns the normalized signal fields for BTC and ETH", () => {
    const btc = computeAssetSignal(uptrend(), CFG, NOW);
    expect(btc.asset).toBe("BTC");
    expect(btc.timestamp).toBe(NOW);
    expect(btc.direction).toBeGreaterThan(0);
    expect(btc.direction).toBeLessThanOrEqual(1);
    expect(btc.confidence).toBeGreaterThanOrEqual(0);
    expect(btc.confidence).toBeLessThanOrEqual(1);
    expect(["quiet", "normal", "volatile", "data-starved"]).toContain(btc.regime);
    expect(btc.metrics.components["momentum"]).toBeDefined();

    const eth = computeAssetSignal(downtrend(12, "ETH"), CFG, NOW);
    expect(eth.asset).toBe("ETH");
    expect(eth.direction).toBeLessThan(0);
  });

  it("is deterministic: same inputs, same outputs", () => {
    expect(computeAssetSignal(uptrend(), CFG, NOW)).toEqual(
      computeAssetSignal(uptrend(), CFG, NOW),
    );
    expect(computeAssetSignal(reversalSeries(), CFG, NOW)).toEqual(
      computeAssetSignal(reversalSeries(), CFG, NOW),
    );
  });
});

// helper: shapeful reversal series for the determinism test
function reversalSeries() {
  const down = Array.from({ length: 6 }, (_, i) => 64_000 - i * 20);
  const up = Array.from({ length: 6 }, (_, i) => 63_900 + i * 20);
  return createAssetHistory(
    "BTC",
    [...down, ...up].map((p, i) => ({ price: p.toFixed(2), at: T0 + i * STEP })),
  );
}

describe("computeAssetSignal — direction semantics", () => {
  it("maps uptrends to positive and downtrends to negative direction", () => {
    expect(computeAssetSignal(uptrend(), CFG, NOW).direction).toBeGreaterThan(0.5);
    expect(computeAssetSignal(downtrend(), CFG, NOW).direction).toBeLessThan(-0.5);
  });

  it("is near zero on a flat series (no invented direction)", () => {
    const s = computeAssetSignal(flat(), CFG, NOW);
    expect(Math.abs(s.direction)).toBeLessThan(0.05);
    expect(s.confidence).toBeLessThanOrEqual(CFG.weakScoreThreshold);
  });

  it("respects the configured weights: momentum alone reproduces its score", () => {
    const config: SignalEngineConfig = {
      ...CFG,
      weights: {
        momentum: 1,
        shortTermReturn: 0,
        acceleration: 0,
        bookImbalance: 0,
        rangePosition: 0,
      },
    };
    const s = computeAssetSignal(uptrend(), config, NOW);
    expect(s.direction).toBeCloseTo(Math.tanh(120 / CFG.momentumSlopeCapPerMin), 6);
  });

  it("book imbalance pulls direction when book data is attached", () => {
    const without = computeAssetSignal(uptrend(), CFG, NOW);
    const withB = computeAssetSignal(attachBook(uptrend(), BTC_BOOK_TIGHT), CFG, NOW);
    // bid-heavy book adds upward pressure
    expect(withB.direction).toBeGreaterThan(without.direction);
    expect(withB.metrics.components["bookImbalance"]).toBeDefined();
  });
});

describe("computeAssetSignal — regime classification", () => {
  it("classifies a zig-zag series as volatile", () => {
    const s = computeAssetSignal(volatileSeries(), CFG, NOW);
    expect(s.regime).toBe("volatile");
    expect(s.metrics.volatilityPerMin).toBeGreaterThan(CFG.volatileRegimeThreshold);
  });

  it("classifies a steady series as quiet or normal", () => {
    const s = computeAssetSignal(uptrend(), CFG, NOW);
    expect(["quiet", "normal"]).toContain(s.regime);
  });
});

describe("computeAssetSignal — data honesty", () => {
  it("returns data-starved with zero confidence for stale data", () => {
    const h = gappy(30_000);
    const isolatedAt = h.samples[h.samples.length - 1]?.at as unknown as number;
    // evaluate just before the isolated tick: newest data is 30s old
    const s = computeAssetSignal(h, CFG, millis(isolatedAt - 1));
    expect(s.regime).toBe("data-starved");
    expect(s.confidence).toBe(0);
    expect(s.direction).toBe(0);
    expect(s.metrics.freshness).toBe("stale");
  });

  it("returns data-starved when fewer than minSamples exist", () => {
    const s = computeAssetSignal(uptrend(3), CFG, NOW);
    expect(s.regime).toBe("data-starved");
    expect(s.confidence).toBe(0);
  });

  it("reduces confidence when components are missing (no book attached)", () => {
    const noBook = computeAssetSignal(uptrend(), CFG, NOW);
    const withB = computeAssetSignal(attachBook(uptrend(), BTC_BOOK_TIGHT), CFG, NOW);
    expect(withB.confidence).toBeGreaterThan(noBook.confidence);
  });

  it("warn-level freshness discounts confidence but not direction", () => {
    const fresh = computeAssetSignal(uptrend(), CFG, NOW);
    const warned = computeAssetSignal(uptrend(), CFG, millis(T0 + 11 * STEP + 3_000));
    expect(warned.metrics.freshness).toBe("warn");
    expect(warned.confidence).toBeLessThan(fresh.confidence);
    expect(warned.direction).toBe(fresh.direction);
  });
});

describe("confidenceTier", () => {
  it("maps confidence to tiers", () => {
    expect(confidenceTier(0, CFG)).toBe("untrustworthy");
    expect(confidenceTier(0.01, CFG)).toBe("weak");
    expect(confidenceTier(0.3, CFG)).toBe("moderate");
    expect(confidenceTier(0.9, CFG)).toBe("strong");
  });
});

describe("computeSignals", () => {
  it("fans out over assets preserving order", () => {
    const out = computeSignals([uptrend(), downtrend(12, "ETH")], CFG, NOW);
    expect(out).toHaveLength(2);
    expect(out[0]?.asset).toBe("BTC");
    expect(out[1]?.asset).toBe("ETH");
    expect((out[0] as AssetSignal).direction).toBeGreaterThan(0);
    expect((out[1] as AssetSignal).direction).toBeLessThan(0);
  });
});

describe("no execution coupling", () => {
  it("signals carry no order fields", () => {
    const s = computeAssetSignal(uptrend(), CFG, NOW);
    expect(Object.keys(s).sort()).toEqual([
      "asset",
      "confidence",
      "direction",
      "metrics",
      "regime",
      "timestamp",
    ]);
  });
});
