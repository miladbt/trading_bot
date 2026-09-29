/**
 * The authoritative RiskEngine: every future live order passes through here.
 *
 * `evaluateRiskOrder` is a pure, deterministic function of (request, limits).
 * It performs no network calls, reads no clock, and consults no model — every
 * observation (health, ages, losses, exposure) arrives as data in the request.
 *
 * Fail-closed design:
 * - The checks run in a fixed canonical order; the first failure wins and the
 *   reason is stable and machine-parseable.
 * - Health inputs are tri-state (`"healthy" | "degraded" | "unhealthy"` with
 *   `undefined` = unknown). Unknown or unhealthy means NO new orders.
 * - Any invalid request value (negative qty/price/losses, unknown boolean,
 *   out-of-range confidence) throws ValidationError rather than guessing.
 *
 * The engine only ever DECIDES. It never submits, amends, or cancels orders.
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decMulRound,
  decNeg,
  decZero,
  type Decimal,
} from "@bot/domain";

import type { RiskLimits } from "./limits.js";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Tri-state health probe. `undefined` = unknown = fail closed. */
export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface RiskOrderRequest {
  // ---- Identity ----
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  /** Order size in shares (must be > 0 to bother evaluating). */
  readonly qty: Decimal;
  /** Limit price per share in USDC (must be > 0). */
  readonly price: Decimal;

  // ---- Capital / exposure snapshot (already aggregated by the caller) ----
  /** Number of orders currently working (open) across the account. */
  readonly openOrderCount: number;
  /** Total capital currently deployed across all markets (USDC). */
  readonly totalCapitalDeployed: Decimal;
  /** Capital currently deployed in THIS market (USDC). */
  readonly marketCapitalDeployed: Decimal;
  /** Signed directional exposure for the asset AFTER this order (USDC). */
  readonly directionalExposureAfter: Decimal;
  /** Leftover one-sided inventory per side, in shares (this market). */
  readonly residualShares: Decimal;
  /** Unhedged (orphan) inventory for this market, in USDC at mark. */
  readonly orphanInventoryUsdc: Decimal;

  // ---- Losses ----
  /** Realized + unrealized loss so far today, as a positive USDC number. */
  readonly dailyLossUsdc: Decimal;
  /** Realized + unrealized loss for this market so far, as a positive USDC number. */
  readonly marketLossUsdc: Decimal;

  // ---- Data freshness ----
  /** Age of the Polymarket market data snapshot, ms. */
  readonly marketDataAgeMs: number;
  /** Age of the underlying (BTC/ETH spot) data snapshot, ms. */
  readonly underlyingDataAgeMs: number;

  // ---- Account / infrastructure health (tri-state; unknown = no orders) ----
  /**
   * Account reconciliation state. `"reconciled"` = local books match the
   * venue. `undefined` = reconciliation not yet run = no new orders.
   */
  readonly reconciliation: "reconciled" | "unreconciled" | undefined;
  /** REST API health. */
  readonly apiHealth: HealthState | undefined;
  /** Market-data / underlying WebSocket health. */
  readonly wsHealth: HealthState | undefined;

  // ---- Market lifecycle ----
  /** True when the market has been flagged closed/expired by discovery. */
  readonly marketExpired: boolean;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** The full evaluation output: verdict plus the evidence behind it. */
export interface RiskEvaluation {
  readonly allowed: boolean;
  /** Stable machine-parseable reason, e.g. "max_open_orders". */
  readonly reason: string;
  /** Whether the engine is currently halting ALL new orders. */
  readonly halted: boolean;
  /** The limits this evaluation ran against (echoed for the audit trail). */
  readonly limits: RiskLimits;
  /** The exposure/economic snapshot the decision was made on. */
  readonly exposure: {
    readonly orderNotionalUsdc: Decimal;
    readonly totalCapitalDeployed: Decimal;
    readonly marketCapitalDeployed: Decimal;
    readonly directionalExposureAfter: Decimal;
    readonly residualShares: Decimal;
    readonly orphanInventoryUsdc: Decimal;
    readonly dailyLossUsdc: Decimal;
    readonly marketLossUsdc: Decimal;
  };
}

// ---------------------------------------------------------------------------
// Validation (invalid data throws; unknown data fails closed)
// ---------------------------------------------------------------------------

/** Guard for quantities/prices that must be strictly positive. */
function requirePositive(value: Decimal, name: string): void {
  if (decCompare(value, decZero()) <= 0) {
    throw new ValidationError(`risk request ${name} must be positive`);
  }
}

/** Guard for observations that must be non-negative. */
function requireNonNegative(value: Decimal, name: string): void {
  if (decCompare(value, decZero()) < 0) {
    throw new ValidationError(`risk request ${name} must be non-negative`);
  }
}

function requireNonNegativeInt(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(`risk request ${name} must be a non-negative number`);
  }
}

