/**
 * Polymarket CLOB DTOs and normalization into internal domain models.
 *
 * This module is the ONLY place that knows Polymarket's response shapes.
 * Everything downstream consumes the normalized `ExecutionOrder` /
 * `ExecutionFill` domain models. Parsing returns Results where failure is
 * expected (bad/partial venue data must never crash the loop — unknown state
 * is handled conservatively by the adapter).
 */

import {
  decFromString,
  decMulRound,
  decZero,
  err,
  ok,
  type Decimal,
  type Result,
} from "@bot/domain";

import type { ExecutionFill, ExecutionOrder } from "../adapter.js";
import { isWorkingExecution, type ExecutionStatus } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Raw DTO shapes (Polymarket CLOB-style)
// ---------------------------------------------------------------------------

/** Raw order status strings the venue returns. */
export type RawOrderStatus =
  | "LIVE"
  | "MATCHED"
  | "DELAYED"
  | "UNMATCHED"
  | "CANCELLED"
  | "CANCELED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "REJECTED"
  | (string & {}); // unknown statuses must be handled, not crash

export interface RawOrderDto {
  readonly id?: string | undefined;
  readonly status?: RawOrderStatus | undefined;
  readonly market?: string | undefined;
  readonly asset_id?: string | undefined;
  readonly side?: string | undefined;
  readonly price?: string | undefined;
  readonly original_size?: string | undefined;
  readonly size_matched?: string | undefined;
  readonly associate_trades?: readonly RawFillDto[] | undefined;
  readonly created_at?: string | undefined;
}

export interface RawFillDto {
  readonly trade_id?: string | undefined;
  readonly size?: string | undefined;
  readonly price?: string | undefined;
  readonly fee_rate_bps?: string | undefined;
  readonly side?: string | undefined;
  readonly status?: string | undefined;
  readonly match_time?: string | undefined;
}

export interface RawOrderPostResponse {
  readonly success?: boolean | undefined;
  readonly orderId?: string | undefined;
  readonly errorMsg?: string | undefined;
}

export interface RawCancelResponse {
  readonly canceled?: readonly string[] | undefined;
  readonly not_canceled?: Readonly<Record<string, string>> | undefined;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const EXEC_STATUS_BY_RAW: Readonly<Record<string, ExecutionStatus>> = {
  LIVE: "LIVE",
  MATCHED: "FILLED",
  FILLED: "FILLED",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  DELAYED: "SUBMITTED",
  UNMATCHED: "LIVE",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  REJECTED: "REJECTED",
};

/**
 * Map a raw venue status to the internal lifecycle. Returns undefined for
 * unknown statuses — the adapter treats unknown as non-working (fail closed),
 * never as filled.
 */
export function normalizeStatus(raw: RawOrderStatus | undefined): ExecutionStatus | undefined {
  if (raw === undefined) return undefined;
  return EXEC_STATUS_BY_RAW[raw];
}

/** Parse a venue decimal string; undefined on missing/invalid input. */
export function parseDecimal(raw: string | undefined): Decimal | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    return decFromString(raw);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a raw fill DTO. Returns err on unusable data (missing qty/price) —
 * the adapter drops such fills rather than guessing.
 */
export function normalizeFill(
  raw: RawFillDto,
  clientOrderId: string,
): Result<ExecutionFill, string> {
  const qty = parseDecimal(raw.size);
  const price = parseDecimal(raw.price);
  if (qty === undefined || price === undefined || (qty as bigint) <= 0n) {
    return err(`unusable fill data for ${clientOrderId}`);
  }
  // fee_rate_bps is basis points of notional; missing → 0.
  // fee_real = notional_real × bps_real / 10^4. In scaled units both operands
  // carry 10^8, so fee_scaled = product / 10^(8+8+4) = product / 10^12.
  const feeBps = parseDecimal(raw.fee_rate_bps) ?? decZero();
  const notional = decMulRound(price, qty);
  const fee = ((notional * feeBps) / 10n ** 12n) as Decimal;
  const at = raw.match_time !== undefined ? Number(raw.match_time) : 0;
  return ok({
    clientOrderId,
    qty,
    price,
    fee: fee,
    at: (Number.isFinite(at) ? at : 0) as never,
  });
}

/**
 * Normalize a raw order DTO into an internal order snapshot. Returns err on
 * structurally unusable data; unknown statuses normalize to undefined and the
 * adapter maps them to a conservative non-working state.
 */
export function normalizeOrder(
  raw: RawOrderDto,
  clientOrderId: string,
): Result<ExecutionOrder, string> {
  const price = parseDecimal(raw.price);
  const qty = parseDecimal(raw.original_size);
  const filledQty = parseDecimal(raw.size_matched) ?? decZero();
  if (price === undefined || qty === undefined || (qty as bigint) <= 0n) {
    return err(`unusable order data for ${clientOrderId}`);
  }
  const status = normalizeStatus(raw.status);
  const fills: ExecutionFill[] = [];
  let totalFees = decZero();
  if (raw.associate_trades !== undefined) {
    for (const t of raw.associate_trades) {
      const fill = normalizeFill(t, clientOrderId);
      if (fill.ok) {
        fills.push(fill.value);
        totalFees = (totalFees + fill.value.fee) as Decimal;
      }
      // Unusable fills are dropped, not fatal.
    }
  }
  const createdAt = parseTimestamp(raw.created_at);
  return ok({
    clientOrderId,
    marketId: raw.market ?? "",
    tokenId: raw.asset_id ?? "",
    outcome: "up", // not carried by the venue DTO; the caller knows the intent
    side: raw.side === "SELL" ? "sell" : "buy",
    kind: "limit",
    price,
    qty,
    filledQty,
    // Unknown status → treated as REJECTED-conservative (non-working).
    status: status ?? "REJECTED",
    createdAt: createdAt,
    updatedAt: createdAt,
    fills,
    totalFees,
    rejectReason: status === undefined ? "unknown_venue_status" : undefined,
    cancelFailureReason: undefined,
  });
}

function parseTimestamp(raw: string | undefined): never {
  if (raw === undefined) return 0 as never;
  const n = Date.parse(raw);
  return (Number.isNaN(n) ? 0 : n) as never;
}

/** True when a normalized order is in a working (open) state. */
export function isOpenOrder(order: ExecutionOrder): boolean {
  return isWorkingExecution(order.status);
}
