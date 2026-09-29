# @bot/orchestrator

The deterministic top-level strategy loop. One `tick(now)` runs the full
pipeline for every discovered market:

```
Market Discovery → Market Data → Signal → Market Phase → Inventory
  → Complete Set Engine → Hybrid Rebalancing → RiskEngine → ExecutionAdapter
```

## Guarantees

- **Risk is never bypassed.** Every intended order passes
  `evaluateRiskOrder` first; if risk says no, no adapter call is made
  (integration tests prove this with a spy adapter).
- **No direct Polymarket calls.** The only venue-facing seam is the
  `ExecutionAdapter` port; in paper mode that is the deterministic simulator
  over configured books.
- **Every decision is auditable.** Each tick emits one `DecisionRecord` per
  market with a unique `decision_id`, the action taken (or the reason for
  taking none), the risk verdict, and the evidence trail. The log is bounded.
- **Paper mode only.** The constructor refuses a live trading config
  outright; live trading is not implemented anywhere.
- **BTC and ETH independently** — signals, markets, and orders are keyed by
  asset and market id; simultaneous markets never share state.
- **Duplicate prevention** — an identical in-flight intent
  (market|token|side|price) blocks re-submission until the in-flight order
  reaches a terminal state.
- **Quote throttling** — at most one new order per market per
  `minRequoteIntervalMs`.
- **Staleness halts** — market-data or underlying-data age beyond the risk
  limits halts new orders for that market (audited as
  `halted_stale_market_data` / `halted_stale_underlying_data`).
- **Fail closed** — missing data, cold signals, and port errors all mean no
  new orders; per-market errors never abort the tick.

## Usage

```ts
const orchestrator = new StrategyOrchestrator({
  config,          // validated AppConfig (paper mode)
  ports,           // discovery / market data / spot / account / lots
  adapter,         // ExecutionAdapter (paper simulator)
});
const decisions = orchestrator.tick(now);
```

All external state arrives through `OrchestratorPorts`, which is what makes
the integration tests fully in-memory and deterministic.

## End-to-end suite

`src/e2e.test.ts` drives the **real** components end to end — orchestrator,
paper adapter, complete-set engine, rebalancing planner, RiskEngine, and the
reconciliation coordinator — over a scripted in-memory world (no network, no
funds, no wall clock):

- **Happy path** (BTC and ETH): discovery → market data → signal → phase →
  Up/Down books → complete-set detection → target inventory → orders → risk
  gate → paper execution with deterministic partial fills → lot-level set
  matching → directional residual maintenance (250 Up / 200 Down = 200 sets +
  50 Up residual, never forced neutral) → settlement-stop at cycle end →
  reconciliation → PnL settlement math.
- **Failure scenarios**: stale feed, WebSocket disconnect, API timeout (thrown
  and silent), partial fills, rejected orders, duplicate events, balance
  mismatch, reconciliation failure with recovery, risk-limit breach, and
  process restart (fail-closed until the first clean reconciliation pass).
