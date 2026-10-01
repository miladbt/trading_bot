/**
 * Backtest dataset (T10): the time-ordered event stream the harness replays.
 *
 * A dataset is produced by `fetch-dataset.ts` (official public APIs: Gamma +
 * CLOB prices-history) or `recorder.ts` (live book/trade/spot capture), and
 * persisted as JSON so runs are reproducible.
 *
 * NO LOOK-AHEAD CONTRACT: the harness consumes datasets only through
 * `eventsUpTo(now)`; events carry `availableAt` (when the data became
 * observable) separately from any event-time, and settlement outcomes are
 * exposed ONLY after the market's settle time. Nothing may read ahead.
 */

import type { Millis } from "@bot/domain";

/** One price point of a token's recorded history (CLOB prices-history row). */
export interface TokenPricePoint {
  /** Observation time, epoch ms (the CLOB API returns seconds; converted). */
  readonly t: Millis;
  /** Last/traded price of the token in [0, 1]. */
  readonly p: number;
}

/** Resolution ground truth for one market (Gamma settlement metadata). */
export interface MarketResolution {
  readonly slug: string;
  /** Chainlink TWAP at the window open (the strike / priceToBeat). */
  readonly priceToBeat: number;
  /** Chainlink TWAP at the window end (settlement reference). */
  readonly finalPrice: number;
  /** "UP" when finalPrice >= priceToBeat (ties resolve Up), else "DOWN". */
  readonly outcome: "UP" | "DOWN";
}

/** A single 5-minute market to replay. */
export interface BacktestMarket {
  /** Polymarket slug, e.g. btc-updown-5m-1790604000 (also the id). */
  readonly slug: string;
  readonly asset: "BTC" | "ETH";
  /** Window open, epoch ms. The window is [startMs, startMs + 300_000). */
  readonly startMs: Millis;
  readonly endMs: Millis;
  readonly upTokenId: string;
  readonly downTokenId: string;
  /** Market contract config (Gamma-verified values). */
  readonly tickSize: number;
  readonly minOrderSize: number;
  /** Taker fee schedule from Gamma `feeSchedule` (crypto_fees_v2). */
  readonly takerFeeRate: number;
  readonly resolution: MarketResolution;
}

/** A recorded price path for one token: last-traded price observations. */
export interface TokenHistory {
  readonly tokenId: string;
  /** Time-ordered, strictly ascending observation times. */
  readonly points: readonly TokenPricePoint[];
}

/** One asset's underlying reference series (spot, for the signal engine). */
export interface UnderlyingSeries {
  readonly asset: "BTC" | "ETH";
  /**
   * Time-ordered anchor points (epoch ms, exact TWAP prices at window
   * boundaries from Gamma settlement metadata; see fetch-dataset.ts).
   */
  readonly points: readonly TokenPricePoint[];
}

/** The complete, immutable replay dataset. */
export interface BacktestDataset {
  /** Dataset format version (bump on breaking shape changes). */
  readonly schema: 1;
  /** Provenance block (sources, retrieval time, counts, gaps). */
  readonly provenance: {
    readonly fetchedAt: string;
    readonly windowStartMs: Millis;
    readonly windowEndMs: Millis;
    readonly assets: readonly ("BTC" | "ETH")[];
    readonly marketCount: number;
    /** Markets skipped and why (e.g. missing price history). */
    readonly skipped: readonly { readonly slug: string; readonly reason: string }[];
    readonly sources: readonly string[];
    /** Known data-quality caveats (recorded verbatim in reports). */
    readonly caveats: readonly string[];
  };
  readonly markets: readonly BacktestMarket[];
  /** Token histories keyed by tokenId. */
  readonly tokenHistories: Readonly<Record<string, TokenHistory>>;
  /** Underlying anchor series per asset. */
  readonly underlying: Readonly<Record<"BTC" | "ETH", UnderlyingSeries>>;
}

// ---------------------------------------------------------------------------
// Look-ahead-safe accessors (the ONLY way the harness reads a dataset)
// ---------------------------------------------------------------------------

/** Price of a token at `now`: the last observation at or before `now`. */
export function tokenPriceAt(history: TokenHistory, now: Millis): number | undefined {
  let result: number | undefined;
  for (const point of history.points) {
    if (point.t > now) break;
    result = point.p;
  }
  return result;
}

/** Underlying anchor price at `now` (last anchor at or before `now`). */
export function underlyingAt(series: UnderlyingSeries, now: Millis): number | undefined {
  let result: number | undefined;
  for (const point of series.points) {
    if (point.t > now) break;
    result = point.p;
  }
  return result;
}

/** Strictly time-ordered, strictly ascending point list (validation helper). */
export function isAscending(points: readonly TokenPricePoint[]): boolean {
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.t <= points[i - 1]!.t) return false;
  }
  return true;
}
