/**
 * Dynamic hedging DECISION engine.
 *
 * This component is **decision-only by construction**: it produces a
 * `HedgeDecision` describing what a hedge *would* look like, and nothing more.
 * It never connects to an external futures/perpetual exchange, never places
 * hedge orders, and never applies leverage. Passing
 * `externalHedgeEnabled: true` throws — external hedge execution is disabled
 * by default (`ENABLE_EXTERNAL_HEDGE=false`) and has no implementation here.
 *
 * Inputs (all injected, all data): BTC/ETH signal stance, Polymarket lot
 * inventory, the residual exposure it implies, the canonical market phase,
 * realized volatility of the underlying, and the risk budget. Output: a pure
 * `HedgeDecision` with `required`, `asset`, `direction`, `targetSize`,
 * `reason`, `confidence`, and `riskImpact`.
 *
 * Sizing model (T6): exposure is the **binary-option delta notional** of the
 * residual (see `binary-delta.ts`), not the naive |residual| × markPrice:
 *
 *   exposure  = |residualShares| × φ(d2) / (σ √T)   (delta-equivalent USDC)
 *   urgency   = signal|direction| × confidence × phaseMultiplier(phase)
 *               × volatilityMultiplier(volatility)
 *   target    = exposure × urgency
 *   target    = min(target, riskBudget)             (never exceeds budget)
 *
 * with d2 = [ln(S/K) − 0.5σ²T] / (σ√T) from the current underlying spot S,
 * the window strike K, annualized realized volatility σ, and time to expiry
 * T. The binary delta peaks at-the-money and spikes like 1/√T into expiry
 * (pin risk), and collapses in both moneyness tails — so the hedge demand
 * concentrates exactly where the position is actually risky. At expiry the
 * model returns 0 (settled: nothing left to hedge); the naive mark fallback
 * (`exposureModel: "mark"`) stays selectable for A/B comparison and as the
 * degraded mode when spot/strike data is unavailable.
 *
 * The float-valued delta model is converted to exact `Decimal` at this
 * engine's boundary (`decFromString(x.toFixed(8))`); every USDC computation
 * downstream remains BigInt Decimal per AGENTS.md rule 1.
 */

import {
  ValidationError,
  decCompare,
  decDivRound,
  decFromString,
  decIsZero,
  decMin,
  decMulRound,
  decNeg,
  decSub,
  decToString,
  decZero,
  type AssetSymbol,
  type Decimal,
  type Millis,
} from "@bot/domain";

import { matchCompleteSets, type AcquisitionLot } from "./complete-set-engine.js";
import {
  CANONICAL_PHASE_MULTIPLIERS,
  phaseMultiplier,
  type MarketPhase,
  type PhaseMultiplierCurve,
  type SignalStance,
} from "./rebalancing.js";
import { binaryDeltaNotionalUsdc } from "./binary-delta.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Realized-volatility regime of the underlying, expressed as a fraction. */
export interface VolatilityInput {
  /**
   * Annualized-or-realized volatility as a plain fraction (e.g. "0.40" = 40%).
   * Must be >= 0. Scaling is piecewise-constant, so any non-negative fraction
   * maps deterministically to a regime.
   */
  readonly fraction: Decimal;
}

/** Risk budget granted to the hedging engine, in USDC. */
export interface HedgeRiskBudget {
  /**
   * Maximum notional the hedge may target, in USDC. The engine never proposes
   * a target above it, and never proposes a target above the exposure itself
   * (no leverage).
   */
  readonly maxNotionalUsdc: Decimal;
}

