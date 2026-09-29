import { describe, expect, it } from "vitest";

import {
  type PaperExecutionAdapter,
  createExecutionAdapter,
  createSimulatedBook,
  type ExecutionFill,
  type ExecutionOrder,
} from "@bot/execution";
import { decFromString, millis, type Decimal, type Millis } from "@bot/domain";
import { DEFAULT_ASSETS, DEFAULT_MARKET, DEFAULT_RISK, DEFAULT_STRATEGY } from "@bot/shared";
import { DEFAULT_SIGNAL_ENGINE_CONFIG } from "@bot/strategy";
import type { AssetSymbol } from "@bot/domain";

import type {
  AccountSnapshot,
  DiscoveredMarket,
  MarketDataSnapshot,
  OrchestratorLot,
  OrchestratorPorts,
  SpotSample,
} from "./ports.js";
import { StrategyOrchestrator } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Deterministic mock world
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const BTC = "BTC" as unknown as AssetSymbol;
const d = (s: string): Decimal => decFromString(s);

function market(over: Partial<DiscoveredMarket> = {}): DiscoveredMarket {
  return {
    marketId: "703257",
    tokenIdUp: "1111111111",
    tokenIdDown: "2222222222",
    asset: BTC,
    startMs: millis(T0),
    endMs: millis(T0 + 300_000),
    ...over,
  };
}

/** Mutable in-memory implementation of OrchestratorPorts. */
class MockPorts implements OrchestratorPorts {
  markets: readonly DiscoveredMarket[] = [];
  dataByMarket = new Map<string, MarketDataSnapshot>();
  samplesByAsset = new Map<string, readonly SpotSample[]>();
  lotsByMarket = new Map<string, { up: OrchestratorLot[]; down: OrchestratorLot[] }>();
  accountSnapshot: AccountSnapshot;
  throwOnMarketData = false;

  constructor() {
    this.accountSnapshot = {
      openOrderCount: 0,
      totalCapitalDeployed: d("0"),
      marketCapitalByMarket: {},
      directionalExposureAfter: d("0"),
      dailyLossUsdc: d("0"),
      marketLossByMarket: {},
      reconciliation: "reconciled",
    };
  }

  discoverMarkets(): readonly DiscoveredMarket[] {
    return this.markets;
  }

  marketData(m: DiscoveredMarket): MarketDataSnapshot | undefined {
    if (this.throwOnMarketData) throw new Error("port failure");
    return this.dataByMarket.get(m.marketId);
  }

  spotSamples(asset: AssetSymbol): readonly SpotSample[] {
    return this.samplesByAsset.get(String(asset)) ?? [];
  }

  account(): AccountSnapshot {
    return this.accountSnapshot;
  }

  lots(marketId: string): { up: readonly OrchestratorLot[]; down: readonly OrchestratorLot[] } {
    return this.lotsByMarket.get(marketId) ?? { up: [], down: [] };
  }

  setHealthyData(m: DiscoveredMarket, upAsk = "0.45", downAsk = "0.56"): void {
    // Default asks sum to 1.01 — no complete-set edge — so the planner's
    // intended action is the residual rebalance, which is what these tests
    // exercise.
    this.dataByMarket.set(m.marketId, {
      marketId: m.marketId,
      upAsk: d(upAsk),
      downAsk: d(downAsk),
      ageMs: 100,
      underlyingAgeMs: 100,
      apiHealth: "healthy",
      wsHealth: "healthy",
    });
  }

  setUpTrend(asset: AssetSymbol, at: Millis): void {
    this.samplesByAsset.set(String(asset), [
      { price: "100", at: millis(Number(at) - 40_000) },
      { price: "101", at: millis(Number(at) - 30_000) },
      { price: "103", at: millis(Number(at) - 20_000) },
      { price: "106", at: millis(Number(at) - 10_000) },
      { price: "110", at: millis(Number(at)) },
    ]);
  }
}

/** Spy adapter: records every submit call to prove risk-gating. */
class SpyAdapter {
  readonly calls: { clientOrderId: string; tokenId: string; price: Decimal; qty: Decimal }[] = [];
  private readonly inner: PaperExecutionAdapter;

  constructor(inner: PaperExecutionAdapter) {
    this.inner = inner;
  }

  submit(r: Parameters<PaperExecutionAdapter["submit"]>[0]) {
    this.calls.push({
      clientOrderId: r.clientOrderId,
      tokenId: r.tokenId,
      price: r.price,
      qty: r.qty,
    });
    return this.inner.submit(r);
  }

