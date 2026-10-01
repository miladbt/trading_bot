# 24-Hour Backtest Report (T11)

**Status: research measurement only. Live trading is NOT approved, NOT enabled, and this report must not be read as evidence of readiness.**

- **Run date:** 2026-10-01 (analysis run ~11:30 UTC)
- **Code state:** branch `strategy-hardening`, commit `f04d038` (+ experiment/reporting additions in the T11 commit), all gates green (`pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`; 692 tests passing)
- **Machine-readable results:** [`reports/backtest-24h.json`](./backtest-24h.json) (same numbers, plus full per-config stats, attribution, bootstrap and sensitivity payloads)

---

## 1. Data provenance

| Item | Value |
| --- | --- |
| Window (fetched) | 2026-09-30T05:00:00Z → 2026-10-01T11:00:00Z (30 h) |
| Walk-forward training | 2026-09-30T05:00Z → 2026-09-30T11:00Z (6 h, 69 markets per asset) |
| **Hold-out (reported)** | **2026-09-30T11:00Z → 2026-10-01T11:00Z (24 h, 288 markets per asset, 576 total)** |
| Markets fetched / skipped | 720 / **0** |
| Assets | BTC + ETH (`<asset>-updown-5m-<unix5m>`) |
| Market config per market | Gamma API: `clobTokenIds`, `orderPriceMinTickSize` 0.001, `orderMinSize` 5, `feeSchedule.rate` 0.07 (`crypto_fees_v2`) |
| Token price paths | CLOB `prices-history` at `fidelity=1` (last-traded, ~5 one-minute points per token window) |
| Underlying series | Chainlink TWAP-60s anchor chain reconstructed from Gamma `eventMetadata.priceToBeat`/`finalPrice` (continuity `finalPrice(N) == priceToBeat(N+1)` verified 2026-09-29, `scripts/probe-basis-approx.mjs`) |
| Outcome ground truth | Gamma `outcomePrices` of settled markets (ties resolve Up) |

Sources (official Polymarket public APIs, read-only, no credentials; retrieval 2026-09-30→10-01):
`https://gamma-api.polymarket.com/events?slug=...` and `https://clob.polymarket.com/prices-history?market=...&fidelity=1`.

