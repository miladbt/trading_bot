/**
 * Observability package: production-grade metrics and structured logs.
 *
 * - `MetricsRegistry` — dependency-free, deterministic counters/gauges with
 *   Prometheus text and JSON rendering.
 * - Typed collectors per concern area (market, strategy, inventory,
 *   execution, risk, system) — the only way bot data enters the registry.
 * - `nodeSystemSampler` — injectable CPU/memory/uptime probe.
 * - `AreaLogger` — structured event logs via the shared redacting logger.
 *
 * Secret hygiene: label keys/values are validated at the boundary (fail
 * closed via `SecretLabelError`); logging goes through the shared redacting
 * logger; no metric or log field carries secret-shaped data.
 */

export { MetricsRegistry, SecretLabelError, METRIC_SECRET_PATTERN } from "./metrics.js";
export type { MetricDefinition, MetricKind, MetricLabels, MetricSample } from "./metrics.js";

export {
  recordApiError,
  recordCompleteSetOpportunity,
  recordExecutionEvent,
  recordExecutionLatency,
  recordInventoryMetrics,
  recordMarketMetrics,
  recordRiskMetrics,
  recordStrategyPhase,
  recordStrategySignal,
  recordStrategyTargetInventory,
  registerAllMetrics,
  WS_STATUS_VALUE,
} from "./collectors.js";
export type {
  CompleteSetOpportunityInput,
  ExecutionEvent,
  ExecutionEventInput,
  ExecutionOperation,
  InventoryMetricsInput,
  MarketMetricsInput,
  RiskMetricsInput,
  RiskState,
  StrategySignalInput,
  StrategyTargetsInput,
  SystemSample,
  WsStatus,
} from "./collectors.js";

export { nodeSystemSampler, recordSystemSample } from "./system.js";
export type { SystemSampler } from "./system.js";

export { AreaLogger, createAreaLoggers } from "./logging.js";
export type { LogArea, LogFieldValue, LogNumeric } from "./logging.js";