  cancel(clientOrderId: string, at: Parameters<PaperExecutionAdapter["cancel"]>[1]) {
    return this.inner.cancel(clientOrderId, at);
  }

  advanceClock(at: Parameters<PaperExecutionAdapter["advanceClock"]>[0]) {
    return this.inner.advanceClock(at);
  }

  getOrder(clientOrderId: string): ExecutionOrder | undefined {
    return this.inner.getOrder(clientOrderId);
  }

  listOrders(): readonly ExecutionOrder[] {
    return this.inner.listOrders();
  }

  listOpenOrders(): readonly ExecutionOrder[] {
    return this.inner.listOpenOrders();
  }

  getFills(clientOrderId?: string): readonly ExecutionFill[] {
    return this.inner.getFills(clientOrderId);
  }

  readonly backend = "paper" as const;
}

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

const ALL_TOKENS = [
  "1111111111",
  "2222222222",
  "3333333333",
  "4444444444",
  "5555555555",
  "6666666666",
  "7777777777",
  "8888888888",
];

function makeOrchestrator(ports: MockPorts, adapter?: SpyAdapter) {
  const paper = createExecutionAdapter("paper", {
    tokens: ALL_TOKENS.map((tokenId) => ({
      tokenId,
      book: createSimulatedBook([{ price: d("0.45"), qty: d("500") }]),
    })),
    takerFeeRate: d("0.002"),
  });
  const spy = adapter !== undefined ? adapter : new SpyAdapter(paper);
  const orchestrator = new StrategyOrchestrator({
    config: appConfig(),
    ports,
    adapter: spy,
    // The engine's inert defaults: 5 fresh samples in an uptrend produce a
    // positive-confidence signal without overfitting.
    signalConfig: DEFAULT_SIGNAL_ENGINE_CONFIG,
  });
  return { orchestrator, spy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pipeline — happy path", () => {
  it("runs the full pipeline and submits an order for a bullish BTC market", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("submit_order");
    expect(decisions[0]!.orderSubmitted).toBe(true);
    expect(decisions[0]!.decisionId).toBe("dec-000001");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.tokenId).toBe("1111111111");
    // The decision is auditable: the audit trail contains it.
    expect(orchestrator.audit.map((r) => r.decisionId)).toContain("dec-000001");
  });

  it("treats BTC and ETH independently (requirement 6)", () => {
    const ports = new MockPorts();
    const ETH = "ETH" as unknown as AssetSymbol;
    const btc = market({ marketId: "703257", tokenIdUp: "1111111111", tokenIdDown: "2222222222" });
    const eth = market({
      marketId: "703999",
      asset: ETH,
      tokenIdUp: "3333333333",
      tokenIdDown: "4444444444",
    });
    ports.markets = [btc, eth];
    ports.setHealthyData(btc);
    ports.setHealthyData(eth);
    ports.setUpTrend(BTC, millis(T0));
    ports.setUpTrend(ETH, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));

    expect(decisions.map((r) => r.action)).toEqual(["submit_order", "submit_order"]);
    expect(decisions.map((r) => r.asset)).toEqual(["BTC", "ETH"]);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.map((c) => c.tokenId)).toEqual(["1111111111", "3333333333"]);
  });

  it("handles multiple simultaneous markets safely (requirement 7)", () => {
    const ports = new MockPorts();
    const markets = [
      market({ marketId: "703257", startMs: millis(T0), endMs: millis(T0 + 300_000) }),
      market({
        marketId: "703258",
        tokenIdUp: "5555555555",
        tokenIdDown: "6666666666",
        startMs: millis(T0 + 150_000),
        endMs: millis(T0 + 450_000),
      }),
      market({
        marketId: "703259",
        tokenIdUp: "7777777777",
        tokenIdDown: "8888888888",
        startMs: millis(T0 + 75_000),
        endMs: millis(T0 + 375_000),
      }),
    ];
    ports.markets = markets;
    const TICK = millis(T0 + 200_000);
    for (const m of markets) {
      ports.setHealthyData(m);
      ports.setUpTrend(BTC, TICK);
    }

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(TICK);

    expect(decisions).toHaveLength(3);
    expect(decisions.every((r) => r.action === "submit_order")).toBe(true);
    expect(spy.calls).toHaveLength(3);
    // Each market got its own client order id (no cross-market clobbering).
    expect(new Set(spy.calls.map((c) => c.clientOrderId)).size).toBe(3);
  });

  it("is deterministic: identical world state yields identical decisions", () => {
    const build = (): { ports: MockPorts; decisions: unknown; calls: unknown } => {
      const ports = new MockPorts();
      const m = market();
      ports.markets = [m];
      ports.setHealthyData(m);
      ports.setUpTrend(BTC, millis(T0));
      const { orchestrator, spy } = makeOrchestrator(ports);
      const decisions = orchestrator.tick(millis(T0));
      return { ports, decisions, calls: spy.calls };
    };
    const a = build();
    const b = build();
    expect(a.decisions).toEqual(b.decisions);
    expect(a.calls).toEqual(b.calls);
  });
});

