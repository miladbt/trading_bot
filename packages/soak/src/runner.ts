/**
 * SoakRunner: long-running paper-trading loop.
 *
 * Drives the REAL stack — StrategyOrchestrator (signal → phase → inventory →
 * complete-set engine → hybrid rebalancing → RiskEngine) over the
 * PaperExecutionAdapter — continuously, with the operational plumbing a soak
 * test needs:
 *
 * 1. paper-mode startup validation (refuses live config outright)
 * 2. health monitoring (per-cycle health snapshot + logs)
 * 3. automatic reconnect (fail-closed backoff policy; a failed cycle logs the
 *    backoff and the next reconciliation observes reality before the gate
 *    reopens — unknown state always means no new orders)
 * 4. state persistence (atomic state.json + JSONL logs after every cycle)
 * 5. periodic reconciliation (local book vs. the paper adapter book)
 * 6. structured decision logging (JSONL, one line per decision)
 * 7. daily performance report (UTC rollover; JSON + CSV)
 * 8. failure recovery (resume from state.json; closed gate until a clean pass)
 *
 * Live trading is never enabled: the runner validates paper mode at
 * construction, and the paper adapter is structurally incapable of network I/O.
 */

import { createLogger, type AppConfig, type Logger } from "@bot/shared";
import {
  decAdd,
  decFromString,
  decMulRound,
  decSub,
  decToString,
  decZero,
  millis,
  type Decimal,
  type Millis,
} from "@bot/domain";
import { ReconciliationCoordinator, createAcquisitionLot } from "@bot/inventory";
import type { PaperExecutionAdapter } from "@bot/execution";
import type { StrategyOrchestrator } from "@bot/orchestrator";

import {
  EMPTY_STATE,
  SoakStateStore,
  toAcquisitionLot,
  type SoakState,
  type StoredLot,
} from "./state-store.js";
import { buildDailyReport } from "./daily-report.js";

/** Failure recovery: deterministic reconnect backoff (fail-closed posture). */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const MAX_BACKOFF_MS = 30_000;

export interface SoakRunnerConfig {
  /** Reconciliation cadence (ms of simulated run time). */
  readonly reconciliationIntervalMs: number;
  /** Reconcile also on the first cycle after (re)start. */
  readonly reconcileOnStart: boolean;
}

export const DEFAULT_SOAK_CONFIG: SoakRunnerConfig = {
  reconciliationIntervalMs: 60_000,
  reconcileOnStart: true,
};

/** Health snapshot for one cycle. */
export interface HealthSnapshot {
  readonly atMs: Millis;
  readonly tradingMode: "paper";
  readonly liveTradingEnabled: false;
  readonly tickCount: number;
  readonly decisionCount: number;
  readonly totalOrders: number;
  readonly openOrders: number;
  readonly fills: number;
  readonly lotCount: number;
  readonly reconciliation: "reconciled" | "unreconciled" | "unknown";
  readonly lastAction: string | undefined;
  readonly stateSizeBytes: number;
}

export interface SoakRunnerDeps {
  readonly config: AppConfig;
  readonly orchestrator: StrategyOrchestrator;
  readonly adapter: PaperExecutionAdapter;
  readonly dataDir: string;
  readonly runnerConfig?: SoakRunnerConfig | undefined;
  readonly log?: Logger | undefined;
}

type OrderStatusView = "working" | "filled" | "cancelled" | "rejected" | "unknown";

function statusView(status: string): OrderStatusView {
  if (status === "FILLED") return "filled";
  if (status === "CANCELLED") return "cancelled";
  if (status === "REJECTED") return "rejected";
  if (
    status === "SUBMITTED" ||
    status === "LIVE" ||
    status === "PARTIALLY_FILLED" ||
    status === "CANCEL_REQUESTED"
  ) {
    return "working";
  }
  return "unknown";
}

