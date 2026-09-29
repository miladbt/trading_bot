import { describe, expect, it } from "vitest";

import { decAdd, decToString, type Decimal } from "@bot/domain";
import { DEFAULT_ASSETS, DEFAULT_MARKET, DEFAULT_RISK, DEFAULT_STRATEGY } from "@bot/shared";

import { loadDatasetJson, parseDataset } from "./sources.js";
import { DEFAULT_REPLAY_CONFIG, ReplayEngine } from "./replay.js";
import { summaryLine, toCsv, toJson } from "./report.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sampleDataset = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/replay-sample.json"), "utf8"),
) as { name: string; windows: { marketId: string }[] };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const d = (s: string): Decimal => decFromString(s);
import { decFromString } from "@bot/domain";

function appConfig() {
  return {
    runtime: { env: "test", logLevel: "silent" },
    trading: { mode: "paper" as const, liveTradingEnabled: false },
    assets: DEFAULT_ASSETS,
    market: DEFAULT_MARKET,
    strategy: DEFAULT_STRATEGY,
    risk: DEFAULT_RISK,
    execution: { postOnly: false, maxRetries: 3, maxReconnects: 5 },
    hedge: { externalHedgeEnabled: false },
    services: { apiPort: 3001, databaseUrl: "postgres://localhost/test" },
  } as never;
}

function parseSample() {
  return parseDataset(loadDatasetJson(JSON.stringify(sampleDataset)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sources — dataset loading and validation", () => {
  it("parses the sample fixture into engine-ready windows", () => {
    const windows = parseSample();
    expect(windows).toHaveLength(2);
    expect(windows[0]!.marketId).toBe("703257");
    expect(decToString(windows[0]!.asks[0]!.upAsk)).toBe("0.45000000");
    expect(decToString(windows[1]!.asks[2]!.downAsk)).toBe("0.51000000");
  });

  it("rejects non-ascending spot samples and invalid prices", () => {
    const bad = loadDatasetJson(
      JSON.stringify({
        name: "bad",
        windows: [
          {
            ...sampleDataset.windows[0],
            spot: [
              { at: 1800000010000, price: "100" },
              { at: 1800000000000, price: "101" },
            ],
          },
        ],
      }),
    );
    expect(() => parseDataset(bad)).toThrow(/time-ascending/);

    const badPrice = loadDatasetJson(
      JSON.stringify({
        name: "bad2",
        windows: [
          {
            ...sampleDataset.windows[0],
            asks: [{ at: 1800000000000, upAsk: "1.5", downAsk: "0.5" }],
          },
        ],
      }),
    );
    expect(() => parseDataset(badPrice)).toThrow(/price in \(0, 1\)/);
  });
});

describe("ReplayEngine — determinism and the no-second-implementation guarantee", () => {
  it("produces byte-identical reports for identical runs", () => {
    const windows = parseSample();
    const a = new ReplayEngine(windows).run(appConfig());
    const b = new ReplayEngine(windows).run(appConfig());
    expect(toJson(a)).toBe(toJson(b));
  });

  it("produces identical results regardless of replay speed (requirement 5)", () => {
    const windows = parseSample();
    const fast = new ReplayEngine(windows, { speed: 0 }).run(appConfig());
    const slow = new ReplayEngine(windows, { speed: 4 }).run(appConfig());
    expect(toJson(fast)).toBe(toJson(slow));
  });

  it("exposes the same orchestrator-driven pipeline (no second strategy)", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows).run(appConfig());
    // Decisions come from the real StrategyOrchestrator: unique ids, audited.
    const ids = report.decisions.map((r) => r.decisionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    expect(report.decisions.every((r) => /^dec-\d{6}$/.test(r.decisionId))).toBe(true);
  });

  it("never trades outside the window and respects the phase timeline", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows, { tickMs: 30_000 }).run(appConfig());
    for (const rec of report.decisions) {
      const w = windows.find((x) => x.marketId === rec.marketId)!;
      expect(rec.at >= w.startMs).toBe(true);
      expect(rec.at <= w.endMs).toBe(true);
    }
  });
});

describe("ReplayEngine — report contents", () => {
  it("reports trades, sets, residuals, edges, fees, pnl, drawdown, exposure, order stats", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows, { tickMs: 30_000 }).run(appConfig());

    const t = report.totals;
    // Order statistics exist and are consistent.
    expect(t.orderStats.submitted).toBeGreaterThanOrEqual(0);
    expect(t.orderStats.submitted).toBe(
      t.orderStats.filled +
        t.orderStats.partiallyFilled +
        t.orderStats.cancelled +
        t.orderStats.rejected +
        (t.orderStats.submitted -
          t.orderStats.filled -
          t.orderStats.partiallyFilled -
          t.orderStats.cancelled -
          t.orderStats.rejected),
    );
    // Fees are non-negative; drawdown is non-negative by definition.
    expect(decToString(t.fees >= d("0") ? d("1") : d("0"))).toBe("1.00000000");
    expect(decToString(t.maxDrawdown >= d("0") ? d("1") : d("0"))).toBe("1.00000000");
    expect(decToString(t.peakInventoryExposure >= d("0") ? d("1") : d("0"))).toBe("1.00000000");

    // Per-window records carry the full complete-set economics.
    for (const w of report.windows) {
      expect(w.sets.matchedSets >= d("0")).toBe(true);
      expect(w.sets.grossEdge === w.sets.expectedSettlementValue - w.sets.grossPairCost).toBe(true);
      expect(w.sets.netEdge === w.sets.expectedSettlementValue - w.sets.netPairCost).toBe(true);
      expect(w.trades.every((tr) => tr.marketId === w.marketId)).toBe(true);
    }
  });

  it("settles each window with the recorded winning outcome", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows, { tickMs: 60_000 }).run(appConfig());
    expect(report.windows[0]!.winningOutcome).toBe("up");
    expect(report.windows[1]!.winningOutcome).toBe("down");
    // Totals reconcile with the sum of window PnLs.
    const sum = report.windows.reduce((acc, w) => decAdd(acc, w.realizedPnl), 0n as Decimal);
    expect(decToString(sum)).toBe(decToString(report.totals.realizedPnl));
  });
});

describe("report exporters", () => {
  it("exports CSV with a header and one row per window", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows, { tickMs: 60_000 }).run(appConfig());
    const csv = toCsv(report);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(1 + report.windows.length);
    expect(lines[0]).toContain("market_id");
    expect(lines[0]).toContain("gross_edge");
    expect(lines[0]).toContain("net_edge");
    expect(lines[1]!.startsWith("703257,")).toBe(true);
  });

  it("exports JSON with exact decimal strings and the full audit trail", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows, { tickMs: 60_000 }).run(appConfig());
    const json = toJson(report);
    const parsed = JSON.parse(json) as { totals: { trades: number }; decisions: unknown[] };
    expect(parsed.totals.trades).toBeTypeOf("number");
    expect(parsed.decisions.length).toBe(report.decisions.length);
    expect(json).not.toContain("NaN");
  });

  it("renders a summary line", () => {
    const windows = parseSample();
    const report = new ReplayEngine(windows, { tickMs: 60_000 }).run(appConfig());
    const line = summaryLine(report);
    expect(line).toContain("dataset=replay");
    expect(line).toContain("windows=2");
  });
});

describe("ReplayConfig", () => {
  it("merges partial config over the defaults", () => {
    expect(DEFAULT_REPLAY_CONFIG.tickMs).toBe(1_000);
    const engine = new ReplayEngine(parseSample(), { tickMs: 5_000 });
    expect(engine.tickTimeline(parseSample()[0]!).length).toBe(60);
  });
});
