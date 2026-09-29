/**
 * ExecutionAdapter: the port implemented by every execution backend.
 *
 * `PaperExecutionAdapter` implements it now; a future Polymarket live adapter
 * would implement the exact same interface. Callers depend on this interface,
 * never on a concrete adapter, and never submit anything themselves — the
 * factory is the only place that decides which backend a mode maps to, and it
 * is fail-closed for live.
 */

import type { Decimal, Millis } from "@bot/domain";

import type { ExecutionStatus } from "./lifecycle.js";

/** The intent to place one order. Data only. */
export interface ExecutionOrderRequest {
  /** Caller-chosen client order id (must be unique per adapter instance). */
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly kind: "limit" | "market";
  /** Limit price per share in (0, 1) — also the cap for market orders. */
  readonly price: Decimal;
  /** Size in shares, > 0. */
  readonly qty: Decimal;
  /** Wall-clock instant of the request (injected; adapters never read clocks). */
  readonly at: Millis;
}

/** One execution fill against an adapter order. */
export interface ExecutionFill {
  readonly clientOrderId: string;
  readonly qty: Decimal;
  /** Executed price per share (equals the resting order price for limit orders). */
  readonly price: Decimal;
  /** Fee charged for this fill (USDC). */
  readonly fee: Decimal;
  /** Simulated time the fill occurred (injected). */
  readonly at: Millis;
}

/** Immutable snapshot of one adapter order. */
export interface ExecutionOrder {
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly kind: "limit" | "market";
  readonly price: Decimal;
  readonly qty: Decimal;
  readonly filledQty: Decimal;
  readonly status: ExecutionStatus;
  readonly createdAt: Millis;
  readonly updatedAt: Millis;
  readonly fills: readonly ExecutionFill[];
  /** Cumulative fees paid across fills. */
  readonly totalFees: Decimal;
  /** Why the order was rejected (REJECTED only). */
  readonly rejectReason: string | undefined;
  /** Why a cancel request failed (CANCEL_REQUESTED only). */
  readonly cancelFailureReason: string | undefined;
}

/** Result of submit/cancel calls. */
export interface ExecutionResult {
  readonly ok: boolean;
  readonly clientOrderId: string;
  /** Stable machine-parseable reason when `ok` is false. */
  readonly reason: string;
}

/** The port: the only way callers interact with any execution backend. */
export interface ExecutionAdapter {
  /** Submit a new order. Validation happens at the adapter boundary. */
  submit(req: ExecutionOrderRequest): ExecutionResult;
  /** Request cancellation of a working order. */
  cancel(clientOrderId: string, at: Millis): ExecutionResult;
  /** Snapshot of one order (or undefined if unknown). */
  getOrder(clientOrderId: string): ExecutionOrder | undefined;
  /** All orders known to the adapter. */
  listOrders(): readonly ExecutionOrder[];
  /** Working (open) orders only: SUBMITTED, LIVE, PARTIALLY_FILLED, CANCEL_REQUESTED. */
  listOpenOrders(): readonly ExecutionOrder[];
  /** All fills, or the fills of one order (empty when none). */
  getFills(clientOrderId?: string): readonly ExecutionFill[];
  /** Backend identity, e.g. "paper" — useful for guard assertions in tests. */
  readonly backend: "paper" | "live";
}
