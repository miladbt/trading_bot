# @bot/inventory

Lot-level acquisition tracking and the complete-set accumulation engine.

## Complete-set engine (`matchCompleteSets`)

1 Up + 1 Down = 1 complete set, and a set always settles to exactly 1 USDC (the
winning token pays 1, the losing token pays 0). The strategy seeks inventory
states where `up cost + down cost` is below the expected settlement value after
all applicable costs. This engine matches *acquisition lots* — the actual fills
the account is holding — into complete sets and reports the cost breakdown and
both edges:

- `upCost` / `downCost` — price paid for the matched portion of each side
- `grossPairCost` — `upCost + downCost`
- `fees` / `rebates` — pro-rata share of each lot's fee/rebate attributable to
  the matched quantity (rounded half-away-from-zero at 8 dp)
- `netPairCost` — `grossPairCost + fees - rebates` (exact identity)
- `expectedSettlementValue` — `settlementValue * matchedSets` (default 1 per set)
- `grossEdge` / `netEdge` — expected settlement value minus gross/net pair cost
- `matchedSets` — matched-set quantity (the smaller side)
- `residualUp` / `residualDown` — leftover inventory, preserved lot by lot

Guarantees:

- **Pure and deterministic.** No clock reads, no I/O, no randomness; inputs are
  never mutated.
- **FIFO matching** by `acquiredAt` (ties broken by input order). A lot may be
  partially consumed across several sets.
- **Unmatched inventory is preserved** in `residualUpLots` / `residualDownLots`.
- **Never forces neutrality.** A surplus on either side stays as directional
  (orphan) inventory for the risk layer to police.
- **BigInt `Decimal` only (8 dp)** — no floating-point arithmetic anywhere.

The engine is the lot-level complement of `@bot/domain`'s per-set parity
helpers (`setCost` / `mergeProfit`), which operate on best-quote snapshots.

```ts
import { createAcquisitionLot, matchCompleteSets } from "@bot/inventory";

const result = matchCompleteSets({
  upLots: [upLot],   // AcquisitionLot[]
  downLots: [downLot],
});
// result.matchedSets, result.grossEdge, result.netEdge, result.residualUp, ...
```

This package never submits orders.

## Hybrid inventory rebalancing (`planRebalance`)

The planner turns a signal + phase + risk limits + current lot inventory into a
`StrategyDecision` (pure data — **not** an order):

- **Target residual** = `direction × confidence × maxResidual × phaseMultiplier`
  (EARLY 1.0 / MID 0.75 / LATE 0.5 / FINAL 0.25), clamped by the configured
  `maxResidual` and risk's `maxDirectionalShares`.
- **Complete-set accumulation** first (when `1 - (upAsk + downAsk + costs) > 0`),
  then **residual rebalancing** toward the target, then **dynamic hedging** of
  an orphan above `maxResidual` by buying the light side.
- Budget-clamped by `min(availableCapital, maxCapital)` with truncated 8-dp
  affordability (never overspends), dust-guarded at 1 micro-USDC.
- Never proposes sells, shorts, or negative inventory; never assumes complete
  sets neutralize the residual; preserves unmatched inventory.

See `STRATEGY.md` at the repo root for the full algorithm and worked example.

## Reconciliation (`ReconciliationCoordinator`)

Compares local state (cash, known trade ids, orders, up/down lots → matched
sets + residuals) against a remote venue snapshot and emits explicit
`ReconciliationEvent`s — timestamp, discrepancy type, local state, remote
state, action taken. **Nothing is ever silently overwritten.**

Reconciled dimensions: account balance, open orders (missing locally /
missing remotely / status drift), fills (unexpected blocks; duplicates are
reported and deduped), Up inventory, Down inventory, matched complete sets,
residual inventory, and local-state staleness.

The coordinator runs on six triggers — `startup`, `reconnect`,
`unknown_order_state`, `api_failure`, `websocket_recovery`, `periodic` — and
exposes a fail-closed gate (`reconciliationState`: `"reconciled"` /
`"unreconciled"` / `undefined` before the first pass). That gate feeds the
RiskEngine's `reconciliation` input, so while reconciliation has not passed,
risk refuses every order: **NO_NEW_ORDERS** is enforced by the authoritative
risk path. A subsequent clean pass recovers the gate.

## Dynamic hedging decisions (`decideHedge`)

Decision-only engine for external (BTC/ETH) hedges of the residual Polymarket
exposure: given the signal, lot inventory, phase, volatility, and a USDC risk
budget, it emits a `HedgeDecision` (`required`, `asset`, `direction`,
`targetSize`, `reason`, `confidence`, `riskImpact`) — pure data, never an
order. `externalHedgeEnabled: true` throws: external hedge execution is
disabled by default (`ENABLE_EXTERNAL_HEDGE=false`), no exchange connection,
no orders, no leverage (target is capped at the exposure itself).
