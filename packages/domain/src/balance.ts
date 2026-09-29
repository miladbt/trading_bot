/**
 * AccountBalance: USDC cash account view with reservation semantics.
 *
 * `reserved` tracks cash locked for open (unfilled) orders; `available` is what
 * risk can actually spend. Reserving and releasing are pure transitions and
 * preserve the invariant `reserved <= total` and `available >= 0`.
 */

import type { Millis } from "./brand.js";
import { ValidationError } from "./errors.js";
import { decAdd, decCompare, decSub, decZero, type Decimal } from "./decimal.js";

export interface AccountBalance {
  /** Total USDC in the account. */
  readonly total: Decimal;
  /** Cash locked for working orders. Always `0 <= reserved <= total`. */
  readonly reserved: Decimal;
  readonly updatedAt: Millis;
}

export interface CreateBalanceInput {
  readonly total: Decimal;
  readonly at: Millis;
}

export function createBalance(input: CreateBalanceInput): AccountBalance {
  if (decCompare(input.total, decZero()) < 0) {
    throw new ValidationError("balance total must be non-negative");
  }
  return { total: input.total, reserved: decZero(), updatedAt: input.at };
}

/** Cash that risk can allocate to new orders. */
export function available(balance: AccountBalance): Decimal {
  return decSub(balance.total, balance.reserved);
}

function touch(b: AccountBalance, at: Millis): AccountBalance {
  return { ...b, updatedAt: at };
}

/** External deposit (e.g. settlement inflow, transfer in). */
export function deposit(balance: AccountBalance, amount: Decimal, at: Millis): AccountBalance {
  if (decCompare(amount, decZero()) <= 0) {
    throw new ValidationError("deposit must be positive");
  }
  return { ...touch(balance, at), total: decAdd(balance.total, amount) };
}

/** External withdrawal. Only unreserved cash can leave. */
export function withdraw(balance: AccountBalance, amount: Decimal, at: Millis): AccountBalance {
  if (decCompare(amount, decZero()) <= 0) {
    throw new ValidationError("withdrawal must be positive");
  }
  if (decCompare(amount, available(balance)) > 0) {
    throw new ValidationError("withdrawal exceeds available balance");
  }
  return { ...touch(balance, at), total: decSub(balance.total, amount) };
}

/** Lock cash for a new order. */
export function reserve(balance: AccountBalance, amount: Decimal, at: Millis): AccountBalance {
  if (decCompare(amount, decZero()) <= 0) {
    throw new ValidationError("reserve amount must be positive");
  }
  if (decCompare(amount, available(balance)) > 0) {
    throw new ValidationError("reserve exceeds available balance");
  }
  return { ...touch(balance, at), reserved: decAdd(balance.reserved, amount) };
}

/** Release previously reserved cash (order canceled/expired/rejected). */
export function release(balance: AccountBalance, amount: Decimal, at: Millis): AccountBalance {
  if (decCompare(amount, decZero()) <= 0) {
    throw new ValidationError("release amount must be positive");
  }
  if (decCompare(amount, balance.reserved) > 0) {
    throw new ValidationError("release exceeds reserved amount");
  }
  return { ...touch(balance, at), reserved: decSub(balance.reserved, amount) };
}

/**
 * Convert a reservation into a realized cash outflow (order filled): cash
 * leaves `total` and the reservation is removed. `settled` is the actually
 * spent amount, which may be less than the reserved amount.
 */
export function settleReservation(
  balance: AccountBalance,
  reservedAmount: Decimal,
  settled: Decimal,
  at: Millis,
): AccountBalance {
  if (decCompare(settled, decZero()) < 0) {
    throw new ValidationError("settled amount must be non-negative");
  }
  if (decCompare(reservedAmount, balance.reserved) > 0) {
    throw new ValidationError("settle exceeds reserved amount");
  }
  if (decCompare(settled, reservedAmount) > 0) {
    throw new ValidationError("settled amount cannot exceed reserved amount");
  }
  return {
    ...touch(balance, at),
    total: decSub(balance.total, settled),
    reserved: decSub(balance.reserved, reservedAmount),
  };
}
