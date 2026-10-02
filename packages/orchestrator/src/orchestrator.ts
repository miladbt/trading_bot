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
import {
  deserializeCalibration,
  evaluateCalibration,
  serializeCalibration,
  type CalibrationModel,
} from "@bot/calibration";
import {
  anchorDistFrac as fvAnchorDistFrac,
  dormant as fvDormant,
  fairValueEstimate,
  momentumPerMin as fvMomentumPerMin,
  volAccelPerMin2 as fvVolAccelPerMin2,
  DEFAULT_FAIR_VALUE_CONFIG,
  type GateEvaluation,
} from "@bot/fair-value";

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
  /** Per-asset fitted calibration model (T2); undefined = raw prior in effect. */
  private readonly calibrationByAsset = new Map<string, CalibrationModel>();
  /**
   * Per-asset Strategy V2 model-quality gate evaluation. Absent or
   * non-"open" = the fair-value model is muted to its base-rate prior
   * (fail closed) — model-driven sizing stops, CSA/rebalancing continue.
   */
  private readonly fv2GateByAsset = new Map<string, GateEvaluation>();
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
    /**
     * Optional fitted calibration models (T2), keyed by asset symbol. When
     * absent for an asset the signal engine's raw probability prior is used
     * unchanged; the mapping's output crosses into sizing only via the
     * Decimal boundary below (`decFromString(p.toFixed(8))`).
     */
    readonly calibration?: Readonly<Record<string, CalibrationModel>> | undefined;
    /**
     * Strategy V2 model-quality gate evaluations keyed by asset (from the
     * out-of-sample evaluation artifact). An asset without an entry is
     * gated OFF: the fair-value prior stays at base — no model trades.
     */
    readonly fv2Gate?: Readonly<Record<string, GateEvaluation>> | undefined;
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
    if (input.calibration !== undefined) {
      for (const [asset, model] of Object.entries(input.calibration)) {
        this.calibrationByAsset.set(asset, model);
      }
    }
    if (input.fv2Gate !== undefined) {
      for (const [asset, gate] of Object.entries(input.fv2Gate)) {
        this.fv2GateByAsset.set(asset, gate);
      }
    }
  }

  /** The loaded calibration model for an asset, or undefined (raw prior). */
  calibrationOf(asset: string): CalibrationModel | undefined {
    return this.calibrationByAsset.get(asset);
  }

  /** Versioned JSON export of every loaded calibration model (audit/soak use). */
  calibrationJson(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [asset, model] of this.calibrationByAsset) {
      out[asset] = serializeCalibration(model);
    }
    return out;
  }

  /**
   * Load a calibration model from its versioned JSON for one asset. Throws on
   * a malformed artifact (fail closed: a bad file must not silently disable
   * calibration when the operator asked for it).
   */
  loadCalibrationJson(asset: string, json: string): void {
    this.calibrationByAsset.set(asset, deserializeCalibration(json));
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

    // ---- 3b. Probability calibration (T2) ----
    // Maps the raw score prior to the fitted mapping when a model is loaded
    // for this asset; otherwise the raw prior passes through unchanged.
    // Floats are allowed for this statistical step; the money path re-enters
    // through the exact Decimal boundary at the sizing call below.
    const calibration = this.calibrationByAsset.get(String(market.asset));
    let probabilityUp =
      calibration === undefined
        ? signal.probabilityUp
        : evaluateCalibration(calibration, signal.probabilityUp);
    let fv2DormantComponents = 0;

    // ---- 3c. Strategy V2 probability source (docs/STRATEGY_V2.md) ----
    // Replaces the signal prior with the fair-value model's P(UP) and applies
    // the model-quality gate. A closed/absent gate is FAIL CLOSED: no model
    // opinion reaches sizing at all (neutral signal, no edge block) — the
    // muted base prior must NOT be traded against market prices, because
    // "0.5 vs 0.45 ask" would be exactly the unjustified edge V2 forbids.
    // CSA and inventory reduction/rebalancing continue in every case.
    let fv2GateReason: string | undefined;
    const fv2Active = this.appConfig.strategy.probabilitySource === "fair-value-v2";
    const fv2Gate = fv2Active ? this.fv2GateByAsset.get(String(market.asset)) : undefined;
    const fv2GateOpen = fv2Gate?.verdict === "open";
    if (fv2Active) {
      const gate = fv2Gate;
      fv2GateReason = gate === undefined ? "no_gate_artifact" : gate.reason;
      const strike = market.priceToBeat;
      const fvSeries = samplesToSeries(samples);
      const estimate = fairValueEstimate({
        elapsedSec: Math.max(0, (now - market.startMs) / 1000),
        remainingSec: Math.max(0, (market.endMs - now) / 1000),
        underlying: {
          anchorDistFrac:
            strike === undefined || strike <= 0
              ? fvDormant
              : fvAnchorDistFrac(fvSeries[fvSeries.length - 1]?.price ?? Number.NaN, strike),
          momentumPerMin: fvMomentumPerMin(fvSeries, now, 900_000),
          volAccelPerMin2: fvVolAccelPerMin2(fvSeries, now, 1_800_000),
        },
        market: { bookImbalance: fvDormant }, // no recorded depth yet (honest)
        config: DEFAULT_FAIR_VALUE_CONFIG,
      });
      fv2DormantComponents =
        (estimate.available.momentum ? 0 : 1) +
        (estimate.available.anchor ? 0 : 1) +
        (estimate.available.volAccel ? 0 : 1) +
        (estimate.available.book ? 0 : 1);
      probabilityUp = fv2GateOpen ? estimate.pUp : DEFAULT_FAIR_VALUE_CONFIG.base;
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
    // V2 charges execution costs to the EXECUTABLE ASK (money stays Decimal)
    // rather than to the model probability: the planner's edge/Kelly sizing
    // then sees the buffered cost basis directly.
    const fv2BufferSum = decAdd(
      decAdd(this.appConfig.strategy.fv2SlippageBuffer, this.appConfig.strategy.fv2AdverseBuffer),
      this.appConfig.strategy.fv2UncertaintyBuffer,
    );
    const effUpAsk = fv2Active ? decAdd(data.upAsk, fv2BufferSum) : data.upAsk;
    const effDownAsk = fv2Active ? decAdd(data.downAsk, fv2BufferSum) : data.downAsk;
    const held = this.ports.lots(market.marketId);
    const upLots = held.up.map((l) => portToLot(l, market, "up"));
    const downLots = held.down.map((l) => portToLot(l, market, "down"));
    const match = matchCompleteSets({
      upLots,
      downLots,
      settlementValue: decFromString("1"),
    });

    // ---- 7. Hybrid rebalancing (target residual from signal/phase/risk) ----
    // V2 gate-closed: the pipeline runs with a NEUTRAL signal and no edge
    // sizing — the planner then only ever proposes complete-set accumulation
    // and inventory REDUCTION (never model-driven accumulation).
    const fv2ModelMuted = fv2Active && !fv2GateOpen;
    const account = this.ports.account();
    const plan = planRebalance({
      marketId: marketIdBrand(market.marketId),
      signal: fv2ModelMuted
        ? { direction: decZero(), confidence: decZero() }
        : {
            direction: decFromString(signal.direction.toFixed(8)),
            confidence: decFromString(signal.confidence.toFixed(8)),
          },
      phase,
      upLots,
      downLots,
      economics: {
        upPrice: effUpAsk,
        downPrice: effDownAsk,
        settlementValue: decFromString("1"),
      },
      risk: {
        maxDirectionalShares: this.appConfig.risk.maxDirectionalExposure,
        maxCapital: this.appConfig.risk.maxTotalCapital,
        availableCapital: decSub(this.appConfig.risk.maxTotalCapital, account.totalCapitalDeployed),
      },
      maxResidual: this.appConfig.strategy.maxResidual,
      // T7: config-driven phase-multiplier curve (canonical default).
      phaseMultipliers: {
        early: this.appConfig.strategy.phaseMultipliers.early,
        mid: this.appConfig.strategy.phaseMultipliers.mid,
        late: this.appConfig.strategy.phaseMultipliers.late,
        final: this.appConfig.strategy.phaseMultipliers.final,
      },
      // T1: when the edge model is configured, size the target residual from
      // the model probability vs the executable asks (fractional Kelly, net of
      // the verified taker fee). The legacy directional model stays the
      // default and is used untouched otherwise. V2 uses the SAME edge sizing
      // when its gate is open, with the buffered mispricing threshold; when
      // the V2 gate is closed there is no edge block at all (fail closed).
      ...(this.appConfig.strategy.sizingModel === "edge" && !fv2ModelMuted
        ? {
            sizing: {
              model: "edge" as const,
              edge: {
                pUp: decFromString(probabilityUp.toFixed(8)),
                takerFeeRate: this.appConfig.fees.takerRate,
                kellyFraction: this.appConfig.strategy.kellyFraction,
                minEdge: fv2Active
                  ? this.appConfig.strategy.fv2MinMispricing
                  : this.appConfig.strategy.minEdge,
              },
            },
          }
        : {}),
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
          ...(fv2Active
            ? {
                fv2Gate: fv2GateReason ?? "open",
                fv2DormantComponents: fv2DormantComponents,
              }
            : {}),
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
          ...(fv2Active
            ? {
                fv2Gate: fv2GateReason ?? "open",
                fv2DormantComponents: fv2DormantComponents,
                fv2BufferedAsk: decToString(intended.outcome === "up" ? effUpAsk : effDownAsk),
              }
            : {}),
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

/**
 * Strategy V2: convert spot samples into the fair-value evidence series
 * (float statistics only; the OUTPUT re-enters through the Decimal boundary
 * at the sizing call, per AGENTS.md).
 */
function samplesToSeries(samples: readonly { price: string; at: Millis }[]): {
  t: number;
  price: number;
}[] {
  return samples.map((s) => ({ t: Number(s.at), price: Number(s.price) }));
}
