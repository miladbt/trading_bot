/**
 * Order model and lifecycle.
 *
 * The lifecycle is a small state machine with pure transition functions; the
 * `status` field is the single source of truth and all transitions are
 * validated. Nothing here talks to an exchange — orders are data plus rules.
 */

import type { Millis, OrderId, TokenId } from "./brand.js";
import { ValidationError } from "./errors.js";
import {
  decAdd,
  decCompare,
  decMulTrunc,
  decOne,
  decSub,
  decZero,
  type Decimal,
} from "./decimal.js";
import { orderId, tokenId } from "./ids.js";
import type { Side } from "./types.js";

/** Who triggers execution. */
export type OrderKind = "market" | "limit";

/** Order lifecycle. */
export type OrderStatus =
  "pending" | "open" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired";

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending",
  "open",
  "partially_filled",
  "filled",
  "canceled",
  "rejected",
  "expired",
] as const;

/** Legal status transitions. */
const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ["open", "rejected", "expired", "canceled"],
  open: ["partially_filled", "filled", "canceled", "expired", "rejected"],
  partially_filled: ["partially_filled", "filled", "canceled", "expired"],
  filled: [],
  canceled: [],
  rejected: [],
  expired: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Active statuses: the order may still trade. */
export function isWorkingStatus(s: OrderStatus): boolean {
  return s === "pending" || s === "open" || s === "partially_filled";
}

/** Terminal statuses: no further transitions allowed. */
export function isTerminalStatus(s: OrderStatus): boolean {
  return s === "filled" || s === "canceled" || s === "rejected" || s === "expired";
}

export interface Order {
  readonly id: OrderId;
  /** Cross-reference to the parent market (raw string to avoid import cycles). */
  readonly marketId: string;
  readonly tokenId: TokenId;
  readonly side: Side;
  readonly kind: OrderKind;
  /** Limit price in (0, 1); for market orders this is the price cap. */
  readonly price: Decimal;
  /** Target size in shares, always positive. */
  readonly quantity: Decimal;
  readonly filledQty: Decimal;
  readonly status: OrderStatus;
  readonly createdAt: Millis;
  readonly updatedAt: Millis;
}

export interface CreateOrderInput {
  readonly id: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: Side;
  readonly kind: OrderKind;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly createdAt: Millis;
}

export function createOrder(input: CreateOrderInput): Order {
  if (decCompare(input.quantity, decZero()) <= 0) {
    throw new ValidationError("order quantity must be positive");
  }
  if (decCompare(input.price, decZero()) <= 0 || decCompare(input.price, decOne()) >= 0) {
    throw new ValidationError("order price must be in (0, 1)");
  }
  return {
    id: orderId(input.id),
    marketId: input.marketId,
    tokenId: tokenId(input.tokenId),
    side: input.side,
    kind: input.kind,
    price: input.price,
    quantity: input.quantity,
    filledQty: decZero(),
    status: "pending",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Pure transition: returns a new Order in status `to`, or throws. */
export function transitionOrder(order: Order, to: OrderStatus, at: Millis): Order {
  if (!canTransitionOrder(order.status, to)) {
    throw new ValidationError(`illegal order status transition ${order.status} -> ${to}`);
  }
  if (to === "filled" && decCompare(order.filledQty, order.quantity) < 0) {
    throw new ValidationError("cannot mark filled before filledQty reaches quantity");
  }
  return { ...order, status: to, updatedAt: at };
}

/** Pure update: increase cumulative filled quantity; may move to filled. */
export function applyFillToOrder(order: Order, fillQty: Decimal, at: Millis): Order {
  if (decCompare(fillQty, decZero()) <= 0) {
    throw new ValidationError("fill quantity must be positive");
  }
  if (!isWorkingStatus(order.status)) {
    throw new ValidationError(`cannot fill an order in status ${order.status}`);
  }
  const newFilled = decAdd(order.filledQty, fillQty);
  const cmp = decCompare(newFilled, order.quantity);
  if (cmp > 0) {
    throw new ValidationError("fill would overfill the order");
  }
  const status: OrderStatus = cmp === 0 ? "filled" : "partially_filled";
  return { ...order, filledQty: newFilled, status, updatedAt: at };
}

/** Remaining quantity to fill; zero for non-working orders. */
export function remainingQty(order: Order): Decimal {
  return isWorkingStatus(order.status) ? decSub(order.quantity, order.filledQty) : decZero();
}

/** Notional value of `qty` at the order's limit price: price * qty. */
export function orderNotional(order: Order, qty: Decimal): Decimal {
  return decMulTrunc(order.price, qty);
}
