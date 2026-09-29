import { describe, expect, it } from "vitest";

import { decFromString, decToString, type Decimal } from "@bot/domain";

import {
  ANALYSIS_CSV_HEADER,
  analysisToCsvRow,
  analyzePerformance,
  collectPerformanceInputs,
  type PerformanceInputs,
} from "./analytics.js";
import type { ReplayReport } from "./replay.js";

const d = (s: string): Decimal => decFromString(s);

/** A minimal valid report fixture for collector tests. */
function sampleReport(): ReplayReport {
  return {
    dataset: "fixture",
    windows: [
      {
        marketId: "w1",
        asset: "BTC",
        winningOutcome: "up",
        realizedPnl: d("2"),
        residualUp: d("0"),
        residualDown: d("0"),
        sets: {
          marketId: "w1",
          matchedSets: d("4"),
          upCost: d("1.80"),
          downCost: d("2.00"),
          grossPairCost: d("3.80"),
          fees: d("0.02"),
          rebates: d("0.01"),
          netPairCost: d("3.81"),
          expectedSettlementValue: d("4"),
          grossEdge: d("0.20"),
          netEdge: d("0.19"),
          residualUp: d("0"),
          residualDown: d("0"),
        },
        trades: [],
      },
      {
        marketId: "w2",
        asset: "BTC",
        winningOutcome: "down",
        realizedPnl: d("-1"),
        residualUp: d("2"),
        residualDown: d("0"),
        sets: {
          marketId: "w2",
          matchedSets: d("6"),
          upCost: d("2.70"),
          downCost: d("3.00"),
          grossPairCost: d("5.70"),
          fees: d("0.03"),
          rebates: d("0.00"),
          netPairCost: d("5.73"),
          expectedSettlementValue: d("6"),
          grossEdge: d("0.30"),
          netEdge: d("0.27"),
          residualUp: d("2"),
          residualDown: d("0"),
        },
        trades: [],
      },
    ],
    totals: {
      trades: 7,
      completeSets: d("10"),
      grossEdge: d("0.50"),
      netEdge: d("0.46"),
      fees: d("0.05"),
      realizedPnl: d("1"),
      maxDrawdown: d("0.40"),
      finalResidualUp: d("2"),
      finalResidualDown: d("0"),
      peakInventoryExposure: d("9"),
      orderStats: {
        submitted: 10,
        filled: 6,
        partiallyFilled: 2,
        cancelled: 1,
        rejected: 1,
        fillRate: "0.80000000",
        avgFillQty: "5.00000000",
      },
    },
    decisions: [],
    extras: {
      inventorySamples: [d("2"), d("4"), d("6"), d("4")],
      holdingTimesMs: [10_000, 30_000, 50_000, 30_000],
      finalMarkUp: d("0.52"),
      finalMarkDown: d("0.49"),
      unrealizedPnl: d("0.06"),
    },
  };
}

describe("collectPerformanceInputs", () => {
  it("collects the raw series from a report", () => {
    const inputs = collectPerformanceInputs(sampleReport(), d("100"));
    expect(inputs.totalTrades).toBe(7);
    expect(inputs.setSamples).toHaveLength(2);
    expect(decToString(inputs.realizedPnl)).toBe("1.00000000");
    expect(inputs.inventorySamples).toHaveLength(4);
    expect(inputs.holdingTimesMs).toHaveLength(4);
    expect(decToString(inputs.maxTotalCapital)).toBe("100.00000000");
  });
});

describe("analyzePerformance — known expected outputs", () => {
  /** Hand-computed expectations for the fixture above. */
  const fixture = (): PerformanceInputs => collectPerformanceInputs(sampleReport(), d("100"));
  const a = () => analyzePerformance(fixture());

  it("totalTrades = 7", () => {
    expect(a().totalTrades).toBe(7);
  });

  it("totalCompleteSets = 4 + 6 = 10", () => {
    expect(decToString(a().totalCompleteSets)).toBe("10.00000000");
  });

  it("avgSetCost = (3.80/4 + 5.70/6) weighted => 9.50/10 = 0.95", () => {
    // totalSetCost = 3.80 + 5.70 = 9.50 over 10 sets.
    expect(decToString(a().avgSetCost)).toBe("0.95000000");
  });

  it("medianSetCost = median(0.95, 0.95) = 0.95 (equal per-window costs)", () => {
    // Window 1: 3.80/4 = 0.95; window 2: 5.70/6 = 0.95.
    expect(decToString(a().medianSetCost)).toBe("0.95000000");
  });

  it("grossEdge sums to 0.50; netEdge sums to 0.46", () => {
    expect(decToString(a().grossEdge)).toBe("0.50000000");
    expect(decToString(a().netEdge)).toBe("0.46000000");
  });

  it("fees = 0.05; rebates = 0.01", () => {
    expect(decToString(a().fees)).toBe("0.05000000");
    expect(decToString(a().rebates)).toBe("0.01000000");
  });

  it("realizedPnl = 1; unrealizedPnl = 0.06", () => {
    expect(decToString(a().realizedPnl)).toBe("1.00000000");
    expect(decToString(a().unrealizedPnl)).toBe("0.06000000");
  });

  it("maxDrawdown = 0.40 (echoed)", () => {
    expect(decToString(a().maxDrawdown)).toBe("0.40000000");
  });

  it("residualExposure = 2 x 0.52 + 0 x 0.49 = 1.04", () => {
    expect(decToString(a().residualExposure)).toBe("1.04000000");
  });

  it("avgInventory = (2+4+6+4)/4 = 4; maxInventory = 6", () => {
    expect(decToString(a().avgInventory)).toBe("4.00000000");
    expect(decToString(a().maxInventory)).toBe("6.00000000");
  });

  it("fillRatio = (6+2)/10 = 0.8; cancellationRatio = 0.1; rejectionRatio = 0.1", () => {
    expect(decToString(a().fillRatio)).toBe("0.80000000");
    expect(decToString(a().cancellationRatio)).toBe("0.10000000");
    expect(decToString(a().rejectionRatio)).toBe("0.10000000");
  });

  it("avgHoldingTimeMs = (10000+30000+50000+30000)/4 = 30000", () => {
    expect(decToString(a().avgHoldingTimeMs)).toBe("30000.00000000");
  });

  it("capitalUtilization = 6/100 = 0.06", () => {
    expect(decToString(a().capitalUtilization)).toBe("0.06000000");
  });

  it("is deterministic: identical inputs produce identical analyses", () => {
    expect(analyzePerformance(fixture())).toEqual(analyzePerformance(fixture()));
  });
});

