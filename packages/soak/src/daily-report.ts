/**
 * Daily performance report (UTC): measurement only, no parameter changes.
 *
 * Aggregates the persisted soak state for one UTC date: activity counts,
 * inventory view (lot-level complete-set matching), cash, and gross exposure.
 * Every value is an exact fixed-point string. Nothing here feeds back into
 * strategy parameters (explicit soak-test requirement) — the report is
 * write-only output for humans/dashboards.
 */

import { decAdd, decFromString, decMulRound, decToString, decZero } from "@bot/domain";
import { matchCompleteSets } from "@bot/inventory";
import type { PaperExecutionAdapter } from "@bot/execution";

import { toAcquisitionLot, type SoakState } from "./state-store.js";

export interface DailyReport {
  readonly date: string;
  readonly tradingMode: "paper";
  readonly liveTradingEnabled: false;
  /** Activity counters. */
  readonly tickCount: number;
  readonly decisionCount: number;
  readonly totalOrders: number;
  readonly openOrders: number;
  readonly filledOrders: number;
  readonly cancelledOrders: number;
  readonly rejectedOrders: number;
  readonly fillCount: number;
  /** Inventory view (lot-level, never forced neutral). */
  readonly lotCount: number;
  readonly matchedSets: string;
  readonly residualUp: string;
  readonly residualDown: string;
  /** Cash and exposure. */
  readonly cashUsdc: string;
  readonly grossExposureUsdc: string;
  readonly feesPaidUsdc: string;
  /** Marked value of the book at the latest paper prices (unrealized proxy). */
  readonly markedInventoryUsdc: string;
}

export interface DailyReportFiles {
  readonly report: DailyReport;
  readonly json: string;
  readonly csv: string;
}

const CSV_FIELDS: readonly (keyof DailyReport)[] = [
  "date",
  "tradingMode",
  "liveTradingEnabled",
  "tickCount",
  "decisionCount",
  "totalOrders",
  "openOrders",
  "filledOrders",
  "cancelledOrders",
  "rejectedOrders",
  "fillCount",
  "lotCount",
  "matchedSets",
  "residualUp",
  "residualDown",
  "cashUsdc",
  "grossExposureUsdc",
  "feesPaidUsdc",
  "markedInventoryUsdc",
];

/** Build the daily report for `date` from the soak state and paper adapter. */
export function buildDailyReport(
  state: SoakState,
  adapter: PaperExecutionAdapter,
  date: string,
): DailyReportFiles {
  const orders = adapter.listOrders();
  const openOrders = orders.filter(
    (o) =>
      o.status === "SUBMITTED" ||
      o.status === "LIVE" ||
      o.status === "PARTIALLY_FILLED" ||
      o.status === "CANCEL_REQUESTED",
  );
  const filledOrders = orders.filter((o) => o.status === "FILLED");
  const cancelledOrders = orders.filter((o) => o.status === "CANCELLED");
  const rejectedOrders = orders.filter((o) => o.status === "REJECTED");
  const fillCount = orders.reduce((n, o) => n + o.fills.length, 0);

  // Lot-level inventory view (validated domain lots from stored plain data).
  const lots = state.lots.map(toAcquisitionLot);
  const match = matchCompleteSets({
    upLots: lots.filter((l) => l.outcome === "up"),
    downLots: lots.filter((l) => l.outcome === "down"),
    settlementValue: decFromString("1"),
  });

  // Cash + fees.
  const cash = decFromString(state.cashUsdc);
  const feesPaid = lots.reduce((acc, l) => decAdd(acc, l.fee), decZero());

  // Gross exposure: cost of the held book (sum of qty*price per lot).
  const grossExposure = lots.reduce(
    (acc, l) => decAdd(acc, decMulRound(l.qty, l.pricePerUnit)),
    decZero(),
  );

  // Marked inventory: qty * last paper price per token where available.
  let marked = decZero();
  for (const lot of lots) {
    const order = orders.find((o) => o.tokenId === lot.tokenId);
    if (order !== undefined) {
      marked = decAdd(marked, decMulRound(lot.qty, order.price));
    } else {
      marked = decAdd(marked, decMulRound(lot.qty, lot.pricePerUnit));
    }
  }

  const report: DailyReport = {
    date,
    tradingMode: "paper",
    liveTradingEnabled: false,
    tickCount: state.tickCount,
    decisionCount: state.decisionCount,
    totalOrders: orders.length,
    openOrders: openOrders.length,
    filledOrders: filledOrders.length,
    cancelledOrders: cancelledOrders.length,
    rejectedOrders: rejectedOrders.length,
    fillCount,
    lotCount: lots.length,
    matchedSets: decToString(match.matchedSets),
    residualUp: decToString(match.residualUp),
    residualDown: decToString(match.residualDown),
    cashUsdc: decToString(cash),
    grossExposureUsdc: decToString(grossExposure),
    feesPaidUsdc: decToString(feesPaid),
    markedInventoryUsdc: decToString(marked),
  };

  const json = JSON.stringify(report, null, 2);
  const header = CSV_FIELDS.join(",");
  const row = CSV_FIELDS.map((f) => {
    const value = report[f];
    return typeof value === "string" ? value : String(value);
  }).join(",");
  const csv = `${header}\n${row}\n`;

  return { report, json, csv };
}
