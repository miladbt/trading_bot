/**
 * Risk limits: the authoritative numbers every order is checked against.
 *
 * Limits are plain data (BigInt `Decimal`s for money/shares, ints for counts
 * and ms). `riskLimitsFromConfig` maps the validated `AppConfig` groups
 * (risk, strategy) onto them, so there is exactly one source of truth: the
 * environment-derived config. Nothing in this package reads env or clock.
 */

import type { Decimal } from "@bot/domain";
import type { AppConfig } from "@bot/shared";

export interface RiskLimits {
  /** Maximum total capital deployed across all markets (USDC). */
  readonly maxTotalCapital: Decimal;
  /** Maximum capital in any single market (USDC). */
  readonly maxMarketCapital: Decimal;
  /** Hard cap on any single order's size (shares). */
  readonly maxOrderSize: Decimal;
  /** Maximum concurrently open orders. */
  readonly maxOpenOrders: number;
  /** Maximum signed directional exposure per asset (USDC). */
  readonly maxDirectionalExposure: Decimal;
  /** Maximum leftover one-sided inventory per side, in shares. */
  readonly maxResidualShares: Decimal;
  /** Maximum unhedged (orphan) inventory per market, in USDC at mark. */
  readonly maxOrphanInventory: Decimal;
  /** Daily loss cutoff (USDC); trading stops when the loss reaches it. */
  readonly maxDailyLoss: Decimal;
  /** Per-market loss cutoff (USDC); that market stops when the loss reaches it. */
  readonly maxMarketLoss: Decimal;
  /** Maximum age of market (Polymarket) data before trading pauses, ms. */
  readonly maxDataAgeMs: number;
  /** Maximum age of underlying (BTC/ETH spot) data before trading pauses, ms. */
  readonly maxUnderlyingAgeMs: number;
}

/** Map the validated AppConfig onto the engine's limit set. */
export function riskLimitsFromConfig(config: AppConfig): RiskLimits {
  return {
    maxTotalCapital: config.risk.maxTotalCapital,
    maxMarketCapital: config.risk.maxMarketCapital,
    maxOrderSize: config.strategy.maxOrderSize,
    maxOpenOrders: config.risk.maxOpenOrders,
    maxDirectionalExposure: config.risk.maxDirectionalExposure,
    maxResidualShares: config.strategy.maxResidual,
    maxOrphanInventory: config.risk.maxOrphanInventory,
    maxDailyLoss: config.risk.maxDailyLoss,
    maxMarketLoss: config.risk.maxMarketCapital,
    maxDataAgeMs: config.risk.maxDataAgeMs,
    maxUnderlyingAgeMs: config.risk.maxDataAgeMs,
  };
}
