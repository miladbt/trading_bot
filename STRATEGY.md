# STRATEGY.md — Hybrid inventory rebalancing

Status: **pure planning layer only.** Nothing in this pipeline submits orders,
touches credentials, or performs I/O. The output of the planner is data that
risk must approve before execution can even consider it.

```
market data ──> Signal (packages/strategy)
                    │
                    ▼
        planRebalance (packages/inventory)  <── risk limits, config
                    │  StrategyDecision (data, not an order)
                    ▼
              RiskDecision (packages/risk)      ← final say
                    │
                    ▼
             TradingDecision (execution)        ← still no submission
```

## 1. Concepts

A 5-minute up/down market has two tokens; 1 Up + 1 Down = 1 **complete set**,
and a complete set always settles to exactly 1 USDC (the winner pays 1, the
loser 0). Inventory is therefore described by two components:

- **Complete sets** — matched 1:1 up/down pairs (`matchedSets` from
  `matchCompleteSets`). These are *capital-neutral*: at settlement they return
  exactly their settlement value regardless of outcome.
- **Residual (orphan) inventory** — leftover shares on one side
  (`residualUp` / `residualDown`). This is *directional*: it pays 1 if its side
  wins and 0 otherwise. Example: 200 Up + 150 Down = **150 complete sets + a
  50 Up residual**. The engine never forces this residual to zero and never
  assumes sets neutralize it.

The strategy combines four concerns:

1. **Complete-set accumulation** — buy more sets when the executable combined
   ask is below the expected settlement value (`setEdgePerSet > 0`):
   `1 - (upAsk + downAsk + perSetCosts) > 0`. Each set bought is neutral and
   locks in the edge at settlement.
2. **Inventory rebalancing** — hold a *target* directional residual derived
   from the signal, not from whatever the fills happened to leave behind.
3. **Directional residual exposure** — the residual is deliberate sizing:
   `direction × confidence × maxResidual × phaseMultiplier`.
4. **Dynamic hedging** — when an orphan exceeds the configured `maxResidual`
   (and the opposite side is flat), buy the light side with the overshoot so
   the next matching pass converts the orphan into sets.

## 2. Target residual

```
target(direction s, confidence c, phase p) =
    clamp( s × c × maxResidual × phaseMultiplier(p),
           -min(maxResidual, maxDirectionalShares),
           +min(maxResidual, maxDirectionalShares) )

target > 0  →  held as an Up residual (targetResidualUp)
target < 0  →  held as a Down residual (targetResidualDown)
```

Inputs, all required by the task:

| Input | Role |
| --- | --- |
| Signal direction | `[-1, 1]`; sign picks the side, magnitude scales it |
| Signal confidence | `[0, 1]`; scales the residual proportionally |
| Market phase | `EARLY/MID/LATE/FINAL` via `phaseMultiplier` |
| Current inventory | lots matched FIFO by `matchCompleteSets` |
| Risk limits | `maxDirectionalShares` caps the result |
| Configured max residual | `maxResidual` scales and caps the result |

`phaseMultiplier` (later phase ⇒ smaller directional tolerance, because less
time remains to correct a wrong bet):

| Phase | Multiplier |
| --- | --- |
| `EARLY` | `1.00` |
| `MID` | `0.75` |
| `LATE` | `0.50` |
| `FINAL` | `0.25` |

The **delta** is `target − current` per side; a positive delta is a buy intent
(`rebalance_up` / `rebalance_down`), a negative delta is left untouched — the
planner never proposes sells, shorts, or negative inventory.

## 3. Planning algorithm (`planRebalance`)

Deterministic, pure, BigInt `Decimal` only. Steps in order:

1. **Match** current lots with `matchCompleteSets` → `currentSets`,
   `residualUp`, `residualDown`. Nothing is force-neutralized.
2. **Target** residual from signal/phase/risk (above); deltas per side.
3. **Set edge**: `setEdgePerSet = settlementValue − (upPrice + downPrice +
   perSetCosts)`.
4. **Actions**, each clamped by the remaining budget
   `min(availableCapital, maxCapital)` and by risk limits, in priority order:
   - **Priority 1 — `accumulate_sets`**: if `setEdgePerSet > 0`, buy
     `budget / setCost` sets. A set adds one share to *each* side, so it never
     changes residuals.
   - **Priority 2 — `rebalance_up` / `rebalance_down`**: buy
     `min(deltaUp, directionalRoom, budgetAfford)` Up and
     `min(deltaDown, directionalRoom, budgetAfford)` Down where
     `directionalRoom = maxDirectionalShares − currentResidual(side)`.
   - **Priority 3 — hedge (`hedge_orphan_residual`)**: if exactly one side has
     a residual and it exceeds `maxResidual`, buy the light side with
     `min(overshoot, budgetAfford)` shares.
   - **Dust guard**: an action whose estimated cost is below 1 micro-USDC
     (0.000001) is dropped, so 8-dp fractional affordability cannot produce a
     meaningless trailing intent.
5. **Assemble** the `StrategyDecision` (residuals, targets, deltas, actions,
   `estimatedTotalCost`, `isFlat`).

Invariants (asserted by the test suite):

- `estimatedTotalCost ≤ min(availableCapital, maxCapital)` — affordability
  uses truncated 8-dp division, so rounding can never overspend.
