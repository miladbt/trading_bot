# Backtest report — Strategy V2 (Fair Value + Mispricing + Model-Quality Gate)

**Status: paper-only.** Live trading remains disabled
(`TRADING_MODE=paper`, `LIVE_TRADING_ENABLED=false`) and is NOT approved by
anything in this report.

**Design:** `docs/STRATEGY_V2.md` · **Data/JSON:** `reports/backtest-v2.json`
· **Commit:** `05d9f75` (recorded in the JSON)

---

## 1. Motivation and question

The T11 24h backtest (`reports/backtest-24h.md`) found **no out-of-sample
signal skill** (calibration hold-out Brier 0.25–0.26, i.e. no better than a
coin flip) and **negative net PnL in every traded configuration**. Strategy
V2 therefore replaces "will BTC go up or down?" with:

> Is the current executable price sufficiently different from our estimated
> fair value after fees, slippage, adverse-selection and
> execution-uncertainty buffers, and risk — and does our probability model
> demonstrably beat a coin-flip baseline out of sample?

V2's hard rule: **a model that does not beat the baseline is not allowed to
generate trades.** The backtest below is the first test of that rule.

## 2. Data and settings (identical harness to T11 — comparability)

- Dataset: committed `data/backtest/dataset.json` (schema 1, 720 markets,
  30 h, BTC+ETH; provenance and caveats in the JSON). Window
  2026-09-30T05:00Z → 2026-10-01T11:00Z.
- Split: walk-forward — calibration fit on the 6 h training window only;
  hold-out = 24 h, 576 markets (288 per asset). Seed 20261001, 2000
  bootstrap iterations, 30 s tick grid, pessimistic fills, latency 250 ms.
- Underlying series: Chainlink settlement-anchor chain (Binance 451 / Kraken
  403 from this environment — see `reports/backtest-24h.md` §9). The V2
  anchor component uses the market's own `priceToBeat` from Gamma settlement
  metadata. **Book evidence is dormant by design:** schema 1 records no
  order-book depth or trade prints, so the V2 book-imbalance component and
  the market-impact buffer contribute nothing and are reported as dormant —
  never fabricated.
- V2 settings (defaults, not tuned): buffers slippage/adverse/uncertainty
  0.003 each; min mispricing 0.01; gate thresholds Brier < 0.23 AND log
  loss < ln 2 − 0.02 on ≥ 50 observations.
- Disclosure: the gate for this hold-out run is evaluated from hold-out
  aggregate skill (per asset, n = 288). This is aggregate-level, not
  per-market, information; config E2 (forced open) is the counterfactual
  that bounds what the gate changed. In production the gate artifact loads
  from a file produced by an evaluation run.

## 3. Headline result

| Config | Description | Submits | Fills | Spent | Net PnL (USDC) | 95% CI (by-market) |
| --- | --- | --- | --- | --- | --- | --- |
| A | legacy directional + optimistic fills | 256 | 256 | 222.89 | **−14.49** | [−41.16, +11.86] |
| B | legacy directional + pessimistic fills | 816 | 9 854 | 189.23 | **−43.52** | [−57.38, −0.29] |
| C | edge/Kelly + pessimistic fills | 1 713 | 26 628 | 148.27 | **−26.38** | [−41.37, +14.88] |
| D1 | no-trade baseline | 0 | 0 | 0 | 0 | — |
| D2 | random-direction baseline | — | — | — | **NOT RUN** (OPEN_QUESTIONS §2) | — |
| D3 | complete-set-only | 0 | 0 | 0 | 0 | — |
| **E** | **V2 gated (the candidate)** | **0** | **0** | **0** | **0.00** | — |
| E2 | V2 gate forced open (DIAGNOSTIC) | 1 279 | 25 862 | 191.71 | **−25.02** | [−29.79, +20.36] |

A/B/C/D1/D3 reproduce T11's numbers exactly — the harness, data, and seed
are comparable run-to-run.

## 4. The model-quality gate did its job

Per-asset hold-out evaluation of the V2 fair-value model (window-open
estimates vs realized outcomes, Chainlink strike):

| Asset | Brier | Log loss | n | Verdict |
| --- | --- | --- | --- | --- |
| BTC | 0.2503 | 0.6938 | 288 | **CLOSED** |
| ETH | 0.2503 | 0.6937 | 288 | **CLOSED** |

