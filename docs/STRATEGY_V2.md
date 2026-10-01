# STRATEGY V2 — Fair Value → Mispricing → Selective Trading

**Status:** implemented, paper-only. Live trading remains disabled and is NOT
approved by this design or by any test result in this repository.
`TRADING_MODE=paper` / `LIVE_TRADING_ENABLED=false` are unchanged.

**Motivation (honest):** the T11 24h backtest (`reports/backtest-24h.md`)
showed **no out-of-sample signal skill** (hold-out Brier 0.25–0.26, i.e. no
better than a coin flip) and **negative net PnL in every traded
configuration**. The V2 redesign therefore replaces "will BTC go up or down?"
with the only question that can be answered honestly from data we can
actually record:

> Is the current executable price sufficiently different from our estimated
> fair value **after fees, expected slippage, adverse-selection and
> execution-uncertainty buffers, and risk** — and does our probability model
> demonstrably beat a coin-flip baseline out of sample?

If that gate does not pass, the engine's correct output is **no trades**.

---

## 1. Hard safety (unchanged)

- `TRADING_MODE=paper`, `LIVE_TRADING_ENABLED=false` — not modified.
- Pipeline unchanged: `StrategyEngine → RiskEngine → OrderManager →
  ExecutionAdapter`. V2 is a **new probability source and decision rule
  inside the existing StrategyEngine seam** (`packages/orchestrator`), not a
  new order path. Every intended order still passes `evaluateRiskOrder`
  before any adapter call; duplicate/throttle/stale-data protections are
  upstream and untouched.
- Hermes remains a control plane only; it cannot bypass RiskEngine,
  OrderManager, position limits, daily loss limits, kill switch, or execution
  controls. No second submission path exists or is added.
- Money math stays exact BigInt Decimal (AGENTS.md). Floats appear only in
  `packages/fair-value` (statistics) and `packages/backtest` (metrics), and
  re-enter the money path only through `decFromString(p.toFixed(8))` at the
  defined boundary — the same boundary T1/T2 already use.

## 2. Where V2 lives

```
packages/fair-value   NEW  @bot/fair-value — FV model, buffers, gate (pure)
packages/strategy     extended: probabilitySource = "signal" | "fair-value-v2"
packages/orchestrator extended: V2 branch in the existing per-market pipeline
packages/backtest     extended: runner support + V2 experiment configs
```

The orchestrator's existing branch stays byte-identical in behavior when
`probabilitySource = "signal"` (the default): same signal engine, same
calibration hook, same planner calls. V2 activates only when configured.

## 3. Fair value engine (`@bot/fair-value`)

### 3.1 Probability model — transparent and bounded

```
P(UP) = clamp(0.001, 0.999,
    base
  + w_momentum    · tanh(momentum / cap)          // per-minute trend
  + w_anchor      · tanh(anchorDist / cap)        // distance from priceToBeat
  + w_accel       · tanh(accel / cap)             // vol acceleration proxy
  + w_book        · imbalance                     // book imbalance, when known
  + w_time        · tanh(timePressure / cap))     // time-to-expiry pull
```

- Every component is bounded (tanh-squashed or inherently in [−1, 1]); the
  sum is clamped to **[0.001, 0.999]** and `P(DOWN) = 1 − P(UP)` exactly.
- Weights are config, not code. Defaults are deliberately inert.
- **Component dormancy is honest:** an input the dataset does not carry
  (book imbalance, sub-window momentum from 5-min anchors) contributes 0 and
  reports `available: false`. A dormant component must never silently
  pretend to have data.

### 3.2 Inputs (declared; dormancy when absent)

- Market state: last-traded Up/Down prices (schema 1); bid/ask/spread/mid,
  imbalance, depth, trade direction/volume — **available only from recorded
  books (schema ≥ 2 or recorder feeds); dormant on the committed dataset**.
- Underlying: current anchor price, `priceToBeat`, distance and %-distance,
  multi-horizon momentum and realized volatility, volatility acceleration —
  **capped at the dataset's 5-minute anchor cadence** (disclosed
  limitation: no sub-minute information exists in the data).
- Time: seconds since start / remaining / normalized time-to-expiry (exact).
- Resolution: `priceToBeat` from Gamma settlement metadata; ties resolve Up
  (verified Chainlink model — `docs/RESOLUTION_AND_FEES.md`).

### 3.3 Fair value, buffers, and mispricing

Executable fair value per side (all Decimal, exact):

```
fair_up_exec   = P(UP)   − slippage − adverse − uncertainty
fair_down_exec = P(DOWN) − slippage − adverse − uncertainty
```

