/**
 * Replay package: deterministic historical replay through the exact strategy
 * stack (orchestrator + paper adapter), with CSV/JSON reporting and a CLI.
 *
 * No second strategy implementation exists here; the engine drives the same
 * `StrategyOrchestrator` used by paper mode over historical data. No
 * credentials, no network, no live trading.
 */

export {
  loadDatasetJson,
  parseDataset,
  replayMillis,
  type HistoricalAskSnapshot,
  type HistoricalBookEvent,
  type HistoricalDataset,
  type HistoricalMarketWindow,
  type HistoricalSpotSample,
  type ParsedAskSnapshot,
  type ParsedWindow,
} from "./sources.js";

export {
  DEFAULT_REPLAY_CONFIG,
  ReplayEngine,
  type ReplayConfig,
  type ReplayOrderStats,
  type ReplayReport,
  type ReplaySetRecord,
  type ReplayTrade,
  type ReplayWindowResult,
} from "./replay.js";

export { summaryLine, toCsv, toJson } from "./report.js";

export {
  ANALYSIS_CSV_HEADER,
  analysisToCsvRow,
  analyzePerformance,
  collectPerformanceInputs,
  type PerformanceAnalysis,
  type PerformanceInputs,
  type PerformanceSetSample,
} from "./analytics.js";
