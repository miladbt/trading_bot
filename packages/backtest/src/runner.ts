/**
 * Backtest runner (T10): replays a dataset through the REAL orchestrator
 * pipeline (discovery → data → signal → phase → inventory → complete-set →
 * rebalancing → risk → paper execution) with an injected clock.
 *
 * No shortcuts: orders are produced by the real StrategyOrchestrator, gated by
 * the real RiskEngine, and filled by the real PaperExecutionAdapter (with the
 * pessimistic fill model and configured latency). No look-ahead: ports expose
 * only data with timestamp <= now; settlement is applied only after endMs from
 * the Gamma resolution metadata (verified resolution source, T3).
 *
 * Money boundaries: the harness measures PnL in BigInt Decimal from the
 * adapter's Decimal fills and the settlement model. Any float statistics live
 * only in the metrics module and never feed back into sizing.
 */

import {
  decAdd,
  decFromString,
  decMulRound,
  decSub,
  decZero,
  millis,
  takerFeePerShare,
  type Decimal,
  type Millis,
} from "@bot/domain";
import {
  createExecutionAdapter,
  createSimulatedBook,
  type ExecutionFill,
  type PaperExecutionAdapter,
} from "@bot/execution";
import { StrategyOrchestrator, type DecisionRecord } from "@bot/orchestrator";
import type { AppConfig } from "@bot/shared";
import { DEFAULT_SIGNAL_ENGINE_CONFIG } from "@bot/strategy";
import type { CalibrationModel } from "@bot/calibration";

import { tokenPriceAt, type BacktestDataset, type BacktestMarket } from "./dataset.js";
import { createBacktestPorts, type BacktestAdapterState } from "./ports.js";
import { settleMarket } from "./settlement.js";

export interface BacktestRunOptions {
  readonly config: AppConfig;
  /** Injected clock start/end (ms). The loop ticks every `tickMs`. */
  readonly windowStartMs: Millis;
  readonly windowEndMs: Millis;
  readonly tickMs: number;
  /** Fill model for the paper adapter ("pessimistic" default per T4). */
  readonly fillModel?: "optimistic" | "pessimistic" | undefined;
  readonly submitLatencyMs?: number | undefined;
  readonly cancelLatencyMs?: number | undefined;
  /** Calibration models per asset (walk-forward artifacts). */
  readonly calibration?: Readonly<Record<string, CalibrationModel>> | undefined;
}

export interface SetEdgeSample {
  readonly at: Millis;
  readonly slug: string;
  readonly asset: "BTC" | "ETH";
  /** Executable combined ask (both legs, derived books). */
  readonly combinedAsk: Decimal;
  /** 1 − combinedAsk − per-set taker fee (verified formula, T3). */
  readonly setEdgePerSet: Decimal;
}

export interface BacktestRunResult {
  readonly ticks: number;
  readonly decisions: readonly DecisionRecord[];
  readonly fills: readonly ExecutionFill[];
  /** Exact Decimal cash spent on buys, fees included (a positive cost). */
  readonly spentUsdc: Decimal;
  /** Exact Decimal fees paid across all fills. */
  readonly feesUsdc: Decimal;
  /** Exact Decimal settlement payouts received after the window. */
  readonly settlementUsdc: Decimal;
  /** Net PnL = settlements − spend. Exact Decimal. */
  readonly netPnlUsdc: Decimal;
  /** Settled payouts per market slug. */
  readonly settlements: readonly { slug: string; payout: Decimal; outcome: "UP" | "DOWN" }[];
  /** T5: executable combined-ask samples with set edge after fees. */
  readonly setEdgeSamples: readonly SetEdgeSample[];
  /** Markets whose window overlapped the run (diagnostic). */
  readonly marketsSeen: number;
}

/**
 * Run one backtest pass. Deterministic: same dataset + options → identical
 * result (no wall-clock anywhere; the injected clock drives everything).
 */
