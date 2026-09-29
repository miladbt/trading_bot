# @bot/execution

Order-lifecycle ports and the deterministic **PaperExecutionAdapter**.

## The port

`ExecutionAdapter` is the interface every execution backend implements — the
paper simulator now, a future Polymarket live adapter later. Callers depend on
the interface, never on a concrete adapter: `submit`, `cancel`, `getOrder`,
`listOrders`, and `backend` (`"paper" | "live"`).

## Paper adapter

`PaperExecutionAdapter` simulates, with total determinism (the simulation
advances **only** when the caller calls `advanceClock(at)`):

- **Limit orders** — rest on the book and fill from the best crossed contra
  level; one level per tick, so large orders fill level-by-level (deterministic
  partial fills that culminate in a full fill).
- **Post-only** — a limit order that would cross is rejected at submit
  (`post_only_would_cross`) and never becomes working state.
- **Market orders** — must be marketable at submit or are rejected
  (`market_order_not_marketable`); fill at the full taker fee rate.
- **Fees** — `takerFeeRate` on market fills, `takerFeeRate − makerRebateRate`
  (clamped ≥ 0) on limit fills; per-token rates may override the defaults.
- **Latency** — `submitLatencyMs` (SUBMITTED → LIVE) and `cancelLatencyMs`
  (CANCEL_REQUESTED → CANCELLED), both simulated.
- **Cancellations** — cancel requests win over new fills in their completion
  tick, but a completing fill beats a cancel still inside its latency window
  (the CANCEL_REQUESTED → FILLED race the lifecycle models).
- **Finite liquidity** — book levels are consumed as they fill and never
  refill, so the sim cannot double-count contra liquidity.

## Lifecycle

Adapter-level lifecycle (venue-style, distinct from `@bot/domain`'s order
model):

```
CREATED → SUBMITTED → LIVE → PARTIALLY_FILLED → FILLED
                    ↘ REJECTED       ↘ CANCEL_REQUESTED → CANCELLED
```

Terminal: `FILLED`, `CANCELLED`, `REJECTED`. See `lifecycle.ts` for the full
transition table.

## Paper-mode guarantee

`createExecutionAdapter(mode, paperConfig)` is the **only** construction path.
`TRADING_MODE=paper` always yields the paper simulator, which holds no venue
client, no credentials, and no network code — it is structurally incapable of
reaching Polymarket. `mode: "live"` throws `LiveExecutionNotImplementedError`:
live execution does not exist, and asking for it fails closed instead of
falling back. Tests assert this guarantee (`factory` suite), including that no
live adapter value can be constructed from paper mode.

This package never submits real orders without the explicit live-execution
authorization described below.

## PolymarketExecutionAdapter (isolated live backend)

`src/polymarket/` contains ALL Polymarket-specific code: raw DTO shapes and
normalization (`dto.ts`), the mockable transport seam (`transport.ts`), and
the adapter itself (`polymarket-adapter.ts`). It implements the same order
surface as the paper adapter (submit / cancel / getOrder / listOpenOrders /
getFills) plus venue reconciliation (`syncOrder`, `syncOpenOrders`,
`syncFills`), and normalizes every venue response into the internal
`ExecutionOrder` / `ExecutionFill` models.

**Live-execution guard (fail closed).** Real submission is only possible when
BOTH `TRADING_MODE === "live"` AND `LIVE_TRADING_ENABLED === true` — checked at
every submit/cancel. With the shipped defaults (`paper`, `false`) every call
returns `live_trading_disabled` and the transport is never touched
(test-proven).

**Risk is never bypassed.** The adapter requires a positive `RiskGate` verdict
(the authoritative RiskEngine's decision) for every submit; without one it
refuses and the transport is never called.

Venue-state semantics:

- An accepted request is **queued/LIVE, never assumed filled**; only venue
  reconciliation moves an order to `FILLED`.
- **Partial fills** accumulate exactly once (deduped by qty/price/time).
- **Unknown venue statuses** are conservative: the order keeps its local
  working state and is flagged `unknown_venue_status` — never marked filled.
- A venue `FILLED` whose quantities disagree with the local fill records is
  downgraded to `PARTIALLY_FILLED` (never over-claimed).
- **Timeouts, network, and server errors** retry with bounded exponential
  backoff (`base × 2^(n-1)`, capped); **rate limits** trigger a cooldown
  during which submissions are refused locally; **auth failures never retry**
  (fail closed).
- A failed cancel restores the order to `LIVE` — the order is still working.

Integration tests use `MockClobTransport` with scripted, deterministic
responses; no network, no credentials.
