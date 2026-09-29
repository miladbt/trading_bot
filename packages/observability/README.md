# @bot/observability

Production-grade observability: **metrics** (Prometheus text + JSON) and
**structured logs**, with secret hygiene enforced at the boundary.

## Metrics

`MetricsRegistry` is a dependency-free counters/gauges registry:

- **Deterministic** — identical state produces byte-identical Prometheus text
  (metrics in registration order, samples sorted by labels; proven by test).
- **Fail-closed secret hygiene** — label keys/values are validated; a
  secret-shaped key (`apiKey`, `private_key`, `credential`, …) or a
  credential-shaped value (40+ char secret-like run) throws
  `SecretLabelError` instead of leaking.
- **Two renderers** — `renderPrometheus()` (text exposition format with
  `# HELP`/`# TYPE`) and `renderJson()` (JSON-safe, for dashboards/CLIs).

Typed collectors are the only way bot data enters the registry. Call
`registerAllMetrics(registry)` once at startup, then the per-area recorders:

| Area      | Recorder(s)                                                               | Metrics |
| --------- | ------------------------------------------------------------------------- | ------- |
| Market    | `recordMarketMetrics`                                                     | `market_underlying_data_age_ms` (BTC/ETH), `market_book_age_ms`, `market_ws_status`, `market_ws_reconnects_total` |
| Strategy  | `recordStrategySignal`, `recordStrategyPhase`, `recordStrategyTargetInventory`, `recordCompleteSetOpportunity` | `strategy_signal_direction`, `strategy_signal_confidence`, `strategy_signal_regime`, `strategy_market_phase`, `strategy_target_inventory_shares`, `strategy_complete_set_opportunities_total`, `strategy_complete_set_gross_edge`, `strategy_complete_set_net_edge` |
| Inventory | `recordInventoryMetrics`                                                  | `inventory_up_shares`, `inventory_down_shares`, `inventory_matched_sets`, `inventory_residual_up_shares`, `inventory_residual_down_shares`, `inventory_orphan_usdc` |
| Execution | `recordExecutionEvent`, `recordExecutionLatency`                          | `execution_orders_total`, `execution_fills_total`, `execution_partial_fills_total`, `execution_cancellations_total`, `execution_rejections_total`, `execution_latency_ms`, `execution_latency_samples_total` |
| Risk      | `recordRiskMetrics`                                                       | `risk_capital_deployed_usdc`, `risk_capital_limit_usdc`, `risk_capital_utilization_ratio`, `risk_directional_exposure_usdc`, `risk_daily_loss_usdc`, `risk_market_loss_usdc`, `risk_state`, `risk_kill_switch` |
| System    | `recordSystemSample` (probe), `recordApiError`                            | `system_cpu_percent`, `system_memory_used_bytes`, `system_memory_rss_bytes`, `system_heap_used_bytes`, `system_heap_limit_bytes`, `system_uptime_seconds`, `system_api_errors_total` |

State-style metrics (`phase`, `regime`, `risk_state`, `ws_status`) emit a `1`
for the active value and `0` for the others, so stale labels self-correct.

### Money is not a metric value

The registry stores numbers and is for **measurement only** (ages, counts,
latencies, ratios). Money and share quantities are computed in the domain with
BigInt `Decimal`s; collectors accept `Decimal | number` and convert once at the
boundary via `decToString` → exact fixed-point parsing. No float arithmetic
ever touches financial math.

## Usage

```ts
import {
  MetricsRegistry,
  nodeSystemSampler,
  recordInventoryMetrics,
  recordSystemSample,
  registerAllMetrics,
} from "@bot/observability";

const registry = new MetricsRegistry();
registerAllMetrics(registry);

recordInventoryMetrics(registry, {
  marketId: "703257",
  upShares: 200,
  downShares: 150,
  matchedSets: 150,
  residualUp: 50,
  residualDown: 0,
  orphanUsdc: 25,
});
recordSystemSample(nodeSystemSampler(), registry);

registry.renderPrometheus(); // scrape endpoint body
registry.renderJson(); // dashboard/CLI body
```

Wire `renderPrometheus()` to an HTTP endpoint (e.g. in `apps/api`) or dump
`renderJson()` on a timer.

## Structured logs

`AreaLogger` emits JSON events with stable fields (`area`, `event`, plus
caller fields) through the shared redacting logger, and applies
`redactSecrets` itself so secret-shaped keys are redacted even if a custom
sink would not be. Decimals render as exact 8-dp fixed-point strings.

```ts
const logs = createAreaLoggers(); // market/strategy/inventory/execution/risk/system/control
logs.execution.info("order_submitted", { clientOrderId: "ord-1", price: decFromString("0.45") });
```

## System probe

`nodeSystemSampler()` (os + process) computes CPU percent from
`process.cpuUsage()` deltas, plus RSS/heap/heap-limit and uptime. The sampler
is injectable (`SystemSampler`) for deterministic tests. The probe never reads
clocks on its own — the caller drives sampling cadence.

## Tests

24 deterministic tests: registry semantics (idempotent registration, monotone
counters, gauge overwrite, sorted snapshots), Prometheus/JSON rendering and
escaping, every collector, flag metrics, secret-label refusals (fail closed),
log redaction with exact decimal rendering, byte-identical determinism, and
the system probe with a fake sampler.
