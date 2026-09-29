/**
 * Persistence event model.
 *
 * Fills and executions are stored as an **append-only event stream** (the
 * source of truth); orders, inventory, sets, and residuals are rebuilt by
 * replaying it deterministically. A point-in-time **snapshot** accelerates
 * recovery but never overrides replay; mismatched snapshot vs. replay is
 * itself a discrepancy (fail closed). See MIGRATIONS.md for schema rules.
 */

import type { ExecutionFill, ExecutionOrder } from "@bot/execution";

import { decodeDecimal, decodeMillis, encodeDecimal, encodeMillis } from "./codec.js";

// ---------------------------------------------------------------------------
// Fill events (append-only; the fill id is the idempotency key)
// ---------------------------------------------------------------------------

/** One persisted fill event. `fillId` dedupes replays and reprocessing. */
export interface FillEvent {
  /** Venue-unique trade id (or deterministic client key in paper mode). */
  readonly fillId: string;
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly qty: string; // encoded Decimal
  readonly price: string; // encoded Decimal
  readonly fee: string; // encoded Decimal
  readonly atMs: string; // encoded Millis
}

export function fillEventFromExecution(fill: ExecutionFill, order: ExecutionOrder): FillEvent {
  return {
    fillId: `${fill.clientOrderId}:${String(fill.at)}:${encodeDecimal(fill.qty)}`,
    clientOrderId: fill.clientOrderId,
    marketId: order.marketId,
    tokenId: order.tokenId,
    outcome: order.outcome,
    side: order.side,
    qty: encodeDecimal(fill.qty),
    price: encodeDecimal(fill.price),
    fee: encodeDecimal(fill.fee),
    atMs: encodeMillis(fill.at),
  };
}

/** Plain-data order as persisted (no Decimal objects). */
export interface StoredOrder {
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly kind: "limit" | "market";
  readonly price: string;
  readonly qty: string;
  readonly filledQty: string;
  /** Persisted verbatim — including PARTIALLY_FILLED and any UNKNOWN marker. */
  readonly status: string;
  readonly createdAtMs: string;
  readonly updatedAtMs: string;
  readonly rejectReason: string | undefined;
  readonly cancelFailureReason: string | undefined;
}

export function storedOrderFromExecution(order: ExecutionOrder): StoredOrder {
  return {
    clientOrderId: order.clientOrderId,
    marketId: order.marketId,
    tokenId: order.tokenId,
    outcome: order.outcome,
    side: order.side,
    kind: order.kind,
    price: encodeDecimal(order.price),
    qty: encodeDecimal(order.qty),
    filledQty: encodeDecimal(order.filledQty),
    status: order.status,
    createdAtMs: encodeMillis(order.createdAt),
    updatedAtMs: encodeMillis(order.updatedAt),
    rejectReason: order.rejectReason,
    cancelFailureReason: order.cancelFailureReason,
  };
}

/** Rebuild a domain `ExecutionOrder` view from its persisted row. */
export function executionOrderFromStored(stored: StoredOrder): ExecutionOrder {
  return {
    clientOrderId: stored.clientOrderId,
    marketId: stored.marketId,
    tokenId: stored.tokenId,
    outcome: stored.outcome,
    side: stored.side,
    kind: stored.kind,
    price: decodeDecimal(stored.price),
    qty: decodeDecimal(stored.qty),
    filledQty: decodeDecimal(stored.filledQty),
    // Persisted verbatim: PARTIALLY_FILLED stays PARTIALLY_FILLED; any state
    // the venue last reported as unknown stays unknown (never auto-FILLED).
    status: stored.status as ExecutionOrder["status"],
    createdAt: decodeMillis(stored.createdAtMs),
    updatedAt: decodeMillis(stored.updatedAtMs),
    fills: [],
    totalFees: decodeDecimal("0"),
    rejectReason: stored.rejectReason,
    cancelFailureReason: stored.cancelFailureReason,
  };
}

// ---------------------------------------------------------------------------
// Inventory lots (append-only acquisitions; lot id is the idempotency key)
// ---------------------------------------------------------------------------

export interface StoredLot {
  readonly lotId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly qty: string;
  readonly pricePerUnit: string;
  readonly fee: string;
  readonly rebate: string;
  readonly acquiredAtMs: string;
}

// ---------------------------------------------------------------------------
// Markets and cycles
// ---------------------------------------------------------------------------

export interface StoredMarket {
  readonly marketId: string;
  readonly asset: string;
  readonly tokenIdUp: string;
  readonly tokenIdDown: string;
  readonly startMs: string;
  readonly endMs: string;
}

// ---------------------------------------------------------------------------
// Records: decisions, risk events, reconciliations, kill-switch
// ---------------------------------------------------------------------------

export interface StoredDecision {
  readonly decisionId: string;
  readonly atMs: string;
  readonly asset: string;
  readonly marketId: string;
  readonly action: string;
  readonly orderSubmitted: boolean;
  readonly riskReason: string | undefined;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export interface StoredRiskEvent {
  readonly atMs: string;
  readonly kind: string;
  /** Machine-parseable context (e.g. which check blocked, which stream). */
  readonly detail: Readonly<Record<string, string>>;
}

export interface StoredReconciliation {
  readonly atMs: string;
  readonly trigger: string;
  readonly state: "reconciled" | "unreconciled";
  readonly blocked: boolean;
  readonly summary: string;
}

/** Persisted kill-switch state (survives restart by requirement F). */
export interface StoredKillSwitch {
  readonly engaged: boolean;
  readonly atMs: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Snapshot: the point-in-time projection of the whole stream
// ---------------------------------------------------------------------------

export interface PersistedSnapshot {
  readonly schemaVersion: number;
  readonly writtenAtMs: string;
  readonly orders: readonly StoredOrder[];
  readonly lots: readonly StoredLot[];
  readonly markets: readonly StoredMarket[];
  readonly killSwitch: StoredKillSwitch;
}

/** Decode helper for fill events read back from disk. */
export function decodedFill(event: FillEvent): {
  readonly fillId: string;
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly qty: ReturnType<typeof decodeDecimal>;
  readonly price: ReturnType<typeof decodeDecimal>;
  readonly fee: ReturnType<typeof decodeDecimal>;
  readonly at: ReturnType<typeof decodeMillis>;
} {
  return {
    fillId: event.fillId,
    clientOrderId: event.clientOrderId,
    marketId: event.marketId,
    tokenId: event.tokenId,
    outcome: event.outcome,
    side: event.side,
    qty: decodeDecimal(event.qty),
    price: decodeDecimal(event.price),
    fee: decodeDecimal(event.fee),
    at: decodeMillis(event.atMs),
  };
}
