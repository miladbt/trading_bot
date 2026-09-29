/**
 * Inventory: the aggregate root over cash and open positions.
 *
 * Immutable data + pure transition functions. It enforces portfolio-level
 * invariants:
 * - no negative positions (a sell must be covered by held shares)
 * - cash never goes negative on a buy (available-balance gating is risk's job,
 *   but the raw accounting here stays sign-correct)
 * - per-market roll-ups: up/down quantities and net exposure
 */

import type { MarketId as MarketIdBrand, Millis, TokenId } from "./brand.js";
import { InvalidTransitionError, ValidationError } from "./errors.js";
import {
  decAdd,
  decCompare,
  decIsZero,
  decMulRound,
  decNeg,
  decSub,
  decZero,
  type Decimal,
} from "./decimal.js";
import type { Outcome } from "./types.js";
import {
  applyFill as applyFillToPosition,
  createPosition,
  unrealizedPnl as positionUnrealizedPnl,
  type Position,
} from "./position.js";

export interface InventoryPositionKey {
  readonly marketId: MarketIdBrand;
  readonly tokenId: TokenId;
}

/** Key a position by market+token. */
export function positionKey(marketId: MarketIdBrand, tokenId: TokenId): string {
  return `${marketId}:${tokenId}`;
}

export interface Inventory {
  /** USDC cash available for trading (excludes funds locked in open positions). */
  readonly cash: Decimal;
  /** Positions keyed by `marketId:tokenId`. */
  readonly positions: Readonly<Record<string, Position>>;
  readonly updatedAt: Millis;
}

export interface CreateInventoryInput {
  readonly cash: Decimal;
  readonly at: Millis;
}

export function createInventory(input: CreateInventoryInput): Inventory {
  if (decCompare(input.cash, decZero()) < 0) {
    throw new ValidationError("inventory cash must be non-negative");
  }
  return { cash: input.cash, positions: {}, updatedAt: input.at };
}

export function findPosition(
  inv: Inventory,
  marketId: MarketIdBrand,
  tokenId: TokenId,
): Position | undefined {
  return inv.positions[positionKey(marketId, tokenId)];
}

export function openPositions(inv: Inventory): readonly Position[] {
  return Object.values(inv.positions).filter((p) => !decIsZero(p.qty));
}

export function hasPositionFor(inv: Inventory, marketId: MarketIdBrand, tokenId: TokenId): boolean {
  const p = findPosition(inv, marketId, tokenId);
  return p !== undefined && !decIsZero(p.qty);
}

function withPosition(inv: Inventory, pos: Position, at: Millis): Inventory {
  return {
    ...inv,
    cash: inv.cash,
    positions: { ...inv.positions, [positionKey(pos.marketId, pos.tokenId)]: pos },
    updatedAt: at,
  };
}

/**
 * Apply a fill to the inventory: updates the position and the cash balance.
 * - buy:  cash -= price*qty + fee ; shares += qty
 * - sell: cash += price*qty - fee ; shares -= qty (must be covered)
 * Pure: returns a new Inventory. Throws on overdraw or insufficient cash.
 */
export function applyFill(
  inv: Inventory,
  fill: {
    readonly marketId: MarketIdBrand;
    readonly tokenId: TokenId;
    readonly outcome: Outcome;
    readonly side: "buy" | "sell";
    readonly price: Decimal;
    readonly qty: Decimal;
    readonly fee?: Decimal;
  },
  at: Millis,
): Inventory {
  if (decCompare(fill.qty, decZero()) <= 0) {
    throw new ValidationError("fill qty must be positive");
  }
  const key = positionKey(fill.marketId, fill.tokenId);
  const existing =
    inv.positions[key] ??
    createPosition({
      id: `pos-${fill.marketId}-${fill.tokenId}`,
      marketId: fill.marketId,
      tokenId: fill.tokenId,
      outcome: fill.outcome,
      openedAt: at,
    });

  if (fill.side === "buy") {
    const cost = decAdd(decMulRound(fill.qty, fill.price), fill.fee ?? decZero());
    if (decCompare(cost, inv.cash) > 0) {
      throw new ValidationError("buy exceeds available cash");
    }
    const newPos = applyFillToPosition(existing, fill, at);
    return {
      ...withPosition(inv, newPos, at),
      cash: decSub(inv.cash, cost),
    };
  }

  // sell: shares must exist
  if (decCompare(existing.qty, fill.qty) < 0) {
    throw new InvalidTransitionError(`qty=${existing.qty}`, "negative", "position qty");
  }
  const proceeds = decSub(decMulRound(fill.qty, fill.price), fill.fee ?? decZero());
  const newPos = applyFillToPosition(existing, fill, at);
  return {
    ...withPosition(inv, newPos, at),
    cash: decAdd(inv.cash, proceeds),
  };
}

