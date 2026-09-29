/**
 * Hybrid inventory rebalancing planner.
 *
 * Combines four concerns into one pure, deterministic plan:
 *
 * 1. **Complete-set accumulation** — when the executable combined ask
 *    (`upPrice + downPrice + per-set costs`) is below the expected settlement
 *    value, buying both sides is positive-edge and neutral. The planner buys
 *    `accumulationSets` full sets first (budget-clamped).
 * 2. **Inventory rebalancing** — the signal-derived *target residual*
 *    `direction × confidence × maxResidual × phaseMultiplier` (shares per
 *    side; `maxResidual` from config). The plan's rebalance actions move the
 *    current residual toward the target on whichever side is light.
 * 3. **Directional residual exposure** — the residual is deliberate: the
 *    planner never assumes complete sets make the book neutral. Example:
 *    200 Up and 150 Down is 150 complete sets plus a 50 Up residual, kept
 *    as-is unless the signal target or risk says otherwise.
 * 4. **Dynamic hedging** — when a residual exceeds the configured
 *    `maxResidual` (and the other side is flat), the planner buys the light
 *    side with the overshoot quantity. Those new lots match the orphan on the
 *    next matching pass, converting the orphan into complete sets.
 *
 * Output is a `StrategyDecision`: pure data describing desired inventory and
 * intent. It is NOT an order and MUST NOT place one — the pipeline is
 * strategy -> risk (RiskDecision) -> execution (TradingDecision), and risk has
 * final say.
 *
 * All arithmetic is BigInt `Decimal` (8 dp); no floats anywhere.
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decDivTrunc,
  decFromString,
  decIsZero,
  decMax,
  decMin,
  decMulRound,
  decNeg,
  decSub,
  decToString,
  decZero,
  type Decimal,
  type MarketId,
  type Millis,
  type Outcome,
} from "@bot/domain";

import { matchCompleteSets, type AcquisitionLot } from "./complete-set-engine.js";
import { edgeTargetResidual } from "./sizing.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Directional stance of the strategy signal. */
export interface SignalStance {
  /**
   * Signed direction: positive = bullish (favor Up), negative = bearish
   * (favor Down), 0 = neutral. Must be in [-1, 1].
   */
  readonly direction: Decimal;
  /** Confidence in [0, 1]; scales how much residual the signal justifies. */
  readonly confidence: Decimal;
}

/** Where we are in the 5-minute cycle (canonical phase engine output). */
export type MarketPhase = "EARLY" | "MID" | "LATE" | "FINAL";

/**
 * Target-residual sizing model (T1):
 * - `directional` (legacy default): `direction × confidence × maxResidual ×
 *   phaseMultiplier`.
 * - `edge`: fractional-Kelly on the net-of-fee edge between the model
 *   probability and the executable asks (see `sizing.ts`). Kept selectable so
 *   the backtest can A/B the two.
 */
export type SizingModel = "directional" | "edge";

/** Edge-model parameters; required when the sizing model is "edge". */
export interface EdgeSizingParams {
  /** Model probability that Up wins, in [0, 1] (uncalibrated prior — T2). */
  readonly pUp: Decimal;
  /** Taker fee rate (verified crypto default; config `FEE_TAKER_RATE`). */
  readonly takerFeeRate: Decimal;
  /** Kelly fraction in (0, 1] (config `STRATEGY_KELLY_FRACTION`). */
  readonly kellyFraction: Decimal;
  /** Minimum net edge to trade at all (config `STRATEGY_MIN_EDGE`). */
  readonly minEdge: Decimal;
}

export interface SizingSelection {
  readonly model: SizingModel;
  readonly edge?: EdgeSizingParams | undefined;
}

/** Risk limits the planner must never exceed. */
export interface RebalanceRiskLimits {
  /** Maximum directional (orphan) inventory per side, in shares. */
  readonly maxDirectionalShares: Decimal;
  /** Maximum capital this plan may commit in total, in USDC. */
  readonly maxCapital: Decimal;
  /**
   * Capital currently available (unspent), in USDC. Action costs are
   * truncated to it — never exceeded.
   */
  readonly availableCapital: Decimal;
}

/** The combined executable economics of one complete set. */
export interface CompleteSetEconomics {
  /** Executable ask for one Up share (e.g. best ask). */
  readonly upPrice: Decimal;
  /** Executable ask for one Down share (e.g. best ask). */
  readonly downPrice: Decimal;
  /** Expected value of one set at settlement (1 USDC by default). */
  readonly settlementValue: Decimal;
  /**
   * Per-set costs (fees net of rebates) to buy one Up + one Down share.
   * Normally 0 on Polymarket taker flow; injectable for generality.
   */
  readonly perSetCosts?: Decimal | undefined;
}

