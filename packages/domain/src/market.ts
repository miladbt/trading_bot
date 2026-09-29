/**
 * Market-side models: Asset, Market, MarketPhase, outcome tokens, OrderBook.
 *
 * These are normalized internal representations, deliberately independent from
 * Polymarket's API DTOs. Adapters (later, in packages/market-data) will translate
 * external payloads into these models; the rest of the bot only ever sees them.
 *
 * All constructors and functions are pure (no I/O, no clock reads).
 */

import type { AssetSymbol, MarketId, MarketSlug, Millis, TokenId } from "./brand.js";
import { ValidationError } from "./errors.js";
import {
  decAdd,
  decCompare,
  decDivRound,
  decDivTrunc,
  decFromInt,
  decMulTrunc,
  decOne,
  decSub,
  decZero,
  type Decimal,
} from "./decimal.js";
import { assetSymbol, marketId, marketSlug, tokenId } from "./ids.js";
import type { Outcome } from "./types.js";

export type { Outcome };

/** A tradable base asset (BTC, ETH). Not a position — just the underlying. */
export interface Asset {
  readonly symbol: AssetSymbol;
  readonly displayName: string;
}

export function createAsset(symbol: string, displayName: string): Asset {
  return { symbol: assetSymbol(symbol), displayName: displayName.trim() };
}

/** The two binary outcomes of a 5-minute up/down market. */
export const OUTCOMES: readonly Outcome[] = ["up", "down"] as const;

export function otherOutcome(o: Outcome): Outcome {
  return o === "up" ? "down" : "up";
}

export function parseOutcome(value: string): Outcome {
  if (value === "up" || value === "down") {
    return value;
  }
  throw new ValidationError(`outcome must be "up" or "down", got "${value}"`);
}

/**
 * One side of a binary market. Binary outcome tokens pay 1 unit at settlement;
 * prices live in (0, 1) and up + down prices sum to ~1.
 */
export interface OutcomeToken {
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
}

/**
 * Lifecycle of a 5-minute market. This is the bot's normalized view; external
 * APIs may expose other states, which adapters must map into these.
 */
export type MarketPhase =
  | "announced" // listed, trading not open yet
  | "open" // trading open, oracle not yet started
  | "live" // underlying being observed for settlement
  | "settling" // awaiting settlement/oracle confirmation
  | "settled" // resolved with a winner
  | "voided"; // canceled/refunded; no winner

export const MARKET_PHASES: readonly MarketPhase[] = [
  "announced",
  "open",
  "live",
  "settling",
  "settled",
  "voided",
] as const;

/** Legal phase progression. Anything not listed here is invalid. */
const PHASE_TRANSITIONS: Readonly<Record<MarketPhase, readonly MarketPhase[]>> = {
  announced: ["open", "voided"],
  open: ["live", "voided"],
  live: ["settling", "voided"],
  settling: ["settled", "voided"],
  settled: [],
  voided: [],
};

