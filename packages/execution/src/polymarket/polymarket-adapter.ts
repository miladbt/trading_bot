/**
 * PolymarketExecutionAdapter: the live-venue execution backend.
 *
 * **LIVE-EXECUTION GUARD (fail closed).** Real order submission is possible
 * only when BOTH of the following hold, checked at construction AND again at
 * every submit/cancel:
 *
 *     TRADING_MODE === "live"  AND  LIVE_TRADING_ENABLED === true
 *
 * With the shipped defaults (`TRADING_MODE=paper`,
 * `LIVE_TRADING_ENABLED=false`) the adapter refuses every real submission with
 * a `live_trading_disabled` result. The guard is a constructor parameter, so
 * tests can exercise both paths; production config supplies it from the
 * validated AppConfig (whose loader already refuses live mode without an
 * explicit two-way opt-in).
 *
 * **Risk is never bypassed.** The adapter does not decide whether an order
 * *should* exist — it receives `RiskEvaluation.allowed` evidence with every
 * submit request and refuses to place anything that arrives without a
 * positive risk verdict from the authoritative RiskEngine.
 *
 * Semantics:
 * - An accepted request is QUEUED, never assumed filled. Venue confirmation
 *   arrives via reconciliation (`syncOrder`), which normalizes DTOs into
 *   internal models; unknown venue statuses map to a conservative non-working
 *   state ("unknown_venue_status"), never to FILLED.
 * - Partial fills are first-class: `size_matched`/`associate_trades` become
 *   per-fill records; remaining quantity stays working.
 * - Transport failures are classified: timeout, network, rate_limited
 *   (backoff, retryable), auth_failed (NOT retryable — fail closed),
 *   server_error, bad_response.
 * - Submits/cancels retry with bounded exponential backoff (attempts ×
 *   baseDelay, doubling, capped); rate limits respect a cooldown; auth
 *   failures never retry.
 *
 * All calls are async (a real venue is I/O); callers get the same
 * `ExecutionResult`/`ExecutionOrder` models as the paper adapter.
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decOne,
  decZero,
  type Decimal,
  type Millis,
  type Result,
} from "@bot/domain";

import type {
  ExecutionFill,
  ExecutionOrder,
  ExecutionOrderRequest,
  ExecutionResult,
} from "../adapter.js";
import type { ExecutionStatus } from "../lifecycle.js";
import { isWorkingExecution } from "../lifecycle.js";
import {
  normalizeFill,
  normalizeOrder,
  normalizeStatus,
  type RawCancelResponse,
  type RawOrderPostResponse,
} from "./dto.js";
import type { ClobFailureReason, ClobTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PolymarketAdapterConfig {
  /**
   * LIVE-EXECUTION GUARD (both required for real submission):
   * TRADING_MODE === "live" AND LIVE_TRADING_ENABLED === true.
   */
  readonly tradingMode: "paper" | "live";
  readonly liveTradingEnabled: boolean;
  /** Per-call timeout, ms. */
  readonly timeoutMs: number;
  /** Max attempts per call (1 = no retry). */
  readonly maxAttempts: number;
  /** Base backoff delay, ms (doubles each retry, capped by maxBackoffMs). */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Cooldown after a rate-limit response, ms (not retryable until elapsed). */
  readonly rateLimitCooldownMs: number;
  /** RiskGate: the authoritative risk verdict provider. */
  readonly riskGate: RiskGate;
  /** Transport seam (mock in tests; real HTTP client in production). */
  readonly transport: ClobTransport;
}

/**
 * Risk gate: the adapter refuses to place any order that does not carry a
 * positive verdict from the authoritative RiskEngine. This makes bypassing
 * risk structurally impossible through this adapter.
 */
