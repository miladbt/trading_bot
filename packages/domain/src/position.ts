/**
 * Position: net holding of one outcome token, tracked with average cost.
 *
 * The position is immutable data; `applyFill` is the single state-transition
 * function and preserves the invariant that a position never goes negative.
 * Selling is only possible against existing (or simultaneous) buys, which the
 * inventory layer enforces across fills; here a sell that would overdraw throws.
 */

import type { MarketId as MarketIdBrand, Millis, PositionId, TokenId } from "./brand.js";
import { InvalidTransitionError, ValidationError } from "./errors.js";
import {
  decAdd,
  decCompare,
  decDivRound,
  decIsZero,
  decMulRound,
  decSub,
  decZero,
  type Decimal,
} from "./decimal.js";
import { positionId } from "./ids.js";
import type { Outcome } from "./types.js";

/**
 * A net position in one outcome token.
 *
 * Invariants:
 * - `qty >= 0` (long-only per outcome; shorts are modeled as the opposite token)
 * - when `qty == 0`, `avgPrice == 0`
 * - `realizedPnl` is the cumulative realized PnL for this position id
 */
export interface Position {
  readonly id: PositionId;
  readonly marketId: MarketIdBrand;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  readonly qty: Decimal;
  readonly avgPrice: Decimal;
  readonly realizedPnl: Decimal;
  readonly openedAt: Millis;
  readonly updatedAt: Millis;
}

export interface CreatePositionInput {
  readonly id: string;
  readonly marketId: MarketIdBrand;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  readonly openedAt: Millis;
}

export function createPosition(input: CreatePositionInput): Position {
  return {
    id: positionId(input.id),
    marketId: input.marketId,
    tokenId: input.tokenId,
    outcome: input.outcome,
    qty: decZero(),
    avgPrice: decZero(),
    realizedPnl: decZero(),
    openedAt: input.openedAt,
    updatedAt: input.openedAt,
  };
}

/**
 * Apply a fill to a position. Buys increase qty and move the average cost;
 * sells reduce qty, realize PnL, and may close the position. Pure: returns a
 * new Position. Throws on overdraw (selling more than held) or foreign fills.
 */
export function applyFill(
  pos: Position,
  fill: {
    readonly side: "buy" | "sell";
    readonly price: Decimal;
    readonly qty: Decimal;
    readonly fee?: Decimal;
  },
  at: Millis,
): Position {
  if (decCompare(fill.qty, decZero()) <= 0) {
    throw new ValidationError("fill qty must be positive");
  }
  if (fill.side === "buy") {
    const newQty = decAdd(pos.qty, fill.qty);
    // avg = (qty*avg + buyQty*buyPrice + fee) / newQty, rounded at 8dp
    const existingCost = decMulRound(pos.qty, pos.avgPrice);
    const buyCost = decAdd(decMulRound(fill.qty, fill.price), fill.fee ?? decZero());
    const newAvg = decDivRound(decAdd(existingCost, buyCost), newQty);
    return { ...pos, qty: newQty, avgPrice: newAvg, updatedAt: at };
  }
  // sell
  if (decCompare(fill.qty, pos.qty) > 0) {
    throw new InvalidTransitionError(`qty=${pos.qty}`, "negative", "position qty");
  }
  if (decIsZero(pos.qty)) {
    throw new InvalidTransitionError("flat", "sell", "position");
  }
  const realized = decSub(decMulRound(fill.qty, fill.price), decMulRound(fill.qty, pos.avgPrice));
  const newQty = decSub(pos.qty, fill.qty);
  return {
    ...pos,
    qty: newQty,
    avgPrice: decIsZero(newQty) ? decZero() : pos.avgPrice,
    realizedPnl: decAdd(pos.realizedPnl, realized),
    updatedAt: at,
  };
}

/** Unrealized PnL at a mark price. Zero when the position is flat. */
export function unrealizedPnl(pos: Position, markPrice: Decimal): Decimal {
  if (decIsZero(pos.qty)) {
    return decZero();
  }
  const marketValue = decMulRound(pos.qty, markPrice);
  const cost = decMulRound(pos.qty, pos.avgPrice);
  return decSub(marketValue, cost);
}

/** Market value of the position at a mark price. */
export function marketValue(pos: Position, markPrice: Decimal): Decimal {
  return decMulRound(pos.qty, markPrice);
}

/** Cost basis of the current open quantity. */
export function costBasis(pos: Position): Decimal {
  return decMulRound(pos.qty, pos.avgPrice);
}
