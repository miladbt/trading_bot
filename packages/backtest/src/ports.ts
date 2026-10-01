/**
 * Dataset-backed `OrchestratorPorts` (T10): feeds the REAL orchestrator
 * pipeline from a recorded dataset with an injected clock. The adapter
 * exposes, at time `now`, only observations with timestamp <= `now`
 * (look-ahead-safe by construction) and only markets whose window is still
 * tradable.
 */

import { decFromString, millis, type Decimal, type Millis } from "@bot/domain";
import type { AssetSymbol } from "@bot/domain";
import {
  tokenPriceAt,
  type BacktestDataset,
  type BacktestMarket,
  type TokenHistory,
} from "./dataset.js";
import type {
  AccountSnapshot,
  DiscoveredMarket,
  MarketDataSnapshot,
  OrchestratorLot,
  OrchestratorPorts,
  SpotSample,
} from "@bot/orchestrator";

const BTC = "BTC" as unknown as AssetSymbol;

/** Book state at a time: derived from the last two observations (a spread). */
interface BookTop {
  readonly ask: number;
  readonly bid: number;
}

/**
 * Derive a conservative synthetic top-of-book from the token's last-traded
 * series: ask = last + halfTick (you must pay up to hit), bid = last (you
 * would sell into the print). With tickSize 0.001 this makes the executable
 * ask one half-tick above the last price — deliberately conservative.
 */
function topOfBook(history: TokenHistory, now: Millis, tickSize: number): BookTop | undefined {
  const last = tokenPriceAt(history, now);
  if (last === undefined) return undefined;
  const halfTick = tickSize / 2;
  const ask = Math.min(0.999, last + halfTick);
  const bid = Math.max(0.001, last - halfTick);
  return { ask, bid };
}

export interface BacktestAdapterState {
  /** Fills the adapter reported so far (updated by the runner each tick). */
  lots: Map<string, { up: readonly OrchestratorLot[]; down: readonly OrchestratorLot[] }>;
  deployed: Decimal;
  dailyLoss: Decimal;
  marketLoss: Map<string, Decimal>;
}

export function createBacktestPorts(
  dataset: BacktestDataset,
  state: BacktestAdapterState,
): OrchestratorPorts {
  const marketsBySlug = new Map<string, BacktestMarket>(dataset.markets.map((m) => [m.slug, m]));

  function discoverMarkets(now: Millis): readonly DiscoveredMarket[] {
    // A market is discoverable while it is tradable: now < endMs. Windows are
    // sequential; the synthetic feed keeps the current window per asset alive.
    const out: DiscoveredMarket[] = [];
    for (const asset of dataset.provenance.assets) {
      const windowMs = 300_000;
      // The window that is live at  (its 5-minute bucket start).
      const startMs = Math.floor(Number(now) / windowMs) * windowMs;
      const slug = `${asset.toLowerCase()}-updown-5m-${Math.floor(startMs / 1000)}`;
      const market = marketsBySlug.get(slug);
      if (market === undefined) continue;
      if (Number(now) >= Number(market.endMs)) continue;
      out.push({
        marketId: market.slug,
        tokenIdUp: market.upTokenId,
        tokenIdDown: market.downTokenId,
        asset: asset === "BTC" ? BTC : (asset as unknown as AssetSymbol),
        startMs: millis(market.startMs),
        endMs: millis(market.endMs),
      });
    }
    return out;
  }

  // The orchestrator's ports interface takes (market) only for marketData, so
  // the current time must be carried by the runner: it rebuilds the adapter
  // per tick with `now` bound. This factory keeps `now` in a mutable box.
  const clock = { now: millis(0) };

  function dataFor(market: DiscoveredMarket, now: Millis): MarketDataSnapshot | undefined {
    const bm = marketsBySlug.get(market.marketId);
    if (bm === undefined) return undefined;
    const up = dataset.tokenHistories[bm.upTokenId];
    const down = dataset.tokenHistories[bm.downTokenId];
    if (up === undefined || down === undefined) return undefined;
    const upTop = topOfBook(up, now, bm.tickSize);
    const downTop = topOfBook(down, now, bm.tickSize);
    if (upTop === undefined || downTop === undefined) return undefined;
    return {
      marketId: market.marketId,
      upAsk: decFromString(upTop.ask.toFixed(8)),
      downAsk: decFromString(downTop.ask.toFixed(8)),
      ageMs: 100,
      underlyingAgeMs: 100,
      apiHealth: "healthy" as const,
      wsHealth: "healthy" as const,
    };
  }

  function spotSamples(asset: AssetSymbol): readonly SpotSample[] {
    const series = dataset.underlying[String(asset) as "BTC" | "ETH"];
    if (series === undefined) return [];
    // Only anchors at or before the current clock (no look-ahead).
    return series.points
      .filter((p) => p.t <= clock.now)
      .slice(-5)
      .map((p) => ({ price: p.p.toFixed(2), at: p.t }));
  }

  return {
    discoverMarkets: (now: Millis) => {
      clock.now = now;
      return discoverMarkets(now);
    },
    marketData: (market: DiscoveredMarket) => dataFor(market, clock.now),
    spotSamples,
    account: (): AccountSnapshot => ({
      openOrderCount: 0,
      totalCapitalDeployed: state.deployed,
      marketCapitalByMarket: Object.fromEntries(state.marketLoss),
      directionalExposureAfter: decFromString("0"),
      dailyLossUsdc: state.dailyLoss,
      marketLossByMarket: Object.fromEntries(state.marketLoss),
      reconciliation: "reconciled" as const,
    }),
    lots: (marketId: string) => state.lots.get(marketId) ?? { up: [], down: [] },
  };
}
