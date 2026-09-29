/**
 * Soak runner tests: deterministic, in-memory where possible, no network.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decFromString, millis } from "@bot/domain";
import { createExecutionAdapter, createSimulatedBook } from "@bot/execution";
import { StrategyOrchestrator } from "@bot/orchestrator";
import { DEFAULT_ASSETS, DEFAULT_MARKET, DEFAULT_RISK, DEFAULT_STRATEGY } from "@bot/shared";
import { DEFAULT_SIGNAL_ENGINE_CONFIG } from "@bot/strategy";

import { SoakRunner, RECONNECT_BACKOFF_MS } from "./runner.js";
import { SoakStateStore, EMPTY_STATE } from "./state-store.js";

const T0 = 1_800_000_000_000;
const d = (s: string) => decFromString(s);

function appConfig(over: Partial<{ mode: string; live: boolean }> = {}) {
  return {
    runtime: { env: "test", logLevel: "silent" },
    trading: {
      mode: (over.mode ?? "paper") as "paper" | "live",
      liveTradingEnabled: over.live ?? false,
    },
    assets: DEFAULT_ASSETS,
    market: DEFAULT_MARKET,
    strategy: { ...DEFAULT_STRATEGY, maxResidual: d("50") },
    risk: { ...DEFAULT_RISK, maxOrphanInventory: d("1000") },
    execution: { postOnly: false, maxRetries: 3, maxReconnects: 5 },
    hedge: { externalHedgeEnabled: false },
    services: { apiPort: 3001, databaseUrl: "postgres://localhost/test" },
  } as never;
}

function silentLogger(): never {
  const noop = () => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  } as never;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "soak-"));
}

/** Deterministic single-market world with an explicit test-controlled clock. */
function buildWorld(dataDir: string) {
  const market = {
    marketId: "soak-1",
    tokenIdUp: "soak-up-001",
    tokenIdDown: "soak-dn-001",
    asset: "BTC" as never,
    startMs: millis(T0),
    endMs: millis(T0 + 300_000),
  };
  const adapter = createExecutionAdapter("paper", {
    tokens: ["soak-up-001", "soak-dn-001"].map((tokenId) => ({
      tokenId,
      book: createSimulatedBook([
        { price: d("0.45"), qty: d("10") },
        { price: d("0.45"), qty: d("5000") },
      ]),
    })),
    takerFeeRate: d("0.002"),
  });

  // Test-controlled "now": the signal engine requires fresh samples, so the
  // world's samples are regenerated relative to this instant.
  let nowMs = T0 + 10_000;

  const orchestrator = new StrategyOrchestrator({
    config: appConfig(),
    ports: {
      discoverMarkets: () => [market],
      marketData: () => ({
        marketId: market.marketId,
        upAsk: d("0.45"),
        downAsk: d("0.56"),
        ageMs: 100,
        underlyingAgeMs: 100,
        apiHealth: "healthy" as const,
        wsHealth: "healthy" as const,
      }),
      spotSamples: () =>
        [0, 1, 3, 6, 10].map((inc, i) => ({
          price: String(100 + inc),
          at: millis(nowMs - 40_000 + i * 10_000),
        })),
      account: () => ({
        openOrderCount: 0,
        totalCapitalDeployed: d("0"),
        marketCapitalByMarket: {},
        directionalExposureAfter: d("0"),
        dailyLossUsdc: d("0"),
        marketLossByMarket: {},
        reconciliation: "reconciled" as const,
      }),
      lots: () => ({ up: [], down: [] }),
    },
    adapter,
    signalConfig: DEFAULT_SIGNAL_ENGINE_CONFIG,
  });

  const runner = new SoakRunner({
    config: appConfig(),
    orchestrator,
    adapter,
    dataDir,
    runnerConfig: { reconciliationIntervalMs: 60_000, reconcileOnStart: true },
    log: silentLogger(),
  });

  return {
    runner,
    adapter,
    market,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

// ---------------------------------------------------------------------------

describe("paper-mode startup validation", () => {
  it("refuses a live trading config outright", () => {
    const adapter = createExecutionAdapter("paper", {
      tokens: [{ tokenId: "t", book: createSimulatedBook([{ price: d("0.45"), qty: d("10") }]) }],
    });
    const liveConfig = appConfig({ mode: "live", live: true });
    expect(() => {
      // The runner validates before anything else; the orchestrator would also
      // refuse, but the runner's own guard fires first by construction.
      new SoakRunner({
        config: liveConfig,
        orchestrator: {} as StrategyOrchestrator,
        adapter,
        dataDir: freshDir(),
        log: silentLogger(),
      });
    }).toThrow(/refuses non-paper/);
  });
});

describe("cycle flow", () => {
  it("ticks, logs decisions, matches fills into lots, and persists state", () => {
    const dir = freshDir();
    const { runner, adapter, setNow } = buildWorld(dir);

    // Cycle 1 at t1: order submitted.
    const t1 = T0 + 10_000;
    setNow(t1);
    const h1 = runner.runCycle(millis(t1));
    expect(h1.tradingMode).toBe("paper");
    expect(h1.liveTradingEnabled).toBe(false);
    expect(h1.totalOrders).toBe(1);
    expect(h1.decisionCount).toBe(1);

    // Advance the adapter clock so fills occur (thin level → partial, then
    // the deep level completes), then the next cycle books them as lots.
    adapter.advanceClock(millis(t1 + 2_000));
    adapter.advanceClock(millis(t1 + 4_000));
    const t2 = t1 + 10_000;
    setNow(t2);
    const h2 = runner.runCycle(millis(t2));
    expect(h2.fills).toBeGreaterThanOrEqual(1);
    expect(h2.lotCount).toBeGreaterThanOrEqual(1);
    expect(h2.tickCount).toBe(2);

    // State persisted: lots recorded, cash decreased by the notional spent.
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
      lots: unknown[];
      decisionCount: number;
      cashUsdc: string;
      knownTradeIds: string[];
    };
    expect(state.lots.length).toBeGreaterThanOrEqual(1);
    expect(state.decisionCount).toBeGreaterThanOrEqual(2);
    expect(state.knownTradeIds.length).toBeGreaterThanOrEqual(1);
    expect(state.cashUsdc.startsWith("-")).toBe(true);
  });

  it("writes JSONL decision logs rotated by UTC date", () => {
    const dir = freshDir();
    const { runner, setNow } = buildWorld(dir);
    const t1 = T0 + 10_000;
    setNow(t1);
    runner.runCycle(millis(t1));
    const date = new Date(t1).toISOString().slice(0, 10);
    const path = join(dir, "logs", `decisions-${date}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(lines[0] as string) as {
      decisionId: string;
      action: string;
      tradingMode?: string;
    };
    expect(first.decisionId).toBe("dec-000001");
    expect(first.action).toBe("submit_order");
  });
});

describe("periodic reconciliation", () => {
  it("runs on start, reports reconciled for an agreeing book, and logs it", () => {
    const dir = freshDir();
    const { runner, setNow } = buildWorld(dir);
    const t1 = T0 + 10_000;
    setNow(t1);
    const h = runner.runCycle(millis(t1));
    // Local lots, known fills, and the adapter all agree → reconciled.
    expect(h.reconciliation).toBe("reconciled");
    const date = new Date(t1).toISOString().slice(0, 10);
    const log = readFileSync(join(dir, "logs", `reconciliations-${date}.jsonl`), "utf8");
    const record = JSON.parse(log.trim().split("\n")[0] as string) as {
      state: string;
      summary: string;
    };
    expect(record.state).toBe("reconciled");
    expect(record.summary).toBe("clean");
  });
});

describe("failure recovery", () => {
  it("resumes from persisted state with counters intact", () => {
    const dir = freshDir();
    const first = buildWorld(dir);
    const t1 = T0 + 10_000;
    first.setNow(t1);
    first.runner.runCycle(millis(t1));
    const before = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
      tickCount: number;
      decisionCount: number;
    };

    // "Restart": a brand-new runner over the same data dir.
    const second = buildWorld(dir);
    const t2 = t1 + 10_000;
    second.setNow(t2);
    const h = second.runner.runCycle(millis(t2));
    expect(h.tickCount).toBe(before.tickCount + 1);
    // The gate reopens only via a clean reconciliation pass this run.
    expect(h.reconciliation === "reconciled" || h.reconciliation === "unknown").toBe(true);
  });

  it("a corrupt state file fails safe to a fresh run", () => {
    const dir = freshDir();
    const store = new SoakStateStore(dir, { ...EMPTY_STATE });
    store.update({ ...EMPTY_STATE, tickCount: 5 });
    store.save();
    writeFileSync(join(dir, "state.json"), "{not json", "utf8");
    expect(SoakStateStore.load(dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("daily report", () => {
  it("finalizes the UTC daily report with end-of-run data, exactly once", () => {
    const dir = freshDir();
    const { runner, setNow } = buildWorld(dir);
    const t1 = T0 + 10_000;
    setNow(t1);
    runner.runCycle(millis(t1));
    // During the run (same UTC day) the report is intentionally not written
    // yet — it finalizes at stop with complete data.
    const date = new Date(t1).toISOString().slice(0, 10);
    const jsonPath = join(dir, "reports", `daily-${date}.json`);
    expect(existsSync(jsonPath)).toBe(false);

    runner.finalize(millis(t1 + 1_000));
    const csvPath = join(dir, "reports", `daily-${date}.csv`);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(csvPath)).toBe(true);

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    expect(report.tradingMode).toBe("paper");
    expect(report.liveTradingEnabled).toBe(false);
    expect(report.totalOrders).toBeGreaterThanOrEqual(1);

    // Idempotent: a second finalize does not duplicate or change the report.
    runner.finalize(millis(t1 + 2_000));
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toEqual(report);
  });

  it("rolls the report over when the UTC day changes", () => {
    const dir = freshDir();
    const { runner, setNow } = buildWorld(dir);
    const t1 = T0 + 10_000; // day A
    setNow(t1);
    runner.runCycle(millis(t1));
    const dayA = new Date(t1).toISOString().slice(0, 10);

    // Cross into day B: the report for day A is written with that day's data.
    const t2 = t1 + 26 * 60 * 60 * 1000;
    setNow(t2);
    runner.runCycle(millis(t2));
    const dayAJson = join(dir, "reports", `daily-${dayA}.json`);
    expect(existsSync(dayAJson)).toBe(true);
    const reportA = JSON.parse(readFileSync(dayAJson, "utf8")) as {
      date: string;
      totalOrders: number;
    };
    expect(reportA.date).toBe(dayA);
    expect(reportA.totalOrders).toBeGreaterThanOrEqual(1);
  });
});

describe("reconnect policy", () => {
  it("exposes a bounded, deterministic backoff schedule", () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  });
});

describe("state store", () => {
  it("saves atomically (no tmp leftovers) and round-trips", () => {
    const dir = freshDir();
    const store = new SoakStateStore(dir, { ...EMPTY_STATE });
    store.update({ ...EMPTY_STATE, tickCount: 3, cashUsdc: "-1.50000000" });
    store.save();
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
    const loaded = SoakStateStore.load(dir);
    expect(loaded?.tickCount).toBe(3);
    expect(loaded?.cashUsdc).toBe("-1.50000000");
    rmSync(dir, { recursive: true, force: true });
  });
});
