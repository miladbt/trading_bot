/**
 * Pure, deterministic simulated order book for the paper adapter.
 *
 * The book is configured (not discovered): resting levels are provided as
 * plain data and matching is a pure function of (order, book). Determinism is
 * total — no random, no clock, no network — so tests can script exact fill
 * sequences: partial fills, full fills, post-only rejection, and level-by-level
 * sweeps.
 *
 * Matching model (buy side; sell is symmetric):
 * - The book holds resting asks `[price, qty]` sorted ascending (best first).
 * - A buy crosses when its limit price >= the best ask. Post-only orders that
 *   would cross are rejected instead (they must rest).
 * - A crossing limit buy sweeps levels while `price >= level.price`, taking
 *   `min(remaining, level.qty)` per level; the remainder rests.
 * - Market orders sweep up to their price cap and never rest.
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decDivRound,
  decMulRound,
  decSub,
  decZero,
  type Decimal,
} from "@bot/domain";

/** One resting level: price per share and total resting quantity at it. */
export interface BookLevel {
  readonly price: Decimal;
  readonly qty: Decimal;
}

/** A two-sided simulated book snapshot. Asks: ascending; bids: descending. */
export interface SimulatedBook {
  readonly asks: readonly BookLevel[];
  readonly bids: readonly BookLevel[];
}

/** How one incoming order interacted with the book. */
export interface MatchOutcome {
  /** Quantity filled immediately by sweeping the book. */
  readonly filledQty: Decimal;
  /** Quantity remaining to rest on the book (limit orders only). */
  readonly restingQty: Decimal;
  /** Average price across the swept levels (weighted by taken qty). */
  readonly avgFillPrice: Decimal;
  /** Level-by-level detail, in sweep order. */
  readonly takes: readonly { readonly price: Decimal; readonly qty: Decimal }[];
  /** True when a post-only order would have crossed (→ reject). */
  readonly postOnlyCrossed: boolean;
}

function assertLevels(levels: readonly BookLevel[], ascending: boolean, side: string): void {
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    if (decCompare(level.price, decZero()) <= 0 || decCompare(level.qty, decZero()) <= 0) {
      throw new ValidationError(`simulated book ${side} levels must have positive price and qty`);
    }
    if (i > 0) {
      const prev = levels[i - 1]!.price;
      const cmp = decCompare(prev, level.price);
      if (ascending ? cmp > 0 : cmp < 0) {
        throw new ValidationError(
          `simulated book ${side} levels must be sorted ${ascending ? "ascending" : "descending"}`,
        );
      }
    }
  }
}

export function createSimulatedBook(
  asks: readonly BookLevel[],
  bids: readonly BookLevel[] = [],
): SimulatedBook {
  assertLevels(asks, true, "ask");
  assertLevels(bids, false, "bid");
  return { asks, bids };
}

/** Total quantity resting on one side of the book. */
export function bookDepth(book: SimulatedBook, side: "asks" | "bids"): Decimal {
  let total = decZero();
  for (const level of book[side]) {
    total = decAdd(total, level.qty);
  }
  return total;
}

/**
 * Match an incoming limit/market order against the book. Pure.
 *
 * - `postOnly` + would-cross → `postOnlyCrossed: true`, nothing fills.
 * - Market orders sweep everything up to their price cap and never rest.
 * - Limit orders sweep what they cross and rest the remainder.
 */
export function matchAgainstBook(
  order: {
    readonly side: "buy" | "sell";
    readonly kind: "limit" | "market";
    readonly price: Decimal;
    readonly qty: Decimal;
    readonly postOnly: boolean;
  },
  book: SimulatedBook,
): MatchOutcome {
  if (decCompare(order.qty, decZero()) <= 0) {
    throw new ValidationError("match qty must be positive");
  }

  // The contra side we sweep: asks for buys (ascending), bids for sells
  // (descending — best bid first).
  const levels = order.side === "buy" ? book.asks : book.bids;
  const crosses = (levelPrice: Decimal): boolean =>
    order.side === "buy"
      ? decCompare(order.price, levelPrice) >= 0
      : decCompare(order.price, levelPrice) <= 0;

  const best = levels[0];
  const wouldCross = best !== undefined && crosses(best.price);
  if (order.postOnly && wouldCross) {
    return {
      filledQty: decZero(),
      restingQty: order.qty,
      avgFillPrice: decZero(),
      takes: [],
      postOnlyCrossed: true,
    };
  }

  let remaining = order.qty;
  let cost = decZero();
  let filled = decZero();
  const takes: { price: Decimal; qty: Decimal }[] = [];
  for (const level of levels) {
    if (decCompare(remaining, decZero()) === 0) break;
    if (!crosses(level.price)) break;
    const take = decCompare(remaining, level.qty) <= 0 ? remaining : level.qty;
    takes.push({ price: level.price, qty: take });
    cost = decAdd(cost, decMulRound(level.price, take));
    filled = decAdd(filled, take);
    remaining = decSub(remaining, take);
  }

  const avgFillPrice = takes.length === 0 ? decZero() : decDivRound(cost, filled);

  // Market orders never rest: unfilled remainder is abandoned (marketable-limit
  // semantics — the cap price bounds what the order will pay/receive).
  const restingQty = order.kind === "market" ? decZero() : remaining;

  return { filledQty: filled, restingQty, avgFillPrice, takes, postOnlyCrossed: false };
}