export interface HedgeEngineInput {
  /** Underlying asset the signal was computed for. */
  readonly asset: AssetSymbol;
  /** BTC/ETH signal stance (direction in [-1, 1], confidence in [0, 1]). */
  readonly signal: SignalStance;
  /** Polymarket acquisition lots held for this asset's market. */
  readonly upLots: readonly AcquisitionLot[];
  readonly downLots: readonly AcquisitionLot[];
  /** Mark price per share (USDC) used to size the residual exposure. */
  readonly markPrice: Decimal;
  /** Canonical phase of the 5-minute cycle. */
  readonly phase: MarketPhase;
  /** Realized volatility of the underlying. */
  readonly volatility: VolatilityInput;
  /** Risk budget. */
  readonly risk: HedgeRiskBudget;
  /**
   * External hedge execution switch. Mirrors ENABLE_EXTERNAL_HEDGE. Must be
   * false: the engine is decision-only. Passing true throws.
   */
  readonly externalHedgeEnabled?: boolean | undefined;
  /** Wall-clock instant of the decision (injected, never read). */
  readonly at: Millis;
  /**
   * T6 exposure model. "mark" (default when no delta inputs are given)
   * keeps the legacy `|residual| × markPrice` sizing; "delta" sizes the
   * residual exposure with the binary-option delta model from `spot`,
   * `strike`, `annualizedVol`, and `msToExpiry`. Providing the four delta
   * inputs without an explicit model selects "delta"; an explicit "delta"
   * with missing inputs throws.
   */
  readonly exposureModel?: "delta" | "mark" | undefined;
  /** Current underlying spot price, USDC (> 0). Required for "delta". */
  readonly spot?: number | undefined;
  /** Window strike (price-to-beat), USDC (> 0). Required for "delta". */
  readonly strike?: number | undefined;
  /**
   * Annualized realized volatility as a fraction (> 0, e.g. 0.6). Required
   * for "delta"; UNVERIFIED scaling: callers convert their realized vol of
   * the window so far to an annualized figure with their own convention.
   */
  readonly annualizedVol?: number | undefined;
  /** Milliseconds to expiry (>= 0). Required for "delta"; 0 = settled. */
  readonly msToExpiry?: number | undefined;
  /** Phase-multiplier curve (T7); defaults to the canonical curve. */
  readonly phaseMultipliers?: PhaseMultiplierCurve | undefined;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Direction of the hedge relative to the residual exposure being hedged. */
export type HedgeDirection = "long" | "short" | "none";

/** Why the engine wants (or does not want) a hedge. */
export type HedgeReason =
  | "no_residual_exposure"
  | "below_min_hedge_notional"
  | "risk_budget_exhausted"
  | "residual_hedge_below_max"
  | "residual_hedge_above_max";

/** Everything risk needs to judge the hedge, without executing it. */
export interface HedgeRiskImpact {
  /** Residual exposure being hedged, in USDC (residualShares × markPrice). */
  readonly exposureUsdc: Decimal;
  /** Hedge target notional, in USDC (never above exposure or budget). */
  readonly hedgeNotionalUsdc: Decimal;
  /** Exposure remaining after the hedge would be applied, in USDC. */
  readonly remainingExposureUsdc: Decimal;
  /** Fraction of exposure covered (target / exposure), at most 1 (no leverage). */
  readonly coverageFraction: Decimal;
  /** True when the target hit the risk-budget cap rather than the model size. */
  readonly budgetCapped: boolean;
  /** True when the target hit the no-leverage cap (equal to exposure). */
  readonly atFullCoverage: boolean;
}

/** A decision-only hedge intent. Data, never an order. */
export interface HedgeDecision {
  /** True when a hedge is recommended; false means explicitly "no hedge". */
  readonly required: boolean;
  /** Underlying asset the hedge would target (BTC/ETH). */
  readonly asset: AssetSymbol;
  /**
   * Direction that *offsets* the residual exposure: a long-Up residual needs a
   * short hedge, a long-Down residual needs a long hedge.
   */
  readonly direction: HedgeDirection;
  /** Hedge target size, in USDC notional (0 when not required). */
  readonly targetSize: Decimal;
  /** Why this decision was made. */
  readonly reason: HedgeReason;
  /** Urgency of the hedge in [0, 1] (signal × phase × volatility product). */
  readonly confidence: Decimal;
  /** Risk accounting of the hedge. */
  readonly riskImpact: HedgeRiskImpact;
  /** The phase used for the decision (audit trail). */
  readonly phase: MarketPhase;
  /** When the decision was made (injected). */
  readonly decidedAt: Millis;
}

// ---------------------------------------------------------------------------
// Deterministic scaling curves
// ---------------------------------------------------------------------------

const ZERO = decZero();
const ONE = decFromString("1");

/**
 * Volatility multiplier (piecewise-constant, deterministic):
 * - < 20%  → 0.5 (calm book: hedge lazily)
 * - < 40%  → 0.75
 * - < 60%  → 1.0 (baseline)
 * - >= 60% → 1.25 (turbulence: hedge more of the exposure)
 */
export function volatilityMultiplier(volatility: VolatilityInput): Decimal {
  const v = volatility.fraction;
  if (decCompare(v, ZERO) < 0) {
    throw new ValidationError("volatility fraction must be non-negative");
  }
  if (decCompare(v, decFromString("0.20")) < 0) return decFromString("0.5");
  if (decCompare(v, decFromString("0.40")) < 0) return decFromString("0.75");
  if (decCompare(v, decFromString("0.60")) < 0) return ONE;
  return decFromString("1.25");
}

/** Below this hedge notional (USDC) a hedge is judged not worth doing. */
export const MIN_HEDGE_NOTIONAL_USDC = decFromString("1.00");

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Decide (never execute) whether the residual Polymarket exposure needs an
 * external hedge. Pure and deterministic: identical inputs produce identical
 * decisions. Rejects `externalHedgeEnabled: true`, rejects negative inputs,
 * and never proposes leverage (target ≤ exposure) or budget overrun.
 */
export function decideHedge(input: HedgeEngineInput): HedgeDecision {
  if (input.externalHedgeEnabled === true) {
    throw new ValidationError(
      "external hedge execution is disabled (ENABLE_EXTERNAL_HEDGE=false); the hedging engine is decision-only",
    );
  }
  if (decCompare(input.markPrice, ZERO) <= 0) {
    throw new ValidationError("mark price must be positive");
  }
  if (decCompare(input.risk.maxNotionalUsdc, ZERO) < 0) {
    throw new ValidationError("risk budget must be non-negative");
  }

  // ---- 0. Exposure model selection (T6) ----
  // Default: "mark" (the legacy |residual| × markPrice sizing) so existing
  // callers behave unchanged. The delta model activates when explicitly
  // selected OR implicitly when all four delta inputs are provided — but an
  // explicit "delta" with missing inputs throws (fail closed, no silent
  // fallback). The float model output is quantized to the exact Decimal
  // boundary here; all downstream USDC math stays BigInt-exact.
  const deltaInputsProvided =
    input.spot !== undefined &&
    input.strike !== undefined &&
    input.annualizedVol !== undefined &&
    input.msToExpiry !== undefined;
  const exposureModel: "delta" | "mark" =
    input.exposureModel ?? (deltaInputsProvided ? "delta" : "mark");
  if (exposureModel === "delta" && !deltaInputsProvided) {
    throw new ValidationError(
      'exposureModel "delta" requires spot, strike, annualizedVol, and msToExpiry',
    );
  }
  const deltaExposureUsdc = (): Decimal => {
    const net = Number(decToString(netResidualShares));
    const notional = binaryDeltaNotionalUsdc({
      spot: input.spot as number,
      strike: input.strike as number,
      annualizedVol: input.annualizedVol as number,
      msToExpiry: input.msToExpiry as number,
      shares: net,
    });
    return decFromString(notional.toFixed(8));
  };

  // ---- 1. Residual exposure from lot-level matching (never force-neutral) --
  const match = matchCompleteSets({
    upLots: input.upLots,
    downLots: input.downLots,
    settlementValue: ONE,
  });
  const residualUp = match.residualUp;
  const residualDown = match.residualDown;
  const netResidualShares = decSub(residualUp, residualDown);

  // Model exposure (T6): binary delta when configured, legacy mark otherwise.
  const modelExposure = exposureModel === "delta" ? deltaExposureUsdc() : undefined;
  const exposureUsdc =
    modelExposure !== undefined
      ? modelExposure
      : decAbs(decMulRound(netResidualShares, input.markPrice));

  const noHedge = (reason: HedgeReason): HedgeDecision => {
    const noHedgeExposureUsdc =
      reason === "no_residual_exposure"
        ? ZERO
        : modelExposure !== undefined
          ? modelExposure
          : decMulRound(decAbs(netResidualShares), input.markPrice);
    return {
      required: false,
      asset: input.asset,
      direction: "none",
      targetSize: ZERO,
      reason,
      confidence: ZERO,
      riskImpact: {
        exposureUsdc: noHedgeExposureUsdc,
        hedgeNotionalUsdc: ZERO,
        remainingExposureUsdc: noHedgeExposureUsdc,
        coverageFraction: ZERO,
        budgetCapped: false,
        atFullCoverage: false,
      },
      phase: input.phase,
      decidedAt: input.at,
    };
  };

  if (decIsZero(netResidualShares) || decIsZero(exposureUsdc)) {
    return noHedge("no_residual_exposure");
  }

  // ---- 2. Urgency: signal × phase × volatility, clamped to [0, 1] ----
  // Urgency is a confidence-like quantity: volatility can push the product to
  // its ceiling (full coverage) but never beyond it — that is the no-leverage
  // guarantee at the sizing-input level as well.
  assertBounded(input.signal.direction, decFromString("-1"), ONE, "signal direction");
  assertBounded(input.signal.confidence, ZERO, ONE, "signal confidence");
  const urgency = decMin(
    decMulRound(
      decMulRound(decAbs(input.signal.direction), input.signal.confidence),
      decMulRound(
        phaseMultiplier(input.phase, input.phaseMultipliers ?? CANONICAL_PHASE_MULTIPLIERS),
        volatilityMultiplier(input.volatility),
      ),
    ),
    ONE,
  );

  // ---- 3. Model target, then cap by budget AND by the exposure itself ----
  // Capping at the exposure guarantees no leverage: the hedge can at most
  // fully cover the residual, never multiply it.
  const modelTarget = decMulRound(exposureUsdc, urgency);
  const targetSize = decMin(decMin(modelTarget, input.risk.maxNotionalUsdc), exposureUsdc);
  const budgetCapped = decCompare(input.risk.maxNotionalUsdc, modelTarget) < 0;

  // A budget below the minimum hedge notional cannot fund any hedge.
  if (decCompare(input.risk.maxNotionalUsdc, MIN_HEDGE_NOTIONAL_USDC) < 0) {
    return noHedge("risk_budget_exhausted");
  }
  if (decCompare(targetSize, MIN_HEDGE_NOTIONAL_USDC) < 0) {
    return noHedge("below_min_hedge_notional");
  }

  // ---- 4. Direction offsets the residual: long-Up residual -> short hedge ----
  const residualIsLongUp = decCompare(netResidualShares, ZERO) > 0;
  const direction: HedgeDirection = residualIsLongUp ? "short" : "long";

  const atFullCoverage = decCompare(targetSize, exposureUsdc) >= 0;
  // Flag when the residual exposure itself exceeds the budgeted maximum: the
  // hedge can then only be partial, and risk should see that explicitly.
  const aboveMax = decCompare(exposureUsdc, input.risk.maxNotionalUsdc) > 0;

  return {
    required: true,
    asset: input.asset,
    direction,
    targetSize,
    reason: aboveMax ? "residual_hedge_above_max" : "residual_hedge_below_max",
    confidence: urgency,
    riskImpact: {
      exposureUsdc,
      hedgeNotionalUsdc: targetSize,
      remainingExposureUsdc: decSub(exposureUsdc, targetSize),
      coverageFraction: decDivRound(targetSize, exposureUsdc),
      budgetCapped,
      atFullCoverage,
    },
    phase: input.phase,
    decidedAt: input.at,
  };
}

function assertBounded(value: Decimal, lo: Decimal, hi: Decimal, name: string): void {
  if (decCompare(value, lo) < 0 || decCompare(value, hi) > 0) {
    throw new ValidationError(`${name} must be in [${decToString(lo)}, ${decToString(hi)}]`);
  }
}

function decAbs(value: Decimal): Decimal {
  return decCompare(value, ZERO) < 0 ? decNeg(value) : value;
}

/** Sum the quantities of a lot list (exported for callers' sanity checks). */
export function residualExposureUsdc(
  upLots: readonly AcquisitionLot[],
  downLots: readonly AcquisitionLot[],
  markPrice: Decimal,
): { upShares: Decimal; downShares: Decimal; netShares: Decimal; exposureUsdc: Decimal } {
  const match = matchCompleteSets({ upLots, downLots, settlementValue: ONE });
  const netShares = decSub(match.residualUp, match.residualDown);
  return {
    upShares: match.residualUp,
    downShares: match.residualDown,
    netShares,
    exposureUsdc: decAbs(decMulRound(netShares, markPrice)),
  };
}
