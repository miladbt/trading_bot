/**
 * Backtest metrics (T5/T11). FLOAT-domain statistics over exact-Decimal run
 * outputs. This module lives only inside packages/backtest and NEVER feeds
 * anything back into order sizing: the money boundary is the runner's Decimal
 * accounting (spentUsdc/settlementUsdc/netPnlUsdc); everything here reads the
 * completed result and produces report numbers.
 */

import { decFromString, decToString, type Decimal, type Millis } from "@bot/domain";

import type { BacktestRunResult } from "./runner.js";

// ---------------------------------------------------------------------------
// Config A/B/C/D descriptors
// ---------------------------------------------------------------------------

/** Fill-model label used in reports. */
export type FillModelLabel = "optimistic" | "pessimistic";

export interface ConfigDescriptor {
  readonly id: "A" | "B" | "C" | "D1" | "D2" | "D3" | "E" | "E2";
  readonly label: string;
  readonly sizingModel: "directional" | "edge";
  readonly fillModel: FillModelLabel;
  /** Baseline configs never trade; their env override flips the pipeline off. */
  readonly noTrade?: boolean;
  /** Random-direction baseline: same sizing, direction randomized deterministically. */
  readonly randomDirection?: boolean;
  /** Complete-set-only: the orchestrator only ever accumulates matched sets. */
  readonly completeSetOnly?: boolean;
  /**
   * Strategy V2 (docs/STRATEGY_V2.md): fair-value probability source with the
   * model-quality gate. The gate is evaluated on hold-out observations only.
   */
  readonly v2?: boolean;
  /** E2 diagnostic: force the gate open regardless of measured skill. */
  readonly forceGateOpen?: boolean;
}

/** The four report configurations (T11) plus the two extra D baselines. */
export const CONFIGS: readonly ConfigDescriptor[] = [
  {
    id: "A",
    label: "old (directional) sizing + optimistic fills",
    sizingModel: "directional",
    fillModel: "optimistic",
  },
  {
    id: "B",
    label: "old (directional) sizing + pessimistic fills",
    sizingModel: "directional",
    fillModel: "pessimistic",
  },
  {
    id: "C",
    label: "edge-based sizing + pessimistic fills (main candidate)",
    sizingModel: "edge",
    fillModel: "pessimistic",
  },
  {
    id: "D1",
    label: "baseline: no trade",
    sizingModel: "directional",
    fillModel: "pessimistic",
    noTrade: true,
  },
  {
    id: "D2",
    label: "baseline: random direction, same sizing",
    sizingModel: "directional",
    fillModel: "pessimistic",
    randomDirection: true,
  },
  {
    id: "D3",
    label: "baseline: complete-set-only (always neutral)",
    sizingModel: "directional",
    fillModel: "pessimistic",
    completeSetOnly: true,
  },
  {
    id: "E",
    label: "V2 fair-value + mispricing + model gate (pessimistic fills)",
    sizingModel: "edge",
    fillModel: "pessimistic",
    v2: true,
  },
  {
    id: "E2",
    label: "V2 DIAGNOSTIC: gate forced open (what the gate prevented)",
    sizingModel: "edge",
    fillModel: "pessimistic",
    v2: true,
    forceGateOpen: true,
  },
];

// ---------------------------------------------------------------------------
// Per-market accounting reconstruction
// ---------------------------------------------------------------------------

export interface MarketOutcome {
  readonly slug: string;
  readonly asset: "BTC" | "ETH";
  readonly startMs: Millis;
  readonly outcome: "UP" | "DOWN";
  /** Settled realized PnL (exact Decimal string). */
  readonly pnl: string;
  /** Whether the market held unmatched inventory at expiry. */
  readonly orphaned: boolean;
  readonly residualUpShares: string;
  readonly residualDownShares: string;
}

/**
 * Reconstruct per-market PnL from the run's settlement records and dataset
 * resolutions. Markets with no fills settle at zero.
 */
