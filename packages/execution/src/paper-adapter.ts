/**
 * PaperExecutionAdapter: a deterministic venue simulator.
 *
 * Implements the same `ExecutionAdapter` port a future live Polymarket adapter
 * will implement. It simulates: limit orders, post-only behavior, partial
 * fills, full fills, cancellations, rejections, order-book interaction, fees,
 * and latency where configured.
 *
 * Determinism model:
 * - The simulation advances ONLY when the caller advances the clock via
 *   `advanceClock(at)` — the single driver. Same call sequence, same result.
 *   No random, no real time, no network, no Polymarket.
 * - Book liquidity is FINITE and tracked per level: each contra level holds a
 *   fixed quantity that is consumed as fills occur and never refills.
 * - Per tick, a working order fills from the BEST crossed contra level with
 *   unconsumed quantity, taking `min(remaining, levelAvailable)` — so large
 *   orders fill level-by-level across ticks (deterministic partial fills).
 * - Fees: market-order fills are pure taker flow (`takerFeeRate`); limit-order
 *   fills are maker flow charged the net rate (`takerFeeRate - makerRebateRate`,
 *   clamped at zero).
 * - Tick processing order: submit latency → cancel completion → matching.
 *   An elapsed cancel therefore completes before new fills, while a cancel
 *   still inside its latency window can lose the race against a completing
 *   fill (the venue convention the lifecycle's
 *   CANCEL_REQUESTED → FILLED transition models).
 *
 * Paper-mode guarantee: the adapter talks only to its own configured
 * `SimulatedBook` instances; it holds no HTTP/WS client, no credentials, and
 * no venue code. The `createExecutionAdapter` factory is the only component
 * that could route to a live backend, and it is fail-closed for anything but
 * paper (see factory.ts).
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decIsZero,
  decMulRound,
  decOne,
  decSub,
  decZero,
  type Decimal,
  type Millis,
} from "@bot/domain";

import type {
  ExecutionAdapter,
  ExecutionFill,
  ExecutionOrder,
  ExecutionOrderRequest,
  ExecutionResult,
} from "./adapter.js";
import type { SimulatedBook } from "./book.js";
import { isCancellableExecution, isWorkingExecution, type ExecutionStatus } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-token simulated book plus optional per-token fee overrides. */
export interface PaperTokenConfig {
  readonly tokenId: string;
  readonly book: SimulatedBook;
  /** Per-token taker fee rate (fraction of notional); overrides the default. */
  readonly takerFeeRate?: Decimal | undefined;
  /** Per-token maker rebate rate (fraction of notional); overrides the default. */
  readonly makerRebateRate?: Decimal | undefined;
}

export interface PaperAdapterConfig {
  readonly tokens: readonly PaperTokenConfig[];
  /** Simulated submit latency: LIVE at `at + submitLatencyMs`. Default 0. */
  readonly submitLatencyMs?: number | undefined;
  /** Simulated cancel latency: CANCEL_REQUESTED → CANCELLED at `at + cancelLatencyMs`. Default 0. */
  readonly cancelLatencyMs?: number | undefined;
  /** Post-only enforcement on limit orders. Default false. */
  readonly postOnly?: boolean | undefined;
  /** Taker fee per fill (fraction of notional). Default 0. */
  readonly takerFeeRate?: Decimal | undefined;
  /** Maker rebate per limit-order fill (fraction of notional). Default 0. */
  readonly makerRebateRate?: Decimal | undefined;
}

// ---------------------------------------------------------------------------
// Internal mutable order state (never leaves the adapter; snapshots are copies)
// ---------------------------------------------------------------------------

