/**
 * Orchestrator package: the deterministic top-level strategy loop.
 *
 * Wires Market Discovery → Market Data → Signal → Market Phase → Inventory →
 * Complete Set Engine → Hybrid Rebalancing → RiskEngine → ExecutionAdapter.
 * Every decision carries a decision_id and a full audit trail; risk is never
 * bypassed; paper mode only.
 */

export type {
  AccountSnapshot,
  DiscoveredMarket,
  MarketDataSnapshot,
  MarketRiskContext,
  OrchestratorLot,
  OrchestratorPorts,
  SpotSample,
} from "./ports.js";

export {
  DEFAULT_ORCHESTRATOR_CONFIG,
  StrategyOrchestrator,
  type DecisionRecord,
  type OrchestratorConfig,
} from "./orchestrator.js";
