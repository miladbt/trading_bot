/**
 * CompleteSet: a matched pair of up + down tokens for the same market.
 *
 * A complete set always settles to exactly 1 USDC (the winning token pays 1,
 * the losing token pays 0). This underpins two mechanics:
 * - minting: pay 1 USDC, receive 1 up + 1 down (splitting collateral)
 * - merging: return 1 up + 1 down, receive 1 USDC (riskless exit at parity)
 *
 * These pure helpers encode the arbitrage bounds: buying both sides must cost
 * ~1, selling both must yield ~1; deviations are riskless (before fees).
 */

import type { MarketId as MarketIdBrand } from "./brand.js";
import { ValidationError } from "./errors.js";
import {
  decAdd,
  decCompare,
  decMulRound,
  decOne,
  decSub,
  decZero,
  type Decimal,
} from "./decimal.js";
import type { Outcome } from "./types.js";

export interface CompleteSetLeg {
  readonly outcome: Outcome;
  readonly tokenId: string;
  readonly price: Decimal; // best available price for this leg
}

export interface CompleteSet {
  readonly marketId: MarketIdBrand;
  readonly up: CompleteSetLeg;
  readonly down: CompleteSetLeg;
}

export interface CreateCompleteSetInput {
  readonly marketId: MarketIdBrand;
  readonly upTokenId: string;
  readonly upPrice: Decimal;
  readonly downTokenId: string;
  readonly downPrice: Decimal;
}

export function createCompleteSet(input: CreateCompleteSetInput): CompleteSet {
  if (decCompare(input.upPrice, decZero()) <= 0 || decCompare(input.downPrice, decZero()) <= 0) {
    throw new ValidationError("complete set leg prices must be positive");
  }
  return {
    marketId: input.marketId,
    up: { outcome: "up", tokenId: input.upTokenId, price: input.upPrice },
    down: { outcome: "down", tokenId: input.downTokenId, price: input.downPrice },
  };
}

/** Cost of buying one complete set (1 up + 1 down). Should be ~1. */
export function setCost(set: CompleteSet): Decimal {
  return decAdd(set.up.price, set.down.price);
}

/** Proceeds of selling one complete set. Should be ~1. */
export function setProceeds(set: CompleteSet): Decimal {
  return setCost(set);
}

/**
 * Riskless profit per set bought both sides and merged: 1 - (up + down).
 * Positive when the combined ask is below parity (buy both, merge, keep delta).
 */
export function mergeProfit(set: CompleteSet): Decimal {
  return decSub(decOne(), setCost(set));
}

/**
 * Riskless profit per set minted and sold both sides: (up + down) - 1.
 * Positive when the combined bid is above parity (mint, sell both).
 */
export function mintProfit(set: CompleteSet): Decimal {
  return decSub(setCost(set), decOne());
}

/** True when buying both sides is profitable after per-set fees. */
export function isMergeArb(set: CompleteSet, feePerSet: Decimal): boolean {
  return decCompare(mergeProfit(set), feePerSet) > 0;
}

/** True when minting and selling both sides is profitable after per-set fees. */
export function isMintArb(set: CompleteSet, feePerSet: Decimal): boolean {
  return decCompare(mintProfit(set), feePerSet) > 0;
}

/** Payout of a set at settlement for a given winning outcome. */
export function setPayoutAtSettlement(
  _set: CompleteSet,
  winningOutcome: Outcome,
  shares: Decimal,
): Decimal {
  return winningOutcome === "up" ? decMulRound(shares, decOne()) : decZero();
}
