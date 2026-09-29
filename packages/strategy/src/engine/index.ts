export {
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  DEFAULT_WEIGHTS,
  type ComponentWeights,
  type SignalEngineConfig,
} from "./config.js";
export {
  createAssetHistory,
  type AssetHistory,
  type BookTop,
  type PriceSample,
} from "./history.js";
export {
  accelerationScore,
  bookImbalanceScore,
  dataFreshness,
  latestSampleAtOrBefore,
  momentumScore,
  rangePositionScore,
  realizedVolatilityPerMin,
  shortTermReturnScore,
  squash,
  windowSamples,
  type Freshness,
  type Score,
} from "./components.js";
export {
  computeAssetSignal,
  computeSignals,
  confidenceTier,
  type AssetSignal,
  type ComponentKey,
  type ConfidenceTier,
  type MarketRegime,
  type SignalMetrics,
} from "./engine.js";