`slippage = slippageBuffer + marketImpactProxy`, with
`marketImpactProxy = k · clamp(size / visibleDepth, 0, 1)` when depth is
known (dormant → 0 on schema 1, disclosed). Buffers are configurable,
default `0.003` each, and their effect on fills is measured in the
sensitivity suite — not assumed.

Mispricing (probability units, net of the verified taker fee
`fee = C · rate · p · (1 − p)`):

```
mispricing_up   = P(UP)   − (ask_up   + fee(ask_up))   − buffers
mispricing_down = P(DOWN) − (ask_down + fee(ask_down)) − buffers
```

**Decision rule:** trade only the strictly positive, strictly-above-minimum
side; positive mispricing = buy that side at its ask (take). The complete-set
arm (buy UP+DOWN < 1 net) is unchanged and is the only always-on strategy —
it needs no probability model.

### 3.4 Model-quality gate (the hard rule)

The engine refuses to trade on model opinion unless the loaded model beats a
coin-flip baseline **out of sample** on the current evaluation window:

```
Brier(model) < 0.25 − 0.02  AND  LogLoss(model) < ln(2) − 0.02
```

(0.02 slack so a genuinely skillful model isn't discarded by noise; both
thresholds configurable.) Failure is fail-closed: `skipped_fv_gate`, audited
with the measured scores, **zero orders**. Gate state can be fed live (the
orchestrator accepts a gate-provider port) but is normally loaded from the
evaluation artifact produced by the backtest on the same dataset. The gate
is per-asset. When the gate is closed, the CSA and inventory/rebalance arms
still run (they do not depend on the model); mispricing trades stop.

### 3.5 Selective market making (policy, explicitly gated)

Two-sided quoting requires data we do not currently record (real depth,
queue position, fills against us). Policy in V2:

- **Quoting stays off by default** (`FV2_MM_ENABLED=false`).
- Even if enabled, MM actions route through the same RiskEngine →
  OrderManager → Adapter path (a resting limit order is an order), same
  caps, same throttle. No bypass.
- Activation criteria (documented, testable): recorded depth ≥
  `FV2_MM_MIN_DEPTH` at quote price, model gate open, spread ≥
  `FV2_MM_MIN_SPREAD_TICKS` ticks, inventory within skew limits. On the
  current dataset these conditions are unsatisfiable by construction — the
  MM arm is inert and honest about it.

### 3.6 Inventory risk control (unchanged ownership, V2-aware)

Rebalancing/hedging stays in `@bot/inventory` with the RiskEngine above it.
V2 adds one input: the model's current side is passed as the *signal* to the
existing planner when the gate is open; when the gate is closed the planner
sees a neutral signal (0 confidence) — inventory reduction may proceed,
inventory accumulation on model opinion may not.

## 4. Backtest and validation plan

- **Same data, same honesty:** committed 30h dataset (schema 1), 6h
  walk-forward training / 24h hold-out, pessimistic fills (T4), in-loop
  settlement, seed 20261001 — identical harness as T11 for comparability.
- **Model quality is the primary read-out:** per-asset Brier/log-loss on the
  hold-out vs 0.25 / ln 2, reliability table, and the gate timeline. The
  expected, honest outcome on this dataset is a **closed gate** (T11's model
  scored 0.25–0.26); V2 configs should then trade ≈ nothing but CSA — which
  is the redesign *working*, not failing.
- **Config matrix:** A/B/C (T11 comparability) + E (V2 gated) + E′ (V2
  forced-gate-open, to measure what the gate prevented — disclosed as a
  diagnostic, not a recommendation) + D1/D3 baselines.
- **Sensitivity:** buffers (slippage/adverse/uncertainty) swept; known
  inert factors (latency, adverse-move relaxation on tick-grid fills)
  re-reported as inert rather than hidden.
- **Every number in the report must be reproducible** from the committed
  dataset + committed code + recorded seed/config (§6 of the report).

## 5. What would falsify this design

- The gate opens on a real hold-out (Brier < 0.23) and mispricing trades
  still lose money net of buffers → the buffers or the decision rule are
  wrong, not the model.
- CSA-only PnL is consistently negative in paper trading over weeks → the
  fee model or fill model is optimistic in a way the pessimistic T4 model
  does not capture.
- Recorded book data (schema 2) shows fills systematically worse than the
  pessimistic model's assumptions.

## 6. Pre-live gating (unchanged, restated)

Live trading stays out of scope. Before it is ever *considered*: model
gate open across multiple regimes on recorded data; real book/trade capture
running in paper mode; jurisdiction confirmation (OPEN_QUESTIONS §1); D2
baseline; and the full T8 structural checklist. None of these are closed.
