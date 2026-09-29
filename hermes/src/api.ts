/**
 * BotControlApi: the ONLY seam through which Hermes may act on the bot.
 *
 * The bot (apps/trader, packages/orchestrator, packages/execution, …) implements
 * this interface and hands it to the ControlPlane. Hermes never imports from
 * packages or apps (the dependency graph stays acyclic: everything flows INTO
 * hermes), so this port is defined with plain JSON-safe data only:
 *
 * - money/shares arrive as fixed-point strings ("1.25000000") — never floats;
 * - counts and timestamps are plain numbers (ms since epoch UTC);
 * - no credential material of any kind appears in any type;
 * - no method submits an arbitrary order — the only mutation surfaces are
 *   cancel (scoped), pause/resume, kill-switch, and reconcile.
 *
 * A minimal safe implementation (`NullBotControlApi`) ships here for tests and
 * for wiring before the bot has a real snapshot provider.
 */

import type { TradingMode } from "@bot/shared";

// ---------------------------------------------------------------------------
// Snapshot payload types (plain data, JSON-safe)
// ---------------------------------------------------------------------------

/** Bot process identity + mode. */
export interface BotStatusInfo {
  readonly botId: string;
  readonly uptimeMs: number;
  readonly tradingMode: TradingMode;
  readonly liveTradingEnabled: boolean;
  /** Whether the bot process considers itself healthy. */
  readonly healthy: boolean;
  readonly version: string;
}

/** One tradable 5-minute market. */
export interface MarketInfo {
  readonly marketId: string;
  readonly asset: string;
  readonly tokenIdUp: string;
  readonly tokenIdDown: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly phase: "early" | "mid" | "late" | "final" | "unknown";
}

/** Latest signal for one underlying asset. */
export interface SignalInfo {
  readonly asset: string;
  /** [-1, 1] as a fixed-point string. */
  readonly direction: string;
  /** [0, 1] as a fixed-point string. */
  readonly confidence: string;
  readonly regime: "quiet" | "normal" | "volatile" | "data-starved";
  readonly atMs: number;
}

/** One acquisition lot (Up or Down side). */
export interface LotInfo {
  readonly lotId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  /** Shares, fixed-point string. */
  readonly qty: string;
  /** Price per share, fixed-point string. */
  readonly pricePerUnit: string;
  readonly acquiredAtMs: number;
}

/** Aggregate inventory for one market. */
export interface InventoryInfo {
  readonly marketId: string;
  /** Matched complete-set quantity, fixed-point string. */
  readonly matchedSets: string;
  /** Leftover one-sided inventory, fixed-point strings. */
  readonly residualUp: string;
  readonly residualDown: string;
  readonly upLots: readonly LotInfo[];
  readonly downLots: readonly LotInfo[];
}

/** One order, normalized. */
export interface OrderInfo {
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly kind: "limit" | "market";
  readonly status: string;
  readonly price: string;
  readonly qty: string;
  readonly filledQty: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** One fill, normalized. */
export interface FillInfo {
  readonly clientOrderId: string;
  readonly qty: string;
  readonly price: string;
  readonly fee: string;
  readonly atMs: number;
}

/** Realized PnL for one market plus account totals. */
export interface PnlInfo {
  readonly byMarket: Readonly<Record<string, string>>;
  readonly total: string;
  /** Realized + unrealized loss today, positive number, fixed-point string. */
  readonly dailyLossUsdc: string;
}

/** Risk posture: whether new orders are permitted and why/why not. */
export interface RiskInfo {
  readonly allowNewOrders: boolean;
  /** Machine-parseable reason when new orders are refused. */
  readonly blockReason: string | undefined;
  /** Reconciliation gate state from the reconciliation subsystem. */
  readonly reconciliation: "reconciled" | "unreconciled" | "unknown";
  /** Whether the pause control (see ControlPlane) is engaged. */
  readonly paused: boolean;
  /** Whether the kill switch (see ControlPlane) is engaged. */
  readonly killed: boolean;
}

/** Outcome of a reconciliation pass. */
export interface ReconcileResultInfo {
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly ok: boolean;
  /** Number of discrepancy events found (0 when clean). */
  readonly eventCount: number;
  /** Machine-parseable summary, e.g. "clean" or "balance_mismatch+unexpected_fill". */
  readonly summary: string;
}

/** One audited decision, JSON-safe (see packages/orchestrator DecisionRecord). */
export interface DecisionInfo {
  readonly decisionId: string;
  readonly atMs: number;
  readonly asset: string;
  readonly marketId: string;
  readonly action: string;
  readonly orderSubmitted: boolean;
  readonly riskReason: string | undefined;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The controlled API Hermes is allowed to call. Read methods return snapshots;
 * write methods are restricted to cancellation (scoped), pause/resume,
 * kill-switch, and reconcile. There is deliberately NO submit-order method.
 */
export interface BotControlApi {
  /** Read-only observability. */
  status(): BotStatusInfo;
  markets(): readonly MarketInfo[];
  signals(): readonly SignalInfo[];
  inventory(): readonly InventoryInfo[];
  orders(): readonly OrderInfo[];
  /** Working (open) orders only. */
  openOrders(): readonly OrderInfo[];
  fills(): readonly FillInfo[];
  pnl(): PnlInfo;
  risk(): RiskInfo;
  /** Recent audited decisions, oldest first (bounded, e.g. last 256). */
  decisions(): readonly DecisionInfo[];
  /** The most recent audited decision (undefined when none yet). */
  lastDecision(): DecisionInfo | undefined;
  /** Reconciliation events from the latest pass (JSON-safe summaries). */
  reconciliationEvents(): readonly Record<string, string | number | boolean>[];

