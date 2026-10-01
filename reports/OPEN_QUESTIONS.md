# Open questions — human decisions required

These are items the work could not or should not decide on its own. Nothing
here blocks the current paper-only state; several block any future move toward
live trading.

Status vocabulary: **DECISION NEEDED** = a human must choose; **UNRESOLVED** =
needs more data or work; **DISCLOSED** = deviation from ideal, accepted for
now, documented elsewhere.

---

## 1. Jurisdiction and legality of automated Polymarket trading — DECISION NEEDED

**Question:** Confirm that operating an automated trading bot on Polymarket
from the operator's jurisdiction is legally permitted, and that Polymarket's
current terms of service permit automated/API trading for that account.

**Why it is open:** This is a legal/regulatory judgment about the operator's
residence, citizenship, and the venue's terms — outside what code or public
docs can establish. Polymarket's site presents region eligibility at
onboarding time; no statement in this repository constitutes legal advice.

**Who decides:** The operator, ideally with qualified legal advice in their
jurisdiction. **This must be closed before any consideration of live
trading.** Until then the bot stays `TRADING_MODE=paper`,
`LIVE_TRADING_ENABLED=false` (fail-closed defaults, unchanged by this work).

---

## 2. D2 random-direction baseline was not run — UNRESOLVED

**Question:** Should we add a random-direction baseline strategy
(config D2 of the backtest plan) to quantify how much of config A/B's loss is
the strategy itself versus the fee/pessimistic-fill structure?

**Why it is open:** Direction in the signal engine is signal-derived by design
(`STRATEGY_SIZING_MODEL=directional|edge`); there is no code path that trades
random directions. Faking one inside the backtest harness would have produced
a number no real run could reproduce — dishonest under this project's rules.
Config B's loss already excludes zero (bootstrap CI [−57.38, −0.29] USDC over
24h), which limits what D2 could newly tell us, so it was deferred.

**Options:** (a) add a `random` sizing model behind an explicit config flag,
clearly excluded from production defaults; (b) accept A/B/C vs D1/D3 as the
comparison set; (c) drop the requirement. Any implementation must not add a
live-order path.

---

## 3. Latency and adverse-move sensitivity factors are inert — DISCLOSED / DECISION NEEDED

**Question:** Accept the inert result, or invest in tick-level book/trade
recording to make latency and adverse-selection modeling meaningful?

**Why it is open:** In the 24h backtest, fill latency (100 ms vs 500 ms) and
the adverse-move relaxation threshold (0 vs 0.02) had **zero** effect on any
config's result. Cause: fills are all-or-nothing decisions on a 30 s tick
grid, and the dataset contains no book depth or trade prints — the paper fill
model re-prices from last-trade marks only. These factors would only matter
at sub-tick timescales the dataset cannot see. This is disclosed in
`reports/backtest-24h.md` §7 (sensitivityNotes in the JSON).

**Options:** (a) record real top-of-book + trades via the read-only recorder
in paper mode (dataset schema already accepts them), then re-run; (b) accept
as a known blind spot and treat all latency-related claims as untested.

---

## 4. Kelly dust vs the 5-share minimum order size — DECISION NEEDED

**Question:** When the `edge` sizing model produces a target below the
verified market minimum (`orderMinSize: 5` shares, Gamma API, verified
2026-09-29), should the bot skip the order, round up to the minimum, or
accumulate intent across ticks?

**Why it is open:** In config C, 630 of 576 markets' orders went unfilled
across 26,628 fill events and 479 markets ended orphaned (83%): undersized or
unfilled intent is a real, recurring state, not an edge case. Current
behavior: sub-minimum intent produces no order. Rounding up trades more size
than Kelly justifies; accumulating adds complexity and stale-intent risk.

**Options:** (a) keep skip-only (current, conservative); (b) round up with a
separate risk cap on "dust round-ups" per market; (c) accumulate until the
minimum is reachable and then act once. Decide before any future live
consideration; paper mode is unaffected.

---

## 5. Underlying-price series is a derived Chainlink chain, not an exchange feed — DISCLOSED

**Question:** Whether to invest in a real BTC/ETH trade feed for research (as
opposed to trading) despite the region blocks hit during this work.

**Facts:** Binance returned HTTP 451 and Kraken 403 from this environment
(2026-09-29). The dataset's underlying series is therefore the Chainlink TWAP
anchor chain reconstructed from Gamma settlement metadata
(`priceToBeat(N) == finalPrice(N−1)` continuity verified; see
`scripts/probe-basis-approx.mjs`). Any exchange-based premium/discount signal
built on this series is an *approximation of a settlement oracle*, not an
exchange price — strategy edge measured against it may not transfer.

---

## 6. Signal quality: out-of-sample Brier ≥ 0.25 — UNRESOLVED

**Question:** Is there any signal to find here at all, and if so, from what
data?

**Facts:** Walk-forward isotonic calibration (6h training / 24h hold-out)
scored BTC 0.2616, ETH 0.2525 — both **worse than the 0.25 coin-flip
baseline** on 288 settled markets per asset. The 24h backtest lost money in
every traded configuration (A −14.49, B −43.52, C −26.38 USDC net; B's CI
excludes zero). No sizing scheme, phase weighting, or fee assumption rescues
a probability estimate with no out-of-sample skill.

**Options:** (a) collect more windows across regimes and repeat honestly;
(b) redesign the signal from richer recorded data (book depth, trades — see
§3); (c) conclude the strategy class has no edge on this market and stop.
The honest default until then: paper only, no live path.

---

## 7. Calibration engine defaults remain second-scale — DISCLOSED

The production signal-engine defaults use second-scale lookbacks
(`returnLookbackMs` 30 s, `maxDataAgeMs` 5 s). The backtest used a rescaled
configuration (`DATASET_SIGNAL_CONFIG`) because the dataset's anchor cadence
is ~1 sample/5 min per market. The deviation is confined to
`packages/backtest/src/run-experiments.ts` and disclosed in the report;
production defaults were not touched. If real book/trade streams are ever
recorded in paper mode (§3), re-check whether the defaults or the research
config should be unified.