export interface RebalancePlannerInput {
  readonly marketId: MarketId;
  readonly signal: SignalStance;
  readonly phase: MarketPhase;
  /** Currently held acquisition lots (both sides, any mix). */
  readonly upLots: readonly AcquisitionLot[];
  readonly downLots: readonly AcquisitionLot[];
  /** Combined-set economics used for the accumulation decision. */
  readonly economics: CompleteSetEconomics;
  /** Risk limits; actions are clamped to all of them. */
  readonly risk: RebalanceRiskLimits;
  /**
   * Configured maximum acceptable residual (shares per side) — also the scale
   * of the signal-derived target: `direction * confidence * maxResidual`.
   */
  readonly maxResidual: Decimal;
  /**
   * Sizing-model selection (T1). Defaults to the legacy `directional` model
   * when omitted, preserving the historical behavior bit-for-bit.
   */
  readonly sizing?: SizingSelection | undefined;
  /** Wall-clock instant of the planning decision (injected, never read). */
  readonly at: Millis;
}

// ---------------------------------------------------------------------------
// Output: StrategyDecision (data, never an order submission)
// ---------------------------------------------------------------------------

/** One proposed rebalancing action. Still just data — risk gates it next. */
export interface RebalanceAction {
  readonly kind: "accumulate_sets" | "rebalance_up" | "rebalance_down";
  /** Outcome the action trades. */
  readonly outcome: Outcome;
  /** Shares to buy (always positive; the planner never proposes shorts). */
  readonly qty: Decimal;
  /** Limit price per share the action is willing to pay. */
  readonly price: Decimal;
  /** Estimated USDC cost of the action at `price`. */
  readonly estimatedCost: Decimal;
  /** Why this action exists (audit trail). */
  readonly reason: string;
}

/**
 * The strategy-layer plan. `actions` are intents for risk/execution to vet —
 * nothing here submits orders.
 */
export interface StrategyDecision {
  readonly marketId: MarketId;
  readonly decidedAt: Millis;
  readonly phase: MarketPhase;
  /** Current matched-set quantity from the lot inventory. */
  currentSets: Decimal;
  /** Current leftover inventory per side (never force-neutralized). */
  residualUp: Decimal;
  residualDown: Decimal;
  /** Signed residual: up - down (positive = long up). */
  netResidual: Decimal;
  /** Signal-derived target residual per side (signed by direction). */
  targetResidualUp: Decimal;
  targetResidualDown: Decimal;
  /** Delta to the target per side (positive = buy that side to reach it). */
  deltaUp: Decimal;
  deltaDown: Decimal;
  /** Full sets the planner wants to buy (budget-clamped; 0 without edge). */
  accumulationSets: Decimal;
  /** Whether the combined set ask is below settlement value after costs. */
  setEdgePositive: boolean;
  /** Set edge per set: settlementValue - (up + down + perSetCosts). */
  setEdgePerSet: Decimal;
  /** The proposed actions, in priority order (accumulation first). */
  actions: readonly RebalanceAction[];
  /** Total estimated cost of all actions; never above the budget. */
  estimatedTotalCost: Decimal;
  /** True when no action is proposed (at target / no edge / no budget). */
  isFlat: boolean;
}

// ---------------------------------------------------------------------------
// Signal-derived target
// ---------------------------------------------------------------------------

const ZERO = decZero();
const ONE = decFromString("1");
const MINUS_ONE = decFromString("-1");

function assertBounded(value: Decimal, lo: Decimal, hi: Decimal, name: string): void {
  if (decCompare(value, lo) < 0 || decCompare(value, hi) > 0) {
    throw new ValidationError(`${name} must be in [${decToString(lo)}, ${decToString(hi)}]`);
  }
}

/**
 * Phase multiplier on the signal-derived target residual: the later the phase,
 * the less directional exposure is justified (settlement approaches and there
 * is less time to correct a wrong directional bet).
 */
export function phaseMultiplier(phase: MarketPhase): Decimal {
  switch (phase) {
    case "EARLY":
      return ONE;
    case "MID":
      return decFromString("0.75");
    case "LATE":
      return decFromString("0.5");
    case "FINAL":
      return decFromString("0.25");
  }
}

