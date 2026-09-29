/**
 * Inventory package: lot-level acquisition tracking and the complete-set
 * accumulation engine.
 *
 * Owns open-position and cash tracking primitives. The first implemented piece
 * is the complete-set accumulator: it matches acquired up/down lots 1:1 into
 * complete sets (1 up + 1 down = 1 USDC at settlement) and reports whether the
 * combined net cost is below the expected settlement value — pure functions
 * over BigInt Decimals, no order submission.
 */

export {
  DEFAULT_SETTLEMENT_VALUE,
  matchCompleteSets,
  type CompleteSetMatchResult,
  type CompleteSetPortfolio,
  type MatchCompleteSetsInput,
  type MatchedLotPortion,
} from "./complete-set-engine.js";

export {
  CANONICAL_PHASE_MULTIPLIERS,
  phaseMultiplier,
  planRebalance,
  targetResidual,
  type CompleteSetEconomics,
  type EdgeSizingParams,
  type MarketPhase,
  type PhaseMultiplierCurve,
  type RebalanceAction,
  type RebalancePlannerInput,
  type RebalanceRiskLimits,
  type SignalStance,
  type SizingModel,
  type SizingSelection,
  type StrategyDecision,
} from "./rebalancing.js";

export { edgeTargetResidual, type EdgeSizingInput, type EdgeSizingResult } from "./sizing.js";

export {
  createAcquisitionLot,
  lotGrossCost,
  lotNetCost,
  type AcquisitionLot,
  type CreateAcquisitionLotInput,
} from "./lot.js";

export {
  MIN_HEDGE_NOTIONAL_USDC,
  decideHedge,
  residualExposureUsdc,
  volatilityMultiplier,
  type HedgeDecision,
  type HedgeDirection,
  type HedgeEngineInput,
  type HedgeReason,
  type HedgeRiskBudget,
  type HedgeRiskImpact,
  type VolatilityInput,
} from "./hedging.js";

export {
  ReconciliationCoordinator,
  compareStates,
  type CompareInput,
  type DiscrepancyType,
  type LocalState,
  type ReconciliationAction,
  type ReconciliationEvent,
  type ReconciliationResult,
  type ReconciliationTrigger,
  type RemoteBalance,
  type RemoteFillSnapshot,
  type RemoteOrderSnapshot,
  type RemoteState,
} from "./reconciliation.js";
