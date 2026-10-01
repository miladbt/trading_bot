/**
 * Dataset fetcher (T10): builds a BacktestDataset from OFFICIAL public APIs.
 *
 * Sources (no credentials, read-only):
 * - Gamma API  : `GET https://gamma-api.polymarket.com/events?slug=<asset>-updown-5m-<unix5m>`
 *   → market ids, clobTokenIds, tickSize, minSize, feeSchedule (crypto_fees_v2),
 *   and the eventMetadata ground truth {priceToBeat, finalPrice} = the
 *   Chainlink BTC/USD TWAP-60s anchors (verified resolution source, T3,
 *   docs/RESOLUTION_AND_FEES.md).
 * - CLOB API   : `GET https://clob.polymarket.com/prices-history?market=<clobTokenId>&startTs=..&endTs=..&fidelity=1`
 *   → the token's recorded last-traded price path at 1-second fidelity for the
 *   window (verified empirically 2026-09-29: 5-minute windows return ~5-100
 *   points per token; see docs/probe notes in the T10 commit).
 *
 * Underlying spot: the Binance feed used in live paper mode is region-blocked
 * from this environment (HTTP 451); the dataset instead reconstructs the
 * underlying anchor series from Gamma settlement metadata — window N's
 * finalPrice equals window N+1's priceToBeat exactly (verified 2026-09-29,
 * scripts/probe-basis-approx.mjs). This is the Chainlink TWAP-60s series —
 * the market's OWN resolution source — which is a defensible underlying
 * reference (no exchange basis needs to be assumed).
 *
 * NO LOOK-AHEAD: the fetcher records everything up front, but the dataset
 * accessors (dataset.ts) expose points only at/before `now`.
 */

import type { Millis } from "@bot/domain";

import {
  isAscending,
  type BacktestDataset,
  type BacktestMarket,
  type TokenPricePoint,
} from "./dataset.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const WINDOW_MS = 300_000;

export interface FetchOptions {
  readonly assets: readonly ("BTC" | "ETH")[];
  /** Window start (epoch ms); expanded backward to a 5-minute boundary. */
  readonly windowStartMs: number;
  /** Exclusive window end (epoch ms); rounded up to a 5-minute boundary. */
  readonly windowEndMs: number;
  /** Delay between HTTP calls (ms) to stay polite to the public APIs. */
  readonly delayMs?: number | undefined;
}

export interface FetchProgress {
  (message: string): void;
}

interface GammaEvent {
  slug?: string;
  eventMetadata?: { priceToBeat?: number; finalPrice?: number };
  markets?: Array<{
    slug?: string;
    conditionId?: string;
    clobTokenIds?: string;
    orderPriceMinTickSize?: string | number;
    orderMinSize?: string | number;
    outcomePrices?: string;
    feeSchedule?: { exponent?: number; rate?: number; takerOnly?: boolean; rebateRate?: number };
    cryptoMarketConfig?: { id?: string; asset?: string; duration?: string; twapEnabled?: boolean };
  }>;
}

async function getJson<T>(url: string, _delayMs: number): Promise<T | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fetch one market's Gamma event + both tokens' price histories. */
async function fetchMarket(
  asset: "BTC" | "ETH",
  windowStartSec: number,
  delayMs: number,
  progress: FetchProgress,
): Promise<
  { market: BacktestMarket; histories: Record<string, TokenPricePoint[]> } | { skip: string }
> {
  const slug = `${asset.toLowerCase()}-updown-5m-${windowStartSec}`;
  const events = await getJson<GammaEvent[]>(`${GAMMA}/events?slug=${slug}`, delayMs);
  if (events === undefined || events.length === 0) return { skip: `${slug}: event not found` };
  const event = events[0]!;
  const gm = event.markets?.[0];
  if (gm === undefined) return { skip: `${slug}: no market` };

  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(gm.clobTokenIds ?? "[]") as string[];
  } catch {
    tokenIds = [];
  }
  if (tokenIds.length !== 2) return { skip: `${slug}: clobTokenIds unavailable` };

  const meta = event.eventMetadata;
  if (meta?.priceToBeat === undefined || meta?.finalPrice === undefined) {
    return { skip: `${slug}: settlement metadata unavailable (not yet resolved?)` };
  }

  const tickSize = Number(gm.orderPriceMinTickSize ?? 0.001);
  const minOrderSize = Number(gm.orderMinSize ?? 5);
  const feeRate = gm.feeSchedule?.rate ?? 0.07;

  // Outcome: Gamma outcomePrices [up, down]; "1" for up ⇒ Up. Ties resolve Up.
  let outcome: "UP" | "DOWN" = meta.finalPrice >= meta.priceToBeat ? "UP" : "DOWN";
  try {
    const prices = JSON.parse(gm.outcomePrices ?? "[]") as string[];
    if (prices.length === 2 && Number(prices[0]) > 0.5) outcome = "UP";
    if (prices.length === 2 && Number(prices[0]) < 0.5) outcome = "DOWN";
  } catch {
    // keep the metadata-derived outcome
  }

  const startMs = windowStartSec * 1000;
  const endMs = startMs + WINDOW_MS;
  const startSec = Math.floor(startMs / 1000) - 20;
  const endSec = Math.ceil(endMs / 1000) + 20;

  const histories: Record<string, TokenPricePoint[]> = {};
  for (const tokenId of tokenIds) {
    const history = await getJson<{ history?: { t: number; p: number }[] }>(
      `${CLOB}/prices-history?market=${tokenId}&startTs=${startSec}&endTs=${endSec}&fidelity=1`,
      delayMs,
    );
    await sleep(delayMs);
    const points = (history?.history ?? [])
      .map((h) => ({ t: h.t * 1000, p: h.p }) as TokenPricePoint)
      .filter((pt) => pt.t >= startMs && pt.t <= endMs)
      .sort((a, b) => a.t - b.t);
    histories[tokenId] = points;
  }

  const upHistory = histories[tokenIds[0]!] ?? [];
  if (upHistory.length < 3) {
    return { skip: `${slug}: price history too sparse (${upHistory.length} points)` };
  }

  const market: BacktestMarket = {
    slug,
    asset,
    startMs: startMs as Millis,
    endMs: endMs as Millis,
    upTokenId: tokenIds[0]!,
    downTokenId: tokenIds[1]!,
    tickSize,
    minOrderSize,
    takerFeeRate: feeRate,
    resolution: {
      slug,
      priceToBeat: meta.priceToBeat,
      finalPrice: meta.finalPrice,
      outcome,
    },
  };
  progress(`${slug}: ${upHistory.length}+${histories[tokenIds[1]!]?.length ?? 0} pts, ${outcome}`);
  return { market, histories };
}