export function marketOutcomes(
  run: BacktestRunResult,
  datasetMarketList: readonly {
    slug: string;
    asset: "BTC" | "ETH";
    startMs: Millis;
    resolution: { outcome: "UP" | "DOWN" };
  }[],
): MarketOutcome[] {
  const bySlug = new Map(run.settlements.map((s) => [s.slug, s]));
  return datasetMarketList.map((m) => {
    const s = bySlug.get(m.slug);
    return {
      slug: m.slug,
      asset: m.asset,
      startMs: m.startMs,
      outcome: m.resolution.outcome,
      pnl: s === undefined ? "0.00000000" : decToString(s.realizedPnlUsdc),
      orphaned: s === undefined ? false : residual(s),
      residualUpShares: s === undefined ? "0.00000000" : decToString(s.residualUpShares),
      residualDownShares: s === undefined ? "0.00000000" : decToString(s.residualDownShares),
    };
  });
}

function residual(s: { residualUpShares: Decimal; residualDownShares: Decimal }): boolean {
  return (
    Number(decToString(s.residualUpShares)) > 0 || Number(decToString(s.residualDownShares)) > 0
  );
}

// ---------------------------------------------------------------------------
// Aggregate statistics (float domain — reporting only)
// ---------------------------------------------------------------------------

export interface RunStats {
  readonly configId: string;
  readonly label: string;
  readonly ticks: number;
  /** Count of submit_order decisions. */
  readonly submits: number;
  readonly fills: number;
  /** Distinct orders that received at least one fill. */
  readonly filledOrders: number;
  /** Orders submitted that never received any fill. */
  readonly unfilledOrders: number;
  /** Orders with at least one fill but not fully filled (partial-fill rate denominator). */
  readonly partiallyFilledOrders: number;
  readonly spentUsdc: string;
  readonly feesUsdc: string;
  readonly settlementUsdc: string;
  readonly netPnlUsdc: string;
  readonly grossPnlUsdc: string;
  readonly marketsTraded: number;
  readonly marketsSettled: number;
  readonly orphanedMarkets: number;
  readonly orphanRate: number;
  readonly worstMarketPnlUsdc: string;
  readonly bestMarketPnlUsdc: string;
  readonly maxDrawdownUsdc: number;
  /** Per-market mean and stdev of realized PnL; Sharpe-like = mean/sd (per-market, i.i.d. assumption caveat). */
  readonly sharpeLikePerMarket: number | null;
  readonly hitRate: number | null;
  readonly marketsWithPositivePnl: number;
}

export function summarize(
  config: ConfigDescriptor,
  run: BacktestRunResult,
  outcomes: readonly MarketOutcome[],
): RunStats {
  const settledPnls = outcomes.map((o) => Number(o.pnl)).filter((n) => Number.isFinite(n));
  const traded = outcomes.filter((o) => Number(o.pnl) !== 0 || o.orphaned);
  const positive = settledPnls.filter((p) => p > 0).length;
  const nonzero = settledPnls.filter((p) => p !== 0);

  // Max drawdown over the settlement sequence (float domain, reporting only).
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of settledPnls) {
    equity += p;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const mean = nonzero.length > 0 ? nonzero.reduce((a, b) => a + b, 0) / nonzero.length : 0;
  const variance =
    nonzero.length > 1
      ? nonzero.reduce((acc, p) => acc + (p - mean) ** 2, 0) / (nonzero.length - 1)
      : 0;
  const sd = Math.sqrt(variance);
  const sharpeLike = sd > 1e-12 ? mean / sd : null;

  const submitDecisions = run.decisions.filter((d) => d.action === "submit_order");
  const orderFillCounts = new Map<string, number>();
  for (const fill of run.fills) {
    orderFillCounts.set(fill.clientOrderId, (orderFillCounts.get(fill.clientOrderId) ?? 0) + 1);
  }
  const submittedOrderIds = new Set(submitDecisions.map((d) => String(d.detail["clientOrderId"])));
  let filledOrders = 0;
  let partialOrders = 0;
  for (const id of submittedOrderIds) {
    const n = orderFillCounts.get(id) ?? 0;
    if (n > 0) filledOrders += 1;
    if (n > 1) partialOrders += 1;
  }

  const worst = settledPnls.length > 0 ? Math.min(...settledPnls) : 0;
  const best = settledPnls.length > 0 ? Math.max(...settledPnls) : 0;

  return {
    configId: config.id,
    label: config.label,
    ticks: run.ticks,
    submits: submitDecisions.length,
    fills: run.fills.length,
    filledOrders,
    unfilledOrders: submittedOrderIds.size - filledOrders,
    partiallyFilledOrders: partialOrders,
    spentUsdc: decToString(run.spentUsdc),
    feesUsdc: decToString(run.feesUsdc),
    settlementUsdc: decToString(run.settlementUsdc),
    netPnlUsdc: decToString(run.netPnlUsdc),
    grossPnlUsdc: decToString(run.settlementUsdc),
    marketsTraded: traded.length,
    marketsSettled: outcomes.length,
    orphanedMarkets: outcomes.filter((o) => o.orphaned).length,
    orphanRate:
      outcomes.length > 0 ? outcomes.filter((o) => o.orphaned).length / outcomes.length : 0,
    worstMarketPnlUsdc: worst.toFixed(8),
    bestMarketPnlUsdc: best.toFixed(8),
    maxDrawdownUsdc: maxDd,
    sharpeLikePerMarket: sharpeLike,
    hitRate: nonzero.length > 0 ? positive / nonzero.length : null,
    marketsWithPositivePnl: positive,
  };
}