export function canTransitionPhase(from: MarketPhase, to: MarketPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

/** Pure state transition; returns the new phase. Throws on illegal transitions. */
export function transitionPhase(from: MarketPhase, to: MarketPhase): MarketPhase {
  if (!canTransitionPhase(from, to)) {
    throw new ValidationError(`illegal market phase transition ${from} -> ${to}`);
  }
  return to;
}

/** A binary up/down market on an underlying asset with a 5-minute window. */
export interface Market {
  readonly id: MarketId;
  readonly slug: MarketSlug;
  readonly asset: AssetSymbol;
  /** Duration of the trading window in milliseconds (300_000 for 5 minutes). */
  readonly durationMs: number;
  readonly openAt: Millis;
  readonly liveAt: Millis;
  readonly settleAt: Millis;
  readonly upToken: OutcomeToken;
  readonly downToken: OutcomeToken;
  readonly phase: MarketPhase;
}

export interface CreateMarketInput {
  readonly id: string;
  readonly slug: string;
  readonly asset: string;
  readonly openAt: Millis;
  readonly liveAt: Millis;
  readonly settleAt: Millis;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly phase?: MarketPhase | undefined;
  readonly durationMs?: number | undefined;
}

export function createMarket(input: CreateMarketInput): Market {
  const id = marketId(input.id);
  const openAt = input.openAt;
  const liveAt = input.liveAt;
  const settleAt = input.settleAt;
  if (!(openAt < liveAt && liveAt < settleAt)) {
    throw new ValidationError("market timestamps must satisfy openAt < liveAt < settleAt");
  }
  const durationMs = input.durationMs ?? Number(liveAt - openAt);
  const upTokenId_ = tokenId(input.upTokenId);
  const downTokenId_ = tokenId(input.downTokenId);
  if (upTokenId_ === downTokenId_) {
    throw new ValidationError("up and down tokens must differ");
  }
  return {
    id,
    slug: marketSlug(input.slug),
    asset: assetSymbol(input.asset),
    durationMs,
    openAt,
    liveAt,
    settleAt,
    upToken: { tokenId: upTokenId_, outcome: "up" },
    downToken: { tokenId: downTokenId_, outcome: "down" },
    phase: input.phase ?? "announced",
  };
}

export function tokenForOutcome(market: Market, outcome: Outcome): OutcomeToken {
  return outcome === "up" ? market.upToken : market.downToken;
}

export function outcomeOfToken(market: Market, token: TokenId): Outcome | undefined {
  if (market.upToken.tokenId === token) return "up";
  if (market.downToken.tokenId === token) return "down";
  return undefined;
}

/** Phase implied purely by wall-clock time relative to the market window. */
export function phaseAt(market: Market, at: Millis): MarketPhase {
  if (at < market.openAt) return "announced";
  if (at < market.liveAt) return "open";
  if (at < market.settleAt) return "live";
  return "settling";
}

export function isTradable(phase: MarketPhase): boolean {
  return phase === "open" || phase === "live";
}

/** Both token ids of a market. */
export function marketTokenIds(market: Market): readonly [TokenId, TokenId] {
  return [market.upToken.tokenId, market.downToken.tokenId];
}

// ---------------------------------------------------------------------------
// OrderBook
// ---------------------------------------------------------------------------

export interface OrderBookLevel {
  readonly price: Decimal; // in (0, 1)
  readonly size: Decimal; // shares available at this price
}

export interface OrderBook {
  readonly tokenId: TokenId;
  /** Bids sorted by price descending (best first). */
  readonly bids: readonly OrderBookLevel[];
  /** Asks sorted by price ascending (best first). */
  readonly asks: readonly OrderBookLevel[];
  /** Epoch ms when this snapshot was taken. */
  readonly at: Millis;
}

export interface CreateOrderBookInput {
  readonly tokenId: string;
  readonly bids: readonly { price: Decimal; size: Decimal }[];
  readonly asks: readonly { price: Decimal; size: Decimal }[];
  readonly at: Millis;
}

function sortLevels(levels: readonly OrderBookLevel[], descending: boolean): OrderBookLevel[] {
  return [...levels].sort((a, b) => {
    const c = decCompare(a.price, b.price);
    return descending ? -c : c;
  });
}

export function createOrderBook(input: CreateOrderBookInput): OrderBook {
  for (const level of [...input.bids, ...input.asks]) {
    const p = decCompare(level.price, decZero());
    if (p <= 0 || decCompare(level.price, decOne()) >= 0) {
      throw new ValidationError("order book prices must be in (0, 1)");
    }
    if ((level.size as bigint) < 0n) {
      throw new ValidationError("order book sizes must be non-negative");
    }
  }
  return {
    tokenId: tokenId(input.tokenId),
    bids: sortLevels(input.bids, true),
    asks: sortLevels(input.asks, false),
    at: input.at,
  };
}

export function bestBid(book: OrderBook): OrderBookLevel | undefined {
  return book.bids[0];
}

export function bestAsk(book: OrderBook): OrderBookLevel | undefined {
  return book.asks[0];
}

/** Mid price of the book, or undefined when either side is empty. */
export function midPrice(book: OrderBook): Decimal | undefined {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid === undefined || ask === undefined) {
    return undefined;
  }
  // (bid + ask) / 2, rounded; 8dp scale keeps any error at 1e-8.
  return decDivRound(decAdd(bid.price, ask.price), decFromInt(2));
}

/** Spread (ask - bid), or undefined when either side is empty. */
export function spread(book: OrderBook): Decimal | undefined {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid === undefined || ask === undefined) {
    return undefined;
  }
  return decSub(ask.price, bid.price);
}

export interface BookDepthResult {
  readonly totalSize: Decimal;
  /** Volume-weighted average price of the swept levels; undefined when empty. */
  readonly vwap: Decimal | undefined;
}

/**
 * Walk the book from the best price, accumulating up to `size` shares.
 * Returns the filled size and VWAP of the swept levels.
 */
export function sweepBook(levels: readonly OrderBookLevel[], size: Decimal): BookDepthResult {
  if ((size as bigint) <= 0n) {
    return { totalSize: decZero(), vwap: undefined };
  }
  let remaining = size;
  let notional = decZero();
  let filled = decZero();
  for (const level of levels) {
    if ((remaining as bigint) === 0n) break;
    const take = decCompare(level.size, remaining) <= 0 ? level.size : remaining;
    notional = decAdd(notional, decMulTrunc(take, level.price));
    filled = decAdd(filled, take);
    remaining = decSub(remaining, take);
  }
  if ((filled as bigint) === 0n) {
    return { totalSize: decZero(), vwap: undefined };
  }
  return { totalSize: filled, vwap: decDivTrunc(notional, filled) };
}

/** Sweep the ask side: cost to buy `size` shares immediately. */
export function costToBuy(book: OrderBook, size: Decimal): BookDepthResult {
  return sweepBook(book.asks, size);
}

/** Sweep the bid side: proceeds to sell `size` shares immediately. */
export function proceedsToSell(book: OrderBook, size: Decimal): BookDepthResult {
  return sweepBook(book.bids, size);
}