describe("analyzePerformance — edge cases", () => {
  it("handles an empty replay: all zeros, no division errors", () => {
    const a = analyzePerformance({
      totalTrades: 0,
      setSamples: [],
      realizedPnl: d("0"),
      unrealizedPnl: d("0"),
      maxDrawdown: d("0"),
      residualUp: d("0"),
      residualDown: d("0"),
      residualMarkUp: d("0.5"),
      residualMarkDown: d("0.5"),
      inventorySamples: [],
      holdingTimesMs: [],
      orders: { submitted: 0, filled: 0, partiallyFilled: 0, cancelled: 0, rejected: 0 },
      maxTotalCapital: d("100"),
    });
    expect(decToString(a.avgSetCost)).toBe("0.00000000");
    expect(decToString(a.medianSetCost)).toBe("0.00000000");
    expect(decToString(a.fillRatio)).toBe("0.00000000");
    expect(decToString(a.avgInventory)).toBe("0.00000000");
    expect(decToString(a.capitalUtilization)).toBe("0.00000000");
    expect(decToString(a.avgHoldingTimeMs)).toBe("0.00000000");
  });

  it("computes the median of an even sample count as the mean of the middles", () => {
    const a = analyzePerformance({
      totalTrades: 2,
      setSamples: [
        {
          matchedSets: d("1"),
          grossPairCost: d("0.90"),
          fees: d("0"),
          rebates: d("0"),
          grossEdge: d("0.10"),
          netEdge: d("0.10"),
        },
        {
          matchedSets: d("1"),
          grossPairCost: d("0.99"),
          fees: d("0"),
          rebates: d("0"),
          grossEdge: d("0.01"),
          netEdge: d("0.01"),
        },
        {
          matchedSets: d("1"),
          grossPairCost: d("0.93"),
          fees: d("0"),
          rebates: d("0"),
          grossEdge: d("0.07"),
          netEdge: d("0.07"),
        },
        {
          matchedSets: d("1"),
          grossPairCost: d("0.97"),
          fees: d("0"),
          rebates: d("0"),
          grossEdge: d("0.03"),
          netEdge: d("0.03"),
        },
      ],
      realizedPnl: d("0"),
      unrealizedPnl: d("0"),
      maxDrawdown: d("0"),
      residualUp: d("0"),
      residualDown: d("0"),
      residualMarkUp: d("0.5"),
      residualMarkDown: d("0.5"),
      inventorySamples: [],
      holdingTimesMs: [],
      orders: { submitted: 0, filled: 0, partiallyFilled: 0, cancelled: 0, rejected: 0 },
      maxTotalCapital: d("100"),
    });
    // per-set costs sorted: 0.90, 0.93, 0.97, 0.99 -> median (0.93+0.97)/2
    expect(decToString(a.medianSetCost)).toBe("0.95000000");
  });

  it("treats zero capital limit as zero utilization (no division by zero)", () => {
    const inputs = collectPerformanceInputs(sampleReport(), d("0"));
    const a = analyzePerformance(inputs);
    expect(decToString(a.capitalUtilization)).toBe("0.00000000");
  });
});

describe("analysis CSV export", () => {
  it("emits the header and a stable, exact-value row", () => {
    const a = analyzePerformance(collectPerformanceInputs(sampleReport(), d("100")));
    expect(ANALYSIS_CSV_HEADER.split(",")).toHaveLength(19);
    const row = analysisToCsvRow(a);
    expect(row.split(",")).toHaveLength(19);
    expect(row).toBe(
      "7,10.00000000,0.95000000,0.95000000,0.50000000,0.46000000,0.05000000,0.01000000," +
        "1.00000000,0.06000000,0.40000000,1.04000000,4.00000000,6.00000000," +
        "0.80000000,0.10000000,0.10000000,30000.00000000,0.06000000",
    );
  });
});
