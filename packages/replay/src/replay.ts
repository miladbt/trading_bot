/**
 * ReplayEngine: deterministic historical replay through the EXACT strategy
 * stack used by paper mode.
 *
 * No second strategy implementation exists: the engine drives the real
 * `StrategyOrchestrator` (signal → phase → inventory → complete-set →
 * rebalancing → risk) with historical data fed through `OrchestratorPorts`,
 * and the real `PaperExecutionAdapter` for simulated fills. Settlement is
 * applied at each window's end with the recorded winning outcome.
 *
 * Replay book model: each token's historical ask snapshots become the resting
 * liquidity ladder of its simulated book (sorted ascending, deep enough to
 * absorb the replay's flow). A buy at the current ask crosses the ladder at
 * that price; fills are therefore priced by historical asks and bounded by
 * historical liquidity — deterministic and free of look-ahead (the orchestrator
 * only ever sees samples at or before the current tick).
 *
 * Determinism: the tick timeline is derived from the dataset (`startMs`,
 * `endMs`, `tickMs`), never from the wall clock. `speed` only paces real-time
 * demos and never affects results.
 *
 * Settlement accounting (exact, BigInt Decimals):
 *   payout = (matchedSets + winnerResidualShares) × 1 USDC
 *   cost   = Σ(fill price × qty) + Σ(fill fees)          [actual cash spent]
 *   pnl    = payout − cost
 * Drawdown is tracked on the tick-by-tick equity curve
 * (realized-so-far + mark-to-market of open inventory at historical asks).
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decDivRound,
  decFromString,
  decMulRound,
  decSub,
  decToString,
  decZero,
  millis,
  type Decimal,
  type Millis,
} from "@bot/domain";
import {
  PaperExecutionAdapter,
  createSimulatedBook,
  type BookLevel,
  type ExecutionFill,
  type ExecutionOrder,
} from "@bot/execution";
import {
  createAcquisitionLot,
  lotNetCost,
  matchCompleteSets,
  type AcquisitionLot,
} from "@bot/inventory";
import {
  StrategyOrchestrator,
  type DecisionRecord,
  type DiscoveredMarket,
  type MarketDataSnapshot,
  type OrchestratorPorts,
} from "@bot/orchestrator";
import type { AssetSymbol } from "@bot/domain";
import type { AppConfig } from "@bot/shared";

import type { ParsedWindow } from "./sources.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReplayConfig {
  /** Tick interval along the historical timeline, ms (default 1s). */
  readonly tickMs: number;
  /**
   * Replay speed for wall-clock-paced runs (demos only). Results are
   * identical for any speed; `0` runs as fast as possible.
   */
  readonly speed: number;
  /** Taker fee rate applied by the simulated venue (fraction of notional). */
  readonly takerFeeRate: string;
  /** Deep liquidity multiplier for the simulated ladder (shares per unit). */
  readonly ladderDepthShares: string;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  tickMs: 1_000,
  speed: 0,
  takerFeeRate: "0.002",
  ladderDepthShares: "100000",
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReplayTrade {
  readonly marketId: string;
  readonly clientOrderId: string;
  readonly outcome: "up" | "down";
  readonly qty: Decimal;
  readonly price: Decimal;
  readonly fee: Decimal;
  readonly at: Millis;
}

export interface ReplaySetRecord {
  readonly marketId: string;
  readonly matchedSets: Decimal;
  readonly upCost: Decimal;
  readonly downCost: Decimal;
  readonly grossPairCost: Decimal;
  readonly fees: Decimal;
  readonly rebates: Decimal;
  readonly netPairCost: Decimal;
  readonly expectedSettlementValue: Decimal;
  readonly grossEdge: Decimal;
  readonly netEdge: Decimal;
  readonly residualUp: Decimal;
  readonly residualDown: Decimal;
}

export interface ReplayWindowResult {
  readonly marketId: string;
  readonly asset: string;
  readonly winningOutcome: "up" | "down";
  readonly realizedPnl: Decimal;
  readonly residualUp: Decimal;
  readonly residualDown: Decimal;
  readonly sets: ReplaySetRecord;
  readonly trades: readonly ReplayTrade[];
}