- Every action has `qty > 0` and `price > 0` — no negative inventory, no
  sells, no shorts.
- Residuals in the decision mirror raw lot matching exactly — never assumed
  neutral, never silently flattened.
- Both Up and Down residuals are supported symmetrically.
- Determinism: identical inputs produce an identical decision.

## 4. Worked example (required by the task)

Inventory: 200 Up shares (avg 0.48), 150 Down shares (avg 0.52); neutral
signal; asks 0.48/0.52 (set cost = 1.00, no edge); budget 1000.

```
matchedSets = 150          residualUp = 50        residualDown = 0
netResidual = +50          target   = 0 (neutral signal, EARLY)
deltaUp = -50 (no buy)     deltaDown = 0
actions = []               isFlat = true
```

The 50 Up residual is reported, preserved, and *not* sold or hedged — it is
within `maxResidual` and the signal gives no reason to change it.

With a bearish signal (`direction = -1, confidence = 1`, `maxResidual = 100`,
`EARLY`): target becomes a 100-share Down residual, so the planner proposes
`rebalance_down qty=100` (cost 52.00 at 0.52), budget permitting. The existing
50 Up residual is still never sold — risk/execution own any sell semantics.

## 5. What this layer does NOT do

- It does not place, size-finalize, or submit orders (`StrategyDecision` is
  data; risk must produce an approving `RiskDecision` first).
- It does not read the clock or fetch data (`at` and prices are injected).
- It does not use floating-point math anywhere (BigInt `Decimal`, 8 dp).
- It does not force neutrality or liquidate orphans.

## 6. Dynamic hedging decision engine (`decideHedge`)

The planner's Priority-3 hedge works *inside* Polymarket (buy the light side).
The hedging engine complements it with an **external** view — what a hedge on
the underlying (BTC/ETH) would look like — as pure data.

**Decision-only by construction.** External hedge execution is disabled by
default (`ENABLE_EXTERNAL_HEDGE=false`); passing `externalHedgeEnabled: true`
throws. The engine never connects to a futures/perpetual exchange, never
places hedge orders, and never applies leverage.

Inputs: BTC/ETH signal stance, Polymarket lot inventory, the residual exposure
it implies, the canonical market phase, realized volatility, and the risk
budget. All injected; all data.

Sizing model (deterministic; the float-valued delta model is quantized to
exact BigInt `Decimal` at the engine boundary — every USDC computation
downstream is BigInt-exact):

```
exposure = |residualUp - residualDown| x binaryDeltaPerShare
urgency  = |direction| x confidence x phaseMultiplier(phase)
             x volatilityMultiplier(volatility)           (clamped to [0, 1])
target   = min(exposure x urgency, riskBudget, exposure)
```

**Binary-option delta exposure (T6).** An Up token is a cash-or-nothing
binary call on the underlying with strike = the window's price-to-beat. With
spot `S`, strike `K`, annualized realized vol `σ`, and time to expiry `T`, the
per-share delta-equivalent USDC exposure is

```
binaryDeltaPerShare = φ(d2) / (σ √T),   d2 = [ln(S/K) − 0.5 σ² T] / (σ √T)
```

(see `packages/inventory/src/binary-delta.ts`, `normalCdf`/`normalPdf` via
Abramowitz–Stegun erf). Properties, all test-encoded:

- the delta **peaks at-the-money** and collapses in both moneyness tails —
  the naive mark model overstates hedge demand away from the strike;
- at-the-money it **spikes like 1/√T into expiry** — pin risk becomes
  expensive to hedge right before settlement;
- at expiry (T = 0) the model returns **0**: the window is settled, there is
  nothing left to hedge.

The legacy `exposure = |residual| × markPrice` sizing remains selectable via
`exposureModel: "mark"` for A/B comparison, and is the automatic fallback
when spot/strike/vol/time inputs are absent; an explicit `"delta"` request
with missing inputs throws (fail closed). UNVERIFIED: the annualization
convention for realized vol (Julian year, 365.25 d) and the lognormality
assumption over a 5-minute horizon — configurable inputs, documented
assumptions, no fabricated market data.

The final `min(…, exposure)` term is the **no-leverage guarantee**: the hedge
can at most fully cover the residual delta, never multiply it.

Volatility regimes (piecewise-constant): <20% → 0.5, <40% → 0.75, <60% → 1.0,
≥60% → 1.25.

Output `HedgeDecision`:

| Field | Meaning |
| --- | --- |
| `required` | true = hedge recommended; false = explicit "no hedge" |
| `asset` | BTC or ETH |
| `direction` | `short` for a long-Up residual, `long` for a long-Down residual, `none` otherwise (offsets the delta) |
| `targetSize` | USDC notional (0 when not required) |
| `reason` | `no_residual_exposure`, `below_min_hedge_notional`, `risk_budget_exhausted`, `residual_hedge_below_max`, `residual_hedge_above_max` |
| `confidence` | the urgency in [0, 1] |
| `riskImpact` | exposure, hedge notional, remaining exposure, coverage fraction (≤ 1), budget-capped / full-coverage flags |

A hedge below 1 USDC notional (`MIN_HEDGE_NOTIONAL_USDC`) is declined
explicitly rather than executed as dust.
