/**
 * StrategyOrchestrator: the deterministic top-level trading loop.
 *
 * Pipeline per tick:
 *   Market Discovery → Market Data → Signal → Market Phase → Inventory
 *     → Complete Set Engine → Hybrid Rebalancing → RiskEngine → ExecutionAdapter
 *
 * Hard rules:
 * - The strategy never bypasses the RiskEngine: every intended order goes
 *   through `evaluateRiskOrder` before any adapter call. If risk says no, no
 *   adapter call is made (verified in tests with a spy adapter).
 * - The strategy never calls Polymarket directly: the only venue-facing seam
 *   is the `ExecutionAdapter` port; in paper mode that is the deterministic
 *   simulator over configured books.
 * - Every decision receives a unique `decision_id` and is appended to the
 *   audit log with the full evidence trail.
 * - Duplicate orders are prevented: an identical in-flight intent
 *   (market|token|side|price) blocks a re-submit until the in-flight order
 *   leaves the working state.
 * - Quote throttling: at most one new order per market per
 *   `minRequoteIntervalMs`.
 * - Stale data (market or underlying) halts new orders for the affected
 *   market; the tick still runs and audits the halt reason.
 * - Fail closed: a port error for one market does not abort the tick; the
 *   error is audited and remaining markets still evaluate. Unknown state
 *   (missing data, cold signal) means no new orders.
 * - Paper mode only: the constructor refuses a live trading config outright.
 */

import {
  ValidationError,
  cyclePhaseAt,
  decAdd,
  decCompare,
  decFromString,
  decMulRound,
  decSub,
  decToString,
  decZero,
  DEFAULT_PHASE_BOUNDARIES,
  marketId as marketIdBrand,
  tokenId as tokenIdBrand,
  type Decimal,
  type Millis,
} from "@bot/domain";
import {
  createAcquisitionLot,
  matchCompleteSets,
  planRebalance,
  type AcquisitionLot,
  type MarketPhase,
} from "@bot/inventory";
import type { ExecutionAdapter } from "@bot/execution";
import { evaluateRiskOrder, riskLimitsFromConfig, type RiskLimits } from "@bot/risk";
import type { AppConfig } from "@bot/shared";
import {
  computeAssetSignal,
  createAssetHistory,
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  type SignalEngineConfig,
} from "@bot/strategy";

