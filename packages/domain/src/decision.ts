/**
 * Decision-layer models produced by strategy and risk, consumed by execution.
 *
 * The pipeline is a pure dataflow:
 *   market data -> Signal (strategy) -> RiskDecision (risk) -> TradingDecision
 *
 * A TradingDecision is always derived from a Signal and a RiskDecision, so the
 * audit trail can reconstruct *why* an order was (not) placed.
 */

import type { MarketId as MarketIdBrand, Millis, TokenId } from "./brand.js";
import { ValidationError } from "./errors.js";
import { decCompare, decMulTrunc, decOne, decSub, decZero, type Decimal } from "./decimal.js";
import type { Outcome, Side } from "./types.js";

// ---------------------------------------------------------------------------
// Signal (strategy output)
// ---------------------------------------------------------------------------

/** Why the strategy believes this trade has edge. */
export type SignalReason =
  | "orderbook_imbalance"
  | "late_window_momentum"
  | "price_deviation"
  | "complete_set_arbitrage"
  | "manual";

/** Directional intent produced by the strategy. Not an order. */
export interface Signal {
  readonly reason: SignalReason;
  readonly marketId: MarketIdBrand;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  readonly side: Side;
  /** Confidence in [0, 1] as a Decimal (e.g. 0.62). */
  readonly confidence: Decimal;
  /** Strategy's estimate of fair value for the token, in (0, 1). */
  readonly fairValue: Decimal;
  /** Epoch ms when the signal was generated. */
  readonly at: Millis;
  /** Free-form, bounded strategy context for the audit trail. */
  readonly detail?: Readonly<Record<string, string | number>> | undefined;
}

export interface CreateSignalInput {
  readonly reason: SignalReason;
  readonly marketId: MarketIdBrand;
  readonly tokenId: TokenId;
  readonly outcome: Outcome;
  readonly side: Side;
  readonly confidence: Decimal;
  readonly fairValue: Decimal;
  readonly at: Millis;
  readonly detail?: Readonly<Record<string, string | number>> | undefined;
}

export function createSignal(input: CreateSignalInput): Signal {
  const c = decCompare(input.confidence, decZero());
  if (c < 0 || decCompare(input.confidence, decOne()) > 0) {
    throw new ValidationError("confidence must be in [0, 1]");
  }
  if (decCompare(input.fairValue, decZero()) <= 0 || decCompare(input.fairValue, decOne()) >= 0) {
    throw new ValidationError("fairValue must be in (0, 1)");
  }
  return {
    reason: input.reason,
    marketId: input.marketId,
    tokenId: input.tokenId,
    outcome: input.outcome,
    side: input.side,
    confidence: input.confidence,
    fairValue: input.fairValue,
    at: input.at,
    detail: input.detail,
  };
}

/**
 * Edge implied by the signal at a given executable price:
 * for a buy, (fairValue - price); for a sell, (price - fairValue).
 * Positive edge means the market price is better than the strategy's fair value.
 */
export function signalEdge(signal: Signal, price: Decimal): Decimal {
  return signal.side === "buy" ? decSub(signal.fairValue, price) : decSub(price, signal.fairValue);
}

// ---------------------------------------------------------------------------
// RiskDecision (risk output)
// ---------------------------------------------------------------------------

/** Risk's verdict on a signal. */
export type RiskVerdict = "approve" | "reduce" | "reject";

export interface RiskDecision {
  readonly verdict: RiskVerdict;
  /** Signal id this decision refers to (signal is identified by market+token+at). */
  readonly signal: Signal;
  /** Approved size after risk sizing (shares); 0 for reject. */
  readonly approvedQty: Decimal;
  /** Approved limit price (shares); equals signal-implied price cap. */
  readonly approvedPrice: Decimal;
  /** Machine-readable rule that produced the verdict, e.g. "max_order_usd". */
  readonly rule: string;
  /** Human-readable explanation for the audit trail. */
  readonly explanation: string;
  readonly at: Millis;
}

export interface CreateRiskDecisionInput {
  readonly verdict: RiskVerdict;
  readonly signal: Signal;
  readonly approvedQty: Decimal;
  readonly approvedPrice: Decimal;
  readonly rule: string;
  readonly explanation: string;
  readonly at: Millis;
}

export function createRiskDecision(input: CreateRiskDecisionInput): RiskDecision {
  if (input.verdict === "reject" && decCompare(input.approvedQty, decZero()) !== 0) {
    throw new ValidationError("rejected risk decision must approve zero quantity");
  }
  if (input.verdict !== "reject" && decCompare(input.approvedQty, decZero()) <= 0) {
    throw new ValidationError("non-reject risk decision must approve positive quantity");
  }
  return {
    verdict: input.verdict,
    signal: input.signal,
    approvedQty: input.approvedQty,
    approvedPrice: input.approvedPrice,
    rule: input.rule,
    explanation: input.explanation,
    at: input.at,
  };
}

// ---------------------------------------------------------------------------
// TradingDecision (what execution would place — still data, no submission)
// ---------------------------------------------------------------------------

/**
 * The final, fully-attributed intent: which order to place (or none). Execution
 * adapters consume this; nothing in the domain submits anything anywhere.
 */
export interface TradingDecision {
  /** None when risk rejected or sizing rounded to zero. */
  readonly order:
    | {
        readonly marketId: MarketIdBrand;
        readonly tokenId: TokenId;
        readonly outcome: Outcome;
        readonly side: Side;
        readonly kind: "market" | "limit";
        readonly price: Decimal;
        readonly qty: Decimal;
      }
    | undefined;
  readonly risk: RiskDecision;
  readonly decidedAt: Millis;
}

export interface CreateTradingDecisionInput {
  readonly order: TradingDecision["order"];
  readonly risk: RiskDecision;
  readonly decidedAt: Millis;
}

export function createTradingDecision(input: CreateTradingDecisionInput): TradingDecision {
  if (input.order === undefined && input.risk.verdict !== "reject") {
    throw new ValidationError("non-reject decision must carry an order");
  }
  if (input.order !== undefined && input.risk.verdict === "reject") {
    throw new ValidationError("reject decision must not carry an order");
  }
  return {
    order: input.order,
    risk: input.risk,
    decidedAt: input.decidedAt,
  };
}

/** Reject helper: build the canonical no-trade decision from a risk rejection. */
export function rejectTradingDecision(risk: RiskDecision, at: Millis): TradingDecision {
  if (risk.verdict !== "reject") {
    throw new ValidationError("rejectTradingDecision requires a rejected risk decision");
  }
  return { order: undefined, risk, decidedAt: at };
}

/** Approximate USD notional of the decision's order at its limit price. */
export function decisionNotional(decision: TradingDecision): Decimal {
  const order = decision.order;
  if (order === undefined) {
    return decZero();
  }
  return decMulTrunc(order.price, order.qty);
}