/**
 * Signal-derived target residual per side:
 * `direction * confidence * maxResidual * phaseMultiplier`, clamped to
 * `[-maxResidual, +maxResidual]` and to risk's directional cap.
 * A positive result is held as an Up residual, a negative one as a Down
 * residual; both sides are never targeted simultaneously.
 */
export function targetResidual(
  signal: SignalStance,
  phase: MarketPhase,
  maxResidual: Decimal,
  maxDirectionalShares: Decimal,
): { up: Decimal; down: Decimal } {
  assertBounded(signal.direction, MINUS_ONE, ONE, "signal direction");
  assertBounded(signal.confidence, ZERO, ONE, "signal confidence");
  if (decCompare(maxResidual, ZERO) < 0) {
    throw new ValidationError("maxResidual must be non-negative");
  }
  if (decCompare(maxDirectionalShares, ZERO) < 0) {
    throw new ValidationError("maxDirectionalShares must be non-negative");
  }
  const scaled = decMulRound(
    decMulRound(decMulRound(signal.direction, signal.confidence), maxResidual),
    phaseMultiplier(phase),
  );
  const cap = decMin(maxResidual, maxDirectionalShares);
  const capped = decMin(decMax(scaled, decNeg(cap)), cap);
  if (decCompare(capped, ZERO) > 0) return { up: capped, down: ZERO };
  if (decCompare(capped, ZERO) < 0) return { up: ZERO, down: decNeg(capped) };
  return { up: ZERO, down: ZERO };
}

// ---------------------------------------------------------------------------
// Core planner
// ---------------------------------------------------------------------------

/**
 * Plan the hybrid rebalance for one market. Pure and deterministic: the same
 * inputs always produce the same StrategyDecision.
 *
 * Invariants:
 * - never exceeds `maxDirectionalShares` on either side
 * - never commits more than `min(availableCapital, maxCapital)` in total
 *   (affordability uses truncated division, so rounding cannot overspend)
 * - never proposes negative inventory (buy-side intents only; risk and
 *   execution own any sell semantics against holdings)
 * - never assumes complete sets neutralize the residual
 */