export function runBacktest(
  dataset: BacktestDataset,
  options: BacktestRunOptions,
): BacktestRunResult {
  const { config } = options;
  const fillModel = options.fillModel ?? "pessimistic";
  const submitLatencyMs = options.submitLatencyMs ?? 250;
  const cancelLatencyMs = options.cancelLatencyMs ?? 250;

  // One simulated book per token; the runner pushes the current derived
  // top-of-book into it every tick via setBook (deterministic replay input).
  const tokenIds = [...new Set(dataset.markets.flatMap((m) => [m.upTokenId, m.downTokenId]))];
  const adapter = createExecutionAdapter("paper", {
    tokens: tokenIds.map((tokenId) => ({
      tokenId,
      book: createSimulatedBook([{ price: decFromString("0.5"), qty: decFromString("1000000") }]),
    })),
    takerFeeRate: config.fees.takerRate,
    fillModel,
    submitLatencyMs,
    cancelLatencyMs,
    ...(fillModel === "pessimistic"
      ? {
          pessimistic: {
            tradeThrough: config.execution.tradeThrough,
            queuePositionFactor: config.execution.queuePositionFactor,
            adverseMoveThreshold: config.execution.adverseMoveThreshold,
          },
        }
      : {}),
  });

  const state: BacktestAdapterState = {
    lots: new Map(),
    deployed: decZero(),
    dailyLoss: decZero(),
    marketLoss: new Map(),
  };

  const orchestrator = new StrategyOrchestrator({
    config,
    ports: createBacktestPorts(dataset, state),
    adapter,
    signalConfig: DEFAULT_SIGNAL_ENGINE_CONFIG,
    ...(options.calibration !== undefined ? { calibration: options.calibration } : {}),
  });

  const allDecisions: DecisionRecord[] = [];
  const setEdgeSamples: SetEdgeSample[] = [];
  let spent = decZero();
  let feesPaid = decZero();
  let ticks = 0;
  // Sequence counter for deterministic, unique lot ids across the whole run.
  let fillSeq = 0;
  // clientOrderId → tokenId, rebuilt from the adapter's own order snapshots
  // whenever a tick produced fills (no orchestrator hook, no module state).
  let tokenByOrder = new Map<string, string>();

  for (
    let now = Number(options.windowStartMs);
    now < Number(options.windowEndMs);
    now += options.tickMs
  ) {
    const at = millis(now);

    // 1. Refresh the simulated books from the dataset at this instant.
    refreshBooks(adapter, dataset, at);

    // 2. The real pipeline decides (risk-gated) and submits through the
    //    adapter; the adapter honors submit latency (goes LIVE later).
    const decisions = orchestrator.tick(at);
    allDecisions.push(...decisions);

    // 3. Advance the adapter clock: submits go live, cancels complete,
    //    working orders fill under the configured fill model.
    const fills = adapter.advanceClock(at);
    for (const fill of fills) {
      spent = decAdd(spent, decAdd(decMulRound(fill.price, fill.qty), fill.fee));
      feesPaid = decAdd(feesPaid, fill.fee);
    }
    if (fills.length > 0) {
      tokenByOrder = buildTokenLookup(adapter);
    }
    applyFillsToLots(dataset, state, fills, tokenByOrder, () => fillSeq++);

    // 4. T5 measurement: executable combined ask / set edge after fees.
    recordSetEdge(dataset, config, at, setEdgeSamples);

    ticks += 1;
  }

  // Settlement: only markets whose window ended inside (or before) the run.
  const settlements = dataset.markets
    .filter((m) => Number(m.endMs) <= Number(options.windowEndMs))
    .map((m) => settleMarket(m, state));
  const settlementUsdc = settlements.reduce<Decimal>((acc, s) => decAdd(acc, s.payout), decZero());

  return {
    ticks,
    decisions: allDecisions,
    fills: adapter.getFills(),
    spentUsdc: spent,
    feesUsdc: feesPaid,
    settlementUsdc,
    netPnlUsdc: decSub(settlementUsdc, spent),
    settlements,
    setEdgeSamples,
    marketsSeen: dataset.markets.length,
  };
}

/** Push the current derived top-of-book into the adapter's simulated books. */
function refreshBooks(adapter: PaperExecutionAdapter, dataset: BacktestDataset, now: Millis): void {
  for (const market of dataset.markets) {
    if (Number(now) < Number(market.startMs) || Number(now) >= Number(market.endMs)) {
      continue; // not tradable right now; the orchestrator cannot see it either
    }
    pushTokenBook(adapter, dataset, market, market.upTokenId, now);
    pushTokenBook(adapter, dataset, market, market.downTokenId, now);
  }
}