export interface ReplayOrderStats {
  readonly submitted: number;
  readonly filled: number;
  readonly partiallyFilled: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly fillRate: string;
  readonly avgFillQty: string;
}

export interface ReplayReport {
  readonly dataset: string;
  readonly windows: readonly ReplayWindowResult[];
  readonly totals: {
    readonly trades: number;
    readonly completeSets: Decimal;
    readonly grossEdge: Decimal;
    readonly netEdge: Decimal;
    readonly fees: Decimal;
    readonly realizedPnl: Decimal;
    readonly maxDrawdown: Decimal;
    readonly finalResidualUp: Decimal;
    readonly finalResidualDown: Decimal;
    readonly peakInventoryExposure: Decimal;
    readonly orderStats: ReplayOrderStats;
  };
  /** Every orchestrator decision, in order (full audit trail). */
  readonly decisions: readonly DecisionRecord[];
  /**
   * Raw measurement series for the analytics module (exact tick samples and
   * holding times; kept out of `totals` so totals stay summary-level).
   */
  readonly extras: {
    /** Inventory exposure (USDC) sampled once per tick, in tick order. */
    readonly inventorySamples: readonly Decimal[];
    /** Holding time of every filled lot, ms (acquisition → settlement). */
    readonly holdingTimesMs: readonly number[];
    /** Final mark prices per share (last ask snapshot of the last window). */
    readonly finalMarkUp: Decimal;
    readonly finalMarkDown: Decimal;
    /** Mark-to-market of the final open inventory minus its cost. */
    readonly unrealizedPnl: Decimal;
  };
}

// ---------------------------------------------------------------------------
// Historical ports (OrchestratorPorts over the dataset — no look-ahead)
// ---------------------------------------------------------------------------

class ReplayPorts implements OrchestratorPorts {
  private readonly windowByMarket = new Map<string, ParsedWindow>();
  private current: ParsedWindow | undefined;
  private currentAskIndex = 0;
  private currentTick = 0;

  readonly lotState: { up: AcquisitionLot[]; down: AcquisitionLot[] } = { up: [], down: [] };
  readonly accountState = {
    openOrderCount: 0,
    totalCapitalDeployed: decZero(),
    marketCapitalByMarket: {} as Record<string, Decimal>,
    directionalExposureAfter: decZero(),
    dailyLossUsdc: decZero(),
    marketLossByMarket: {} as Record<string, Decimal>,
    reconciliation: "reconciled" as const,
  };

  constructor(windows: readonly ParsedWindow[]) {
    for (const w of windows) this.windowByMarket.set(w.marketId, w);
  }

  /** Focus the ports on a window at a point on the historical timeline. */
  focus(marketId: string, tickMs: number): void {
    this.current = this.windowByMarket.get(marketId);
    this.currentTick = tickMs;
    const w = this.current;
    if (w === undefined) {
      this.currentAskIndex = 0;
      return;
    }
    let idx = 0;
    for (let i = 0; i < w.asks.length; i++) {
      if (w.asks[i]!.at <= tickMs) idx = i;
    }
    this.currentAskIndex = idx;
  }

  discoverMarkets(): readonly DiscoveredMarket[] {
    const w = this.current;
    if (w === undefined) return [];
    return [
      {
        marketId: w.marketId,
        tokenIdUp: w.tokenIdUp,
        tokenIdDown: w.tokenIdDown,
        asset: w.asset as AssetSymbol,
        startMs: millis(w.startMs),
        endMs: millis(w.endMs),
      },
    ];
  }

  marketData(): MarketDataSnapshot | undefined {
    const w = this.current;
    if (w === undefined) return undefined;
    const ask = w.asks[this.currentAskIndex];
    if (ask === undefined) return undefined;
    return {
      marketId: w.marketId,
      upAsk: ask.upAsk,
      downAsk: ask.downAsk,
      ageMs: Math.max(0, this.currentTick - ask.at),
      underlyingAgeMs: this.underlyingAge(),
      apiHealth: "healthy",
      wsHealth: "healthy",
    };
  }