import type {
  DiscoveredMarket,
  MarketDataSnapshot,
  OrchestratorLot,
  OrchestratorPorts,
} from "./ports.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Min interval between new orders per market (quote throttling), ms. */
  readonly minRequoteIntervalMs: number;
  /** Max audit-log entries retained (bounded memory). */
  readonly maxAuditEntries: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  minRequoteIntervalMs: 2_000,
  maxAuditEntries: 512,
};

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/** One auditable decision: the verdict plus the full evidence trail. */
export interface DecisionRecord {
  /** Unique decision id (monotonic per orchestrator instance). */
  readonly decisionId: string;
  readonly at: Millis;
  readonly asset: string;
  readonly marketId: string;
  /** What the orchestrator decided to do this tick for this market. */
  readonly action:
    | "submit_order"
    | "no_action"
    | "halted_stale_market_data"
    | "halted_stale_underlying_data"
    | "halted_risk"
    | "skipped_duplicate"
    | "throttled"
    | "skipped_no_signal"
    | "skipped_no_market_data"
    | "error";
  /** Whether an order was submitted through the adapter this tick. */
  readonly orderSubmitted: boolean;
  /** Machine-parseable detail; free-form context for humans. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  /** The risk verdict reason when the pipeline reached the risk stage. */
  readonly riskReason: string | undefined;
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export class StrategyOrchestrator {
  private readonly config: OrchestratorConfig;
  private readonly appConfig: AppConfig;
  private readonly limits: RiskLimits;
  private readonly ports: OrchestratorPorts;
  private readonly adapter: ExecutionAdapter;
  private readonly signalConfig: SignalEngineConfig;
  private readonly auditLog: DecisionRecord[] = [];
  private decisionCounter = 0;
  /** Last new-order time per marketId (quote throttling). */
  private readonly lastOrderAt = new Map<string, Millis>();
  /** In-flight intent fingerprint per marketId (duplicate prevention). */
  private readonly inFlightIntent = new Map<string, string>();
  /** In-flight client order id per marketId (to detect completion). */
  private readonly inFlightOrder = new Map<string, string>();

  constructor(input: {
    readonly config: AppConfig;
    readonly orchestratorConfig?: OrchestratorConfig | undefined;
    readonly ports: OrchestratorPorts;
    readonly adapter: ExecutionAdapter;
    readonly signalConfig?: SignalEngineConfig | undefined;
  }) {
    const { config } = input;
    // Requirement: do not enable live trading. Refuse a live config outright.
    if (config.trading.mode === "live" || config.trading.liveTradingEnabled) {
      throw new ValidationError(
        "StrategyOrchestrator supports paper mode only; live trading is not implemented",
      );
    }
    this.config = input.orchestratorConfig ?? DEFAULT_ORCHESTRATOR_CONFIG;
    this.appConfig = config;
    this.limits = riskLimitsFromConfig(config);
    this.ports = input.ports;
    this.adapter = input.adapter;
    this.signalConfig = input.signalConfig ?? DEFAULT_SIGNAL_ENGINE_CONFIG;
  }

  /** The audit trail (bounded; oldest entries are dropped). */
  get audit(): readonly DecisionRecord[] {
    return [...this.auditLog];
  }

  /** Number of decisions audited so far. */
  get decisionCount(): number {
    return this.decisionCounter;
  }

  /** In-flight intent fingerprint for a market ("" when none). */
  inFlightIntentOf(marketId: string): string {
    return this.inFlightIntent.get(marketId) ?? "";
  }

  /**
   * Run one pipeline pass across all discovered markets. Deterministic given
   * (ports state, adapter state, `now`). Returns this tick's decisions.
   */
  tick(now: Millis): readonly DecisionRecord[] {
    this.pruneInFlight();
    const decisions: DecisionRecord[] = [];
    const markets = this.ports.discoverMarkets(now);

    for (const market of markets) {
      try {
        decisions.push(...this.processMarket(market, now));
      } catch (err) {
        decisions.push(
          this.record(now, market, "error", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Bound the audit log.
    if (this.auditLog.length > this.config.maxAuditEntries) {
      this.auditLog.splice(0, this.auditLog.length - this.config.maxAuditEntries);
    }
    return decisions;
  }

  // ---- Per-market pipeline -------------------------------------------------

  private processMarket(market: DiscoveredMarket, now: Millis): readonly DecisionRecord[] {
    // ---- 2. Market data (fail closed when absent) ----
    const data = this.ports.marketData(market);
    if (data === undefined || data.marketId !== market.marketId) {
      return [this.record(now, market, "skipped_no_market_data", {})];
    }

    // ---- Staleness halts (still audited) ----
    if (data.ageMs > this.limits.maxDataAgeMs) {
      return [this.record(now, market, "halted_stale_market_data", { ageMs: data.ageMs })];
    }
    if (data.underlyingAgeMs > this.limits.maxUnderlyingAgeMs) {
      return [
        this.record(now, market, "halted_stale_underlying_data", { ageMs: data.underlyingAgeMs }),
      ];
    }

    // ---- 3. Signal (per asset; BTC and ETH are independent) ----
    const samples = this.ports.spotSamples(market.asset);
    if (samples.length === 0) {
      return [this.record(now, market, "skipped_no_signal", { reason: "no_spot" })];
    }
    const signal = computeAssetSignal(
      createAssetHistory(
        String(market.asset),
        samples.map((s) => ({ price: s.price, at: s.at })),
      ),
      this.signalConfig,
      now,
    );
    if (signal.confidence <= 0) {
      return [this.record(now, market, "skipped_no_signal", { regime: signal.regime })];
    }

    // ---- 4. Market phase (canonical phase engine; AGENTS.md rule 0) ----
    const phaseResult = cyclePhaseAt(
      { startMs: market.startMs, endMs: market.endMs },
      DEFAULT_PHASE_BOUNDARIES,
      now,
    );
    if (!phaseResult.ok) {
      return [this.record(now, market, "skipped_no_signal", { reason: "phase_unavailable" })];
    }
    const phase: MarketPhase = phaseResult.value;

    // ---- 5./6. Inventory + complete-set matching (lot-level) ----
    const held = this.ports.lots(market.marketId);
    const upLots = held.up.map((l) => portToLot(l, market, "up"));
    const downLots = held.down.map((l) => portToLot(l, market, "down"));
    const match = matchCompleteSets({
      upLots,
      downLots,
      settlementValue: decFromString("1"),
    });

    // ---- 7. Hybrid rebalancing (target residual from signal/phase/risk) ----
    const account = this.ports.account();
    const plan = planRebalance({
      marketId: marketIdBrand(market.marketId),
      signal: {
        direction: decFromString(signal.direction.toFixed(8)),
        confidence: decFromString(signal.confidence.toFixed(8)),
      },
      phase,
      upLots,
      downLots,
      economics: {
        upPrice: data.upAsk,
        downPrice: data.downAsk,
        settlementValue: decFromString("1"),
      },
      risk: {
        maxDirectionalShares: this.appConfig.risk.maxDirectionalExposure,
        maxCapital: this.appConfig.risk.maxTotalCapital,
        availableCapital: decSub(this.appConfig.risk.maxTotalCapital, account.totalCapitalDeployed),
      },
      maxResidual: this.appConfig.strategy.maxResidual,
      at: now,
    });

    // One intended order per market per tick: the first residual-target action.
    const intended = plan.actions.find((a) => a.kind !== "accumulate_sets");
    if (intended === undefined) {
      return [
        this.record(now, market, "no_action", {
          currentSets: decToString(plan.currentSets),
          residualUp: decToString(plan.residualUp),
          residualDown: decToString(plan.residualDown),
        }),
      ];
    }

    // ---- Quote throttling (requirement 9) ----
    const last = this.lastOrderAt.get(market.marketId);
    if (last !== undefined && now - last < this.config.minRequoteIntervalMs) {
      return [this.record(now, market, "throttled", { sinceLastMs: now - last })];
    }

    // ---- Duplicate prevention (requirement 8) ----
    const tokenId = intended.outcome === "up" ? market.tokenIdUp : market.tokenIdDown;
    const intent = `${market.marketId}|${tokenId}|buy|${decToString(intended.price)}`;
    const existing = this.inFlightIntent.get(market.marketId);
    if (existing !== undefined && existing === intent) {
      return [this.record(now, market, "skipped_duplicate", { intent })];
    }

    // ---- 8. RiskEngine (never bypassed — requirement 1) ----
    const residualShares =
      decCompare(plan.residualUp, plan.residualDown) > 0 ? plan.residualUp : plan.residualDown;
    const risk = evaluateRiskOrder(
      {
        marketId: market.marketId,
        tokenId,
        outcome: intended.outcome,
        side: "buy",
        qty: intended.qty,
        price: intended.price,
        openOrderCount: account.openOrderCount,
        totalCapitalDeployed: account.totalCapitalDeployed,
        marketCapitalDeployed: account.marketCapitalByMarket[market.marketId] ?? decZero(),
        directionalExposureAfter: account.directionalExposureAfter,
        residualShares,
        orphanInventoryUsdc: orphanUsdc(plan.residualUp, plan.residualDown, data),
        dailyLossUsdc: account.dailyLossUsdc,
        marketLossUsdc: account.marketLossByMarket[market.marketId] ?? decZero(),
        marketDataAgeMs: data.ageMs,
        underlyingDataAgeMs: data.underlyingAgeMs,
        reconciliation: account.reconciliation,
        apiHealth: data.apiHealth,
        wsHealth: data.wsHealth,
        marketExpired: now >= market.endMs,
      },
      this.limits,
    );

    if (!risk.allowed) {
      // Risk wins: no adapter call. The in-flight intent is not set, so a
      // later tick may re-propose when the breach clears.
      return [this.record(now, market, "halted_risk", {}, { riskReason: risk.reason })];
    }

    // ---- 9. ExecutionAdapter (paper) ----
    const clientOrderId = `ord-${market.marketId}-${this.decisionCounter}`;
    const result = this.adapter.submit({
      clientOrderId,
      marketId: market.marketId,
      tokenId,
      outcome: intended.outcome,
      side: "buy",
      kind: "limit",
      price: intended.price,
      qty: intended.qty,
      at: now,
    });
    if (!result.ok) {
      return [this.record(now, market, "error", { adapterReason: result.reason })];
    }

    this.lastOrderAt.set(market.marketId, now);
    this.inFlightIntent.set(market.marketId, intent);
    this.inFlightOrder.set(market.marketId, clientOrderId);

    return [
      this.record(
        now,
        market,
        "submit_order",
        {
          clientOrderId,
          qty: decToString(intended.qty),
          price: decToString(intended.price),
          matchedSets: decToString(match.matchedSets),
          residualUp: decToString(plan.residualUp),
          residualDown: decToString(plan.residualDown),
        },
        { riskReason: risk.reason },
      ),
    ];
  }

  /** Drop in-flight markers whose adapter order reached a terminal state. */
  private pruneInFlight(): void {
    for (const [marketId, clientOrderId] of this.inFlightOrder) {
      const order = this.adapter.getOrder(clientOrderId);
      if (order === undefined) {
        this.inFlightOrder.delete(marketId);
        this.inFlightIntent.delete(marketId);
        continue;
      }
      if (
        order.status === "FILLED" ||
        order.status === "CANCELLED" ||
        order.status === "REJECTED"
      ) {
        this.inFlightOrder.delete(marketId);
        this.inFlightIntent.delete(marketId);
      }
    }
  }

  /** Append one audited decision with a fresh decision id. */
  private record(
    now: Millis,
    market: DiscoveredMarket,
    action: DecisionRecord["action"],
    detail: Readonly<Record<string, string | number | boolean>>,
    extra: { riskReason?: string } = {},
  ): DecisionRecord {
    this.decisionCounter += 1;
    const rec: DecisionRecord = {
      decisionId: `dec-${String(this.decisionCounter).padStart(6, "0")}`,
      at: now,
      asset: String(market.asset),
      marketId: market.marketId,
      action,
      orderSubmitted: action === "submit_order",
      riskReason: extra.riskReason,
      detail,
    };
    this.auditLog.push(rec);
    return rec;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a port lot into the inventory package's lot shape (validated). */
function portToLot(
  lot: OrchestratorLot,
  market: DiscoveredMarket,
  side: "up" | "down",
): AcquisitionLot {
  return createAcquisitionLot({
    lotId: lot.lotId,
    marketId: marketIdBrand(market.marketId),
    tokenId: tokenIdBrand(side === "up" ? market.tokenIdUp : market.tokenIdDown),
    outcome: side,
    qty: lot.qty,
    pricePerUnit: lot.pricePerUnit,
    fee: lot.fee,
    rebate: lot.rebate,
    acquiredAt: lot.acquiredAt,
  });
}

/** Residual orphan exposure in USDC, marked at the combined ask. */
function orphanUsdc(residualUp: Decimal, residualDown: Decimal, data: MarketDataSnapshot): Decimal {
  const net = decSub(residualUp, residualDown);
  const mark = decAdd(data.upAsk, data.downAsk);
  const abs = decCompare(net, decZero()) < 0 ? ((decZero() - net) as Decimal) : net;
  return decMulRound(abs, mark);
}