// ---------------------------------------------------------------------------
// T5 set-edge analysis
// ---------------------------------------------------------------------------

export interface SetEdgeStats {
  readonly samples: number;
  /** Samples with setEdgePerSet > 0 after fees. */
  readonly positiveCount: number;
  readonly positiveFraction: number;
  /** Mean positive edge per set (USDC), among positive samples. */
  readonly meanPositiveEdgeUsdc: number | null;
  /** Max positive edge observed (USDC). */
  readonly maxPositiveEdgeUsdc: number | null;
  /**
   * Longest run of consecutive positive samples per market (ticks; a tick is
   * tickMs apart) — "how long it lasts".
   */
  readonly longestPositiveRunTicks: number;
  /**
   * Capturable fraction: positive samples occurring at least
   * `captureLatencyTicks` ticks BEFORE expiry (a real taker needs time to act
   * and fill before the window closes).
   */
  readonly capturableFraction: number;
  readonly captureLatencyTicks: number;
}

export function analyzeSetEdge(run: BacktestRunResult, captureLatencyTicks: number): SetEdgeStats {
  const expiryBySlug = new Map<string, number>();
  for (const s of run.setEdgeSamples) {
    if (!expiryBySlug.has(s.slug)) expiryBySlug.set(s.slug, Number(s.at));
  }
  // `last sample time per market` approximates the last in-window tick.
  const lastBySlug = new Map<string, number>();
  for (const s of run.setEdgeSamples) {
    lastBySlug.set(s.slug, Math.max(lastBySlug.get(s.slug) ?? 0, Number(s.at)));
  }

  const positive = run.setEdgeSamples.filter((s) => Number(decToString(s.setEdgePerSet)) > 0);
  const positiveEdges = positive.map((s) => Number(decToString(s.setEdgePerSet)));

  // Longest consecutive-positive run per slug (samples arrive in time order
  // per slug because the runner iterates ticks outermost).
  const runLengths = new Map<string, number>();
  let prevSlug = "";
  let currentRun = 0;
  let longest = 0;
  for (const s of run.setEdgeSamples) {
    const isPositive = Number(decToString(s.setEdgePerSet)) > 0;
    if (s.slug !== prevSlug) {
      currentRun = 0;
      prevSlug = s.slug;
    }
    if (isPositive) {
      currentRun += 1;
      runLengths.set(s.slug, Math.max(runLengths.get(s.slug) ?? 0, currentRun));
    } else {
      currentRun = 0;
    }
    longest = Math.max(longest, runLengths.get(s.slug) ?? 0);
  }

  const total = run.setEdgeSamples.length;
  const capturable = positive.filter((s) => {
    const last = lastBySlug.get(s.slug) ?? Number(s.at);
    return last - Number(s.at) >= captureLatencyTicks * 30_000;
  }).length;

  return {
    samples: total,
    positiveCount: positive.length,
    positiveFraction: total > 0 ? positive.length / total : 0,
    meanPositiveEdgeUsdc:
      positiveEdges.length > 0
        ? positiveEdges.reduce((a, b) => a + b, 0) / positiveEdges.length
        : null,
    maxPositiveEdgeUsdc: positiveEdges.length > 0 ? Math.max(...positiveEdges) : null,
    longestPositiveRunTicks: longest,
    capturableFraction: positive.length > 0 ? capturable / positive.length : 0,
    captureLatencyTicks,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap confidence intervals (resample by market)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so CIs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  readonly statistic: "net_pnl_usdc" | "hit_rate";
  readonly estimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly iterations: number;
  readonly seed: number;
}

/**
 * Percentile bootstrap over per-market realized PnLs. Deterministic given the
 * seed. Float domain — reporting only.
 */
export function bootstrapByMarket(
  statistic: "net_pnl_usdc" | "hit_rate",
  pnls: readonly number[],
  iterations: number,
  seed: number,
): BootstrapCI {
  const rng = mulberry32(seed);
  const n = pnls.length;
  if (n === 0) {
    return { statistic, estimate: 0, ciLow: 0, ciHigh: 0, iterations, seed };
  }
  const estimates: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    let wins = 0;
    let nonzero = 0;
    for (let j = 0; j < n; j++) {
      const p = pnls[Math.floor(rng() * n)] ?? 0;
      sum += p;
      if (p > 0) wins += 1;
      if (p !== 0) nonzero += 1;
    }
    estimates.push(statistic === "net_pnl_usdc" ? sum : nonzero > 0 ? wins / nonzero : 0);
  }
  estimates.sort((a, b) => a - b);
  const point =
    statistic === "net_pnl_usdc"
      ? pnls.reduce((a, b) => a + b, 0)
      : nonzeroCount(pnls) > 0
        ? pnls.filter((p) => p > 0).length / nonzeroCount(pnls)
        : 0;
  const lo = estimates[Math.floor(0.025 * iterations)] ?? 0;
  const hi = estimates[Math.ceil(0.975 * iterations) - 1] ?? 0;
  return { statistic, estimate: point, ciLow: lo, ciHigh: hi, iterations, seed };
}

