/**
 * AcquisitionLot: one buy-side acquisition of a single outcome token.
 *
 * Lot-level tracking (instead of net positions) is what lets the complete-set
 * engine attribute every matched set to the exact fills that paid for it,
 * including each lot's own fee and rebate. Lots are immutable data; matching
 * consumption happens purely in `complete-set-engine.ts`, which returns
 * residual lots instead of mutating anything.
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decIsNegative,
  decMulRound,
  decSub,
  decZero,
  millis,
  type Decimal,
  type MarketId,
  type Millis,
  type Outcome,
  type TokenId,
} from "@bot/domain";

export interface AcquisitionLot {
  /** Caller-chosen unique id (e.g. the originating fill id). */
  readonly lotId: string;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  /** Shares held in this lot (> 0). Matching consumes this quantity. */
  readonly qty: Decimal;
  /** Average price paid per share for this lot (> 0). */
  readonly pricePerUnit: Decimal;
  /** Total fee paid to acquire this lot (USDC, >= 0). */
  readonly fee: Decimal;
  /** Total rebate received for this lot, e.g. maker rewards (USDC, >= 0). */
  readonly rebate: Decimal;
  /** UTC acquisition instant; the engine matches FIFO by this. */
  readonly acquiredAt: Millis;
}

export interface CreateAcquisitionLotInput {
  readonly lotId: string;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  readonly qty: Decimal;
  readonly pricePerUnit: Decimal;
  readonly fee?: Decimal | undefined;
  readonly rebate?: Decimal | undefined;
  readonly acquiredAt: Millis;
}

/** Validated smart constructor for an acquisition lot. */
export function createAcquisitionLot(input: CreateAcquisitionLotInput): AcquisitionLot {
  const lotId = input.lotId.trim();
  if (lotId.length === 0) {
    throw new ValidationError("lot id must be a non-empty string");
  }
  if (input.outcome !== "up" && input.outcome !== "down") {
    throw new ValidationError(`lot outcome must be "up" or "down", got ${String(input.outcome)}`);
  }
  if (decCompare(input.qty, decZero()) <= 0) {
    throw new ValidationError(`lot "${lotId}" qty must be positive`);
  }
  if (decCompare(input.pricePerUnit, decZero()) <= 0) {
    throw new ValidationError(`lot "${lotId}" price per unit must be positive`);
  }
  if (decIsNegative(input.fee ?? decZero())) {
    throw new ValidationError(`lot "${lotId}" fee must be non-negative`);
  }
  if (decIsNegative(input.rebate ?? decZero())) {
    throw new ValidationError(`lot "${lotId}" rebate must be non-negative`);
  }
  return {
    lotId,
    marketId: input.marketId,
    tokenId: input.tokenId,
    outcome: input.outcome,
    qty: input.qty,
    pricePerUnit: input.pricePerUnit,
    fee: input.fee ?? decZero(),
    rebate: input.rebate ?? decZero(),
    acquiredAt: millis(input.acquiredAt),
  };
}

/** Gross cost of the whole lot: pricePerUnit * qty. */
export function lotGrossCost(lot: AcquisitionLot): Decimal {
  return decMulRound(lot.pricePerUnit, lot.qty);
}

/** Net cost of the whole lot: gross cost + fees - rebates. */
export function lotNetCost(lot: AcquisitionLot): Decimal {
  return decSub(decAdd(lotGrossCost(lot), lot.fee), lot.rebate);
}