/**
 * Fetch a full dataset for the given window. Deterministic content for a
 * window (the APIs are append-only for settled markets).
 */
export async function fetchDataset(
  options: FetchOptions,
  progress: FetchProgress = () => {},
): Promise<BacktestDataset> {
  const delayMs = options.delayMs ?? 150;
  const windowStartMs = Math.floor(options.windowStartMs / WINDOW_MS) * WINDOW_MS;
  const windowEndMs = Math.ceil(options.windowEndMs / WINDOW_MS) * WINDOW_MS;

  const markets: BacktestMarket[] = [];
  const tokenHistories: Record<string, { tokenId: string; points: readonly TokenPricePoint[] }> =
    {};
  const underlying: Record<"BTC" | "ETH", { asset: "BTC" | "ETH"; points: TokenPricePoint[] }> = {
    BTC: { asset: "BTC", points: [] },
    ETH: { asset: "ETH", points: [] },
  };
  const skipped: { slug: string; reason: string }[] = [];
  const caveats: string[] = [];

  for (const asset of options.assets) {
    const anchors: TokenPricePoint[] = [];
    for (let t = Math.floor(windowStartMs / 1000); t < windowEndMs / 1000; t += WINDOW_MS / 1000) {
      const result = await fetchMarket(asset, t, delayMs, progress);
      await sleep(delayMs);
      if ("skip" in result) {
        skipped.push({ slug: `${asset.toLowerCase()}-updown-5m-${t}`, reason: result.skip });
        continue;
      }
      markets.push(result.market);
      anchors.push({ t: result.market.startMs, p: result.market.resolution.priceToBeat });
      for (const [tokenId, points] of Object.entries(result.histories)) {
        if (points.length === 0) continue;
        tokenHistories[tokenId] = { tokenId, points };
      }
    }
    // Underlying anchor series: the strike chain (window N+1's priceToBeat is
    // window N's finalPrice — exact Chainlink continuity, verified 2026-09-29).
    underlying[asset] = { asset, points: anchors };
  }

  // Down-sample the underlying to a 5-minute resolution the signal can use.
  if (markets.length === 0) {
    caveats.push(
      "no markets fetched: the window predates available history or the API shape changed",
    );
  }
  caveats.push(
    "token histories are LAST-TRADED price paths (CLOB prices-history), not full order-book depth; the runner derives a conservative synthetic top-of-book (ask = last + half tick)",
  );
  caveats.push(
    "the underlying signal series is the Chainlink TWAP-60s anchor chain (the market's own resolution source), sampled every 5 minutes; it is coarser than the live Binance feed and makes the signal slower/blunter than production",
  );
  caveats.push(
    "historical fills use derived books, so queue position is approximate by construction (T4 parameters still applied)",
  );

  const dataset: BacktestDataset = {
    schema: 1,
    provenance: {
      fetchedAt: new Date().toISOString(),
      windowStartMs: windowStartMs as Millis,
      windowEndMs: windowEndMs as Millis,
      assets: options.assets,
      marketCount: markets.length,
      skipped,
      sources: [
        "https://gamma-api.polymarket.com/events?slug=<asset>-updown-5m-<unix5m> (market config, clobTokenIds, feeSchedule, eventMetadata settlement ground truth)",
        "https://clob.polymarket.com/prices-history?market=<clobTokenId>&startTs=..&endTs=..&fidelity=1 (recorded token price paths)",
      ],
      caveats,
    },
    markets,
    tokenHistories,
    underlying,
  };

  // Self-check: histories must be strictly time-ascending.
  for (const history of Object.values(tokenHistories)) {
    if (!isAscending(history.points)) {
      throw new Error(`dataset fetch produced non-ascending history for ${history.tokenId}`);
    }
  }
  return dataset;
}