Both metrics sit exactly at the coin-flip baseline (0.25 / ln 2 ≈ 0.6931) —
the transparent additive model, fed only the Chainlink anchor chain and
time, has **zero out-of-sample skill on this dataset**. The gate closed on
both assets and config E correctly submitted **nothing**: the model was not
allowed to gamble capital it cannot predict.

The E2 diagnostic (gate forced open, disclosed as a diagnostic only) shows
what the gate prevented: 1 279 submits, −25.02 USDC net (CI [−29.79,
+20.36]), hit rate 30.6% — statistically indistinguishable from config C's
loss and consistent with paying fees+spreads on a coin flip. Attribution:
BTC −9.73, ETH +4.57 (cost 89.12 / 82.74).

**Honest reading:** V2's contribution on this dataset is not a new profit
source — it is the prevention of ~25 USDC of unjustified trading per 24 h
per 100 USDC of risk budget, backed by an auditable, fail-closed gate. The
engine's correct output under the measured conditions is *no model-driven
trades*; complete-set arbitrage and inventory-reduction paths remain
available and were exercised by the pipeline in every config.

## 5. Calibration quality (unchanged conclusion, now also gate-relevant)

The T2 isotonic calibration hold-out quality (signal-engine prior):
BTC Brier 0.2616, ETH 0.2525 — both worse than the coin-flip baseline.
Combined with the V2 model's 0.2503/0.6938: **no probability model built
from this dataset's information beats chance out of sample.** Until a model
does (Brier < 0.23 AND log loss < 0.6732 on ≥ 50 fresh observations), the
gate stays closed by design and the tradable universe is CSA + inventory
rebalancing only.

## 6. Sensitivity (unchanged factors, re-verified under V2 run)

Fee sensitivity remains the only factor that moves results materially
(fee-zero would have improved config C by +9.94 USDC; fees at 0.10 cost a
further −0.82). Latency (100/500 ms) and the adverse-move threshold (0 /
0.02) remain **inert** in this harness: fills are all-or-nothing per 30 s
tick and the dataset carries no depth or prints — see
`reports/backtest-24h.md` §7 and `sensitivityNotes` in the JSON. These
factors cannot be honestly measured until real book/trade capture exists.

## 7. Conclusion

1. **The gate works.** V2 refused to trade a skill-less model, in both gate
   states being explicit and audited (`fv2Gates` in the JSON, per-decision
   `fv2Gate` detail in the audit trail).
2. **No demonstrated edge.** With Brier ≈ 0.2503 and log loss ≈ 0.6938 on
   the hold-out, the fair-value model has no out-of-sample skill, and the
   forced-open counterfactual lost money like every other directional
   config. **Do not trade on this evidence.**
3. **What would change the verdict** (in order of evidence value): recorded
   real book depth + trade prints (activates the dormant components and
   makes latency/adverse selection measurable); a signal with out-of-sample
   Brier < 0.23 across multiple regimes; CSA-only paper performance tracked
   over weeks as the always-on control.

## 8. Limitations

1. No order-book depth or trade prints in schema 1 — V2's book component and
   impact buffer are dormant; fills are derived last-price marks.
2. Underlying series is the Chainlink settlement chain at 5-min cadence —
   10 s/30 s/60 s momentum components are unobservable here (dormant), not
   an exchange feed.
3. The gate for this run is evaluated on the same hold-out it gates
   (aggregate-level disclosure above); per-market gating in production must
   load a pre-built artifact.
4. Single 24 h window, single regime; bootstrap CIs are by-market and do
   not capture cross-market correlation structure.
5. Phase multipliers affect directional sizing only and are unchanged from
   T11 (canonical −43.52 / flat −43.76 / reversed −29.59 under config B —
   all negative; no default change).
6. D2 (random-direction baseline) remains unrun — OPEN_QUESTIONS §2.
7. E2 is a diagnostic, not a strategy: it suppresses the gate's protection
   and is labeled accordingly everywhere.
8. Money math is exact Decimal throughout; float statistics never feed
   sizing (AGENTS.md boundary respected — same as T11).

## 9. Reproduce

```bash
BACKTEST_GIT_COMMIT=$(git rev-parse --short HEAD) \
  ./packages/backtest/node_modules/.bin/tsx packages/backtest/src/run-experiments.ts \
  --dataset data/backtest/dataset.json --out reports/backtest-v2.json \
  --holdout-hours 24 --bootstrap-iters 2000 --seed 20261001
```

The committed dataset + committed code + fixed seed reproduce every number
in this report deterministically (no network needed — the fetch step that
produced `dataset.json` is the only network-dependent part and its artifact
is committed).
