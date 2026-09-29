/**
 * Performance analysis for replay results — measurement and validation ONLY.
 *
 * This module computes descriptive statistics over a replay. It deliberately
 * does NOT rank strategies, score configurations, or optimize anything: there
 * is no "best strategy" concept here, only exact arithmetic over what happened.
 *
 * `analyzePerformance` is pure: identical inputs produce identical outputs.
 * All money math is BigInt `Decimal` (8 dp); ratios are Decimals in [0, 1]
 * (rounded half-away-from-zero); times are integer milliseconds.
 */

import {
  decAdd,
  decCompare,
  decDivRound,
  decFromString,
  decMulRound,
  decToString,
  decZero,
  type Decimal,
} from "@bot/domain";

import type { ReplayReport } from "./replay.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Per-window complete-set economics sample. */
export interface PerformanceSetSample {
  readonly matchedSets: Decimal;
  /** Total gross cost of the matched sets (price only). */
  readonly grossPairCost: Decimal;
  readonly fees: Decimal;
  readonly rebates: Decimal;
  readonly grossEdge: Decimal;
  readonly netEdge: Decimal;
}

/** Everything the analyzer measures, collected from a report (or hand-built). */
export interface PerformanceInputs {
  readonly totalTrades: number;
  readonly setSamples: readonly PerformanceSetSample[];
  readonly realizedPnl: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly maxDrawdown: Decimal;
  /** Final residual inventory, in shares per side. */
  readonly residualUp: Decimal;
  readonly residualDown: Decimal;
  /** Mark price per share used to value the residuals. */
  readonly residualMarkUp: Decimal;
  readonly residualMarkDown: Decimal;
  /** Inventory-exposure time series (USDC, one sample per tick). */
  readonly inventorySamples: readonly Decimal[];
  /** Holding time of every filled lot, ms (acquisition → settlement). */
  readonly holdingTimesMs: readonly number[];
  readonly orders: {
    readonly submitted: number;
    readonly filled: number;
    readonly partiallyFilled: number;
    readonly cancelled: number;
    readonly rejected: number;
  };
  /** Risk limit used for capital utilization (USDC). */
  readonly maxTotalCapital: Decimal;
}

// ---------------------------------------------------------------------------
// Outputs — exactly the requested measurement set
// ---------------------------------------------------------------------------

export interface PerformanceAnalysis {
  readonly totalTrades: number;
  readonly totalCompleteSets: Decimal;
  /** Average gross cost per complete set (0 when no sets were matched). */
  readonly avgSetCost: Decimal;
  /** Median per-window cost per complete set (0 when no sets). */
  readonly medianSetCost: Decimal;
  readonly grossEdge: Decimal;
  readonly netEdge: Decimal;
  readonly fees: Decimal;
  readonly rebates: Decimal;
  readonly realizedPnl: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly maxDrawdown: Decimal;
  /** Residual inventory valued at the final marks (USDC). */
  readonly residualExposure: Decimal;
  /** Mean inventory exposure across the tick series (USDC). */
  readonly avgInventory: Decimal;
  /** Peak inventory exposure across the tick series (USDC). */
  readonly maxInventory: Decimal;
  /** filled / submitted (0 when nothing was submitted). */
  readonly fillRatio: Decimal;
  /** cancelled / submitted. */
  readonly cancellationRatio: Decimal;
  /** rejected / submitted. */
  readonly rejectionRatio: Decimal;
  /** Mean holding time of filled lots, ms (0 when none). */
  readonly avgHoldingTimeMs: Decimal;
  /** maxInventory / maxTotalCapital (0 when the capital limit is 0). */
  readonly capitalUtilization: Decimal;
}

// ---------------------------------------------------------------------------
// Collection: report → inputs
// ---------------------------------------------------------------------------

/**
 * Collect the analyzer inputs from a replay report. Pure. `maxTotalCapital`
 * comes from the risk config (the report does not carry risk limits).
 */
export function collectPerformanceInputs(
  report: ReplayReport,
  maxTotalCapital: Decimal,
): PerformanceInputs {
  const setSamples = report.windows.map((w) => ({
    matchedSets: w.sets.matchedSets,
    grossPairCost: w.sets.grossPairCost,
    fees: w.sets.fees,
    rebates: w.sets.rebates,
    grossEdge: w.sets.grossEdge,
    netEdge: w.sets.netEdge,
  }));
  return {
    totalTrades: report.totals.trades,
    setSamples,
    realizedPnl: report.totals.realizedPnl,
    unrealizedPnl: report.extras.unrealizedPnl,
    maxDrawdown: report.totals.maxDrawdown,
    residualUp: report.totals.finalResidualUp,
    residualDown: report.totals.finalResidualDown,
    residualMarkUp: report.extras.finalMarkUp,
    residualMarkDown: report.extras.finalMarkDown,
    inventorySamples: report.extras.inventorySamples,
    holdingTimesMs: report.extras.holdingTimesMs,
    orders: {
      submitted: report.totals.orderStats.submitted,
      filled: report.totals.orderStats.filled,
      partiallyFilled: report.totals.orderStats.partiallyFilled,
      cancelled: report.totals.orderStats.cancelled,
      rejected: report.totals.orderStats.rejected,
    },
    maxTotalCapital,
  };
}

