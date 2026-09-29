/**
 * Orchestrator ports: the seams between the orchestrator and the world.
 *
 * Everything the pipeline needs from outside arrives through these small
 * interfaces, so integration tests can drive the full pipeline with in-memory
 * mocks and the real adapters can be added later without touching the
 * orchestrator. No port method performs network I/O inside the orchestrator —
 * implementations own that (and the paper-mode stack never needs it).
 */

import type { AssetSymbol, Decimal, Millis } from "@bot/domain";

/** One tradable 5-minute up/down market. */
export interface DiscoveredMarket {
  readonly marketId: string;
  readonly tokenIdUp: string;
  readonly tokenIdDown: string;
  /** Underlying asset the market tracks ("BTC" | "ETH" brands). */
  readonly asset: AssetSymbol;
  /** Cycle open (UTC ms). */
  readonly startMs: Millis;
  /** Cycle close (UTC ms) — settlement instant. */
  readonly endMs: Millis;
}

/** Health/freshness snapshot for one market's data. */
export interface MarketDataSnapshot {
  readonly marketId: string;
  /** Executable ask per share for the up and down tokens. */
  readonly upAsk: Decimal;
  readonly downAsk: Decimal;
  /** Age of this market-data snapshot, ms. */
  readonly ageMs: number;
  /** Age of the underlying spot feed data, ms. */
  readonly underlyingAgeMs: number;
  /** Venue-facing health of the market-data feed. */
  readonly apiHealth: "healthy" | "degraded" | "unhealthy" | undefined;
  /** Health of the underlying (spot) WebSocket feed. */
  readonly wsHealth: "healthy" | "degraded" | "unhealthy" | undefined;
}

/** Spot price of an underlying at a point in time. */
export interface SpotSample {
  readonly price: string;
  readonly at: Millis;
}

/** Account-level inputs the risk engine needs (aggregated by the caller). */
export interface AccountSnapshot {
  /** Number of orders currently working across the account. */
  readonly openOrderCount: number;
  /** Total capital deployed across all markets (USDC). */
  readonly totalCapitalDeployed: Decimal;
  /** Capital deployed in each market, keyed by marketId. */
  readonly marketCapitalByMarket: Readonly<Record<string, Decimal>>;
  /** Signed directional exposure per asset after the intended order (USDC). */
  readonly directionalExposureAfter: Decimal;
  /** Realized + unrealized loss today (positive number, USDC). */
  readonly dailyLossUsdc: Decimal;
  /** Realized + unrealized loss for each market, keyed by marketId (positive). */
  readonly marketLossByMarket: Readonly<Record<string, Decimal>>;
  /** Whether the account books are reconciled. */
  readonly reconciliation: "reconciled" | "unreconciled" | undefined;
}

/**
 * Per-market inventory + intended-order context the orchestrator assembles
 * before consulting the RiskEngine.
 */
export interface MarketRiskContext {
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly qty: Decimal;
  readonly price: Decimal;
  /** Acquisition lots held for this market (both sides). */
  readonly upLots: readonly OrchestratorLot[];
  readonly downLots: readonly OrchestratorLot[];
  /** Leftover one-sided inventory per side, in shares. */
  readonly residualShares: Decimal;
  /** Unhedged orphan inventory for this market (USDC at mark). */
  readonly orphanInventoryUsdc: Decimal;
}

/** Acquisition-lot shape the orchestrator passes through (see @bot/inventory). */
export interface OrchestratorLot {
  readonly lotId: string;
  readonly qty: Decimal;
  readonly pricePerUnit: Decimal;
  readonly fee: Decimal;
  readonly rebate: Decimal;
  readonly acquiredAt: Millis;
  readonly outcome: "up" | "down";
}

/** Latest spot samples for an underlying, time-ascending (empty when cold). */
export interface SpotSample {
  readonly price: string;
  readonly at: Millis;
}

/** The full external view the orchestrator needs for one tick. */
export interface OrchestratorPorts {
  /** Discovery: which 5-minute markets are currently tradable. */
  discoverMarkets(now: Millis): readonly DiscoveredMarket[];
  /** Market data snapshot for one market (undefined when unavailable). */
  marketData(market: DiscoveredMarket): MarketDataSnapshot | undefined;
  /** Recent spot samples for an underlying, time-ascending (may be empty). */
  spotSamples(asset: AssetSymbol): readonly SpotSample[];
  /** Account state snapshot (aggregated by the adapter layer). */
  account(): AccountSnapshot;
  /** Acquisition lots currently held, keyed by marketId. */
  lots(marketId: string): {
    readonly up: readonly OrchestratorLot[];
    readonly down: readonly OrchestratorLot[];
  };
}
