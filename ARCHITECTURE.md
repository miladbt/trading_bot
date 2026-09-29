# ARCHITECTURE.md — polymarket-bot domain layer

This document describes the core domain architecture implemented in
`packages/domain` (`@bot/domain`). It covers the normalized models, their
invariants, and the dataflow the rest of the system is expected to follow.

## 1. Design principles

1. **Framework-free and adapter-agnostic.** The domain knows nothing about
   Polymarket. No SDK types, no HTTP clients, no venue concepts. Adapters (later,
   in `packages/market-data` and `packages/execution`) translate external DTOs
   into domain models at the boundary; everything inside the monorepo speaks
   only the language of this package.
2. **Decimal-safe money.** All financial values are `Decimal` — a BigInt scaled
   by 10^8 (8 decimal places). Floats never touch money; `decFromNumber` exists
   only for unavoidable boundaries and rounds deterministically.
3. **UTC everywhere.** Timestamps are `Millis` (epoch ms) or `UtcIso`
   (ISO-8601 with mandatory `Z` suffix). Naive local-time strings cannot enter
   the domain.
4. **Immutability + pure functions.** Models are plain immutable data; every
   state change is a pure function returning a new value. The only non-pure
   functions in the package are `nowMillis()` and the branded-string
   constructors' input validation.
5. **Make illegal states unrepresentable.** Branded ids (`MarketId`, `TokenId`,
   `OrderId`, …) prevent cross-field mixups; smart constructors validate
   invariants at the edge; state machines (market phase, order status) expose
   only legal transitions.
6. **No I/O.** No network calls, no order submission, no live trading. The
   package compiles and tests offline by construction (AGENTS.md rule).

## 2. Module map

| Module | Contents |
| --- | --- |
| `brand.ts` | Branded primitives: ids, `Millis`, `UtcIso` |
| `decimal.ts` | `Decimal` type + pure arithmetic (`decAdd`, `decMulRound`, `decDivRound`, …) |
| `time.ts` | `Millis`/`UtcIso` constructors, conversions, comparisons |
| `ids.ts` | Smart constructors for branded identifiers |
| `types.ts` | Canonical `Side`, `Outcome` unions |
| `errors.ts` | `DomainError`, `ValidationError`, `InvalidTransitionError` |
| `result.ts` | `Result<T, E>` and `tryParse` for expected-failure flows |
| `market.ts` | `Asset`, `Market`, `MarketPhase`, `OutcomeToken`, `OrderBook` |
| `phase-engine.ts` | **Canonical** 5-minute cycle phase engine: `EARLY`/`MID`/`LATE`/`FINAL` |
| `order.ts` | `Order`, status state machine, fill application |
| `fill.ts` | `Fill` execution reports and signed cash/share impacts |
| `position.ts` | `Position` with average-cost accounting |
| `inventory.ts` | `Inventory` aggregate root: cash + positions, settlement |
| `balance.ts` | `AccountBalance` with reserve/release/settle semantics |
| `complete-set.ts` | `CompleteSet` parity/arbitrage economics |
| `decision.ts` | `Signal`, `RiskDecision`, `TradingDecision` |
| `pnl.ts` | `PnL`, `EquitySnapshot`, drawdown/high-water-mark math |

## 3. Primitives

### 3.1 Branded ids and time

```ts
type Tagged<B> = string & { readonly brand: B };
type MarketId = Tagged<"MarketId">;   // also TokenId, OrderId, FillId, PositionId, AssetSymbol, MarketSlug
type Millis = number & { readonly brand: "Millis" };
type UtcIso  = string & { readonly brand: "UtcIso" };
```

Brands are compile-time only (zero runtime cost). A `TokenId` cannot be passed
where a `MarketId` is expected; a float cannot masquerade as `Millis`.

### 3.2 Decimal

`Decimal` is a branded `bigint` storing the amount × 10^8:

