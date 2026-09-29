/**
 * Binance spot WebSocket adapter pieces.
 *
 * Isolated here so the rest of the subsystem stays exchange-agnostic: the
 * provider (underlying-provider.ts) depends only on `WebSocketLike`, and the
 * strategy only ever sees `UnderlyingMarketDataProvider`.
 *
 * Endpoint: wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker
 * Payload (combined stream): { stream, data: { c, b, a, q, v, E } } where
 * c = last price, b = best bid, a = best ask, q = 24h quote volume,
 * v = 24h base volume, E = event time (venue clock, ms).
 */

import { isUnderlyingSymbol, type UnderlyingSymbol } from "./types.js";

/** Minimal async socket surface the provider needs; mockable in tests. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: ((event: CloseEventLike) => void) | null;
  onerror: ((event: ErrorEventLike) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Loose event shapes: `exactOptionalPropertyTypes`-compatible both ways. */
export interface CloseEventLike {
  readonly code?: number;
  readonly reason?: string;
}

export interface ErrorEventLike {
  readonly message?: string;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const BINANCE_WS_HOST = "wss://stream.binance.com:9443";

/** Build the combined-stream URL for the given symbols. */
export function binanceStreamUrl(
  symbols: readonly UnderlyingSymbol[],
  host: string = BINANCE_WS_HOST,
): string {
  const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join("/");
  return `${host}/stream?streams=${streams}`;
}

/** Parse a combined-stream message into { stream, data }, or undefined. */
export function parseCombinedStream(
  raw: unknown,
): { stream: string; data: Record<string, unknown> } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const stream = obj["stream"];
  const data = obj["data"];
  if (typeof stream !== "string" || typeof data !== "object" || data === null) {
    return undefined;
  }
  return { stream, data: data as Record<string, unknown> };
}

/** Symbol from a stream name like "btcusdt@ticker"; undefined if unsupported. */
export function streamSymbol(stream: string): UnderlyingSymbol | undefined {
  const name = stream.split("@")[0]?.toUpperCase();
  if (name === undefined) return undefined;
  return isUnderlyingSymbol(name) ? name : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface NormalizedTicker {
  readonly symbol: UnderlyingSymbol;
  readonly lastPrice: string;
  readonly bid: string | undefined;
  readonly ask: string | undefined;
  readonly baseVolume: string | undefined;
  readonly quoteVolume: string | undefined;
  /** Venue event time. */
  readonly eventTime: number;
}

/** Fields from the Binance 24h ticker payload; all strings, all optional-safe. */
export function normalizeTicker(data: Record<string, unknown>): NormalizedTicker | undefined {
  const symbolRaw = str(data["s"]);
  if (symbolRaw === undefined) return undefined;
  const symbolUpper = symbolRaw.toUpperCase();
  if (!isUnderlyingSymbol(symbolUpper)) return undefined;
  const lastPrice = str(data["c"]);
  if (lastPrice === undefined) return undefined;
  const eventTime = data["E"];
  return {
    symbol: symbolUpper,
    lastPrice,
    bid: str(data["b"]),
    ask: str(data["a"]),
    baseVolume: str(data["v"]),
    quoteVolume: str(data["q"]),
    eventTime: typeof eventTime === "number" ? eventTime : Number.NaN,
  };
}

/**
 * True when an event is out of order relative to the last seen venue time:
 * strictly older events are rejected; equal timestamps re-apply (idempotent
 * refresh of the same tick), strictly newer apply.
 */
export function isOutOfOrder(eventTime: number, lastEventTime: number | undefined): boolean {
  if (lastEventTime === undefined) return false;
  if (Number.isNaN(eventTime)) return false; // caller decides; treat as not-OOO
  return eventTime < lastEventTime;
}
