// @bot/backtest — deterministic replay harness (T10).
// Replays recorded/historical data through the REAL orchestrator pipeline
// with an injected clock. No live trading, no look-ahead, exact Decimal money.

export {
  isAscending,
  tokenPriceAt,
  underlyingAt,
  type BacktestDataset,
  type BacktestMarket,
  type MarketResolution,
  type TokenHistory,
  type TokenPricePoint,
  type UnderlyingSeries,
} from "./dataset.js";
export { createBacktestPorts, type BacktestAdapterState } from "./ports.js";
export { runBacktest, type BacktestRunOptions, type BacktestRunResult } from "./runner.js";
export { settleMarket, type SettlementResult } from "./settlement.js";