**Data-quality caveats (verbatim from the dataset's `provenance.caveats`):**

1. Token histories are **last-traded price paths, not order-book depth**; the runner derives a conservative synthetic top-of-book (ask = last + half tick).
2. The underlying signal series is the **Chainlink TWAP-60s anchor chain at 5-minute resolution** — the market's own resolution source, but far coarser than the live Binance feed; the signal is slower/blunter than production.
3. Historical fills use derived books, so queue position is approximate by construction (T4 parameters still applied).

Binance/Kraken/Coinbase spot are region-blocked or unreachable from this environment (HTTP 451/403, verified 2026-09-29), which is why the anchor chain is used.

## 2. Settings

Full machine-readable settings are in `backtest-24h.json` under `settings`. Summary:

- **Shared experiment size (all configs):** `STRATEGY_MAX_RESIDUAL=20` shares, `RISK_MAX_TOTAL_CAPITAL=100` USDC, `RISK_MAX_MARKET_CAPITAL=100`, `RISK_MAX_ORPHAN_INVENTORY=100`, `RISK_MAX_DAILY_LOSS=100`, `RISK_MAX_OPEN_ORDERS=500`. Chosen once, before any run, and identical across A/B/C so the comparison isolates sizing + fill model. **Not tuned**; at minOrderSize 5 shares these are also the smallest sizes that produce a meaningful number of venue-valid orders.
- **Fills (T4):** pessimistic model default — trade-through 0.001, queue-position factor 0.5, adverse-move threshold 0.01, submit/cancel latency 250 ms; config A uses the optimistic model for contrast.
- **Fees (T3, verified):** taker 0.07 × p(1−p) per share, taker-only (makers never charged), source `docs/RESOLUTION_AND_FEES.md` (Polymarket docs + Gamma `feeSchedule`, retrieved 2026-09-29).
- **Sizing:** A/B legacy directional (`direction × confidence × maxResidual × phase multiplier`); C edge-based fractional Kelly (fraction 0.25, minEdge 0.01, net of taker fee).
- **Calibration (T2, walk-forward):** isotonic regression fit per asset **on the 6 h training window only** (raw prior → calibrated probability; versions `walkforward-isotonic-v1`), frozen before the hold-out and loaded via the orchestrator's calibration port. Hold-out quality is *reported*, never tuned on.
- **Signal cadence (DISCLOSED DEVIATION):** production signal lookbacks are seconds-scale; this dataset's underlying series steps 5 minutes, so the backtest widens `returnLookbackMs`→300 000, `volatilityLookbackMs`→600 000, `rangeLookbackMs`→900 000, `maxDataAgeMs`→300 000. This only *enables* trading on this cadence — it supplies no extra information — and the production default stays untouched.
- **Replay mechanics:** injected clock, 30 s ticks; settlement applied in-loop exactly when a market expires (expired capital recycles like the live 5-minute cycle); realized losses update the same risk state the pipeline reads, so loss cutoffs are live.
- **Look-ahead discipline:** ports expose only data with timestamp ≤ now; settlement uses recorded resolution only after `endMs`; calibration and every threshold were fixed before the hold-out.
- **Determinism:** identical dataset + options → byte-identical results (harness test); bootstrap uses a fixed seed (20261001).

Reproduce:

```bash
# 1. fetch the dataset (30 h, both assets, official APIs only)
node_modules/.bin/tsx packages/backtest/src/cli-fetch.ts --assets BTC,ETH --hours 30 --out data/backtest/dataset.json --delay 80
# 2. run configs A/B/C/D + T7 phase curves + sensitivity, write reports/backtest-24h.json
BACKTEST_GIT_COMMIT=$(git rev-parse --short HEAD) node_modules/.bin/tsx packages/backtest/src/run-experiments.ts \
  --dataset data/backtest/dataset.json --out reports/backtest-24h.json --holdout-hours 24 --bootstrap-iters 2000 --seed 20261001
```

## 3. Headline results (hold-out, 576 markets)

| Config | Description | Net PnL (USDC) | Spent | Fees | Settlements | Fill events | Orphaned markets | Max DD | Sharpe-like* | Hit rate* |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | old sizing + optimistic fills | **−14.49** | 222.89 | 14.58 | 208.40 | 256 | 243/576 | 22.55 | −0.068 | 0.486 |
| B | old sizing + pessimistic fills | **−43.52** | 189.23 | 12.38 | 145.72 | 9 854 | 238/576 | 28.78 | −0.129 | 0.336 |
| C | edge/Kelly + pessimistic (candidate) | **−26.38** | 148.27 | 9.70 | 121.88 | 26 628 | 479/576 | 18.40 | −0.044 | 0.200 |
| D1 | no trade | **0.00** | 0 | 0 | 0 | 0 | 0 | 0 | — | — |
| D2 | random direction, same sizing | **not run** (see §8) | | | | | | | | |
| D3 | complete-set-only | **0.00** (no directional trades by design) | 0 | 0 | 0 | 0 | 0 | 0 | — | — |

\* Per-market mean/σ of realized PnL; Sharpe-like only in the loosest sense (i.i.d. assumption false — windows overlap in calendar time and share regime). Hit rate = share of nonzero-PnL markets with PnL > 0.

Bootstrap 95% CIs (resampling markets, 2 000 iterations, seed 20261001):

| Config | Net PnL 95% CI (USDC) | Contains 0? | Hit-rate 95% CI |
| --- | --- | --- | --- |
| A | [−41.16, +11.86] | yes | [0.423, 0.548] |
| B | [−57.38, −0.29] | **no (negative)** | [0.272, 0.400] |
| C | [−41.37, +14.88] | yes | [0.165, 0.237] |

Per asset / phase / probability-bucket attribution (config C; USDC, first-fill phase):

| Slice | Net PnL | Cost | Markets |
| --- | --- | --- | --- |
| BTC | −15.32 | 79.76 | 288 |
| ETH | **+1.61** | 55.84 | 288 |
| phase EARLY | −9.80 | 67.79 | 171 |
| phase MID | −4.00 | 61.48 | 245 |
| phase FINAL | +0.09 | 6.33 | 63 |
| p<0.35 (raw prior) | −7.04 | 48.32 | 242 |
| 0.5–0.65 | **+2.75** | 2.91 | 38 |
| p≥0.65 | −8.77 | 83.56 | 291 |

Worst single market: A −2.54, B −2.40, C −1.27 USDC. Best: C +5.93 USDC.

## 4. Fill quality (T4 observable)

- **A (optimistic):** 256 submits → 256 fills, zero partials — the optimistic model fills everything it touches, which is exactly why it flatters results.
- **B:** 816 submits → 9 854 fill events, 444 orders partially filled, 372 never filled — trade-through + queue haircut bite hard.
- **C:** 1 713 submits → 26 628 fill events across 24 h; 1 083 orders partially filled, 630 never filled.
- **Orphans/leg risk:** 41–42% of hold-out markets end with unmatched one-sided inventory in A/B; **83% in C** — Kelly sizing buys one side only, so almost every traded market carries leg risk to expiry. This is the dominant risk style of the edge model and it is fully simulated through settlement.

## 5. T5 set-edge frequency (identical across configs — measured on the same books)

- Samples: 5 155 market-ticks (executable combined ask, after verified taker fees).
- **`setEdgePerSet > 0` in 22.7% of samples** (1 168), mean positive edge 0.028 USDC/set, max 0.507 USDC.
- Persistence is poor: longest consecutive-positive run = **2 ticks (≈1 minute)**.
- Naïvely "capturable" (≥2 ticks before expiry, i.e. time for a 250 ms-latency taker to act and fill): 82.6% of positive samples.
- **Honest reading:** the derived-book construction (ask = last + half tick per leg) makes small positive combined-ask gaps likely on volatile last-trade prints; with real depth/queue these would mostly vanish. 22.7% is an *upper bound flavored* figure, not an exploitable frequency — and the traded configs' fee-burdened PnL confirms they did not capture it.

## 6. Calibration quality (hold-out, model frozen from training window)

| Asset | Brier ↓ | Log loss ↓ | Reliability (predicted vs realized) |
| --- | --- | --- | --- |
| BTC | **0.2616** | 0.7176 | bin 0.4–0.6: pred 0.467 / realized 0.538 (n=143); bin 0.6–0.8: pred 0.658 / realized 0.517 (n=145) |
| ETH | **0.2525** | 0.6984 | bin 0.4–0.6: pred 0.508 / realized 0.523 (n=176); bin 0.6–0.8: pred 0.621 / realized 0.554 (n=112) |

Coin-flip baseline Brier = 0.25. **Both assets score worse than never predicting** (BTC clearly, ETH marginally). The reliability table shows overconfidence in the 0.6–0.8 bin (realized ≈ 0.52–0.55). The momentum-derived prior has **no demonstrated out-of-sample information** about 5-minute direction on this window. All calibration machinery (fit, serialize, evaluate, metrics) works; the input signal simply does not predict.

## 7. Sensitivity (config C, one factor at a time)

| Factor | Net PnL (USDC) | vs baseline |
| --- | --- | --- |
| baseline (C) | −26.38 | — |
| latency 100 ms | −26.38 | identical — **inert, see note** |
| latency 500 ms | −26.38 | identical — **inert, see note** |
| fee 0.00 | −16.44 | +9.94 (fees cost ~10 USDC/24 h) |
| fee 0.10 | −27.20 | −0.82 |
| adverse 0 | −26.38 | identical — **inert, see note** |
| adverse 0.02 | −26.38 | identical — **inert, see note** |

Inert-factor notes (recorded in the JSON under `sensitivityNotes`): fills in this harness resolve all-or-nothing on a fixed 30 s tick grid, so 100 ms vs 500 ms never changes which tick an order fills on (latency is effectively binary: same tick or next tick). Likewise, the adverse-relaxation path requires an order to keep resting across mid moves, which the refresh-then-decide loop never produces. **Latency and adverse selection are therefore UNDER-modeled here; a tick-level replay with recorded depth is required before drawing any conclusion about them.**

T7 phase multipliers (config B, where the curve is in effect — the edge/Kelly path is deliberately multiplier-free): canonical −43.52, flat −43.76, reversed −29.59 USDC. **Reversed is least-bad by 14 USDC**, but all three are negative with overlapping uncertainty; on this evidence alone no default change is justified (and the existing default stays).

## 8. HONEST CONCLUSION

**There is no statistically supported edge in this window — state that plainly.**

1. Every trading configuration loses money net of fees on the 24 h hold-out (A −14.49, B −43.52, C −26.38 USDC). B's loss is statistically distinguishable from zero (CI excludes 0); A and C are negative but not significantly so. The only configs that don't lose are the ones that don't trade.
2. The signal has no demonstrated predictive power out-of-sample: hold-out Brier scores (0.2616 / 0.2525) are worse than the 0.25 no-information baseline on both assets. Edge-based sizing (C) mechanically avoids low-edge trades and spends less (148 vs 189–223 USDC) with smaller drawdown than A/B, but it cannot conjure an edge the underlying probability model does not have — and its orphan rate (83%) concentrates leg risk.
3. Small sample: 576 markets is *far* below what these CIs would need. The 95% CI on C's net PnL spans roughly [−41, +15] USDC — everything from "badly loses" to "modestly profits" is compatible with this single window. No tuning was done to flatter any number; the shared experiment size was fixed before running and every negative result is reported as-is.
4. What the backtest *does* support: the harness exercises the real pipeline end-to-end (discovery → signal → calibration → phase → inventory → complete-set → risk → paper fills → settlement), fee and spread costs are material (~10 USDC/24 h at fee 0.07 vs 0), and the pessimistic fill model changes results dramatically vs optimistic (A vs B: +29 USDC of pure fill-model optimism). Any future claim of edge must first clear the bar of pessimistic fills and out-of-sample Brier < 0.25.

**This is a negative result and it is the most informative outcome available from one 24 h window: do not trade this strategy with real funds on this evidence.**

## 9. Limitations and unverified assumptions

1. **No recorded order-book depth** (CLOB `/book` returns nothing for closed markets — verified 2026-09-29). Books are derived from last-traded prints (ask = last + half tick). Real spreads/depth would likely make results *worse*, not better.
2. **Underlying series is the Chainlink TWAP anchor chain at 5-minute steps**, not the production Binance feed (region-blocked here, HTTP 451). Signal cadence/quality differs from production; the widened lookbacks are a disclosed deviation.
3. **Latency and adverse-selection sensitivities are inert in this harness** (§7 notes) — under-modeled, unmeasured here.
4. **One 24 h window, one market regime.** Crypto up/down markets behave differently across volatility regimes; nothing here generalizes.
5. **Calibration trained on only 6 h / ~138 markets per asset** (the fetcher's window minus hold-out); a real walk-forward would fit on weeks of data.
6. **D2 (random-direction baseline) was not run** — it requires strategy-code changes (direction is signal-derived by design); faking it in the harness would have been dishonest. Recorded in `reports/OPEN_QUESTIONS.md`.
7. **minOrderSize 5 shares:** C's Kelly sizing regularly proposes sub-share dust, which the venue would reject; in the harness those orders simply never fill (fill events are all-or-nothing per tick at deep synthetic liquidity). Real-world C would trade even less than simulated.
8. **Fee model** is the verified crypto_fees_v2 taker formula; maker-side dynamics (rebate pooling) are not simulated beyond the adapter's maker-rate convention.
9. **Settlement uses recorded Gamma outcomes** (authoritative); no resolution-model risk is taken. But the *signal's* basis vs Chainlink is unmeasured beyond the anchor chain itself.
10. **Bootstrap CIs** assume i.i.d. markets; consecutive 5-minute windows share regime, so real uncertainty is wider.
11. **Tie rule** (finalPrice == priceToBeat resolves Up) is documented from the market description (§1, docs/RESOLUTION_AND_FEES.md); its empirical frequency in this window was not separately measured.
12. UNVERIFIED items carried from T3 docs: Chainlink TWAP historical retrievability outside settlement metadata; ETH resolution-stream symmetry; per-market fee-rate stability over time.

## 10. What would have to change before re-running this analysis

- Record real top-of-book depth + trades via the read-only recorder in paper mode (the dataset format already accepts it).
- A signal with out-of-sample Brier < 0.25 (currently 0.25–0.26); without it, no sizing scheme can produce edge.
- Tick-level replay to make latency/adverse-selection sensitivities meaningful.
- Multiple 24 h windows across regimes with expanding-window walk-forward calibration.
