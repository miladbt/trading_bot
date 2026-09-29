/**
 * Report exporters: pure functions from a ReplayReport to CSV/JSON strings.
 *
 * Decimals render as exact 8-dp strings, so the CSV/JSON outputs are exactly
 * as precise as the engine's internal math.
 */

import { decToString, type Decimal } from "@bot/domain";

import type { ReplayReport, ReplayWindowResult } from "./replay.js";

const CSV_HEADERS = [
  "market_id",
  "asset",
  "winning_outcome",
  "realized_pnl",
  "matched_sets",
  "up_cost",
  "down_cost",
  "gross_pair_cost",
  "fees",
  "rebates",
  "net_pair_cost",
  "expected_settlement",
  "gross_edge",
  "net_edge",
  "residual_up",
  "residual_down",
  "trade_count",
] as const;

function csvEscape(value: string): string {
  return value.includes(",") || value.includes('"') || value.includes("\n")
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function csvRow(values: readonly string[]): string {
  return values.map(csvEscape).join(",");
}

/** Exact 8-dp string for a Decimal (never the raw scaled bigint). */
function money(value: Decimal): string {
  return decToString(value);
}

/** Export the per-window results as CSV (one row per market window). */
export function toCsv(report: ReplayReport): string {
  const rows: string[] = [csvRow(CSV_HEADERS)];
  for (const w of report.windows) {
    rows.push(
      csvRow([
        w.marketId,
        w.asset,
        w.winningOutcome,
        money(w.realizedPnl),
        money(w.sets.matchedSets),
        money(w.sets.upCost),
        money(w.sets.downCost),
        money(w.sets.grossPairCost),
        money(w.sets.fees),
        money(w.sets.rebates),
        money(w.sets.netPairCost),
        money(w.sets.expectedSettlementValue),
        money(w.sets.grossEdge),
        money(w.sets.netEdge),
        money(w.residualUp),
        money(w.residualDown),
        String(w.trades.length),
      ]),
    );
  }
  return rows.join("\n") + "\n";
}

/** Export the full report as pretty-printed JSON (Decimals as scaled strings). */
export function toJson(report: ReplayReport): string {
  return JSON.stringify(report, decimalAwareReplacer, 2);
}

function decimalAwareReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

/** Summary line for CLI output (pure). */
export function summaryLine(report: ReplayReport): string {
  const t = report.totals;
  return [
    `dataset=${report.dataset}`,
    `windows=${report.windows.length}`,
    `trades=${t.trades}`,
    `sets=${money(t.completeSets)}`,
    `pnl=${money(t.realizedPnl)}`,
    `maxDD=${money(t.maxDrawdown)}`,
    `fees=${money(t.fees)}`,
    `orders=${t.orderStats.submitted}`,
  ].join(" ");
}

/** Re-export for callers assembling file contents. */
export type { ReplayWindowResult };