  /** Mutations — the complete, closed set of what Hermes can trigger. */

  /** Cancel one order by client order id. Scoped; never a raw venue call. */
  cancelOrder(clientOrderId: string): { readonly ok: boolean; readonly reason: string };
  /** Cancel every working order (risk-reduction action). */
  cancelAllOrders(): {
    readonly ok: boolean;
    readonly cancelled: readonly string[];
    readonly reason: string;
  };
  /**
   * Fail-safe pause: the bot stops creating NEW orders but keeps managing
   * existing ones. Idempotent.
   */
  pause(): { readonly ok: boolean; readonly reason: string };
  /** Release a pause. Never releases a kill switch. */
  resume(): { readonly ok: boolean; readonly reason: string };
  /**
   * Fail-safe kill switch: no new orders AND working orders are requested to
   * cancel. Sticky: resume() must not clear it.
   */
  killSwitch(): { readonly ok: boolean; readonly reason: string };
  /** Run a reconciliation pass now. */
  reconcile(): ReconcileResultInfo;
}

/**
 * Minimal safe implementation: reports an honest "nothing wired" snapshot and
 * fail-safe mutations. Used for tests and as a placeholder before the bot has
 * a real snapshot provider — every answer errs on the side of "no new orders".
 */
export class NullBotControlApi implements BotControlApi {
  // Visible for tests/diagnostics; plain booleans, not secret material.
  readonly startedAtMs: number;
  pauseEngaged = false;
  killEngaged = false;

  constructor(botId = "null-bot") {
    this.startedAtMs = Date.now();
    this.botId = botId;
  }

  readonly botId: string;

  status(): BotStatusInfo {
    return {
      botId: this.botId,
      uptimeMs: Date.now() - this.startedAtMs,
      tradingMode: "paper",
      liveTradingEnabled: false,
      healthy: !this.killEngaged,
      version: "0.1.0",
    };
  }

  markets(): readonly MarketInfo[] {
    return [];
  }

  signals(): readonly SignalInfo[] {
    return [];
  }

  inventory(): readonly InventoryInfo[] {
    return [];
  }

  orders(): readonly OrderInfo[] {
    return [];
  }

  openOrders(): readonly OrderInfo[] {
    return [];
  }

  fills(): readonly FillInfo[] {
    return [];
  }

  pnl(): PnlInfo {
    return { byMarket: {}, total: "0.00000000", dailyLossUsdc: "0.00000000" };
  }

  lastDecision(): DecisionInfo | undefined {
    return undefined;
  }

  decisions(): readonly DecisionInfo[] {
    return [];
  }

  risk(): RiskInfo {
    return {
      allowNewOrders: false,
      blockReason: this.killEngaged
        ? "kill_switch_engaged"
        : this.pauseEngaged
          ? "paused"
          : "not_wired",
      reconciliation: "unknown",
      paused: this.pauseEngaged,
      killed: this.killEngaged,
    };
  }

  reconciliationEvents(): readonly Record<string, string | number | boolean>[] {
    return [];
  }

  cancelOrder(clientOrderId: string): { readonly ok: boolean; readonly reason: string } {
    return { ok: false, reason: `unknown_order:${clientOrderId}` };
  }

  cancelAllOrders(): {
    readonly ok: boolean;
    readonly cancelled: readonly string[];
    readonly reason: string;
  } {
    return { ok: true, cancelled: [], reason: "no_open_orders" };
  }

  pause(): { readonly ok: boolean; readonly reason: string } {
    this.pauseEngaged = true;
    return { ok: true, reason: "paused" };
  }

  resume(): { readonly ok: boolean; readonly reason: string } {
    if (this.killEngaged) {
      return { ok: false, reason: "kill_switch_sticky" };
    }
    this.pauseEngaged = false;
    return { ok: true, reason: "resumed" };
  }

  killSwitch(): { readonly ok: boolean; readonly reason: string } {
    this.killEngaged = true;
    this.pauseEngaged = true;
    return { ok: true, reason: "kill_switch_engaged" };
  }

  reconcile(): ReconcileResultInfo {
    const now = Date.now();
    return {
      startedAtMs: now,
      finishedAtMs: now,
      ok: false,
      eventCount: 0,
      summary: "not_wired",
    };
  }
}