/**
 * Settle a market: the winning token pays `payoutPerShare` (normally 1) per
 * share, the losing token pays 0 and is removed. Pure.
 */
export function settleMarket(
  inv: Inventory,
  marketId: MarketIdBrand,
  winningTokenId: TokenId,
  payoutPerShare: Decimal,
  at: Millis,
): Inventory {
  let next = inv;
  const keys = Object.keys(inv.positions).filter((k) => k.startsWith(`${marketId}:`));
  for (const k of keys) {
    const pos = inv.positions[k];
    if (pos === undefined || decIsZero(pos.qty)) continue;
    const isWinner = pos.tokenId === winningTokenId;
    if (isWinner) {
      const payout = decMulRound(pos.qty, payoutPerShare);
      const realized = decSub(payout, decMulRound(pos.qty, pos.avgPrice));
      const settled: Position = {
        ...pos,
        qty: decZero(),
        avgPrice: decZero(),
        realizedPnl: decAdd(pos.realizedPnl, realized),
        updatedAt: at,
      };
      next = {
        ...withPosition(next, settled, at),
        cash: decAdd(next.cash, payout),
      };
    } else {
      const losing: Position = {
        ...pos,
        qty: decZero(),
        avgPrice: decZero(),
        realizedPnl: decAdd(pos.realizedPnl, decNeg(decMulRound(pos.qty, pos.avgPrice))),
        updatedAt: at,
      };
      next = withPosition(next, losing, at);
    }
  }
  return next;
}

/** Total unrealized PnL across open positions at their mark prices. */
export function totalUnrealizedPnl(
  inv: Inventory,
  markPrices: Readonly<Record<string, Decimal>>,
): Decimal {
  let total = decZero();
  for (const pos of openPositions(inv)) {
    const mark = markPrices[positionKey(pos.marketId, pos.tokenId)];
    if (mark !== undefined) {
      total = decAdd(total, positionUnrealizedPnl(pos, mark));
    }
  }
  return total;
}

/** Total realized PnL across all tracked positions. */
export function totalRealizedPnl(inv: Inventory): Decimal {
  let total = decZero();
  for (const pos of Object.values(inv.positions)) {
    total = decAdd(total, pos.realizedPnl);
  }
  return total;
}

/** Sum of market value of open positions at their mark prices. */
export function positionsMarketValue(
  inv: Inventory,
  markPrices: Readonly<Record<string, Decimal>>,
): Decimal {
  let total = decZero();
  for (const pos of openPositions(inv)) {
    const mark = markPrices[positionKey(pos.marketId, pos.tokenId)];
    if (mark !== undefined) {
      total = decAdd(total, decMulRound(pos.qty, mark));
    }
  }
  return total;
}

/** Cash + market value of open positions. */
export function totalEquity(
  inv: Inventory,
  markPrices: Readonly<Record<string, Decimal>>,
): Decimal {
  return decAdd(inv.cash, positionsMarketValue(inv, markPrices));
}

/**
 * Net exposure per market: value of up position minus value of down position at
 * mark prices. Positive = long up; negative = long down; zero = hedged/flat.
 */
export function marketExposure(
  inv: Inventory,
  marketId: MarketIdBrand,
  markPrices: Readonly<Record<string, Decimal>>,
): Decimal {
  let up = decZero();
  let down = decZero();
  for (const pos of openPositions(inv)) {
    if (pos.marketId !== marketId) continue;
    const mark = markPrices[positionKey(pos.marketId, pos.tokenId)];
    if (mark === undefined) continue;
    const value = decMulRound(pos.qty, mark);
    if (pos.outcome === "up") {
      up = decAdd(up, value);
    } else {
      down = decAdd(down, value);
    }
  }
  return decSub(up, down);
}

// re-exports for ergonomic imports from the package root
export type { Position } from "./position.js";
export { createPosition } from "./position.js";