// ---------------------------------------------------------------------------
// Core analysis (pure)
// ---------------------------------------------------------------------------

/** Mean of a Decimal list (0 when empty), rounded at 8 dp. */
function mean(values: readonly Decimal[]): Decimal {
  if (values.length === 0) return decZero();
  const total = values.reduce((acc, v) => decAdd(acc, v), decZero());
  return decDivRound(total, decFromString(String(values.length)));
}

/** Median of a Decimal list (mean of the two middles for even lengths). */
function median(values: readonly Decimal[]): Decimal {
  if (values.length === 0) return decZero();
  const sorted = [...values].sort((a, b) => decCompare(a, b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return decDivRound(decAdd(sorted[mid - 1]!, sorted[mid]!), decFromString("2"));
}

/** Safe ratio: num / den, or 0 when den is 0. */
function ratio(num: Decimal, den: Decimal): Decimal {
  if (decCompare(den, decZero()) === 0) return decZero();
  return decDivRound(num, den);
}

/** Analyze the inputs. Pure and deterministic. */
export function analyzePerformance(inputs: PerformanceInputs): PerformanceAnalysis {
  // ---- Complete sets ----
  let totalSets = decZero();
  let totalSetCost = decZero();
  let grossEdge = decZero();
  let netEdge = decZero();
  let fees = decZero();
  let rebates = decZero();
  const perSetCosts: Decimal[] = [];
  for (const s of inputs.setSamples) {
    totalSets = decAdd(totalSets, s.matchedSets);
    totalSetCost = decAdd(totalSetCost, s.grossPairCost);
    grossEdge = decAdd(grossEdge, s.grossEdge);
    netEdge = decAdd(netEdge, s.netEdge);
    fees = decAdd(fees, s.fees);
    rebates = decAdd(rebates, s.rebates);
    if (decCompare(s.matchedSets, decZero()) > 0) {
      perSetCosts.push(decDivRound(s.grossPairCost, s.matchedSets));
    }
  }
  const avgSetCost = ratio(totalSetCost, totalSets);
  const medianSetCost = median(perSetCosts);

  // ---- Inventory ----
  const avgInventory = mean(inputs.inventorySamples);
  const maxInventory = inputs.inventorySamples.reduce(
    (acc, v) => (decCompare(v, acc) > 0 ? v : acc),
    decZero(),
  );
  const residualExposure = decAdd(
    mulMark(inputs.residualUp, inputs.residualMarkUp),
    mulMark(inputs.residualDown, inputs.residualMarkDown),
  );

  // ---- Order ratios ----
  const submitted = decFromString(String(inputs.orders.submitted));
  const fillRatio = ratio(
    decFromString(String(inputs.orders.filled + inputs.orders.partiallyFilled)),
    submitted,
  );
  const cancellationRatio = ratio(decFromString(String(inputs.orders.cancelled)), submitted);
  const rejectionRatio = ratio(decFromString(String(inputs.orders.rejected)), submitted);

  // ---- Holding time ----
  const holdingMean =
    inputs.holdingTimesMs.length === 0
      ? decZero()
      : decDivRound(
          decFromString(String(inputs.holdingTimesMs.reduce((a, b) => a + b, 0))),
          decFromString(String(inputs.holdingTimesMs.length)),
        );

  // ---- Capital utilization ----
  const capitalUtilization = ratio(maxInventory, inputs.maxTotalCapital);

  return {
    totalTrades: inputs.totalTrades,
    totalCompleteSets: totalSets,
    avgSetCost,
    medianSetCost,
    grossEdge,
    netEdge,
    fees,
    rebates,
    realizedPnl: inputs.realizedPnl,
    unrealizedPnl: inputs.unrealizedPnl,
    maxDrawdown: inputs.maxDrawdown,
    residualExposure,
    avgInventory,
    maxInventory,
    fillRatio,
    cancellationRatio,
    rejectionRatio,
    avgHoldingTimeMs: holdingMean,
    capitalUtilization,
  };
}

function mulMark(shares: Decimal, mark: Decimal): Decimal {
  return decMulRound(shares, mark);
}

/** CSV row for the analysis (stable column order). */
export function analysisToCsvRow(a: PerformanceAnalysis): string {
  return [
    a.totalTrades,
    decToString(a.totalCompleteSets),
    decToString(a.avgSetCost),
    decToString(a.medianSetCost),
    decToString(a.grossEdge),
    decToString(a.netEdge),
    decToString(a.fees),
    decToString(a.rebates),
    decToString(a.realizedPnl),
    decToString(a.unrealizedPnl),
    decToString(a.maxDrawdown),
    decToString(a.residualExposure),
    decToString(a.avgInventory),
    decToString(a.maxInventory),
    decToString(a.fillRatio),
    decToString(a.cancellationRatio),
    decToString(a.rejectionRatio),
    decToString(a.avgHoldingTimeMs),
    decToString(a.capitalUtilization),
  ].join(",");
}

export const ANALYSIS_CSV_HEADER =
  "total_trades,total_complete_sets,avg_set_cost,median_set_cost,gross_edge,net_edge,fees,rebates," +
  "realized_pnl,unrealized_pnl,max_drawdown,residual_exposure,avg_inventory,max_inventory," +
  "fill_ratio,cancellation_ratio,rejection_ratio,avg_holding_time_ms,capital_utilization";