- `decFromString` parses decimal/exponent notation, round-half-up beyond 8 dp
  (max 12 fractional digits accepted).
- `decAdd`/`decSub`/`decMulRound`/`decMulTrunc`/`decDivRound`/`decDivTrunc` are
  exact or deterministically rounded. Division re-scales: `(a × 10^8) / b`.
- `decToString` renders round-trip-safe strings (`"-12.50000000"`);
  `decToScaled`/`decFromScaled` convert to/from raw bigints for persistence.
- Comparisons/predicates: `decCompare`, `decEquals`, `decIsZero`,
  `decIsPositive`, `decIsNegative`, `decMin`, `decMax`.

Prices are always in `(0, 1)` (probability-like outcome tokens); quantities and
USDC amounts are `>= 0` unless explicitly signed (PnL, cash impact).

### 3.3 Errors and Results

Constructors throw `ValidationError` on invariant violations; illegal state
transitions throw `InvalidTransitionError`. Flows where failure is expected
(e.g. parsing an external DTO) use `Result<T, E>` with `tryParse`.

## 4. Market-side models

### Asset

```ts
interface Asset { readonly symbol: AssetSymbol; readonly displayName: string }
```

The underlying (BTC, ETH). `assetSymbol()` enforces 2–10 uppercase letters.

### Market and MarketPhase

```ts
interface Market {
  id: MarketId; slug: MarketSlug; asset: AssetSymbol;
  durationMs: number;                      // 300_000 for 5-minute markets
  openAt: Millis; liveAt: Millis; settleAt: Millis;   // openAt < liveAt < settleAt
  upToken: OutcomeToken; downToken: OutcomeToken;      // distinct token ids
  phase: MarketPhase;
}
```

Lifecycle (validated by `transitionPhase`/`canTransitionPhase`):

```
announced → open → live → settling → settled
     ↘ voided   ↘ voided  ↘ voided   ↘ voided
```

`phaseAt(market, at)` derives the phase from wall-clock time;
`isTradable` is true for `open` and `live`. `settled` and `voided` are terminal.

### Outcome tokens

Each market has exactly two tokens (`up`, `down`), each paying 1 USDC per share
if its outcome wins, 0 otherwise. `tokenForOutcome`, `outcomeOfToken`,
`otherOutcome` navigate the pair.

### The canonical 5-minute phase engine (`phase-engine.ts`)

The single source of truth for the intra-cycle **EARLY / MID / LATE / FINAL**
progression. Strategy, inventory, and risk must derive "where are we in the
cycle" exclusively from this engine — never from their own arithmetic.

- Boundaries are **fractions of the cycle** (defaults 0.5 / 0.75 / 0.9), making
  the engine duration-agnostic; deployment values come from
  `MARKET_PHASE_MID/LATE/FINAL` in `@bot/shared` config and must satisfy
  `mid < late < final`.
- Boundary semantics: an instant exactly on a boundary belongs to the **later**
  phase; `endMs` is `FINAL`. `[start, mid)` EARLY, `[mid, late)` MID,
  `[late, final)` LATE, `[final, end]` FINAL.
- Clock-skew safety: all comparisons take an explicit `nowMs`/`atMs`
  parameter — the engine never reads a clock. `clampClockSkew(peerMs, nowMs,
  maxSkewMs)` bounds venue-reported timestamps to a trusted window.
- Missing timestamps are typed failures (`missing_start`/`missing_end`/
  `invalid_range`/`invalid_boundaries`) returned as `Result` — never guessed
  phases, never thrown.
- API: `cyclePhaseAt` (strict, in-cycle), `cyclePositionOf` (adds
  `before`/`after`), `phaseSchedule` (absolute boundary timestamps),
  `msRemaining`, `cycleTimeline`/`validateTimeline`.

### OrderBook

```ts
interface OrderBook { tokenId; bids: Level[]; asks: Level[]; at: Millis }
interface OrderBookLevel { price: Decimal; size: Decimal }  // price in (0,1), size >= 0
```