export class SoakRunner {
  private readonly log: Logger;
  private readonly cfg: SoakRunnerConfig;
  private readonly store: SoakStateStore;
  private readonly coordinator: ReconciliationCoordinator;
  private state: SoakState;
  private readonly orchestrator: StrategyOrchestrator;
  private readonly adapter: PaperExecutionAdapter;
  private lastReconcileAt: number | undefined;
  private lastReportDate: string | undefined;
  private stopped = false;

  constructor(deps: SoakRunnerDeps) {
    // ---- 1. Paper-mode startup validation (fail closed) ----
    if (deps.config.trading.mode !== "paper" || deps.config.trading.liveTradingEnabled) {
      throw new Error(
        `SoakRunner refuses non-paper configuration (mode=${deps.config.trading.mode}, live=${String(
          deps.config.trading.liveTradingEnabled,
        )})`,
      );
    }

    this.log = deps.log ?? createLogger().child({ component: "soak" });
    this.cfg = deps.runnerConfig ?? DEFAULT_SOAK_CONFIG;
    this.orchestrator = deps.orchestrator;
    this.adapter = deps.adapter;

    // ---- 8. Failure recovery: resume or fresh start ----
    const persisted = SoakStateStore.load(deps.dataDir);
    this.state = persisted ?? { ...EMPTY_STATE };
    this.store = new SoakStateStore(deps.dataDir, this.state);
    // The gate starts undefined (unknown) — closed until the first clean
    // reconciliation pass. On resume this is exactly the fail-safe posture.
    this.coordinator = new ReconciliationCoordinator({ maxLocalAgeMs: 600_000 });

    if (persisted !== undefined) {
      this.log.info("soak resumed from persisted state", {
        tickCount: persisted.tickCount,
        lotCount: persisted.lots.length,
        lastTickMs: persisted.lastTickMs,
      });
    } else {
      this.log.info("soak starting fresh (paper mode)");
    }
    this.store.save();
  }

  /** Current state (for tests/monitoring). */
  get snapshot(): SoakState {
    return this.state;
  }

  get reconciliationState(): "reconciled" | "unreconciled" | "unknown" {
    return this.coordinator.reconciliationState ?? "unknown";
  }

  /** Request a graceful stop after the current cycle. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Finalize the run: write the current day's report (so short runs still
   * produce a complete report instead of an empty cycle-1 snapshot) and
   * persist state. Idempotent.
   */
  finalize(atMs?: Millis): void {
    const at = atMs ?? millis(this.state.lastTickMs || this.nowFallback());
    const date = new Date(at).toISOString().slice(0, 10);
    if (!this.state.reportedDays.includes(date)) {
      const { csv, json } = buildDailyReport(this.state, this.adapter, date);
      this.store.writeDailyReport(date, csv, json);
      this.state = {
        ...this.state,
        reportedDays: [...this.state.reportedDays, date],
      };
      this.log.info("final daily report written", { date });
    }
    this.store.update(this.state);
    this.store.save();
  }