/**
 * Canonical validation of the request. Pure data checks only — a malformed
 * request is a caller bug, so it throws instead of failing closed silently.
 */
export function validateRiskOrderRequest(req: RiskOrderRequest): void {
  if (req.marketId.trim().length === 0) {
    throw new ValidationError("risk request marketId must be a non-empty string");
  }
  if (req.tokenId.trim().length === 0) {
    throw new ValidationError("risk request tokenId must be a non-empty string");
  }
  if (req.outcome !== "up" && req.outcome !== "down") {
    throw new ValidationError(`risk request outcome must be "up" or "down"`);
  }
  if (req.side !== "buy" && req.side !== "sell") {
    throw new ValidationError(`risk request side must be "buy" or "sell"`);
  }
  requirePositive(req.qty, "qty");
  requirePositive(req.price, "price");
  requireNonNegativeInt(req.openOrderCount, "openOrderCount");
  requireNonNegative(req.totalCapitalDeployed, "totalCapitalDeployed");
  requireNonNegative(req.marketCapitalDeployed, "marketCapitalDeployed");
  // NOTE: directionalExposureAfter is intentionally NOT validated as
  // non-negative — it is a signed value (negative = net short the asset).
  requireNonNegative(req.residualShares, "residualShares");
  requireNonNegative(req.orphanInventoryUsdc, "orphanInventoryUsdc");
  requireNonNegative(req.dailyLossUsdc, "dailyLossUsdc");
  requireNonNegative(req.marketLossUsdc, "marketLossUsdc");
  requireNonNegativeInt(req.marketDataAgeMs, "marketDataAgeMs");
  requireNonNegativeInt(req.underlyingDataAgeMs, "underlyingDataAgeMs");
  if (
    req.reconciliation !== undefined &&
    req.reconciliation !== "reconciled" &&
    req.reconciliation !== "unreconciled"
  ) {
    throw new ValidationError(
      `risk request reconciliation must be "reconciled", "unreconciled", or undefined`,
    );
  }
  if (req.apiHealth !== undefined) {
    requireHealthState(req.apiHealth, "apiHealth");
  }
  if (req.wsHealth !== undefined) {
    requireHealthState(req.wsHealth, "wsHealth");
  }
}

