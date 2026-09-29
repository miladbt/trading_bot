# @bot/replay

Deterministic historical replay through the **exact** strategy stack used by
paper mode — no second strategy implementation exists here.

## What it does

`ReplayEngine.run(config)` drives the real `StrategyOrchestrator`
(signal → phase → inventory → complete-set engine → hybrid rebalancing →
RiskEngine) over a historical dataset via `OrchestratorPorts`, and the real
`PaperExecutionAdapter` for simulated fills against historical ask ladders.
Each market window settles with its recorded winning outcome.

## Guarantees

- **Deterministic** — the tick timeline is derived from the dataset
  (`startMs`/`endMs`/`tickMs`), never the wall clock; identical datasets
  produce byte-identical reports. `speed` paces demos only and never changes
  results (test-proven).
- **No look-ahead** — the orchestrator only sees spot samples and ask
  snapshots at or before the current tick.
- **No credentials, no network** — the dataset is a local JSON file.
- **Paper mode only** — the CLI refuses to run unless `TRADING_MODE=paper`.

## Data format

See `fixtures/replay-sample.json`: a `name` and `windows[]`, each with the
market ids/token ids, cycle bounds, recorded `winningOutcome`, time-ascending
underlying `spot[]` and `book[]` snapshots, and executable `asks[]` snapshots
(`upAsk`/`downAsk` in (0,1)).

## CLI

```bash
pnpm replay --dataset packages/replay/fixtures/replay-sample.json \
            --outdir replay-out \
            [--speed 1] [--tick 1000]
```

Writes `report.csv` (one row per window: sets, costs, fees, edges, residuals,
PnL), `report.json` (full report + decision audit trail), and `analysis.csv`
(the performance-analysis row), and logs a summary line.

## Performance analysis (`analyzePerformance`)

Pure measurement & validation over a replay: total trades, total complete
sets, average/median complete-set cost, gross edge, net edge, fees, rebates,
realized & unrealized PnL, max drawdown, residual exposure, average & maximum
inventory, fill/cancellation/rejection ratios, average holding time, and
capital utilization. All BigInt `Decimal` arithmetic; identical inputs always
produce identical outputs.

There is deliberately **no strategy ranking and no parameter optimization** —
this module only measures what happened, exactly.