  private underlyingAge(): number {
    const w = this.current;
    if (w === undefined) return Number.MAX_SAFE_INTEGER;
    // Age relative to the newest sample at or before the tick (no look-ahead).
    let newest: number | undefined;
    for (const s of w.spot) {
      if (s.at <= this.currentTick) newest = s.at;
    }
    return newest === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, this.currentTick - newest);
  }

  spotSamples(): readonly { price: string; at: Millis }[] {
    const w = this.current;
    if (w === undefined) return [];
    return w.spot
      .filter((s) => s.at <= this.currentTick)
      .map((s) => ({ price: s.price, at: millis(s.at) }));
  }

  account() {
    const a = this.accountState;
    return {
      openOrderCount: a.openOrderCount,
      totalCapitalDeployed: a.totalCapitalDeployed,
      marketCapitalByMarket: a.marketCapitalByMarket,
      directionalExposureAfter: a.directionalExposureAfter,
      dailyLossUsdc: a.dailyLossUsdc,
      marketLossByMarket: a.marketLossByMarket,
      reconciliation: a.reconciliation,
    };
  }

  lots(): { up: readonly AcquisitionLot[]; down: readonly AcquisitionLot[] } {
    return { up: this.lotState.up, down: this.lotState.down };
  }

  /** Current window's ask snapshot at or before the tick. */
  currentAsk(): { upAsk: Decimal; downAsk: Decimal } | undefined {
    const w = this.current;
    if (w === undefined) return undefined;
    const ask = w.asks[this.currentAskIndex];
    return ask === undefined ? undefined : { upAsk: ask.upAsk, downAsk: ask.downAsk };
  }

  currentWindow(): ParsedWindow | undefined {
    return this.current;
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class ReplayEngine {
  private readonly windows: readonly ParsedWindow[];
  private readonly config: ReplayConfig;

  constructor(windows: readonly ParsedWindow[], config?: Partial<ReplayConfig>) {
    if (windows.length === 0) {
      throw new ValidationError("replay requires at least one market window");
    }
    this.windows = windows;
    this.config = { ...DEFAULT_REPLAY_CONFIG, ...config };
  }

  /** The tick timeline of a window (pure; used by run and by pacing callers). */
  tickTimeline(window: ParsedWindow): readonly Millis[] {
    const out: Millis[] = [];
    for (let t = window.startMs; t < window.endMs; t += this.config.tickMs) {
      out.push(millis(t));
    }
    return out;
  }

  /**
   * Run the replay. Deterministic: identical datasets + config produce
   * identical reports. `hooks.onTick` exists for pacing/progress only.
   */
  run(
    appConfig: AppConfig,
    hooks: { readonly onTick?: (tickIndex: number, at: Millis) => void } = {},
  ): ReplayReport {
    const adapter = new PaperExecutionAdapter({
      tokens: this.windows.flatMap((w) => [
        { tokenId: w.tokenIdUp, book: this.ladder(w.asks.map((a) => a.upAsk)) },
        { tokenId: w.tokenIdDown, book: this.ladder(w.asks.map((a) => a.downAsk)) },
      ]),
      takerFeeRate: decFromString(this.config.takerFeeRate),
    });

    const ports = new ReplayPorts(this.windows);
    const orchestrator = new StrategyOrchestrator({
      config: appConfig,
      ports,
      adapter,
    });

    const trades: ReplayTrade[] = [];
    const decisions: DecisionRecord[] = [];
    const inventorySamples: Decimal[] = [];
    const holdingTimesMs: number[] = [];
    let realizedTotal = decZero();
    let peakExposure = decZero();
    let equityPeak = decZero();
    let maxDrawdown = decZero();
    let tickCounter = 0;

    for (const window of this.windows) {
      const windowTradesStart = trades.length;
      const windowFillCountAtStart = holdingTimesMs.length;

      for (const t of this.tickTimeline(window)) {
        ports.focus(window.marketId, t);

        // Simulator first: fills from orders submitted on earlier ticks.
        const fills = adapter.advanceClock(t);
        for (const fill of fills) {
          this.recordFill(fill, window, ports, t, trades, (id) => adapter.getOrder(id));
        }

        // The SAME orchestrator as paper mode decides on this tick.
        decisions.push(...orchestrator.tick(t));

        // Mark-to-market for the equity curve and exposure tracking.
        const ask = ports.currentAsk();
        if (ask !== undefined) {
          const exposure = markValue(ports.lotState, ask.upAsk, ask.downAsk);
          inventorySamples.push(exposure);
          if (decCompare(exposure, peakExposure) > 0) peakExposure = exposure;

          const cost = cashSpent(trades);
          const equity = decSub(decAdd(realizedTotal, exposure), cost);
          if (decCompare(equity, equityPeak) > 0) equityPeak = equity;
          const dd = decSub(equityPeak, equity);
          if (decCompare(dd, maxDrawdown) > 0) maxDrawdown = dd;
        }

        tickCounter += 1;
        hooks.onTick?.(tickCounter, t);
      }

      // ---- Window accounting: sets record, then settlement ----
      const windowTrades = trades.slice(windowTradesStart);
      const match = matchFromTrades(window, windowTrades);
      const pnl = settleWindow(window, match, windowTrades);
      realizedTotal = decAdd(realizedTotal, pnl);

      // Fold losses into the account state (losses are positive numbers).
      if (decCompare(pnl, decZero()) < 0) {
        const loss = decSub(decZero(), pnl);
        ports.accountState.dailyLossUsdc = decAdd(ports.accountState.dailyLossUsdc, loss);
        ports.accountState.marketLossByMarket[window.marketId] = decAdd(
          ports.accountState.marketLossByMarket[window.marketId] ?? decZero(),
          loss,
        );
      }

      // Holding times for this window's fills: acquisition → window end.
      for (let i = windowFillCountAtStart; i < trades.length; i++) {
        holdingTimesMs.push(Number(window.endMs) - Number(trades[i]!.at));
      }

      // Clear settled inventory for the next window.
      ports.lotState.up = [];
      ports.lotState.down = [];
    }

    const windowResults = this.windowResults(trades);

    // Final marks + unrealized PnL: value any residual inventory at the last
    // ask snapshot of the last window. (In the normal replay flow inventory
    // is settled and cleared per window, so this is usually zero; the fields
    // exist so interrupted/carry-over replays measure correctly.)
    const lastWindow = this.windows[this.windows.length - 1];
    const finalAsk = lastWindow !== undefined ? lastAskOf(lastWindow) : undefined;
    const finalMarkUp = finalAsk !== undefined ? finalAsk.upAsk : decZero();
    const finalMarkDown = finalAsk !== undefined ? finalAsk.downAsk : decZero();
    const remainingUp = ports.lotState.up;
    const remainingDown = ports.lotState.down;
    const remainingMark = markValue(
      { up: remainingUp, down: remainingDown },
      finalMarkUp,
      finalMarkDown,
    );
    const remainingCost = decAdd(costOf(remainingUp), costOf(remainingDown));
    const unrealizedPnl = decSub(remainingMark, remainingCost);

    return {
      dataset: "replay",
      windows: windowResults,
      totals: buildTotals(windowResults, trades, adapter.listOrders(), {
        realizedTotal,
        maxDrawdown,
        peakExposure,
      }),
      decisions,
      extras: {
        inventorySamples,
        holdingTimesMs,
        finalMarkUp,
        finalMarkDown,
        unrealizedPnl,
      },
    };
  }

  /** Build the liquidity ladder for one token from its historical asks. */
  private ladder(asks: readonly Decimal[]): ReturnType<typeof createSimulatedBook> {
    const depth = decFromString(this.config.ladderDepthShares);
    const levels: BookLevel[] = asks
      .map((price) => ({ price, qty: depth }))
      .sort((a, b) => decCompare(a.price, b.price));
    // Deduplicate equal prices by summing quantity.
    const merged: BookLevel[] = [];
    for (const level of levels) {
      const last = merged[merged.length - 1];
      if (last !== undefined && decCompare(last.price, level.price) === 0) {
        merged[merged.length - 1] = { price: last.price, qty: decAdd(last.qty, level.qty) };
      } else {
        merged.push(level);
      }
    }
    return createSimulatedBook(merged);
  }

  private recordFill(
    fill: ExecutionFill,
    window: ParsedWindow,
    ports: ReplayPorts,
    at: Millis,
    trades: ReplayTrade[],
    orderOf: (clientOrderId: string) => ExecutionOrder | undefined,
  ): void {
    const order = orderOf(fill.clientOrderId);
    const outcome: "up" | "down" =
      order !== undefined && order.tokenId === window.tokenIdUp ? "up" : "down";
    trades.push({
      marketId: window.marketId,
      clientOrderId: fill.clientOrderId,
      outcome,
      qty: fill.qty,
      price: fill.price,
      fee: fill.fee,
      at,
    });
    const lot = createAcquisitionLot({
      lotId: `${fill.clientOrderId}-f${trades.length}`,
      marketId: window.marketId as never,
      tokenId: (outcome === "up" ? window.tokenIdUp : window.tokenIdDown) as never,
      outcome,
      qty: fill.qty,
      pricePerUnit: fill.price,
      fee: fill.fee,
      rebate: decZero(),
      acquiredAt: at,
    });
    if (outcome === "up") ports.lotState.up.push(lot);
    else ports.lotState.down.push(lot);
  }

  private windowResults(trades: readonly ReplayTrade[]): ReplayWindowResult[] {
    return this.windows.map((w) => {
      const windowTrades = trades.filter((t) => t.marketId === w.marketId);
      const match = matchFromTrades(w, windowTrades);
      const pnl = settleWindow(w, match, windowTrades);
      return {
        marketId: w.marketId,
        asset: w.asset,
        winningOutcome: w.winningOutcome,
        realizedPnl: pnl,
        residualUp: match.residualUp,
        residualDown: match.residualDown,
        sets: {
          marketId: w.marketId,
          matchedSets: match.matchedSets,
          upCost: match.upCost,
          downCost: match.downCost,
          grossPairCost: match.grossPairCost,
          fees: match.fees,
          rebates: match.rebates,
          netPairCost: match.netPairCost,
          expectedSettlementValue: match.expectedSettlementValue,
          grossEdge: match.grossEdge,
          netEdge: match.netEdge,
          residualUp: match.residualUp,
          residualDown: match.residualDown,
        },
        trades: windowTrades,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lotOf(
  window: ParsedWindow,
  side: "up" | "down",
  trade: ReplayTrade,
  index: number,
): AcquisitionLot {
  return createAcquisitionLot({
    lotId: `${trade.clientOrderId}-f${index}`,
    marketId: window.marketId as never,
    tokenId: (side === "up" ? window.tokenIdUp : window.tokenIdDown) as never,
    outcome: side,
    qty: trade.qty,
    pricePerUnit: trade.price,
    fee: trade.fee,
    rebate: decZero(),
    acquiredAt: trade.at,
  });
}

/** Match a window's trades into lots and run the complete-set engine. */
function matchFromTrades(
  window: ParsedWindow,
  windowTrades: readonly ReplayTrade[],
): ReturnType<typeof matchCompleteSets> {
  const upLots = windowTrades
    .filter((t) => t.outcome === "up")
    .map((t, i) => lotOf(window, "up", t, i));
  const downLots = windowTrades
    .filter((t) => t.outcome === "down")
    .map((t, i) => lotOf(window, "down", t, i));
  return matchCompleteSets({ upLots, downLots, settlementValue: decFromString("1") });
}

/** Cash spent on a trade list: Σ(price × qty) + Σ(fees). */
function windowCost(trades: readonly ReplayTrade[]): Decimal {
  let total = decZero();
  for (const t of trades) {
    total = decAdd(total, decAdd(decMulRound(t.price, t.qty), t.fee));
  }
  return total;
}

/** Net cost of a lot list: Σ(price × qty) + Σ(fees) − Σ(rebates). */
function costOf(lots: readonly AcquisitionLot[]): Decimal {
  let total = decZero();
  for (const lot of lots) {
    total = decAdd(total, lotNetCost(lot));
  }
  return total;
}

/** Last ask snapshot of a window (the final mark). */
function lastAskOf(window: ParsedWindow): { upAsk: Decimal; downAsk: Decimal } | undefined {
  const last = window.asks[window.asks.length - 1];
  return last === undefined ? undefined : { upAsk: last.upAsk, downAsk: last.downAsk };
}

function cashSpent(trades: readonly ReplayTrade[]): Decimal {
  return windowCost(trades);
}

/** Mark value of inventory at the given asks. */
function markValue(
  lots: { readonly up: readonly AcquisitionLot[]; readonly down: readonly AcquisitionLot[] },
  upAsk: Decimal,
  downAsk: Decimal,
): Decimal {
  let total = decZero();
  for (const lot of lots.up) total = decAdd(total, decMulRound(lot.qty, upAsk));
  for (const lot of lots.down) total = decAdd(total, decMulRound(lot.qty, downAsk));
  return total;
}

/**
 * Settle one window: payout = (matchedSets + winnerResidual) × 1, cost =
 * actual cash spent (notional + fees). Pure with respect to its inputs.
 */
function settleWindow(
  window: ParsedWindow,
  match: ReturnType<typeof matchCompleteSets>,
  windowTrades: readonly ReplayTrade[],
): Decimal {
  const winnerIsUp = window.winningOutcome === "up";
  const winnerResidual = winnerIsUp ? match.residualUp : match.residualDown;
  const payout = decMulRound(decAdd(match.matchedSets, winnerResidual), decFromString("1"));
  return decSub(payout, windowCost(windowTrades));
}

function buildTotals(
  windowResults: readonly ReplayWindowResult[],
  trades: readonly ReplayTrade[],
  orders: readonly ExecutionOrder[],
  finals: {
    realizedTotal: Decimal;
    maxDrawdown: Decimal;
    peakExposure: Decimal;
  },
): ReplayReport["totals"] {
  const submitted = orders.length;
  const filled = orders.filter((o) => o.status === "FILLED").length;
  const partial = orders.filter((o) => o.status === "PARTIALLY_FILLED").length;
  const cancelled = orders.filter((o) => o.status === "CANCELLED").length;
  const rejected = orders.filter((o) => o.status === "REJECTED").length;
  const worked = filled + partial + cancelled;
  const totalQty = trades.reduce((acc, t) => decAdd(acc, t.qty), decZero());
  const fees = trades.reduce((acc, t) => decAdd(acc, t.fee), decZero());

  // Aggregate sets/edges/residuals across all window results.
  let completeSets = decZero();
  let grossEdge = decZero();
  let netEdge = decZero();
  let residualUp = decZero();
  let residualDown = decZero();
  for (const w of windowResults) {
    completeSets = decAdd(completeSets, w.sets.matchedSets);
    grossEdge = decAdd(grossEdge, w.sets.grossEdge);
    netEdge = decAdd(netEdge, w.sets.netEdge);
    residualUp = decAdd(residualUp, w.residualUp);
    residualDown = decAdd(residualDown, w.residualDown);
  }

  return {
    trades: trades.length,
    completeSets,
    grossEdge,
    netEdge,
    fees,
    realizedPnl: finals.realizedTotal,
    maxDrawdown: finals.maxDrawdown,
    finalResidualUp: residualUp,
    finalResidualDown: residualDown,
    peakInventoryExposure: finals.peakExposure,
    orderStats: {
      submitted,
      filled,
      partiallyFilled: partial,
      cancelled,
      rejected,
      fillRate:
        submitted === 0
          ? decToString(decZero())
          : decToString(
              decDivRound(decFromString(String(worked)), decFromString(String(submitted))),
            ),
      avgFillQty:
        trades.length === 0
          ? decToString(decZero())
          : decToString(decDivRound(totalQty, decFromString(String(trades.length)))),
    },
  };
}