Invariant: `bids` sorted price-descending, `asks` price-ascending (best first).
Pure analytics: `bestBid`/`bestAsk`, `midPrice`, `spread`,
`costToBuy`/`proceedsToSell` (level-by-level sweeps returning filled size and
VWAP). Snapshot timestamps make staleness detectable downstream.

## 5. Trade-side models

### Order and its state machine

```ts
interface Order {
  id: OrderId; marketId: string; tokenId: TokenId;
  side: Side; kind: "market" | "limit";
  price: Decimal;      // limit price / cap, in (0,1)
  quantity: Decimal;   // target shares, > 0
  filledQty: Decimal;  // cumulative, <= quantity
  status: OrderStatus; createdAt: Millis; updatedAt: Millis;
}
```

Statuses and transitions (validated by `transitionOrder`/`applyFillToOrder`):

```
pending → open → partially_filled → filled
   ↘ rejected/expired/canceled     ↘ canceled/expired
```

Invariants enforced by the module:

- `quantity > 0`, `price ∈ (0, 1)`.
- fills are positive and never overfill; `filledQty == quantity` flips status
  to `filled`; `filled` cannot be reached before that.
- terminal statuses (`filled`, `canceled`, `rejected`, `expired`) accept no
  transitions and no further fills.
- `remainingQty(order)` is zero for non-working orders by definition.

### Fill

Immutable execution report: price, qty (both validated), fee ≥ 0, side,
outcome, timestamps. Pure impact helpers: `fillCashImpact` (signed USDC flow
excluding fees), `fillShareImpact` (signed shares), `fillGrossAmount`.

### Position

Average-cost tracking of one outcome token. Invariants:

- `qty >= 0` (long-only per outcome; a short is modeled as the opposite token)
- `qty == 0 ⇒ avgPrice == 0`
- sells must be covered (`fill.qty <= pos.qty`), else `InvalidTransitionError`
- buys fold fees into `avgPrice`; sells realize
  `qty × (price − avgPrice)` into `realizedPnl`
- unrealized PnL at a mark: `qty × mark − qty × avgPrice`

### Inventory (aggregate root)

```ts
interface Inventory { cash: Decimal; positions: Record<"marketId:tokenId", Position>; updatedAt }
```

Pure transitions: `applyInventoryFill` (updates position + cash atomically,
rejecting buys beyond cash and sells beyond holdings), `settleMarket` (winner
pays `payoutPerShare` — normally 1 — per share; loser is zeroed and its cost
booked as negative realized PnL). Read-side roll-ups: `openPositions`,
`totalRealizedPnl`, `totalUnrealizedPnl`, `positionsMarketValue`, `totalEquity`,
and `marketExposure` (signed up-minus-down value per market).

### Complete-set accumulation (`packages/inventory`)

Lot-level complement of the `CompleteSet` parity helpers above. An
`AcquisitionLot` records one buy-side fill (qty, price per unit, fee, rebate,
`acquiredAt`). `matchCompleteSets` consumes up lots against down lots FIFO into
complete sets and reports per side: `upCost`/`downCost`, `grossPairCost`,
pro-rata `fees`/`rebates`, `netPairCost` (exact identity
`gross + fees − rebates`), `matchedSets`, `expectedSettlementValue`
(`settlementValue × matchedSets`, default 1 per set), `grossEdge`/`netEdge`,
and residuals that preserve unmatched inventory lot by lot. Partial matching is
first-class (a lot may be consumed across many sets), leftovers are never
dropped, and the engine never forces neutrality — surplus stays as directional
(orphan) inventory for risk to police. Pure, deterministic, BigInt `Decimal`
only; no order submission.

### Hybrid rebalancing planner (`packages/inventory`)