describe("risk gating — the strategy cannot bypass the RiskEngine", () => {
  it("never calls the adapter when risk rejects (spy proof)", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    ports.setUpTrend(BTC, millis(T0));
    // Breach the daily-loss limit: risk must halt everything.
    ports.accountSnapshot = {
      ...ports.accountSnapshot,
      dailyLossUsdc: d("50"),
    };

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));

    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("max_daily_loss");
    expect(spy.calls).toHaveLength(0); // the adapter was NEVER called
  });

  it("halts on stale market data and never reaches risk or the adapter", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.dataByMarket.set(m.marketId, {
      marketId: m.marketId,
      upAsk: d("0.45"),
      downAsk: d("0.52"),
      ageMs: 6_000, // > 5_000 limit
      underlyingAgeMs: 100,
      apiHealth: "healthy",
      wsHealth: "healthy",
    });
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));

    expect(decisions[0]!.action).toBe("halted_stale_market_data");
    expect(spy.calls).toHaveLength(0);
  });

  it("halts on stale underlying data", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.dataByMarket.set(m.marketId, {
      marketId: m.marketId,
      upAsk: d("0.45"),
      downAsk: d("0.52"),
      ageMs: 100,
      underlyingAgeMs: 9_999,
      apiHealth: "healthy",
      wsHealth: "healthy",
    });
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));
    expect(decisions[0]!.action).toBe("halted_stale_underlying_data");
    expect(spy.calls).toHaveLength(0);
  });

  it("halts when the account is not reconciled (fail closed)", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    ports.setUpTrend(BTC, millis(T0));
    ports.accountSnapshot = { ...ports.accountSnapshot, reconciliation: undefined };

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));
    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("reconciliation_unknown");
    expect(spy.calls).toHaveLength(0);
  });

  it("halts on unhealthy feeds (fail closed)", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.dataByMarket.set(m.marketId, {
      marketId: m.marketId,
      upAsk: d("0.45"),
      downAsk: d("0.56"),
      ageMs: 100,
      underlyingAgeMs: 100,
      apiHealth: "degraded",
      wsHealth: "healthy",
    });
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));
    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("api_health_degraded");
    expect(spy.calls).toHaveLength(0);
  });
});

describe("duplicate prevention and throttling", () => {
  it("does not re-submit an identical in-flight intent (requirement 8)", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const first = orchestrator.tick(millis(T0));
    expect(first[0]!.action).toBe("submit_order");

    // Next tick (beyond the throttle window but while data is fresh): the
    // same intent is still in flight (the paper order rests unfilled), so no
    // duplicate.
    const second = orchestrator.tick(millis(T0 + 3_000));
    expect(second[0]!.action).toBe("skipped_duplicate");
    expect(spy.calls).toHaveLength(1);
  });

  it("allows a new order once the in-flight order reaches a terminal state", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const paper = createExecutionAdapter("paper", {
      tokens: [
        {
          tokenId: "1111111111",
          book: createSimulatedBook([{ price: d("0.45"), qty: d("500") }]),
        },
      ],
    });
    void paper; // the orchestrator's own adapter fills against its own book
    orchestrator.tick(millis(T0));
    // Cancel the in-flight order and let the cancel complete in the simulator.
    const orderId = spy.calls[0]!.clientOrderId;
    spy.cancel(orderId, millis(T0 + 1));
    spy.advanceClock(millis(T0 + 1));
    const second = orchestrator.tick(millis(T0 + 3_000));
    expect(second[0]!.action).toBe("submit_order");
    expect(spy.calls).toHaveLength(2);
  });

  it("throttles requotes within minRequoteIntervalMs (requirement 9)", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    orchestrator.tick(millis(T0));
    // Immediately cancel the in-flight order (and complete the cancel) so
    // duplicate-prevention does not mask the throttle check, then tick again
    // inside the throttle window.
    spy.cancel(spy.calls[0]!.clientOrderId, millis(T0 + 1));
    spy.advanceClock(millis(T0 + 1));
    const again = orchestrator.tick(millis(T0 + 1_000));
    expect(again[0]!.action).toBe("throttled");
    expect(spy.calls).toHaveLength(1);
  });
});