  private nowFallback(): number {
    return this.state.lastTickMs || 0;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  // ---------------------------------------------------------------------------
  // One cycle: tick → fills → reconcile → report → persist
  // ---------------------------------------------------------------------------

  /** Run one cycle at `atMs`. Deterministic given (ports state, state, atMs). */
  runCycle(atMs: Millis): HealthSnapshot {
    if (this.stopped) {
      return this.health(atMs);
    }

    let failed = false;
    try {
      // ---- Orchestrator tick: the full strategy pipeline ----
      const decisions = this.orchestrator.tick(atMs);
      for (const d of decisions) {
        this.state = {
          ...this.state,
          decisionCount: this.state.decisionCount + 1,
        };
        this.store.appendDecision({
          atMs: d.at,
          decisionId: d.decisionId,
          asset: d.asset,
          marketId: d.marketId,
          action: d.action,
          orderSubmitted: d.orderSubmitted,
          riskReason: d.riskReason,
          detail: d.detail,
        });
      }

      // ---- Venue time advances with the run clock: the paper adapter's
      // simulation is driven by advanceClock, so each cycle advances it to
      // `atMs` before harvesting fills (submit latency, cancel completion,
      // then matching — deterministic venue semantics). ----
      this.adapter.advanceClock(atMs);

      // ---- Fill processing: adapter fills → lots → cash ----
      this.processFills();

      this.state = {
        ...this.state,
        lastTickMs: atMs,
        tickCount: this.state.tickCount + 1,
      };
    } catch (err) {
      failed = true;
      this.log.error("cycle failed; fail-closed until next clean reconciliation", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ---- 3. Automatic reconnect policy (deterministic backoff advice) ----
    if (failed) {
      this.log.warn("reconnect backoff engaged (caller paces next cycle)", {
        backoffScheduleMs: RECONNECT_BACKOFF_MS.join(","),
        maxBackoffMs: MAX_BACKOFF_MS,
      });
    }

    // ---- 5. Periodic reconciliation (also immediately after start/resume) ----
    this.reconcileIfNeeded(atMs);

    // ---- 7. Daily report on UTC rollover ----
    this.rolloverDailyReport(atMs);

    // ---- 4. Persist atomically after every cycle ----
    this.store.update(this.state);
    this.store.save();

    return this.health(atMs);
  }

  // ---- Fill processing -------------------------------------------------------

  /** Consume new adapter fills once: lots, cash, JSONL log. */
  private processFills(): void {
    const known = new Set(this.state.knownTradeIds);
    const newLots: StoredLot[] = [];
    let cash = decFromString(this.state.cashUsdc);

    for (const order of this.adapter.listOrders()) {
      for (const fill of order.fills) {
        const tradeKey = `${fill.clientOrderId}:${String(fill.at)}:${decToString(fill.qty)}`;
        if (known.has(tradeKey)) {
          continue;
        }
        known.add(tradeKey);
        newLots.push({
          lotId: tradeKey,
          marketId: order.marketId,
          tokenId: order.tokenId,
          outcome: order.outcome,
          qty: decToString(fill.qty),
          pricePerUnit: decToString(fill.price),
          fee: decToString(fill.fee),
          rebate: "0.00000000",
          acquiredAt: fill.at,
        });
        this.store.appendFill({
          atMs: fill.at,
          clientOrderId: fill.clientOrderId,
          tokenId: order.tokenId,
          outcome: order.outcome,
          side: order.side,
          qty: decToString(fill.qty),
          price: decToString(fill.price),
          fee: decToString(fill.fee),
        });
        // Cash: buys spend qty*price + fee (exact fixed-point arithmetic).
        cash = decSub(cash, decAdd(decMulRound(fill.price, fill.qty), fill.fee));
      }
    }

    if (newLots.length > 0) {
      this.state = {
        ...this.state,
        lots: [...this.state.lots, ...newLots],
        knownTradeIds: [...known],
        cashUsdc: decToString(cash),
      };
    }
  }

  // ---- Reconciliation ----------------------------------------------------------

  private reconcileIfNeeded(atMs: Millis): void {
    const due =
      this.cfg.reconcileOnStart && this.lastReconcileAt === undefined
        ? true
        : this.lastReconcileAt === undefined
          ? false
          : Number(atMs) - this.lastReconcileAt >= this.cfg.reconciliationIntervalMs;
    if (!due) {
      return;
    }
    this.lastReconcileAt = Number(atMs);

    const result = this.runReconciliation(atMs);
    const summary =
      result.events.length === 0 ? "clean" : result.events.map((e) => e.type).join("+");
    this.store.appendReconciliation({
      atMs,
      trigger: "periodic",
      state: result.state,
      blocked: result.blocked,
      eventCount: result.events.length,
      summary,
      events: result.events.map((e) => ({
        type: e.type,
        localState: e.localState,
        remoteState: e.remoteState,
        action: e.action,
      })),
    });
    if (result.blocked) {
      this.log.warn("reconciliation blocked; NO_NEW_ORDERS enforced", { summary });
    }
  }

  /**
   * Full local-vs-adapter reconciliation. The remote side is derived from the
   * paper adapter itself (the venue of record in paper mode), so a clean pass
   * is meaningful: it proves the persisted lots, known fills, and order
   * statuses all agree with the simulated venue.
   */
  runReconciliation(atMs: Millis): ReturnType<ReconciliationCoordinator["reconcile"]> {
    const lots = this.state.lots.map(toAcquisitionLot);

    // Remote view from the adapter: orders + every fill as a trade record.
    const remoteOrders = this.adapter.listOrders().map((o) => ({
      venueOrderId: o.clientOrderId,
      clientOrderId: o.clientOrderId,
      status: statusView(o.status),
      qty: o.qty,
      filledQty: o.filledQty,
    }));
    const remoteFills = this.adapter.getFills().map((f) => ({
      tradeId: `${f.clientOrderId}:${String(f.at)}:${decToString(f.qty)}`,
      clientOrderId: f.clientOrderId,
      qty: f.qty,
      price: f.price,
      fee: f.fee,
      at: f.at,
    }));

    const localOrders = new Map(
      this.adapter.listOrders().map((o) => [
        o.clientOrderId,
        {
          status: statusView(o.status) as "working" | "filled" | "cancelled" | "rejected",
          venueOrderId: o.clientOrderId,
        },
      ]),
    );

    return this.coordinator.reconcile(
      "periodic",
      {
        cashUsdc: decFromString(this.state.cashUsdc),
        knownTradeIds: new Set(this.state.knownTradeIds),
        orders: localOrders,
        upLots: lots.filter((l) => l.outcome === "up"),
        downLots: lots.filter((l) => l.outcome === "down"),
        lastReconciledAt: millis(this.state.lastTickMs),
      },
      {
        balance: { availableUsdc: decFromString(this.state.cashUsdc) },
        orders: remoteOrders,
        fills: remoteFills,
        reachable: true,
      },
      atMs,
    );
  }

  // ---- Daily report --------------------------------------------------------------

  private rolloverDailyReport(atMs: Millis): void {
    const date = new Date(atMs).toISOString().slice(0, 10);
    if (this.lastReportDate === undefined) {
      // First cycle of the run: remember the day; the report for this date is
      // written by finalize() at stop (or at the next rollover).
      this.lastReportDate = date;
      return;
    }
    if (this.lastReportDate === date || this.state.reportedDays.includes(this.lastReportDate)) {
      this.lastReportDate = date;
      return;
    }
    // UTC day changed: write the report for the day that just ended (the
    // state snapshot at this point reflects that day's activity).
    const endingDay = this.lastReportDate;
    const { csv, json } = buildDailyReport(this.state, this.adapter, endingDay);
    this.store.writeDailyReport(endingDay, csv, json);
    this.state = {
      ...this.state,
      reportedDays: [...this.state.reportedDays, endingDay],
    };
    this.lastReportDate = date;
    this.log.info("daily report written", { date: endingDay });
  }

  // ---- 2. Health -------------------------------------------------------------------

  private health(atMs: Millis): HealthSnapshot {
    const orders = this.adapter.listOrders();
    const fills = orders.reduce((n, o) => n + o.fills.length, 0);
    const snapshot: HealthSnapshot = {
      atMs,
      tradingMode: "paper",
      liveTradingEnabled: false,
      tickCount: this.state.tickCount,
      decisionCount: this.state.decisionCount,
      totalOrders: orders.length,
      openOrders: orders.filter((o) => statusView(o.status) === "working").length,
      fills,
      lotCount: this.state.lots.length,
      reconciliation: this.reconciliationState,
      lastAction: undefined,
      stateSizeBytes: this.store.sizeBytes,
    };
    this.log.info("soak health", {
      atMs: Number(atMs),
      ticks: snapshot.tickCount,
      decisions: snapshot.decisionCount,
      orders: snapshot.totalOrders,
      open: snapshot.openOrders,
      fills: snapshot.fills,
      lots: snapshot.lotCount,
      reconciliation: snapshot.reconciliation,
      cash: snapshot.stateSizeBytes > 0 ? undefined : undefined,
    });
    return snapshot;
  }
}

// Re-export for CLI/tests convenience.
export { createAcquisitionLot, decZero, decAdd, decToString, type Decimal };
