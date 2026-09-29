/**
 * Adapter-internal types for Polymarket market discovery.
 *
 * These are normalized intermediate representations between the Gamma API DTOs
 * and the domain `Market` model. Nothing here is Polymarket-shaped beyond what
 * the DTO accessors already flattened away.
 */

import type { AssetSymbol, Market, MarketId, Millis } from "@bot/domain";

/** Coarse lifecycle state of a discovered market. */
export type MarketStatus = "active" | "closed" | "expired";

/**
 * Immutable, venue-verified metadata: fields that are fixed at market creation
 * (ids, token pair, time window). Safe to cache indefinitely and reuse across
 * discovery cycles; never mutated by later observations.
 */
export interface ImmutableMarketMeta {
  /** Venue market id (Gamma numeric id string). */
  readonly marketId: MarketId;
  /** On-chain condition id, when the venue provides one. */
  readonly conditionId: string | undefined;
  /** Up-outcome CLOB token id. */
  readonly upTokenId: string;
  /** Down-outcome CLOB token id. */
  readonly downTokenId: string;
  readonly slug: string;
  /** Branded asset symbol; discovery guarantees BTC or ETH. */
  readonly asset: AssetSymbol;
  readonly openAt: Millis;
  readonly liveAt: Millis;
  readonly settleAt: Millis;
}

/**
 * Resolution metadata as reported by the venue. The adapter never interprets
 * the outcome and never assumes any particular oracle; `oracleSource` is
 * recorded verbatim (undefined when the venue does not say).
 */
export interface ResolutionMetadata {
  /** Venue-reported winner, when the market has resolved. */
  readonly winningOutcome: "up" | "down" | "voided" | undefined;
  /** Venue-reported resolution source, verbatim. Never inferred. */
  readonly oracleSource: string | undefined;
  /** Epoch ms when the venue marked the market resolved, if reported. */
  readonly resolvedAt: Millis | undefined;
}

/**
 * Fully normalized result of discovering one external market: the domain model
 * plus the venue-only extras the domain model deliberately does not carry.
 */
export interface DiscoveredMarket {
  readonly market: Market;
  readonly conditionId: string | undefined;
  readonly status: MarketStatus;
  readonly resolution: ResolutionMetadata;
  /** Epoch ms when this record was produced from venue data. */
  readonly discoveredAt: Millis;
}

/** One raw market record from the venue, as the transport received it. */
export interface RawMarketRecord {
  readonly payload: unknown;
  /** Epoch ms when the record was fetched. */
  readonly fetchedAt: Millis;
}

/** Why a raw record could not be normalized. */
export type ParseFailureReason =
  | "not_an_object"
  | "missing_id"
  | "missing_tokens"
  | "invalid_tokens"
  | "invalid_timing"
  | "invalid_shape";

export interface ParseFailure {
  readonly reason: ParseFailureReason;
  readonly detail: string;
}

/**
 * Policy knobs for discovery. Phase boundaries come from config; the defaults
 * here are only fallbacks for standalone usage.
 */
export interface DiscoveryPolicy {
  /** Nominal cycle length in ms (300_000 for 5-minute markets). */
  readonly cycleMs: number;
  /** Open -> live offset in ms. */
  readonly liveOffsetMs: number;
  /** Open -> settle offset in ms. */
  readonly settleOffsetMs: number;
  /** Reject markets whose derived duration deviates more than this fraction. */
  readonly durationTolerancePct: number;
  /** Reject markets that ended more than this long ago (ms). */
  readonly maxAgeMs: number;
}

export const DEFAULT_DISCOVERY_POLICY: DiscoveryPolicy = {
  cycleMs: 300_000,
  liveOffsetMs: 240_000,
  settleOffsetMs: 300_000,
  durationTolerancePct: 0.25,
  maxAgeMs: 3_600_000,
} as const;

export function isBtcOrEth(value: string): value is "BTC" | "ETH" {
  return value === "BTC" || value === "ETH";
}