describe("fail-closed behavior", () => {
  it("skips markets without data and still processes the rest", () => {
    const ports = new MockPorts();
    const m1 = market({ marketId: "703257" });
    const m2 = market({ marketId: "703258", tokenIdUp: "5555555555", tokenIdDown: "6666666666" });
    ports.markets = [m1, m2];
    ports.setHealthyData(m2);
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));
    expect(decisions.map((r) => [r.marketId, r.action])).toEqual([
      ["703257", "skipped_no_market_data"],
      ["703258", "submit_order"],
    ]);
    expect(spy.calls).toHaveLength(1);
  });

  it("audits port errors per market without aborting the tick", () => {
    const ports = new MockPorts();
    const m1 = market({ marketId: "703257" });
    const m2 = market({ marketId: "703258", tokenIdUp: "5555555555", tokenIdDown: "6666666666" });
    ports.markets = [m1, m2];
    ports.setHealthyData(m2);
    ports.setUpTrend(BTC, millis(T0));
    ports.throwOnMarketData = true;

    const { orchestrator } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));
    expect(decisions).toHaveLength(2);
    expect(decisions.every((r) => r.action === "error")).toBe(true);
    expect(decisions[0]!.detail["error"]).toContain("port failure");
  });

  it("skips when the signal is cold (no spot samples)", () => {
    const ports = new MockPorts();
    const m = market();
    ports.markets = [m];
    ports.setHealthyData(m);
    // no samples

    const { orchestrator, spy } = makeOrchestrator(ports);
    const decisions = orchestrator.tick(millis(T0));
    expect(decisions[0]!.action).toBe("skipped_no_signal");
    expect(spy.calls).toHaveLength(0);
  });
});

describe("paper-mode guarantee and audit trail", () => {
  it("refuses to run against a live trading config (requirement 5)", () => {
    const ports = new MockPorts();
    const cfg = {
      runtime: { env: "test", logLevel: "silent" },
      trading: { mode: "live", liveTradingEnabled: true },
      assets: DEFAULT_ASSETS,
      market: DEFAULT_MARKET,
      strategy: DEFAULT_STRATEGY,
      risk: DEFAULT_RISK,
      execution: { postOnly: false, maxRetries: 3, maxReconnects: 5 },
      hedge: { externalHedgeEnabled: false },
      services: { apiPort: 3001, databaseUrl: "postgres://localhost/test" },
    } as never;
    expect(
      () =>
        new StrategyOrchestrator({
          config: cfg,
          ports,
          adapter: new SpyAdapter(
            createExecutionAdapter("paper", {
              tokens: [
                {
                  tokenId: "1111111111",
                  book: createSimulatedBook([{ price: d("0.45"), qty: d("5") }]),
                },
              ],
            }),
          ),
        }),
    ).toThrow(/paper mode only/);
  });

  it("gives every decision a unique decision_id and a complete audit trail", () => {
    const ports = new MockPorts();
    const m1 = market({ marketId: "703257" });
    const m2 = market({ marketId: "703258", tokenIdUp: "5555555555", tokenIdDown: "6666666666" });
    ports.markets = [m1, m2];
    ports.setHealthyData(m1);
    ports.setHealthyData(m2);
    ports.setUpTrend(BTC, millis(T0));

    const { orchestrator } = makeOrchestrator(ports);
    orchestrator.tick(millis(T0));
    orchestrator.tick(millis(T0 + 10_000));

    const ids = orchestrator.audit.map((r) => r.decisionId);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((id) => /^dec-\d{6}$/.test(id))).toBe(true);
    for (const rec of orchestrator.audit) {
      expect(rec.at).toBeTypeOf("number");
      expect(rec.marketId).toBeTypeOf("string");
      expect(rec.action).toBeTypeOf("string");
      expect(rec.detail).toBeTypeOf("object");
    }
  });
});
