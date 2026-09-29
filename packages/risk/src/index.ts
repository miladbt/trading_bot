/**
 * Risk package: the authoritative RiskEngine.
 *
 * Every future live order passes through `evaluateRiskOrder` before anything
 * else may act on it. Pure, deterministic, fail-closed: no network calls, no
 * clock reads, no models — observations arrive as data, unknown state means no
 * new orders, and the engine only ever DECIDES (it never submits orders).
 */

export { riskLimitsFromConfig, type RiskLimits } from "./limits.js";

export {
  evaluateRiskOrder,
  validateRiskOrderRequest,
  type HealthState,
  type RiskEvaluation,
  type RiskOrderRequest,
} from "./engine.js";