interface InternalOrder {
  clientOrderId: string;
  marketId: string;
  tokenId: string;
  outcome: "up" | "down";
  side: "buy" | "sell";
  kind: "limit" | "market";
  price: Decimal;
  qty: Decimal;
  filledQty: Decimal;
  status: ExecutionStatus;
  createdAt: Millis;
  updatedAt: Millis;
  fills: ExecutionFill[];
  totalFees: Decimal;
  /** Becomes LIVE at this instant (submit latency). */
  goLiveAt: Millis;
  /** Becomes CANCELLED at this instant (cancel latency); undefined = none. */
  cancelAt: Millis | undefined;
  rejectReason: string | undefined;
  takerFeeRate: Decimal;
  makerRebateRate: Decimal;
}

/** Net fee rate for a maker (limit-order) fill: taker fee minus rebate, >= 0. */
function netMakerRate(takerFeeRate: Decimal, makerRebateRate: Decimal): Decimal {
  const net = decSub(takerFeeRate, makerRebateRate);
  return decCompare(net, decZero()) < 0 ? decZero() : net;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly backend = "paper" as const;

  private readonly tokens: Map<string, PaperTokenConfig>;
  private readonly submitLatencyMs: number;
  private readonly cancelLatencyMs: number;
  private readonly postOnly: boolean;
  private readonly defaultTakerFeeRate: Decimal;
  private readonly defaultMakerRebateRate: Decimal;
  private readonly orders: Map<string, InternalOrder>;
  /** Consumed quantity per contra level: key `tokenId|contraSide|levelIndex`. */
  private readonly consumed: Map<string, Decimal>;

  constructor(config: PaperAdapterConfig) {
    if (config.tokens.length === 0) {
      throw new ValidationError("paper adapter requires at least one token config");
    }
    this.tokens = new Map(config.tokens.map((t) => [t.tokenId, t]));
    this.submitLatencyMs = config.submitLatencyMs ?? 0;
    this.cancelLatencyMs = config.cancelLatencyMs ?? 0;
    this.postOnly = config.postOnly ?? false;
    this.defaultTakerFeeRate = config.takerFeeRate ?? decZero();
    this.defaultMakerRebateRate = config.makerRebateRate ?? decZero();
    if (decCompare(this.defaultTakerFeeRate, decZero()) < 0) {
      throw new ValidationError("takerFeeRate must be non-negative");
    }
    if (decCompare(this.defaultMakerRebateRate, decZero()) < 0) {
      throw new ValidationError("makerRebateRate must be non-negative");
    }
    this.orders = new Map();
    this.consumed = new Map();
  }

  // ---- Port implementation -------------------------------------------------

  submit(req: ExecutionOrderRequest): ExecutionResult {
    const fail = (reason: string): ExecutionResult => ({
      ok: false,
      clientOrderId: req.clientOrderId,
      reason,
    });

    if (req.clientOrderId.trim().length === 0) {
      return fail("empty_client_order_id");
    }
    if (this.orders.has(req.clientOrderId)) {
      return fail("duplicate_client_order_id");
    }
    if (req.kind !== "limit" && req.kind !== "market") {
      return fail("invalid_kind");
    }
    if (decCompare(req.qty, decZero()) <= 0) {
      return fail("non_positive_qty");
    }
    // Price must be in (0, 1) — a venue-like validity check.
    if (decCompare(req.price, decZero()) <= 0 || decCompare(req.price, decOne()) >= 0) {
      return fail("price_out_of_range");
    }
    const token = this.tokens.get(req.tokenId);
    if (token === undefined) {
      return fail("unknown_token");
    }
    // Market orders must be marketable (cross), otherwise they would be
    // abandoned instantly — reject up front so the caller learns immediately.
    if (req.kind === "market") {
      const best = req.side === "buy" ? token.book.asks[0] : token.book.bids[0];
      const crosses =
        best !== undefined &&
        (req.side === "buy"
          ? decCompare(req.price, best.price) >= 0
          : decCompare(req.price, best.price) <= 0);
      if (!crosses) {
        return fail("market_order_not_marketable");
      }
    }

    // Post-only: a limit order that would cross is rejected at submit (it
    // must rest); it never becomes a working order.
    if (this.postOnly && req.kind === "limit") {
      const best = req.side === "buy" ? token.book.asks[0] : token.book.bids[0];
      const wouldCross =
        best !== undefined &&
        (req.side === "buy"
          ? decCompare(req.price, best.price) >= 0
          : decCompare(req.price, best.price) <= 0);
      if (wouldCross) {
        const rejected = this.newOrder(req, "REJECTED", {});
        rejected.rejectReason = "post_only_would_cross";
        this.orders.set(rejected.clientOrderId, rejected);
        return fail("post_only_would_cross");
      }
    }

    const order = this.newOrder(req, "SUBMITTED", {
      goLiveAt: (req.at + this.submitLatencyMs) as Millis,
      takerFeeRate: token.takerFeeRate ?? this.defaultTakerFeeRate,
      makerRebateRate: token.makerRebateRate ?? this.defaultMakerRebateRate,
    });
    this.orders.set(order.clientOrderId, order);
    return { ok: true, clientOrderId: req.clientOrderId, reason: "accepted" };
  }

  cancel(clientOrderId: string, at: Millis): ExecutionResult {
    const order = this.orders.get(clientOrderId);
    if (order === undefined) {
      return { ok: false, clientOrderId, reason: "unknown_order" };
    }
    if (!isCancellableExecution(order.status)) {
      return {
        ok: false,
        clientOrderId,
        reason:
          order.status === "CANCEL_REQUESTED"
            ? "cancel_already_requested"
            : `not_cancellable_in_status_${order.status}`,
      };
    }
    order.status = "CANCEL_REQUESTED";
    order.updatedAt = at;
    order.cancelAt = (at + this.cancelLatencyMs) as Millis;
    return { ok: true, clientOrderId, reason: "cancel_requested" };
  }

  getOrder(clientOrderId: string): ExecutionOrder | undefined {
    const order = this.orders.get(clientOrderId);
    return order === undefined ? undefined : snapshotOf(order);
  }

  listOrders(): readonly ExecutionOrder[] {
    return [...this.orders.values()].map(snapshotOf);
  }

  listOpenOrders(): readonly ExecutionOrder[] {
    return this.listOrders().filter((o) => isWorkingExecution(o.status));
  }

  getFills(clientOrderId?: string): readonly ExecutionFill[] {
    const all = [...this.orders.values()].flatMap((o) => o.fills);
    if (clientOrderId === undefined) return all;
    return all.filter((f) => f.clientOrderId === clientOrderId);
  }

  // ---- Simulation driver ---------------------------------------------------

  /**
   * Advance the simulated clock and process everything that is due, in order:
   * submit latency (SUBMITTED → LIVE), cancel completion (CANCEL_REQUESTED →
   * CANCELLED once the latency elapses), then matching for working orders.
   * Returns the fills that occurred during this tick.
   */
  advanceClock(at: Millis): readonly ExecutionFill[] {
    const fills: ExecutionFill[] = [];

    for (const order of this.orders.values()) {
      // 1. Submit latency.
      if (order.status === "SUBMITTED" && at >= order.goLiveAt) {
        order.status = "LIVE";
        order.updatedAt = at;
      }

      // 2. Cancel completion: an elapsed cancel wins over new fills in the
      // same tick. (A completing fill in an EARLIER tick already switched the
      // order to FILLED, which also beats the cancel — the lifecycle's
      // CANCEL_REQUESTED → FILLED race.)
      if (
        order.status === "CANCEL_REQUESTED" &&
        order.cancelAt !== undefined &&
        at >= order.cancelAt
      ) {
        order.status = "CANCELLED";
        order.updatedAt = at;
        order.cancelAt = undefined;
        continue;
      }

      // 3. Matching for working orders — including one with a cancel still in
      // flight (inside its latency window), which may still fill or even
      // complete before the cancel lands.
      if (
        (isWorkingExecution(order.status) || order.status === "CANCEL_REQUESTED") &&
        at >= order.goLiveAt
      ) {
        fills.push(...this.tryFill(order, at));
      }
    }

    return fills;
  }

  // ---- Internals -----------------------------------------------------------

  private newOrder(
    req: ExecutionOrderRequest,
    status: ExecutionStatus,
    extra: {
      goLiveAt?: Millis;
      takerFeeRate?: Decimal;
      makerRebateRate?: Decimal;
    },
  ): InternalOrder {
    return {
      clientOrderId: req.clientOrderId,
      marketId: req.marketId,
      tokenId: req.tokenId,
      outcome: req.outcome,
      side: req.side,
      kind: req.kind,
      price: req.price,
      qty: req.qty,
      filledQty: decZero(),
      status,
      createdAt: req.at,
      updatedAt: req.at,
      fills: [],
      totalFees: decZero(),
      goLiveAt: extra.goLiveAt ?? req.at,
      cancelAt: undefined,
      rejectReason: undefined,
      takerFeeRate: extra.takerFeeRate ?? this.defaultTakerFeeRate,
      makerRebateRate: extra.makerRebateRate ?? this.defaultMakerRebateRate,
    };
  }

  /**
   * Fill one working order from the best crossed contra level that still has
   * unconsumed quantity. At most one level per tick — deterministic partial
   * fills level-by-level as the order works through the book.
   */
  private tryFill(order: InternalOrder, at: Millis): readonly ExecutionFill[] {
    const token = this.tokens.get(order.tokenId);
    if (token === undefined) return [];

    const remaining = decSub(order.qty, order.filledQty);
    if (decIsZero(remaining)) return [];

    const contraSide = order.side === "buy" ? "asks" : "bids";
    const levels = token.book[contraSide];

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      const crosses =
        order.side === "buy"
          ? decCompare(order.price, level.price) >= 0
          : decCompare(order.price, level.price) <= 0;
      if (!crosses) break; // levels are sorted; nothing further can cross

      const key = `${order.tokenId}|${contraSide}|${String(i)}`;
      const consumedQty = this.consumed.get(key) ?? decZero();
      const available = decSub(level.qty, consumedQty);
      if (decIsZero(available)) continue;

      const take = decCompare(remaining, available) <= 0 ? remaining : available;
      this.consumed.set(key, decAdd(consumedQty, take));

      // Fee convention (see module doc): market fills are pure taker flow;
      // limit fills are maker flow at the net rate.
      const rate =
        order.kind === "market"
          ? order.takerFeeRate
          : netMakerRate(order.takerFeeRate, order.makerRebateRate);
      const fee = decMulRound(decMulRound(level.price, take), rate);

      const fill: ExecutionFill = {
        clientOrderId: order.clientOrderId,
        qty: take,
        price: level.price,
        fee,
        at,
      };
      order.fills.push(fill);
      order.filledQty = decAdd(order.filledQty, take);
      order.totalFees = decAdd(order.totalFees, fee);
      order.updatedAt = at;

      const fullyFilled = decCompare(order.filledQty, order.qty) >= 0;
      order.status = fullyFilled ? "FILLED" : "PARTIALLY_FILLED";
      if (fullyFilled) {
        order.cancelAt = undefined; // a completing fill beats the cancel
      }
      return [fill];
    }
    return [];
  }
}

function snapshotOf(order: InternalOrder): ExecutionOrder {
  return {
    clientOrderId: order.clientOrderId,
    marketId: order.marketId,
    tokenId: order.tokenId,
    outcome: order.outcome,
    side: order.side,
    kind: order.kind,
    price: order.price,
    qty: order.qty,
    filledQty: order.filledQty,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    fills: [...order.fills],
    totalFees: order.totalFees,
    rejectReason: order.rejectReason,
    cancelFailureReason: undefined,
  };
}
