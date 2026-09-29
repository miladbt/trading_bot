/**
 * Polymarket taker-fee model (crypto category).
 *
 * Verified facts (full citations in docs/RESOLUTION_AND_FEES.md):
 * - Official docs, https://docs.polymarket.com/trading/fees (retrieved
 *   2026-09-29): fee = C × feeRate × p × (1 − p); takers only; "Makers are
 *   never charged fees. Only takers pay fees."; Crypto taker fee rate = 0.07.
 * - Gamma API per-market `feeSchedule` on a settled 5-minute BTC event
 *   (retrieved 2026-09-29): { exponent: 1, rate: 0.07, takerOnly: true,
 *   rebateRate: 0.2 }, feeType "crypto_fees_v2".
 * - Docs: fees are rounded to 5 decimal places; smallest charged fee is
 *   0.00001 USDC.
 *
 * Pure Decimal arithmetic only (BigInt, 8 dp). No floats, no I/O, no clocks.
 */

import {
  decAdd,
  decFromString,
  decMulRound,
  decSub,
  decToString,
  type Decimal,
} from "./decimal.js";
import { ValidationError } from "./errors.js";

/**
 * Default crypto taker fee rate (docs table, retrieved 2026-09-29).
 * UNVERIFIED over time: live markets must be read from the Gamma
 * `feeSchedule.rate` per market; this default is config-overridable.
 */
export const DEFAULT_CRYPTO_TAKER_FEE_RATE = "0.07";

/** Fees round to 5 decimal places (docs); implemented via 8-dp truncation-free round. */
export const FEE_MIN_CHARGED = "0.00001";

/** Compute the per-share taker fee at price p: feeRate × p × (1 − p). */
export function takerFeePerShare(price: Decimal, feeRate: Decimal): Decimal {
  if (isInvalidPrice(price)) {
    throw new ValidationError(`price must be in (0, 1), got ${decToString(price)}`);
  }
  if ((feeRate as bigint) < 0n) {
    throw new ValidationError(`feeRate must be non-negative, got ${decToString(feeRate)}`);
  }
  const complement = decSub(decFromString("1"), price);
  return decMulRound(feeRate, decMulRound(price, complement));
}

/**
 * Taker fee for a filled quantity at an average price p:
 * qty × feeRate × p × (1 − p), rounded half-away-from-zero at 8 dp.
 * (Per-share fee × qty; matches the docs formula C × feeRate × p × (1 − p)
 * up to deterministic 8-dp rounding of intermediate products.)
 */
export function takerFeeQty(qty: Decimal, price: Decimal, feeRate: Decimal): Decimal {
  if ((qty as bigint) < 0n) {
    throw new ValidationError(`qty must be non-negative, got ${decToString(qty)}`);
  }
  return decMulRound(qty, takerFeePerShare(price, feeRate));
}

/**
 * Effective edge after taker fees for buying at executable ask `ask` with a
 * model probability `pWin` that the token settles at 1: pWin − (ask + fee).
 */
export function edgeNetOfTakerFee(pWin: Decimal, ask: Decimal, feeRate: Decimal): Decimal {
  const fee = takerFeePerShare(ask, feeRate);
  const cost = decAdd(ask, fee);
  return decSub(pWin, cost) as Decimal;
}

function isInvalidPrice(price: Decimal): boolean {
  const v = price as bigint;
  return v <= 0n || v >= 100_000_000n; // (0, 1) exclusive at 8 dp
}
