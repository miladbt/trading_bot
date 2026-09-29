/**
 * Typed metric collectors: the ONLY way bot data enters the registry.
 *
 * One focused function per concern area (market, strategy, inventory,
 * execution, risk, system). Each takes plain data — domain `Decimal`s are
 * accepted and converted to numbers exactly once, at this boundary — and
 * writes the metric set for its area. Flag-style metrics (phase, regime,
 * risk state) emit a 1 for the active value and 0 for the others, so stale
 * labels self-correct on every write.
 *
 * No label in this module carries secret-shaped data: keys are fixed
 * identifiers (asset, market_id, feed, outcome, side, reason, …) and values
 * are short enums or ids. The registry itself rejects secret-shaped labels
 * (fail closed) as defense in depth.
 */

import { decToString, type Decimal } from "@bot/domain";

import type { MetricsRegistry } from "./metrics.js";

/** Decimal-or-number input at the collector boundary. */
type Numeric = Decimal | number;

function num(value: Numeric): number {
  return typeof value === "number" ? value : Number(decToString(value));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register every metric this package emits. Idempotent; call once at startup. */
export function registerAllMetrics(registry: MetricsRegistry): void {
  const G = (name: string, help: string) => registry.register(name, "gauge", help);
  const C = (name: string, help: string) => registry.register(name, "counter", help);

  // Market
  G("market_underlying_data_age_ms", "Age of the underlying spot feed per asset");
  G("market_book_age_ms", "Age of the Polymarket book snapshot per market");
  G(
    "market_ws_status",
    "WebSocket feed status (0 unknown, 1 connecting, 2 healthy, 3 degraded, 4 unhealthy)",
  );
  C("market_ws_reconnects_total", "WebSocket reconnect count per feed");

  // Strategy
  G("strategy_signal_direction", "Signal direction [-1, 1] per asset");
  G("strategy_signal_confidence", "Signal confidence [0, 1] per asset");
  G("strategy_signal_regime", "Signal regime flag per asset (1 = active regime)");
  G("strategy_market_phase", "Market phase flag per market (1 = active phase)");
  G("strategy_target_inventory_shares", "Target inventory in shares per market and outcome");
  C("strategy_complete_set_opportunities_total", "Complete-set opportunities observed");
  G(
    "strategy_complete_set_gross_edge",
    "Gross edge of the latest complete-set opportunity per market",
  );
  G("strategy_complete_set_net_edge", "Net edge of the latest complete-set opportunity per market");

  // Inventory
  G("inventory_up_shares", "Up inventory in shares per market");
  G("inventory_down_shares", "Down inventory in shares per market");
  G("inventory_matched_sets", "Matched complete-set quantity per market");
  G("inventory_residual_up_shares", "Residual Up inventory in shares per market");
  G("inventory_residual_down_shares", "Residual Down inventory in shares per market");
  G("inventory_orphan_usdc", "Orphan (unhedged) inventory value in USDC per market");

  // Execution
  C("execution_orders_total", "Orders by outcome, side, and status");
  C("execution_fills_total", "Fills (full or partial) by outcome and side");
  C("execution_partial_fills_total", "Partial fills by outcome and side");
  C("execution_cancellations_total", "Cancellations by outcome and side");
  C("execution_rejections_total", "Rejections by outcome, side, and reason");
  G("execution_latency_ms", "Last observed latency in ms per operation");
  C("execution_latency_samples_total", "Latency observation count per operation");

  // Risk
  G("risk_capital_deployed_usdc", "Total capital deployed in USDC");
  G("risk_capital_limit_usdc", "Configured total capital limit in USDC");
  G("risk_capital_utilization_ratio", "Capital deployed / capital limit");
  G("risk_directional_exposure_usdc", "Signed directional exposure in USDC per asset");
  G("risk_daily_loss_usdc", "Daily loss in USDC (positive number)");
  G("risk_market_loss_usdc", "Per-market loss in USDC (positive number)");
  G("risk_state", "Risk state flag (1 = active state)");
  G("risk_kill_switch", "Kill switch engaged (1) or not (0)");

  // System
  G("system_cpu_percent", "Process CPU usage percent");
  G("system_memory_used_bytes", "System memory used in bytes");
  G("system_memory_rss_bytes", "Process resident set size in bytes");
  G("system_heap_used_bytes", "V8 heap used in bytes");
  G("system_heap_limit_bytes", "V8 heap limit in bytes");
  G("system_uptime_seconds", "Process uptime in seconds");
  C("system_api_errors_total", "API errors by area");
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export type WsStatus = "unknown" | "connecting" | "healthy" | "degraded" | "unhealthy";

/** Numeric encoding for `market_ws_status`. */
export const WS_STATUS_VALUE: Readonly<Record<WsStatus, number>> = {
  unknown: 0,
  connecting: 1,
  healthy: 2,
  degraded: 3,
  unhealthy: 4,
};

export interface MarketMetricsInput {
  /** Asset → underlying data age in ms (e.g. BTC, ETH). */
  readonly underlyingDataAgeMs: Readonly<Record<string, number>>;
  /** Market id → book snapshot age in ms. */
  readonly bookAgeMs: Readonly<Record<string, number>>;
  /** Feed name → WebSocket status (e.g. "polymarket", "binance-btc"). */
  readonly wsStatus: Readonly<Record<string, WsStatus>>;
  /** Feed name → reconnect count since process start. */
  readonly wsReconnects: Readonly<Record<string, number>>;
}

/** BTC/ETH data ages, book ages, WebSocket status, reconnect counts. */
export function recordMarketMetrics(registry: MetricsRegistry, input: MarketMetricsInput): void {
  for (const [asset, ageMs] of Object.entries(input.underlyingDataAgeMs)) {
    registry.set("market_underlying_data_age_ms", { asset }, ageMs);
  }
  for (const [marketId, ageMs] of Object.entries(input.bookAgeMs)) {
    registry.set("market_book_age_ms", { market_id: marketId }, ageMs);
  }
  for (const [feed, status] of Object.entries(input.wsStatus)) {
    registry.set("market_ws_status", { feed }, WS_STATUS_VALUE[status]);
  }
  for (const [feed, count] of Object.entries(input.wsReconnects)) {
    registry.set("market_ws_reconnects_total", { feed }, count);
  }
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

const REGIMES = ["quiet", "normal", "volatile", "data-starved"] as const;
const PHASES = ["early", "mid", "late", "final", "unknown"] as const;

export interface StrategySignalInput {
  readonly asset: string;
  readonly direction: Numeric;
  readonly confidence: Numeric;
  readonly regime: string;
}

/** Signal direction, confidence, and regime flag per asset. */
export function recordStrategySignal(registry: MetricsRegistry, input: StrategySignalInput): void {
  const labels = { asset: input.asset };
  registry.set("strategy_signal_direction", labels, num(input.direction));
  registry.set("strategy_signal_confidence", labels, num(input.confidence));
  for (const regime of REGIMES) {
    registry.set(
      "strategy_signal_regime",
      { asset: input.asset, regime },
      regime === input.regime ? 1 : 0,
    );
  }
}

/** Market phase flag for one market (1 = active phase, 0 otherwise). */
export function recordStrategyPhase(
  registry: MetricsRegistry,
  marketId: string,
  phase: string,
): void {
  for (const p of PHASES) {
    registry.set("strategy_market_phase", { market_id: marketId, phase: p }, p === phase ? 1 : 0);
  }
}

export interface StrategyTargetsInput {
  readonly marketId: string;
  readonly upShares: Numeric;
  readonly downShares: Numeric;
}

/** Target inventory (shares) per outcome for one market. */
export function recordStrategyTargetInventory(
  registry: MetricsRegistry,
  input: StrategyTargetsInput,
): void {
  registry.set(
    "strategy_target_inventory_shares",
    { market_id: input.marketId, outcome: "up" },
    num(input.upShares),
  );
  registry.set(
    "strategy_target_inventory_shares",
    { market_id: input.marketId, outcome: "down" },
    num(input.downShares),
  );
}

export interface CompleteSetOpportunityInput {
  readonly marketId: string;
  readonly grossEdge: Numeric;
  readonly netEdge: Numeric;
}

/** Count one complete-set opportunity and record its edges. */
export function recordCompleteSetOpportunity(
  registry: MetricsRegistry,
  input: CompleteSetOpportunityInput,
): void {
  registry.increment("strategy_complete_set_opportunities_total", {});
  registry.set(
    "strategy_complete_set_gross_edge",
    { market_id: input.marketId },
    num(input.grossEdge),
  );
  registry.set("strategy_complete_set_net_edge", { market_id: input.marketId }, num(input.netEdge));
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryMetricsInput {
  readonly marketId: string;
  readonly upShares: Numeric;
  readonly downShares: Numeric;
  readonly matchedSets: Numeric;
  readonly residualUp: Numeric;
  readonly residualDown: Numeric;
  /** Orphan (unhedged) inventory value in USDC. */
  readonly orphanUsdc: Numeric;
}

/** Up/Down shares, matched sets, residuals, orphan inventory for one market. */
export function recordInventoryMetrics(
  registry: MetricsRegistry,
  input: InventoryMetricsInput,
): void {
  const labels = { market_id: input.marketId };
  registry.set("inventory_up_shares", labels, num(input.upShares));
  registry.set("inventory_down_shares", labels, num(input.downShares));
  registry.set("inventory_matched_sets", labels, num(input.matchedSets));
  registry.set("inventory_residual_up_shares", labels, num(input.residualUp));
  registry.set("inventory_residual_down_shares", labels, num(input.residualDown));
  registry.set("inventory_orphan_usdc", labels, num(input.orphanUsdc));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ExecutionEvent = "submitted" | "filled" | "partial_fill" | "cancelled" | "rejected";

export interface ExecutionEventInput {
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly event: ExecutionEvent;
  /** Rejection reason (required for `rejected`, ignored otherwise). */
  readonly reason?: string | undefined;
}

/**
 * Record one execution event: orders (submitted), fills, partial fills,
 * cancellations, rejections. A partial fill also counts as a fill.
 */
export function recordExecutionEvent(registry: MetricsRegistry, input: ExecutionEventInput): void {
  const base = { outcome: input.outcome, side: input.side };
  switch (input.event) {
    case "submitted":
      registry.increment("execution_orders_total", base);
      break;
    case "filled":
      registry.increment("execution_fills_total", base);
      break;
    case "partial_fill":
      registry.increment("execution_fills_total", base);
      registry.increment("execution_partial_fills_total", base);
      break;
    case "cancelled":
      registry.increment("execution_cancellations_total", base);
      break;
    case "rejected":
      registry.increment("execution_rejections_total", {
        ...base,
        reason: input.reason ?? "unspecified",
      });
      break;
  }
}

export type ExecutionOperation = "submit" | "cancel";

/** Last observed latency and sample count for one operation. */
export function recordExecutionLatency(
  registry: MetricsRegistry,
  operation: ExecutionOperation,
  latencyMs: number,
): void {
  registry.set("execution_latency_ms", { operation }, latencyMs);
  registry.increment("execution_latency_samples_total", { operation });
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

const RISK_STATES = ["allowed", "halted", "blocked"] as const;

export type RiskState = (typeof RISK_STATES)[number];

export interface RiskMetricsInput {
  readonly capitalDeployedUsdc: Numeric;
  readonly capitalLimitUsdc: Numeric;
  /** Asset → signed directional exposure in USDC. */
  readonly directionalExposureUsdc: Readonly<Record<string, Numeric>>;
  readonly dailyLossUsdc: Numeric;
  /** Optional per-market loss overrides. */
  readonly marketLossUsdc?: Readonly<Record<string, Numeric>> | undefined;
  readonly state: RiskState;
  readonly killSwitch: boolean;
}

/** Capital, exposure, daily/market loss, risk state, kill switch. */
export function recordRiskMetrics(registry: MetricsRegistry, input: RiskMetricsInput): void {
  const deployed = num(input.capitalDeployedUsdc);
  const limit = num(input.capitalLimitUsdc);
  registry.set("risk_capital_deployed_usdc", {}, deployed);
  registry.set("risk_capital_limit_usdc", {}, limit);
  registry.set("risk_capital_utilization_ratio", {}, limit > 0 ? deployed / limit : 0);
  for (const [asset, exposure] of Object.entries(input.directionalExposureUsdc)) {
    registry.set("risk_directional_exposure_usdc", { asset }, num(exposure));
  }
  registry.set("risk_daily_loss_usdc", {}, num(input.dailyLossUsdc));
  for (const [marketId, loss] of Object.entries(input.marketLossUsdc ?? {})) {
    registry.set("risk_market_loss_usdc", { market_id: marketId }, num(loss));
  }
  for (const state of RISK_STATES) {
    registry.set("risk_state", { state }, state === input.state ? 1 : 0);
  }
  registry.set("risk_kill_switch", {}, input.killSwitch ? 1 : 0);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SystemSample {
  /** Process CPU usage percent (0–100, since last sample). */
  readonly cpuPercent: number;
  readonly memoryUsedBytes: number;
  readonly memoryRssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapLimitBytes: number;
  /** Process uptime in seconds. */
  readonly uptimeSeconds: number;
}

/** CPU, memory, and uptime gauges from a sampled snapshot. */
export function recordSystemMetrics(registry: MetricsRegistry, sample: SystemSample): void {
  registry.set("system_cpu_percent", {}, sample.cpuPercent);
  registry.set("system_memory_used_bytes", {}, sample.memoryUsedBytes);
  registry.set("system_memory_rss_bytes", {}, sample.memoryRssBytes);
  registry.set("system_heap_used_bytes", {}, sample.heapUsedBytes);
  registry.set("system_heap_limit_bytes", {}, sample.heapLimitBytes);
  registry.set("system_uptime_seconds", {}, sample.uptimeSeconds);
}

/** Count one API error for an area (e.g. "market-data", "execution"). */
export function recordApiError(registry: MetricsRegistry, area: string): void {
  registry.increment("system_api_errors_total", { area });
}