function nonzeroCount(pnls: readonly number[]): number {
  return pnls.filter((p) => p !== 0).length;
}

// ---------------------------------------------------------------------------
// Sensitivity helpers
// ---------------------------------------------------------------------------

export interface SensitivitySpec {
  readonly name: string;
  readonly submitLatencyMs: number;
  readonly takerRateOverride?: string | undefined;
  readonly tradeThroughOverride?: string | undefined;
  readonly queuePositionFactorOverride?: string | undefined;
  readonly adverseMoveThresholdOverride?: string | undefined;
}

/** ±latency / ±fee / ±adverse-selection grid (T11 sensitivity section). */
export const SENSITIVITY_SPECS: readonly SensitivitySpec[] = [
  { name: "latency-100ms", submitLatencyMs: 100 },
  { name: "latency-500ms", submitLatencyMs: 500 },
  { name: "fee-zero", submitLatencyMs: 250, takerRateOverride: "0" },
  { name: "fee-0.10", submitLatencyMs: 250, takerRateOverride: "0.10" },
  { name: "adverse-0", submitLatencyMs: 250, adverseMoveThresholdOverride: "0" },
  { name: "adverse-0.02", submitLatencyMs: 250, adverseMoveThresholdOverride: "0.02" },
];

/** Parse helper for sensitivity overrides (exact Decimal at the boundary). */
export function decOf(s: string): Decimal {
  return decFromString(s);
}