`planRebalance` consumes a signal stance (`direction`, `confidence`), the
canonical cycle phase, current lots, set economics, and risk limits, and emits
a `StrategyDecision`: matched sets, preserved residuals, signal-derived target
(`direction × confidence × maxResidual × phaseMultiplier`, EARLY 1 / MID 0.75 /
LATE 0.5 / FINAL 0.25, clamped by `maxResidual` and risk), per-side deltas, and
budget-clamped buy-side actions (accumulate sets → rebalance to target → hedge
an oversized orphan). It never places orders, never proposes sells or negative
inventory, never assumes sets neutralize the residual, and never exceeds
`min(availableCapital, maxCapital)` (truncated 8-dp affordability + dust guard).

### Hedging decisions (`packages/inventory`)

`decideHedge` is decision-only: external hedge execution is disabled by
default (`ENABLE_EXTERNAL_HEDGE=false`; enabling throws) and nothing connects
to a futures/perpetual venue. It converts the residual exposure
(`|residualUp − residualDown| × markPrice`) into a `HedgeDecision` for the
underlying: urgency = `|direction| × confidence × phaseMultiplier ×
volatilityMultiplier` (≤ 1), target = `min(exposure × urgency, riskBudget,
exposure)` — the last term guarantees no leverage. Direction offsets the
delta (long-Up residual → short hedge). No orders are produced.

### AccountBalance

Cash account view with reservation semantics: `total`, `reserved`
(`0 ≤ reserved ≤ total`), derived `available = total − reserved`. Transitions:
`deposit`, `withdraw` (available only), `reserve`/`release` (working orders),
`settleReservation` (convert a reservation into the realized outflow, which may
be smaller than reserved). This is what risk will consume to gate order sizes.

### CompleteSet

A matched up+down pair for one market. Economics encoded as pure functions:
`setCost` (should be ~1), `mergeProfit = 1 − (up + down)` (buy both, merge),
`mintProfit = (up + down) − 1` (mint, sell both), `isMergeArb`/`isMintArb`
with a per-set fee floor, and `setPayoutAtSettlement`.

## 6. Decision pipeline

```
market data ──> Signal ──> RiskDecision ──> TradingDecision ──> (execution adapter)
  (strategy)      (risk)        (this is data only)
```

- **Signal** — directional intent from the strategy: `reason`
  (`orderbook_imbalance`, `late_window_momentum`, `price_deviation`,
  `complete_set_arbitrage`, `manual`), market/token/outcome, `side`,
  `confidence ∈ [0,1]`, `fairValue ∈ (0,1)`, timestamp, bounded `detail` map.
  `signalEdge(signal, price)` computes the strategy's estimated edge.
- **RiskDecision** — verdict (`approve` | `reduce` | `reject`) over the signal,
  with `approvedQty`/`approvedPrice` (zero for rejects), the triggering `rule`,
  and a human-readable `explanation`. Rejects must approve zero; approves must
  be positive.
- **TradingDecision** — the fully-attributed order (or none, for rejects) plus
  the risk decision that produced it, so the audit trail can reconstruct *why*.
  Constructor enforces verdict/order consistency; `decisionNotional` sizes it.

Nothing here submits orders. Execution adapters will consume
`TradingDecision` and translate to venue requests — a later, explicitly
authorized step.

## 7. PnL and equity

`PnL { realized, unrealized, fees }` with `netPnL = realized + unrealized` and
`grossPnL = net + fees`; `addPnL` composes across scopes. `EquitySnapshot`
captures `cash + positionsValue = equity` at a time, feeding `drawdown` (vs a
high-water mark) and `updateHighWaterMark` for monitoring and risk limits.

## 8. Invariants summary (tested)

All of the following are covered by unit tests in `packages/domain/src/*.test.ts`:

1. Decimal parse/round-trip exactness; no float accumulation on repeated adds.
2. Division re-scaling (`1/3 → 0.33333333`; `a == b*q + r` reconstruction).
3. Market timestamp ordering; distinct outcome tokens; phase graph legality.
4. Book sorting, mid/spread, sweep VWAP and partial-fill behavior; price range.
5. Order lifecycle legality; no overfill; no fills in terminal states.
6. Position average cost (fees included), realized/unrealized PnL, no overdraw.
7. Inventory cash accounting for buys/sells (fees included), settlement payouts,
   signed exposure, and equity roll-ups.
8. Balance reserve/release/settle/withdraw invariants (`available ≥ 0`).
9. Complete-set parity arbitrage bounds.
10. Decision pipeline consistency (reject ⇒ no order; approve ⇒ positive qty).

## 9. Boundary contract (for future packages)

- `packages/market-data` will map Polymarket Gamma/CLOB DTOs → `Market`,
  `OrderBook`, `PriceQuote`; failures use `Result`/`tryParse`.
- `packages/strategy` will consume `Market` + `OrderBook` snapshots and emit
  `Signal`s only.
- `packages/risk` (implemented) hosts the authoritative `evaluateRiskOrder`:
  callers aggregate their own state (capital, losses, ages, health) into a
  `RiskOrderRequest`; the engine returns a `RiskEvaluation` verdict only.
- `packages/execution` (implemented, paper only) defines the `ExecutionAdapter`
  port and a deterministic `PaperExecutionAdapter` over configured simulated
  books. The factory is fail-closed: `TRADING_MODE=paper` cannot construct any
  live venue adapter, and no live execution exists.
- `packages/persistence` will store `Decimal`s via `decToScaled`/`decFromScaled`
  (bigint columns) and timestamps as epoch `Millis`.
- `packages/observability` (implemented) provides the measurement plane: a
  deterministic, dependency-free `MetricsRegistry` (Prometheus text + JSON)
  fed by typed collectors per concern area (market data ages, WebSocket
  status, signal/confidence/phase, complete-set opportunities, inventory
  up/down/sets/residual/orphan, execution order/fill/cancel/reject/latency,
  risk capital/exposure/loss/state/kill-switch, system CPU/memory/uptime,
  reconnects, API errors). Metric labels are validated at the boundary and
  secret-shaped keys/values are refused (`SecretLabelError`); structured
  events flow through the shared redacting logger.
- `packages/orchestrator` (implemented, paper only) composes the full pipeline
  per market per tick: Discovery → Market Data → Signal → Phase → Inventory →
  Complete-Set → Rebalancing → RiskEngine → ExecutionAdapter. It emits
  audited `DecisionRecord`s (unique decision ids), never bypasses risk, never
  calls the venue directly, dedupes in-flight intents, throttles requotes, and
  fails closed on stale/unknown data.
- `packages/soak` (implemented, paper only) wraps the orchestrator + paper
  adapter in a long-running loop for soak testing: fail-closed paper-mode
  validation at construction, per-cycle health snapshots, a deterministic
  bounded reconnect backoff (the reconciliation gate never reopens without a
  clean pass), crash-safe atomic state persistence plus append-only JSONL
  event logs (decisions/fills/reconciliations, UTC-date rotated), periodic
  full local-vs-adapter reconciliation, and UTC daily performance reports
  (JSON + CSV). Strictly measurement-only: results never adjust strategy
  parameters. See `SOAK.md` for the runbook and acceptance checklist.
- `hermes` (implemented: control plane) is the audited operational interface:
  a closed command allow-list (`status`, `markets`, `signals`, `inventory`,
  `orders`, `pnl`, `risk`, `reconcile`, `pause`, `resume`, `cancel-all`,
  `kill-switch`, `explain-last-decision`) dispatched through `ControlPlane`
  against the plain-data `BotControlApi` port. No order submission exists in
  the surface, no secrets pass through it, and pause/kill-switch are fail-safe
  (see `HERMES.md`). Future event payloads will reference domain models by
  value, never strings.