export function planRebalance(input: RebalancePlannerInput): StrategyDecision {
  const { economics, risk } = input;
  if (decCompare(economics.upPrice, ZERO) <= 0 || decCompare(economics.downPrice, ZERO) <= 0) {
    throw new ValidationError("set economics prices must be positive");
  }
  if (decCompare(economics.settlementValue, ZERO) <= 0) {
    throw new ValidationError("settlement value must be positive");
  }
  if (decCompare(input.maxResidual, ZERO) < 0) {
    throw new ValidationError("maxResidual must be non-negative");
  }
  if (decCompare(risk.maxDirectionalShares, ZERO) < 0 || decCompare(risk.maxCapital, ZERO) < 0) {
    throw new ValidationError("risk limits must be non-negative");
  }
  if (decCompare(risk.availableCapital, ZERO) < 0) {
    throw new ValidationError("availableCapital must be non-negative");
  }

  // ---- 1. Current inventory: lot-level matching, never forced neutral ----
  const match = matchCompleteSets({
    upLots: input.upLots,
    downLots: input.downLots,
    settlementValue: economics.settlementValue,
  });
  const residualUp = match.residualUp;
  const residualDown = match.residualDown;
  const netResidual = decSub(residualUp, residualDown);

  // ---- 2. Target residual from the selected sizing model ----
  const sizing = input.sizing;
  const target =
    sizing !== undefined && sizing.model === "edge" && sizing.edge !== undefined
      ? (() => {
          const r = edgeTargetResidual({
            pUp: sizing.edge.pUp,
            askUp: economics.upPrice,
            askDown: economics.downPrice,
            takerFeeRate: sizing.edge.takerFeeRate,
            kellyFraction: sizing.edge.kellyFraction,
            minEdge: sizing.edge.minEdge,
            maxResidual: input.maxResidual,
            maxDirectionalShares: risk.maxDirectionalShares,
          });
          return decCompare(r.target, ZERO) > 0
            ? { up: r.target, down: ZERO }
            : { up: ZERO, down: decNeg(r.target) };
        })()
      : targetResidual(input.signal, input.phase, input.maxResidual, risk.maxDirectionalShares);
  // Delta: what to add (per side) to move current -> target.
  const deltaUp = decSub(target.up, residualUp);
  const deltaDown = decSub(target.down, residualDown);

  // ---- 3. Complete-set accumulation edge ----
  const perSetCosts = economics.perSetCosts ?? ZERO;
  const setCost = decAdd(decAdd(economics.upPrice, economics.downPrice), perSetCosts);
  const setEdgePerSet = decSub(economics.settlementValue, setCost);
  const setEdgePositive = decCompare(setEdgePerSet, ZERO) > 0;

  // ---- 4. Actions, budget-clamped (truncation keeps spend <= budget) ----
  const budget = decMin(risk.availableCapital, risk.maxCapital);
  const actions: RebalanceAction[] = [];
  let spent = ZERO;
  const budgetLeft = (): Decimal => decSub(budget, spent);

  /**
   * Dust floor: an action must cost at least one micro-USDC (1e-6) to be
   * worth proposing. Fractional-share affordability (8 dp) can otherwise
   * leave a meaningless trailing action (e.g. 0.00000002 shares for
   * 0.00000001 USDC) after a prior action consumed nearly all the budget.
   */
  const MIN_ACTION_COST = decFromString("0.000001");
  const worthwhile = (cost: Decimal): boolean => decCompare(cost, MIN_ACTION_COST) >= 0;

  // Priority 1: buy complete sets while the edge is positive. A set adds one
  // share to EACH side, so it never changes the residuals — pure neutrality.
  let accumulationSets = ZERO;
  if (setEdgePositive && decCompare(budgetLeft(), setCost) >= 0) {
    const qty = decDivTrunc(budgetLeft(), setCost);
    const cost = decMulRound(setCost, qty);
    if (decCompare(qty, ZERO) > 0 && worthwhile(cost)) {
      accumulationSets = qty;
      spent = decAdd(spent, cost);
      actions.push({
        kind: "accumulate_sets",
        outcome: "up",
        qty,
        price: setCost,
        estimatedCost: cost,
        reason: "complete_set_arbitrage",
      });
    }
  }

  // Priority 2: move the residual toward the target (both sides supported).
  const rebalanceSide = (outcome: Outcome, delta: Decimal, price: Decimal): void => {
    if (decCompare(delta, ZERO) <= 0) return; // target already met on this side
    const current = outcome === "up" ? residualUp : residualDown;
    const room = decSub(risk.maxDirectionalShares, current);
    if (decCompare(room, ZERO) <= 0) return; // directional cap already reached
    const qty = decMin(decMin(delta, room), decDivTrunc(budgetLeft(), price));
    const cost = decMulRound(price, qty);
    if (decCompare(qty, ZERO) <= 0 || !worthwhile(cost)) return; // no budget / dust
    spent = decAdd(spent, cost);
    actions.push({
      kind: outcome === "up" ? "rebalance_up" : "rebalance_down",
      outcome,
      qty,
      price,
      estimatedCost: cost,
      reason: "residual_target",
    });
  };
  rebalanceSide("up", deltaUp, economics.upPrice);
  rebalanceSide("down", deltaDown, economics.downPrice);

  // Priority 3: dynamic hedging — when a residual exceeds the configured
  // maxResidual while the other side is flat, buy the light side with the
  // overshoot quantity. The new lots match the orphan on the next matching
  // pass, converting it into complete sets.
  const hedge = (overshoot: Decimal, outcome: Outcome, price: Decimal): void => {
    if (decCompare(overshoot, ZERO) <= 0) return;
    const qty = decDivTrunc(budgetLeft(), price);
    const capped = decMin(overshoot, qty);
    const cost = decMulRound(price, capped);
    if (decCompare(capped, ZERO) <= 0 || !worthwhile(cost)) return;
    spent = decAdd(spent, cost);
    actions.push({
      kind: outcome === "up" ? "rebalance_up" : "rebalance_down",
      outcome,
      qty: capped,
      price,
      estimatedCost: cost,
      reason: "hedge_orphan_residual",
    });
  };
  if (decIsZero(residualDown)) {
    hedge(decSub(residualUp, input.maxResidual), "down", economics.downPrice);
  } else if (decIsZero(residualUp)) {
    hedge(decSub(residualDown, input.maxResidual), "up", economics.upPrice);
  }

  return {
    marketId: input.marketId,
    decidedAt: input.at,
    phase: input.phase,
    currentSets: match.matchedSets,
    residualUp,
    residualDown,
    netResidual,
    targetResidualUp: target.up,
    targetResidualDown: target.down,
    deltaUp,
    deltaDown,
    accumulationSets,
    setEdgePositive,
    setEdgePerSet,
    actions,
    estimatedTotalCost: spent,
    isFlat: actions.length === 0,
  };
}
