/**
 * Soak package: long-running paper-trading soak-test infrastructure.
 *
 * Drives the real orchestrator + paper adapter continuously with:
 * paper-mode validation, health monitoring, fail-closed reconnect policy,
 * crash-safe state persistence, periodic reconciliation, structured decision
 * logging, UTC daily reports, and restart recovery.
 *
 * Measurement only: nothing in this package adjusts strategy parameters from
 * results (explicit soak-test requirement).
 */

export {
  DEFAULT_SOAK_CONFIG,
  MAX_BACKOFF_MS,
  RECONNECT_BACKOFF_MS,
  SoakRunner,
  type HealthSnapshot,
  type SoakRunnerConfig,
  type SoakRunnerDeps,
} from "./runner.js";

export {
  EMPTY_STATE,
  JsonlSink,
  SoakStateStore,
  toAcquisitionLot,
  type SoakState,
  type StoredDecision,
  type StoredFill,
  type StoredLot,
  type StoredReconciliation,
  type StoredReconciliationEvent,
} from "./state-store.js";

export { buildDailyReport, type DailyReport, type DailyReportFiles } from "./daily-report.js";