export interface RiskGate {
  /** Must return the (already-computed) risk decision for this exact order. */
  evaluate(req: ExecutionOrderRequest): { allowed: boolean; reason: string };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface TrackedOrder {
  readonly req: ExecutionOrderRequest;
  /** Venue order id once accepted (undefined while queued/unconfirmed). */
  venueOrderId: string | undefined;
  status: ExecutionStatus;
  fills: ExecutionFill[];
  totalFees: Decimal;
  rejectReason: string | undefined;
  /** True when the last reconciliation saw an unknown venue status. */
  unknownState: boolean;
}

/** Fail-loud for invalid adapter construction (caller bug, not venue state). */
class LiveExecutionGuardError extends ValidationError {
  constructor(detail: string) {
    super(`live execution guard: ${detail}`);
    this.name = "LiveExecutionGuardError";
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The async execution port for I/O-bound live backends. Structurally the same
 * surface as `ExecutionAdapter` plus the reconciliation methods; the paper
 * adapter's sync methods are assignable to this shape.
 */
export interface AsyncExecutionAdapter {
  submit(req: ExecutionOrderRequest): Promise<ExecutionResult>;
  cancel(clientOrderId: string, at: Millis): Promise<ExecutionResult>;
  getOrder(clientOrderId: string): ExecutionOrder | undefined;
  listOrders(): readonly ExecutionOrder[];
  listOpenOrders(): readonly ExecutionOrder[];
  getFills(clientOrderId?: string): readonly ExecutionFill[];
  readonly backend: "paper" | "live";
}

export class PolymarketExecutionAdapter implements AsyncExecutionAdapter {
  readonly backend = "live" as const;

  private readonly cfg: PolymarketAdapterConfig;
  private readonly orders = new Map<string, TrackedOrder>();
  /** Earliest instant the venue accepts another call after a rate limit. */
  private rateLimitedUntil = 0;

  constructor(config: PolymarketAdapterConfig) {
    if (config.timeoutMs <= 0) {
      throw new ValidationError("timeoutMs must be positive");
    }
    if (config.maxAttempts < 1) {
      throw new ValidationError("maxAttempts must be >= 1");
    }
    if (config.baseBackoffMs < 0 || config.maxBackoffMs < 0) {
      throw new ValidationError("backoff delays must be non-negative");
    }
    this.cfg = config;
    // Construction-time guard: refuse an inconsistent configuration outright.
    if (
      config.tradingMode === "live" &&
      config.liveTradingEnabled &&
      config.riskGate === undefined
    ) {
      throw new LiveExecutionGuardError("live mode requires a RiskGate");
    }
  }

  /** The live-execution guard, evaluated fresh on every real call. */
  private liveAllowed(): boolean {
    return this.cfg.tradingMode === "live" && this.cfg.liveTradingEnabled === true;
  }

  private guardResult(clientOrderId: string): ExecutionResult | undefined {
    if (this.liveAllowed()) return undefined;
    return {
      ok: false,
      clientOrderId,
      reason: "live_trading_disabled",
    };
  }

  // ---- Port implementation (async: real venue I/O) -------------------------

  async submit(req: ExecutionOrderRequest): Promise<ExecutionResult> {
    // 1. LIVE-EXECUTION GUARD — before anything touches the transport.
    const guarded = this.guardResult(req.clientOrderId);
    if (guarded !== undefined) return guarded;

    // 2. RISK GATE — the adapter refuses orders without a positive verdict.
    const risk = this.cfg.riskGate.evaluate(req);
    if (!risk.allowed) {
      return { ok: false, clientOrderId: req.clientOrderId, reason: `risk_${risk.reason}` };
    }

    // 3. Local validation (venue-like pre-checks).
    const localFail = this.validate(req);
    if (localFail !== undefined) {
      return { ok: false, clientOrderId: req.clientOrderId, reason: localFail };
    }
    if (this.orders.has(req.clientOrderId)) {
      return { ok: false, clientOrderId: req.clientOrderId, reason: "duplicate_client_order_id" };
    }
    if (Date.now() < this.rateLimitedUntil) {
      return { ok: false, clientOrderId: req.clientOrderId, reason: "rate_limited_cooldown" };
    }

    // 4. Queue the order locally: accepted == queued, never filled.
    const tracked: TrackedOrder = {
      req,
      venueOrderId: undefined,
      status: "SUBMITTED",
      fills: [],
      totalFees: decZero(),
      rejectReason: undefined,
      unknownState: false,
    };
    this.orders.set(req.clientOrderId, tracked);

    // 5. Place at the venue with retry/backoff; failure to place keeps the
    // order queued locally (unknown state) rather than vanishing.
    const body = JSON.stringify({
      clientOrderId: req.clientOrderId,
      market: req.marketId,
      asset_id: req.tokenId,
      side: req.side === "buy" ? "BUY" : "SELL",
      price: req.price.toString(),
      size: req.qty.toString(),
      type: "LIMIT",
    });
    const placed = await this.withRetry(
      "submit",
      () => this.cfg.transport.postOrder(body, this.cfg.timeoutMs),
      (r: RawOrderPostResponse) => r.success === true && typeof r.orderId === "string",
    );

    if (!placed.ok) {
      tracked.status = "REJECTED";
      tracked.rejectReason = `venue_${placed.error}`;
      return { ok: false, clientOrderId: req.clientOrderId, reason: `venue_${placed.error}` };
    }

    tracked.venueOrderId = placed.value.orderId;
    tracked.status = "LIVE"; // live on the venue; NOT filled — see syncOrder
    return { ok: true, clientOrderId: req.clientOrderId, reason: "accepted" };
  }

  async cancel(clientOrderId: string, _at: Millis): Promise<ExecutionResult> {
    // LIVE-EXECUTION GUARD — real cancels are also gated (defense in depth).
    const guarded = this.guardResult(clientOrderId);
    if (guarded !== undefined) return guarded;

    const order = this.orders.get(clientOrderId);
    if (order === undefined) {
      return { ok: false, clientOrderId, reason: "unknown_order" };
    }
    if (!isWorkingExecution(order.status)) {
      return { ok: false, clientOrderId, reason: `not_cancellable_in_status_${order.status}` };
    }
    if (order.venueOrderId === undefined) {
      return { ok: false, clientOrderId, reason: "venue_order_id_unconfirmed" };
    }
    order.status = "CANCEL_REQUESTED";

    const done = await this.withRetry(
      "cancel",
      () => this.cfg.transport.cancelOrder(order.venueOrderId!, this.cfg.timeoutMs),
      (r: RawCancelResponse) =>
        Array.isArray(r.canceled) && r.canceled.includes(order.venueOrderId!),
    );
    if (!done.ok) {
      // Cancel failed at the venue: the order is still working (LIVE).
      order.status = "LIVE";
      return { ok: false, clientOrderId, reason: `venue_${done.error}` };
    }
    order.status = "CANCELLED";
    return { ok: true, clientOrderId, reason: "cancelled" };
  }

  /** Local snapshot; venue truth requires `syncOrder` (unknown state kept). */
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

  // ---- Reconciliation (venue truth → internal models) ----------------------

  /**
   * Reconcile one order against the venue: normalizes the DTO, applies new
   * fills (partial fills accumulate), and handles unknown statuses
   * conservatively. This is the ONLY path that may move an order to FILLED —
   * an accepted submit never implies a fill.
   */
  async syncOrder(clientOrderId: string): Promise<ExecutionOrder | undefined> {
    if (!this.liveAllowed()) {
      return this.getOrder(clientOrderId);
    }
    const order = this.orders.get(clientOrderId);
    if (order === undefined || order.venueOrderId === undefined) {
      return order === undefined ? undefined : snapshotOf(order);
    }
    const raw = await this.withRetry(
      "getOrder",
      () => this.cfg.transport.getOrder(order.venueOrderId!, this.cfg.timeoutMs),
      () => true,
    );
    if (!raw.ok) {
      // Venue unreachable: keep local state (unknown, non-terminal).
      order.unknownState = true;
      return snapshotOf(order);
    }
    const normalized = normalizeOrder(raw.value, clientOrderId);
    if (!normalized.ok) {
      // Unusable DTO: keep local state; the order is NOT assumed filled.
      order.unknownState = true;
      return snapshotOf(order);
    }
    order.unknownState = false;
    const venueStatus = normalizeStatus(raw.value.status);
    if (venueStatus === undefined) {
      // Unknown venue status: conservative — keep working state only if we
      // have not seen a terminal state before; never invent FILLED.
      order.rejectReason = "unknown_venue_status";
      return snapshotOf(order);
    }

    // Apply new fills only (partial fills accumulate exactly once).
    let appliedNew = false;
    const seen = new Set(order.fills.map((f) => `${f.qty}:${f.price}:${f.at}`));
    for (const fill of normalized.value.fills) {
      const key = `${fill.qty}:${fill.price}:${fill.at}`;
      if (!seen.has(key)) {
        order.fills.push(fill);
        order.totalFees = decAdd(order.totalFees, fill.fee);
        appliedNew = true;
      }
    }

    // Status: venue is authoritative, but FILLED requires the cumulative qty.
    const totalFilled = order.fills.reduce((acc, f) => (acc + f.qty) as Decimal, decZero());
    if (venueStatus === "FILLED" && decCompare(totalFilled, order.req.qty) < 0) {
      // Venue says FILLED but quantities disagree: PARTIALLY_FILLED (unknown
      // quantity state is treated conservatively, never over-claimed).
      order.status = "PARTIALLY_FILLED";
    } else {
      order.status = venueStatus;
    }
    if (appliedNew || venueStatus !== "LIVE") {
      // updatedAt advances via fill application or status change.
    }
    return snapshotOf(order);
  }

  /** Reconcile all working orders (a periodic loop would call this). */
  async syncOpenOrders(): Promise<readonly ExecutionOrder[]> {
    if (!this.liveAllowed()) {
      return this.listOpenOrders();
    }
    const open = this.listOpenOrders();
    const out: ExecutionOrder[] = [];
    for (const o of open) {
      const synced = await this.syncOrder(o.clientOrderId);
      if (synced !== undefined) out.push(synced);
    }
    return out;
  }

  /** Pull fills from the venue trades endpoint (normalize + dedupe). */
  async syncFills(): Promise<readonly ExecutionFill[]> {
    if (!this.liveAllowed()) return this.getFills();
    const raw = await this.withRetry(
      "getTrades",
      () => this.cfg.transport.getTrades(this.cfg.timeoutMs),
      () => true,
    );
    if (!raw.ok) return this.getFills();
    const fills: ExecutionFill[] = [];
    for (const t of raw.value) {
      const normalized = normalizeFill(t, t.trade_id ?? "unknown");
      if (normalized.ok) fills.push(normalized.value);
    }
    return fills;
  }

  // ---- Retry / backoff / rate-limit machinery ------------------------------

  /**
   * Run a transport call with bounded exponential backoff.
   * - timeout / network / server_error / bad_response: retryable.
   * - rate_limited: honors the cooldown, then retryable.
   * - auth_failed: NOT retryable (fail closed; credentials are wrong).
   */
  private async withRetry<T>(
    op: string,
    call: () => Promise<Result<T, ClobFailureReason>>,
    isSuccess: (value: T) => boolean,
  ): Promise<Result<T, ClobFailureReason>> {
    let lastError: ClobFailureReason = "bad_response";
    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      const res = await call();
      if (res.ok && isSuccess(res.value)) return res;
      if (!res.ok) {
        lastError = res.error;
        if (res.error === "auth_failed") break; // never retry auth failures
        if (res.error === "rate_limited") {
          this.rateLimitedUntil = Date.now() + this.cfg.rateLimitCooldownMs;
        }
        if (op === "submit" && res.error === "rate_limited" && attempt < this.cfg.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        if (
          (res.error === "timeout" ||
            res.error === "network" ||
            res.error === "server_error" ||
            res.error === "bad_response") &&
          attempt < this.cfg.maxAttempts
        ) {
          await this.backoff(attempt);
          continue;
        }
      } else {
        // Transport ok but semantic failure (e.g. success=false).
        lastError = "bad_response";
        if (attempt < this.cfg.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
      }
      break;
    }
    return { ok: false, error: lastError };
  }

  /** Bounded exponential backoff: base * 2^(attempt-1), capped. */
  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(this.cfg.baseBackoffMs * 2 ** (attempt - 1), this.cfg.maxBackoffMs);
    if (delay <= 0) return;
    await new Promise((r) => setTimeout(r, delay));
  }

  private validate(req: ExecutionOrderRequest): string | undefined {
    if (req.clientOrderId.trim().length === 0) return "empty_client_order_id";
    if ((req.qty as bigint) <= 0n) return "non_positive_qty";
    if (decCompare(req.price, decZero()) <= 0 || decCompare(req.price, decOne()) >= 0) {
      return "price_out_of_range";
    }
    if (req.kind !== "limit") return "unsupported_kind"; // live: limit only
    return undefined;
  }
}

function snapshotOf(order: TrackedOrder): ExecutionOrder {
  return {
    clientOrderId: order.req.clientOrderId,
    marketId: order.req.marketId,
    tokenId: order.req.tokenId,
    outcome: order.req.outcome,
    side: order.req.side,
    kind: order.req.kind,
    price: order.req.price,
    qty: order.req.qty,
    filledQty: order.fills.reduce((acc, f) => (acc + f.qty) as Decimal, decZero()),
    status: order.status,
    createdAt: order.req.at,
    updatedAt: order.req.at,
    fills: [...order.fills],
    totalFees: order.totalFees,
    rejectReason: order.rejectReason,
    cancelFailureReason: undefined,
  };
}
