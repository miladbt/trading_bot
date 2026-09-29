/**
 * Fill: an execution report against an order. Immutable record; aggregations
 * happen in the position/inventory modules.
 */

import type { FillId, Millis, OrderId, TokenId } from "./brand.js";
import { ValidationError } from "./errors.js";
import {
  decAdd,
  decCompare,
  decMulTrunc,
  decNeg,
  decOne,
  decZero,
  type Decimal,
} from "./decimal.js";
import { fillId, orderId, tokenId } from "./ids.js";
import type { Outcome, Side } from "./types.js";

/** A single execution against an order. */
export interface Fill {
  readonly id: FillId;
  readonly orderId: OrderId;
  readonly marketId: string;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  readonly side: Side;
  readonly price: Decimal; // in (0, 1)
  readonly qty: Decimal; // shares filled, positive
  readonly fee: Decimal; // fees paid, >= 0
  readonly executedAt: Millis;
}

export interface CreateFillInput {
  readonly id: string;
  readonly orderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: Outcome;
  readonly side: Side;
  readonly price: Decimal;
  readonly qty: Decimal;
  readonly fee?: Decimal | undefined;
  readonly executedAt: Millis;
}

export function createFill(input: CreateFillInput): Fill {
  if (decCompare(input.price, decZero()) <= 0 || decCompare(input.price, decOne()) >= 0) {
    throw new ValidationError("fill price must be in (0, 1)");
  }
  if (decCompare(input.qty, decZero()) <= 0) {
    throw new ValidationError("fill qty must be positive");
  }
  const fee = input.fee ?? decZero();
  if (decCompare(fee, decZero()) < 0) {
    throw new ValidationError("fill fee must be non-negative");
  }
  return {
    id: fillId(input.id),
    orderId: orderId(input.orderId),
    marketId: input.marketId,
    tokenId: tokenId(input.tokenId),
    outcome: input.outcome,
    side: input.side,
    price: input.price,
    qty: input.qty,
    fee,
    executedAt: input.executedAt,
  };
}

/**
 * Signed cash impact of this fill on the USDC balance, excluding fees.
 * A buy removes cash; a sell adds cash. (Settlement PnL is separate.)
 */
export function fillCashImpact(fill: Fill): Decimal {
  const notional = decMulTrunc(fill.price, fill.qty);
  return fill.side === "buy" ? decNeg(notional) : notional;
}

/** Signed share impact on the token position. Buys add shares, sells subtract. */
export function fillShareImpact(fill: Fill): Decimal {
  return fill.side === "buy" ? fill.qty : decNeg(fill.qty);
}

/** Total cost (buys) or proceeds (sells) including fee. Always >= 0. */
export function fillGrossAmount(fill: Fill): Decimal {
  return decAdd(decMulTrunc(fill.price, fill.qty), fill.fee);
}