function requireHealthState(value: HealthState, name: string): void {
  if (value !== "healthy" && value !== "degraded" && value !== "unhealthy") {
    throw new ValidationError(`risk request ${name} must be a valid health state`);
  }
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one intended order against the risk limits.
 *
 * Canonical check order (first failure wins):
 *   1. market expiration
 *   2. account reconciliation (unknown counts as not reconciled)
 *   3. API health (unknown counts as unhealthy)
 *   4. WebSocket health (unknown counts as unhealthy)
 *   5. stale market data
 *   6. stale underlying data
 *   7. maximum daily loss
 *   8. maximum market loss
 *   9. maximum total capital
 *  10. maximum market capital
 *  11. maximum order size
 *  12. maximum open orders (the new order would occupy one more slot)
 *  13. maximum directional exposure
 *  14. maximum residual inventory
 *  15. maximum orphan inventory
 *
 * Deterministic: identical (request, limits) pairs produce identical
 * evaluations. Fail closed: when in doubt, `allowed: false`.
 */
export function evaluateRiskOrder(req: RiskOrderRequest, limits: RiskLimits): RiskEvaluation {
  validateRiskOrderRequest(req);

  const exposure = {
    orderNotionalUsdc: decMulRound(req.price, req.qty),
    totalCapitalDeployed: req.totalCapitalDeployed,
    marketCapitalDeployed: req.marketCapitalDeployed,
    directionalExposureAfter: req.directionalExposureAfter,
    residualShares: req.residualShares,
    orphanInventoryUsdc: req.orphanInventoryUsdc,
    dailyLossUsdc: req.dailyLossUsdc,
    marketLossUsdc: req.marketLossUsdc,
  } as const;

  const base = { limits, exposure };

  // 1. Market expiration — hard stop.
  if (req.marketExpired) {
    return reject(base, "market_expired", true);
  }

  // 2. Account reconciliation — unknown/unreconciled books, no new orders.
  if (req.reconciliation !== "reconciled") {
    return reject(
      base,
      req.reconciliation === undefined ? "reconciliation_unknown" : "account_unreconciled",
      true,
    );
  }

  // 3./4. Infrastructure health — unknown/degraded/unhealthy, no new orders.
  if (req.apiHealth !== "healthy") {
    return reject(
      base,
      req.apiHealth === undefined ? "api_health_unknown" : `api_health_${req.apiHealth}`,
      true,
    );
  }
  if (req.wsHealth !== "healthy") {
    return reject(
      base,
      req.wsHealth === undefined ? "ws_health_unknown" : `ws_health_${req.wsHealth}`,
      true,
    );
  }

  // 5./6. Data freshness.
  if (req.marketDataAgeMs > limits.maxDataAgeMs) {
    return reject(base, "stale_market_data", true);
  }
  if (req.underlyingDataAgeMs > limits.maxUnderlyingAgeMs) {
    return reject(base, "stale_underlying_data", true);
  }

  // 7. Maximum daily loss (losses are positive numbers).
  if (decCompare(req.dailyLossUsdc, limits.maxDailyLoss) >= 0) {
    return reject(base, "max_daily_loss", true);
  }
  // 8. Maximum market loss.
  if (decCompare(req.marketLossUsdc, limits.maxMarketLoss) >= 0) {
    return reject(base, "max_market_loss", true);
  }

  // 9. Maximum total capital: the order notional must still fit.
  const projectedTotal = decAdd(req.totalCapitalDeployed, notionalOf(req));
  if (decCompare(projectedTotal, limits.maxTotalCapital) > 0) {
    return reject(base, "max_total_capital", false);
  }

  // 10. Maximum market capital.
  const projectedMarket = decAdd(req.marketCapitalDeployed, notionalOf(req));
  if (decCompare(projectedMarket, limits.maxMarketCapital) > 0) {
    return reject(base, "max_market_capital", false);
  }

  // 11. Maximum order size.
  if (decCompare(req.qty, limits.maxOrderSize) > 0) {
    return reject(base, "max_order_size", false);
  }

  // 12. Maximum open orders (the new order would occupy one more slot).
  if (req.openOrderCount + 1 > limits.maxOpenOrders) {
    return reject(base, "max_open_orders", false);
  }

  // 13. Maximum directional exposure (signed: either direction may breach).
  if (
    decCompare(req.directionalExposureAfter, limits.maxDirectionalExposure) > 0 ||
    decCompare(req.directionalExposureAfter, decNeg(limits.maxDirectionalExposure)) < 0
  ) {
    return reject(base, "max_directional_exposure", false);
  }

  // 14. Maximum residual inventory.
  if (decCompare(req.residualShares, limits.maxResidualShares) > 0) {
    return reject(base, "max_residual_inventory", false);
  }

  // 15. Maximum orphan inventory.
  if (decCompare(req.orphanInventoryUsdc, limits.maxOrphanInventory) > 0) {
    return reject(base, "max_orphan_inventory", false);
  }

  return { allowed: true, reason: "ok", halted: false, ...base };
}

function notionalOf(req: RiskOrderRequest): Decimal {
  return decMulRound(req.price, req.qty);
}

function reject(
  base: { limits: RiskLimits; exposure: RiskEvaluation["exposure"] },
  reason: string,
  halted: boolean,
): RiskEvaluation {
  return { allowed: false, reason, halted, ...base };
}
