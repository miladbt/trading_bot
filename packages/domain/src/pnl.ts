/**
 * PnL: realized + unrealized profit-and-loss roll-ups.
 *
 * All amounts are Decimal USDC. Realized PnL is the sum over closed/settled
 * lots; unrealized is mark-to-market of open positions; fees are tracked
 * separately so gross vs net views stay distinguishable.
 */

import type { MarketId as MarketIdBrand, Millis } from "./brand.js";
import { ValidationError } from "./errors.js";
import { decAdd, decCompare, decSub, decZero, type Decimal } from "./decimal.js";

/** PnL components for a market, a token, or the whole account. */
export interface PnL {
  /** Cumulative realized PnL (fills + settlements), fees included. */
  readonly realized: Decimal;
  /** Mark-to-market of currently open exposure at the snapshot's marks. */
  readonly unrealized: Decimal;
  /** Cumulative fees paid. */
  readonly fees: Decimal;
}

export interface CreatePnLInput {
  readonly realized: Decimal;
  readonly unrealized: Decimal;
  readonly fees: Decimal;
}

export function createPnL(input: CreatePnLInput): PnL {
  if (decCompare(input.fees, decZero()) < 0) {
    throw new ValidationError("fees must be non-negative");
  }
  return {
    realized: input.realized,
    unrealized: input.unrealized,
    fees: input.fees,
  };
}

export function emptyPnL(): PnL {
  return { realized: decZero(), unrealized: decZero(), fees: decZero() };
}

export function addPnL(a: PnL, b: PnL): PnL {
  return {
    realized: decAdd(a.realized, b.realized),
    unrealized: decAdd(a.unrealized, b.unrealized),
    fees: decAdd(a.fees, b.fees),
  };
}

/** Net PnL = realized + unrealized (fees already embedded in realized). */
export function netPnL(pnl: PnL): Decimal {
  return decAdd(pnl.realized, pnl.unrealized);
}

/** Gross PnL before fees: net + fees. */
export function grossPnL(pnl: PnL): Decimal {
  return decAdd(netPnL(pnl), pnl.fees);
}

/** Point-in-time account snapshot used for monitoring and drawdown math. */
export interface EquitySnapshot {
  readonly at: Millis;
  readonly cash: Decimal;
  readonly positionsValue: Decimal;
  /** cash + positionsValue. */
  readonly equity: Decimal;
  readonly pnl: PnL;
}

export interface CreateEquitySnapshotInput {
  readonly at: Millis;
  readonly cash: Decimal;
  readonly positionsValue: Decimal;
  readonly pnl: PnL;
}

export function createEquitySnapshot(input: CreateEquitySnapshotInput): EquitySnapshot {
  return {
    at: input.at,
    cash: input.cash,
    positionsValue: input.positionsValue,
    equity: decAdd(input.cash, input.positionsValue),
    pnl: input.pnl,
  };
}

/**
 * Drawdown of a snapshot vs the high-water mark: negative number when below
 * the peak, zero when at/above it. Pure.
 */
export function drawdown(snapshot: EquitySnapshot, highWaterMark: Decimal): Decimal {
  if (decCompare(highWaterMark, decZero()) <= 0) {
    throw new ValidationError("high-water mark must be positive");
  }
  const dd = decSub(snapshot.equity, highWaterMark);
  return decCompare(dd, decZero()) < 0 ? dd : decZero();
}

/**
 * Update the high-water mark: returns the max of the current mark and the
 * snapshot equity.
 */
export function updateHighWaterMark(current: Decimal, snapshot: EquitySnapshot): Decimal {
  return decCompare(snapshot.equity, current) > 0 ? snapshot.equity : current;
}

/** Per-market PnL attribution row (for reports/persistence). */
export interface MarketPnLRow {
  readonly marketId: MarketIdBrand;
  readonly pnl: PnL;
}
