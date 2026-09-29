/**
 * Fixed historical fixtures: synthetic but realistic price series with known
 * shapes (uptrend, downtrend, flat, spike, reversal, volatile, stale, gappy).
 * Tests assert exact expected behavior against these — never snapshots.
 */

import { createAssetHistory, type AssetHistory, type BookTop } from "./history.js";

export const T0 = 1_800_000_000_000;
/** Sample spacing: 5 seconds. */
export const STEP = 5_000;

type Asset = "BTC" | "ETH";

function series(prices: number[], startOffset = 0) {
  return prices.map((p, i) => ({ price: p.toFixed(2), at: T0 + (startOffset + i) * STEP }));
}

function make(prices: number[], asset: Asset = "BTC"): AssetHistory {
  return createAssetHistory(asset, series(prices));
}

/** Attach a book top at the series end via the validated constructor. */
export function attachBook(
  history: AssetHistory,
  book: Omit<BookTop, "at"> & { at: number },
): AssetHistory {
  return createAssetHistory(history.asset, history.samples, book);
}

/** Steady uptrend: +10 per sample (≈ +120/min slope). */
export function uptrend(samples = 12, asset: Asset = "BTC"): AssetHistory {
  return make(
    Array.from({ length: samples }, (_, i) => 64_000 + i * 10),
    asset,
  );
}

/** Steady downtrend: -10 per sample. */
export function downtrend(samples = 12, asset: Asset = "BTC"): AssetHistory {
  return make(
    Array.from({ length: samples }, (_, i) => 64_000 - i * 10),
    asset,
  );
}

/** Flat line: no slope, degenerate range. */
export function flat(samples = 12, price = 64_000, asset: Asset = "BTC"): AssetHistory {
  return make(
    Array.from({ length: samples }, () => price),
    asset,
  );
}

/** Rising then falling: positive early slope, negative late slope. */
export function spike(asset: Asset = "BTC"): AssetHistory {
  const up = Array.from({ length: 6 }, (_, i) => 64_000 + i * 20);
  const down = Array.from({ length: 6 }, (_, i) => 64_100 - i * 20);
  return make([...up, ...down], asset);
}

/** Falling then rising (V): negative early slope, positive late slope. */
export function reversal(asset: Asset = "BTC"): AssetHistory {
  const down = Array.from({ length: 6 }, (_, i) => 64_000 - i * 20);
  const up = Array.from({ length: 6 }, (_, i) => 63_900 + i * 20);
  return make([...down, ...up], asset);
}

/** Volatile zig-zag around a flat mean: high per-minute stdev. */
export function volatileSeries(samples = 12, amplitude = 400, asset: Asset = "BTC"): AssetHistory {
  return make(
    Array.from({ length: samples }, (_, i) =>
      i % 2 === 0 ? 64_000 + amplitude : 64_000 - amplitude,
    ),
    asset,
  );
}

/**
 * Three contiguous samples, then a single isolated tick `gapMs` after the
 * cluster. At `clusterEnd + gapMs` the data age equals `gapMs` — used for
 * staleness boundary tests.
 */
export function gappy(gapMs: number, asset: Asset = "BTC"): AssetHistory {
  const cluster = [64_000, 64_010, 64_020];
  const isolated = { price: "64030.00", at: T0 + 2 * STEP + gapMs };
  return createAssetHistory(asset, [...series(cluster), isolated]);
}

export const BTC_BOOK_TIGHT = {
  bid: "64999.90",
  ask: "65000.30",
  bidSize: "10",
  askSize: "2",
  at: T0 + 11 * STEP,
};

export const BTC_BOOK_LOPSIDED_SELL = {
  bid: "64999.90",
  ask: "65000.30",
  bidSize: "1",
  askSize: "9",
  at: T0 + 11 * STEP,
};
