import { describe, expect, it } from "vitest";

import { decAdd, decFromString, decMulRound, decToString, millis } from "@bot/domain";
import { loadConfig } from "@bot/shared";

import type { BacktestDataset, BacktestMarket, TokenPricePoint } from "./dataset.js";
import { runBacktest, type BacktestRunOptions } from "./runner.js";

const T0 = 1_800_000_000_000; // window start (ms)
const W = 300_000;

function points(base: number, drift: number, count: number, startMs: number): TokenPricePoint[] {
  const out: TokenPricePoint[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      t: millis(startMs + i * 30_000),
      p: Math.min(0.99, Math.max(0.01, base + (drift * i) / count)),
    });
  }
  return out;
}

function syntheticDataset(): BacktestDataset {
  const slug = "btc-updown-5m-1800000000";
  const upTokenId = "tok-up-1";
  const downTokenId = "tok-down-1";
  const market: BacktestMarket = {
    slug,
    asset: "BTC",
    startMs: millis(T0),
    endMs: millis(T0 + W),
    upTokenId,
    downTokenId,
    tickSize: 0.001,
    minOrderSize: 5,
    takerFeeRate: 0.07,
    resolution: { slug, priceToBeat: 100_000, finalPrice: 100_500, outcome: "UP" },
  };
  // Up path rises toward 1 (window resolves Up), Down mirrors it.
  const upPoints = points(0.45, 0.45, 10, T0);
  const downPoints = points(0.54, -0.5, 10, T0);
  return {
    schema: 1,
    provenance: {
      fetchedAt: "2026-09-29T00:00:00.000Z",
      windowStartMs: millis(T0),
      windowEndMs: millis(T0 + W),
      assets: ["BTC"],
      marketCount: 1,
      skipped: [],
      sources: ["synthetic-test"],
      caveats: [],
    },
    markets: [market],
    tokenHistories: {
      [upTokenId]: { tokenId: upTokenId, points: upPoints },
      [downTokenId]: { tokenId: downTokenId, points: downPoints },
    },
    underlying: {
      BTC: {
        asset: "BTC",
        points: [
          { t: millis(T0 - W), p: 100_000 },
          { t: millis(T0), p: 100_100 },
          { t: millis(T0 + W), p: 100_500 },
        ],
      },
      ETH: { asset: "ETH", points: [] },
    },
  };
}

function runOptions(over: Partial<BacktestRunOptions> = {}): BacktestRunOptions {
  return {
    config: loadConfig({}),
    windowStartMs: millis(T0),
    windowEndMs: millis(T0 + W),
    tickMs: 30_000,
    fillModel: "pessimistic",
    ...over,
  };
}

describe("runBacktest — harness mechanics", () => {
  it("is deterministic: two runs produce byte-identical PnL and decisions", () => {
    const dataset = syntheticDataset();
    const a = runBacktest(dataset, runOptions());
    const b = runBacktest(dataset, runOptions());
    expect(a.ticks).toBe(b.ticks);
    expect(a.decisions.map((d) => d.decisionId)).toEqual(b.decisions.map((d) => d.decisionId));
    expect(decToString(a.netPnlUsdc)).toBe(decToString(b.netPnlUsdc));
    expect(a.setEdgeSamples.length).toBe(b.setEdgeSamples.length);
  });

  it("ticks through the window and records T5 set-edge samples", () => {
    const result = runBacktest(syntheticDataset(), runOptions());
    expect(result.ticks).toBe(10);
    expect(result.setEdgeSamples.length).toBeGreaterThan(0);
    // Each sample's set edge = 1 - combinedAsk - perSetFee.
    const sample = result.setEdgeSamples[0]!;
    expect(Number(decToString(sample.setEdgePerSet))).toBeLessThan(0.1);
  });

  it("settles the market after expiry with the recorded outcome", () => {
    const result = runBacktest(syntheticDataset(), runOptions());
    expect(result.settlements).toHaveLength(1);
    expect(result.settlements[0]!.outcome).toBe("UP");
  });

  it("applies risk gating: decisions either submit through risk or halt", () => {
    const result = runBacktest(syntheticDataset(), runOptions());
    for (const decision of result.decisions) {
      expect([
        "submit_order",
        "no_action",
        "halted_risk",
        "throttled",
        "skipped_duplicate",
        "skipped_no_signal",
        "skipped_no_market_data",
        "halted_stale_market_data",
        "halted_stale_underlying_data",
      ]).toContain(decision.action);
    }
  });

  it("optimistic vs pessimistic fill models produce different (or equal) fill counts deterministically", () => {
    const dataset = syntheticDataset();
    const optimistic = runBacktest(dataset, runOptions({ fillModel: "optimistic" }));
    const pessimistic = runBacktest(dataset, runOptions({ fillModel: "pessimistic" }));
    // Pessimistic fills can only be fewer or equal (trade-through + queue
    // haircut) for the same decision stream.
    expect(pessimistic.fills.length).toBeLessThanOrEqual(optimistic.fills.length);
  });

  it("spend equals the exact Decimal sum of fill notional + fees", () => {
    const result = runBacktest(syntheticDataset(), runOptions());
    let manual = decFromString("0");
    let fees = decFromString("0");
    for (const fill of result.fills) {
      fees = decAdd(fees, fill.fee);
      manual = decAdd(manual, decAdd(decMulRound(fill.price, fill.qty), fill.fee));
    }
    expect(decToString(result.spentUsdc)).toBe(decToString(manual));
    expect(decToString(result.feesUsdc)).toBe(decToString(fees));
  });
});
