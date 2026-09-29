# @bot/strategy

**Deterministic signal engine** for BTC/ETH. Pure functions only — no orders,
no execution coupling, no network, no clock reads (`now` is always a
parameter), no ML, no LLM.

## Signal shape

```ts
interface AssetSignal {
  asset;          // BTC | ETH
  timestamp;      // UTC ms (parameter, not a clock read)
  direction;      // [-1, +1]: -1 down pressure, +1 up pressure
  confidence;     // [0, 1]
  regime;         // quiet | normal | volatile | data-starved
  metrics;        // supporting metrics: per-component scores, freshness, age
}
```

## Components (all configurable, all tanh-squashed to [-1, 1])

1. Short-term price momentum (window slope, price/min)
2. Short-term return (simple return over the lookback)
3. Volatility (per-minute return stdev — regime + confidence gate, no direction)
4. Order-book imbalance (depth-weighted, optional, freshness-gated)
5. Price acceleration (early vs late half-window slope)
6. Distance from recent local range (position in [low, high])
7. Market-data freshness (fresh/warn/stale gate)

Aggregation is a weighted mean over **available** components; missing
components lower confidence instead of being invented. Stale data yields
`confidence: 0`, regime `data-starved`. All thresholds live in
`engine/config.ts` (`SignalEngineConfig`) with inert, documented defaults.

Determinism: identical inputs + config + `now` produce identical signals.
Tests run against fixed historical fixtures with exact expectations
(`engine/fixtures.ts`).
