// Primitives
export type {
  AssetSymbol,
  FillId,
  MarketId,
  MarketSlug,
  Millis,
  OrderId,
  PositionId,
  Tagged,
  TokenId,
  UtcIso,
} from "./brand.js";
export { DomainError, InvalidTransitionError, ValidationError, isDomainError } from "./errors.js";
export { err, ok, tryParse, type Result } from "./result.js";

// Decimal (financial arithmetic)
export {
  DecimalParseError,
  MAX_PARSE_DECIMALS,
  SCALE,
  SCALE_FACTOR,
  decAbs,
  decAdd,
  decCompare,
  decDivMod,
  decDivRound,
  decDivTrunc,
  decEquals,
  decFromInt,
  decFromNumber,
  decFromScaled,
  decFromString,
  decIsNegative,
  decIsPositive,
  decIsZero,
  decMax,
  decMin,
  decMulRound,
  decMulTrunc,
  decNeg,
  decOne,
  decPctOf,
  decSub,
  decToNumber,
  decToScaled,
  decToString,
  decZero,
  type Decimal,
  type RationalDivisionResult,
} from "./decimal.js";

// Time
export {
  isAfter,
  isBefore,
  millis,
  millisToUtcIso,
  minutesBetween,
  nowMillis,
  secondsBetween,
  utcIso,
  utcIsoToMillis,
} from "./time.js";

// 5-minute market phase engine (canonical EARLY/MID/LATE/FINAL)
export {
  CYCLE_PHASES,
  DEFAULT_PHASE_BOUNDARIES,
  clampClockSkew,
  cycleTimeline,
  msRemaining,
  cyclePhaseAt,
  cyclePositionOf,
  phaseSchedule,
  validateBoundaries,
  validateTimeline,
  type CyclePhase,
  type CyclePosition,
  type CycleTimeline,
  type PhaseBoundaries,
  type PhaseError,
  type PhaseErrorReason,
  type PhaseSchedule,
} from "./phase-engine.js";

// Ids
export { assetSymbol, fillId, marketId, marketSlug, orderId, positionId, tokenId } from "./ids.js";
// Types
export type { Outcome, Side } from "./types.js";

// Market
export {
  MARKET_PHASES,
  OUTCOMES,
  bestAsk,
  bestBid,
  canTransitionPhase,
  costToBuy,
  createAsset,
  createMarket,
  createOrderBook,
  isTradable,
  marketTokenIds,
  midPrice,
  outcomeOfToken,
  otherOutcome,
  parseOutcome,
  phaseAt,
  proceedsToSell,
  spread,
  sweepBook,
  tokenForOutcome,
  transitionPhase,
  type Asset,
  type BookDepthResult,
  type CreateMarketInput,
  type CreateOrderBookInput,
  type Market,
  type MarketPhase,
  type OrderBook,
  type OrderBookLevel,
  type OutcomeToken,
} from "./market.js";

// Order
export {
  ORDER_STATUSES,
  applyFillToOrder,
  canTransitionOrder,
  createOrder,
  isTerminalStatus,
  isWorkingStatus,
  orderNotional,
  remainingQty,
  transitionOrder,
  type CreateOrderInput,
  type Order,
  type OrderKind,
  type OrderStatus,
} from "./order.js";

// Fill
export {
  createFill,
  fillCashImpact,
  fillGrossAmount,
  fillShareImpact,
  type CreateFillInput,
  type Fill,
} from "./fill.js";

// Position
export {
  applyFill,
  costBasis,
  createPosition,
  marketValue as positionMarketValue,
  unrealizedPnl as positionUnrealizedPnl,
  type CreatePositionInput,
  type Position,
} from "./position.js";

// Inventory
export {
  applyFill as applyInventoryFill,
  createInventory,
  findPosition,
  hasPositionFor,
  marketExposure,
  openPositions,
  positionKey,
  positionsMarketValue,
  settleMarket,
  totalEquity,
  totalRealizedPnl,
  totalUnrealizedPnl,
  type CreateInventoryInput,
  type Inventory,
  type InventoryPositionKey,
} from "./inventory.js";

// Balance
export {
  available as availableBalance,
  createBalance,
  deposit,
  release,
  reserve,
  settleReservation,
  withdraw,
  type AccountBalance,
  type CreateBalanceInput,
} from "./balance.js";

// Complete set
export {
  createCompleteSet,
  isMergeArb,
  isMintArb,
  mergeProfit,
  mintProfit,
  setCost,
  setPayoutAtSettlement,
  setProceeds,
  type CompleteSet,
  type CompleteSetLeg,
} from "./complete-set.js";

// Decision
export {
  createRiskDecision,
  createSignal,
  createTradingDecision,
  decisionNotional,
  rejectTradingDecision,
  signalEdge,
  type CreateRiskDecisionInput,
  type CreateSignalInput,
  type CreateTradingDecisionInput,
  type RiskDecision,
  type RiskVerdict,
  type Signal,
  type SignalReason,
  type TradingDecision,
} from "./decision.js";

// PnL
export {
  addPnL,
  createEquitySnapshot,
  createPnL,
  drawdown,
  emptyPnL,
  grossPnL,
  netPnL,
  updateHighWaterMark,
  type CreateEquitySnapshotInput,
  type CreatePnLInput,
  type EquitySnapshot,
  type MarketPnLRow,
  type PnL,
} from "./pnl.js";