function pushTokenBook(
  adapter: PaperExecutionAdapter,
  dataset: BacktestDataset,
  market: BacktestMarket,
  tokenId: string,
  now: Millis,
): void {
  const history = dataset.tokenHistories[tokenId];
  if (history === undefined) return;
  const last = tokenPriceAt(history, now);
  if (last === undefined) return;
  // Conservative derived book: ask one half-tick above the last print, bid
  // one half-tick below, deep quantity (liquidity is not modeled at depth —
  // recorded books would be needed; documented limitation).
  const halfTick = market.tickSize / 2;
  const ask = Math.min(0.9995, last + halfTick);
  const bid = Math.max(0.0005, last - halfTick);
  try {
    adapter.setBook(
      tokenId,
      createSimulatedBook(
        [{ price: decFromString(ask.toFixed(8)), qty: decFromString("1000000") }],
        [{ price: decFromString(bid.toFixed(8)), qty: decFromString("1000000") }],
      ),
    );
  } catch {
    // A crossed/degenerate derived book (last print at the boundary): skip
    // this tick's refresh; the previous book remains.
  }
}

/**
 * Accumulate fills into lot state (per market slug) and account totals.
 * The fill→market mapping is recovered from the ADAPTER's own order
 * snapshots (ExecutionOrder carries tokenId + marketId), so no side table
 * and no orchestrator hook are needed.
 */
function applyFillsToLots(
  dataset: BacktestDataset,
  state: BacktestAdapterState,
  fills: readonly ExecutionFill[],
  tokenByOrder: ReadonlyMap<string, string>,
  nextSeq: () => number,
): void {
  if (fills.length === 0) return;
  const tokenToMarket = new Map<string, { market: BacktestMarket; isUp: boolean }>();
  for (const market of dataset.markets) {
    tokenToMarket.set(market.upTokenId, { market, isUp: true });
    tokenToMarket.set(market.downTokenId, { market, isUp: false });
  }
  for (const fill of fills) {
    const tokenId = tokenByOrder.get(fill.clientOrderId) ?? "";
    const found = tokenToMarket.get(tokenId);
    if (found === undefined) continue; // fill for a token outside the dataset: ignore
    const { market, isUp } = found;
    const lot = {
      lotId: `bt-${market.slug}-${isUp ? "up" : "down"}-${String(nextSeq()).padStart(6, "0")}`,
      qty: fill.qty,
      pricePerUnit: fill.price,
      fee: fill.fee,
      rebate: decZero(),
      acquiredAt: fill.at,
      outcome: isUp ? ("up" as const) : ("down" as const),
    };
    const held = state.lots.get(market.slug) ?? { up: [], down: [] };
    state.lots.set(market.slug, {
      up: isUp ? [...held.up, lot] : held.up,
      down: isUp ? held.down : [...held.down, lot],
    });
  }
}

/**
 * clientOrderId → tokenId, recovered from the adapter's order snapshots
 * (each ExecutionOrder embeds the token it was submitted for).
 */
function buildTokenLookup(adapter: PaperExecutionAdapter): Map<string, string> {
  const map = new Map<string, string>();
  for (const order of adapter.listOrders()) {
    map.set(order.clientOrderId, order.tokenId);
  }
  return map;
}

/** T5 sample: executable combined ask and set edge after fees at this tick. */
function recordSetEdge(
  dataset: BacktestDataset,
  config: AppConfig,
  at: Millis,
  out: SetEdgeSample[],
): void {
  for (const market of dataset.markets) {
    if (Number(at) < Number(market.startMs) || Number(at) >= Number(market.endMs)) continue;
    const up = dataset.tokenHistories[market.upTokenId];
    const down = dataset.tokenHistories[market.downTokenId];
    if (up === undefined || down === undefined) continue;
    const upLast = tokenPriceAt(up, at);
    const downLast = tokenPriceAt(down, at);
    if (upLast === undefined || downLast === undefined) continue;
    const halfTick = market.tickSize / 2;
    const upAsk = Math.min(0.999, upLast + halfTick);
    const downAsk = Math.min(0.999, downLast + halfTick);
    const upAskDec = decFromString(upAsk.toFixed(8));
    const downAskDec = decFromString(downAsk.toFixed(8));
    const combinedAsk = decAdd(upAskDec, downAskDec);
    // Per-set taker fee (verified crypto_fees_v2 formula, docs/RESOLUTION_AND_FEES.md §2):
    // fee = rate × [p_up(1−p_up) + p_down(1−p_down)] per share pair.
    const perSetFee = decMulRound(
      decAdd(
        takerFeePerShare(upAskDec, config.fees.takerRate),
        takerFeePerShare(downAskDec, config.fees.takerRate),
      ),
      config.fees.takerRate,
    );
    const setEdge = decSub(decSub(decFromString("1"), combinedAsk), perSetFee);
    out.push({
      at,
      slug: market.slug,
      asset: market.asset,
      combinedAsk,
      setEdgePerSet: setEdge,
    });
  }
}
