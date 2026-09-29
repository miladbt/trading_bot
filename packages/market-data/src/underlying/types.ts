/**
 * Underlying (spot) market data for BTCUSDT / ETHUSDT.
 *
 * Purpose: a normalized, exchange-agnostic feed for **signal generation only**.
 * The strategy consumes `UnderlyingMarketDataProvider`; it never touches an
 * exchange SDK. This package never places orders (nothing here can: there is
 * no order API, no credentials, and no keys anywhere in this file).
 */

import type { Millis } from "@bot/domain";

/** Underlying symbols supported by this subsystem. */
export type UnderlyingSymbol = "BTCUSDT" | "ETHUSDT";

export const UNDERLYING_SYMBOLS: readonly UnderlyingSymbol[] = ["BTCUSDT", "ETHUSDT"] as const;

export function isUnderlyingSymbol(value: string): value is UnderlyingSymbol {
  return value === "BTCUSDT" || value === "ETHUSDT";
}

/** A single normalized tick: the venue's last traded price. */
export interface UnderlyingLastPrice {
  readonly symbol: UnderlyingSymbol;
  readonly price: string; // decimal string, exact
  readonly timestamp: Millis;
}

/** Best bid/ask snapshot. */
export interface UnderlyingBookTop {
  readonly symbol: UnderlyingSymbol;
  readonly bid: string | undefined;
  readonly ask: string | undefined;
  readonly timestamp: Millis;
}

/** 24h rolling stats, where the venue provides them. */
export interface UnderlyingVolume {
  readonly symbol: UnderlyingSymbol;
  readonly baseVolume: string | undefined; // e.g. BTC
  readonly quoteVolume: string | undefined; // e.g. USDT
  readonly timestamp: Millis;
}

/** Full normalized view maintained by the provider. */
export interface UnderlyingMarketSnapshot {
  readonly symbol: UnderlyingSymbol;
  readonly lastPrice: string | undefined;
  readonly bid: string | undefined;
  readonly ask: string | undefined;
  /** ask - bid as a decimal string; undefined until both sides exist. */
  readonly spread: string | undefined;
  readonly baseVolume: string | undefined;
  readonly quoteVolume: string | undefined;
  /** Newest event timestamp folded into this snapshot. */
  readonly timestamp: Millis;
  /** Provider-side receive time of the newest event. */
  readonly receivedAt: Millis;
  /** True when the provider considers this data too old to use. */
  readonly stale: boolean;
  /** Ms since the newest event, at evaluation time. */
  readonly ageMs: number;
}

/** Connection lifecycle, reported by the provider. */
export type ConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "failed";

/**
 * The seam the strategy programs against. Implementations may wrap any venue
 * (Binance, a stub, a recorder); nothing here mentions an exchange.
 */
export interface UnderlyingMarketDataProvider {
  start(): void;
  stop(): void;
  /** Latest normalized view; undefined before the first event. */
  snapshot(symbol: UnderlyingSymbol): UnderlyingMarketSnapshot | undefined;
  /** Newest event timestamp for the symbol, or undefined. */
  lastEventAt(symbol: UnderlyingSymbol): Millis | undefined;
  /** Ms since the newest event (Infinity when none), at evaluation time. */
  freshnessMs(symbol: UnderlyingSymbol, now: Millis): number;
  status(): ConnectionStatus;
  onEvent(
    listener: (symbol: UnderlyingSymbol, snapshot: UnderlyingMarketSnapshot) => void,
  ): () => void;
  onStatusChange(listener: (status: ConnectionStatus, detail?: string) => void): () => void;
}
