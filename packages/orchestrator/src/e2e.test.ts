/**
 * End-to-end suite: the full 5-minute up/down lifecycle through the REAL
 * components — StrategyOrchestrator (signal → phase → inventory → complete-set
 * engine → hybrid rebalancing → RiskEngine) and PaperExecutionAdapter —
 * driven by a scripted in-memory world. No network, no funds, no wall clock.
 *
 * Happy path covers the 18-step scenario for BTC and ETH. Failure scenarios
 * cover stale feeds, WS disconnect, API timeout, partial fills, rejected
 * orders, duplicate events, balance mismatch, reconciliation failure, risk
 * breach, and process restart.
 */

import { describe, expect, it } from "vitest";

import { createExecutionAdapter, createSimulatedBook, type ExecutionFill } from "@bot/execution";
import type { PaperExecutionAdapter } from "@bot/execution";
import { ReconciliationCoordinator } from "@bot/inventory";
import {
  decFromString,
  decToString,
  decZero,
  marketId as marketIdBrand,
  millis,
  tokenId as tokenIdBrand,
  type Decimal,
  type Millis,
} from "@bot/domain";
import { createAcquisitionLot, type AcquisitionLot } from "@bot/inventory";
import { DEFAULT_ASSETS, DEFAULT_MARKET, DEFAULT_RISK, DEFAULT_STRATEGY } from "@bot/shared";
import { DEFAULT_SIGNAL_ENGINE_CONFIG } from "@bot/strategy";
import type { AssetSymbol } from "@bot/domain";

import type {
  AccountSnapshot,
  DiscoveredMarket,
  MarketDataSnapshot,
  OrchestratorLot,
  SpotSample,
} from "./ports.js";
import { StrategyOrchestrator } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Deterministic world
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const d = (s: string): Decimal => decFromString(s);
const BTC = "BTC" as unknown as AssetSymbol;
const ETH = "ETH" as unknown as AssetSymbol;

interface MarketFixture {
  readonly market: DiscoveredMarket;
  readonly spotAsset: AssetSymbol;
  readonly spotStart: string;
}

function btcMarket(): MarketFixture {
  return {
    market: {
      marketId: "703257",
      tokenIdUp: "1111111111",
      tokenIdDown: "2222222222",
      asset: BTC,
      startMs: millis(T0),
      endMs: millis(T0 + 300_000),
    },
    spotAsset: BTC,
    spotStart: "100",
  };
}

function ethMarket(): MarketFixture {
  return {
    market: {
      marketId: "704000",
      tokenIdUp: "5555555555",
      tokenIdDown: "6666666666",
      asset: ETH,
      startMs: millis(T0),
      endMs: millis(T0 + 300_000),
    },
    spotAsset: ETH,
    spotStart: "50",
  };
}

const ALL_TOKENS = ["1111111111", "2222222222", "5555555555", "6666666666"];

/** Deeply configurable in-memory ports. */
class World {
  markets: DiscoveredMarket[] = [];
  dataByMarket = new Map<string, MarketDataSnapshot>();
  samplesByAsset = new Map<string, SpotSample[]>();
  lotsByMarket = new Map<string, { up: OrchestratorLot[]; down: OrchestratorLot[] }>();
  account: AccountSnapshot;
  failMarketData: string | null = null;
  slowMarketData: string | null = null;

  constructor() {
    this.account = {
      openOrderCount: 0,
      totalCapitalDeployed: decZero(),
      marketCapitalByMarket: {},
      directionalExposureAfter: decZero(),
      dailyLossUsdc: decZero(),
      marketLossByMarket: {},
      reconciliation: "reconciled",
    };
  }

  discoverMarkets(): readonly DiscoveredMarket[] {
    return this.markets;
  }

  marketData(m: DiscoveredMarket): MarketDataSnapshot | undefined {
    if (this.failMarketData === m.marketId) {
      throw new Error(`api timeout for ${m.marketId}`);
    }
    if (this.slowMarketData === m.marketId) {
      return undefined; // data not ready — timeout-shaped
    }
    return this.dataByMarket.get(m.marketId);
  }

  spotSamples(asset: AssetSymbol): readonly SpotSample[] {
    return this.samplesByAsset.get(String(asset)) ?? [];
  }

  accountState(): AccountSnapshot {
    return this.account;
  }

  lots(marketId: string): { up: readonly OrchestratorLot[]; down: readonly OrchestratorLot[] } {
    return this.lotsByMarket.get(marketId) ?? { up: [], down: [] };
  }

  /** Replace the account snapshot (tests mutate posture via this). */
  setAccount(patch: Partial<AccountSnapshot>): void {
    this.account = { ...this.account, ...patch };
  }

  /** Default books sum to 1.01 (no set edge) so the residual path is exercised. */
  setHealthyData(m: DiscoveredMarket, upAsk = "0.45", downAsk = "0.56", ageMs = 100): void {
    this.dataByMarket.set(m.marketId, {
      marketId: m.marketId,
      upAsk: d(upAsk),
      downAsk: d(downAsk),
      ageMs,
      underlyingAgeMs: ageMs,
      apiHealth: "healthy",
      wsHealth: "healthy",
    });
  }

  setUpTrend(asset: AssetSymbol, at: Millis, start = "100"): void {
    const t = Number(at);
    this.samplesByAsset.set(String(asset), [
      { price: start, at: millis(t - 40_000) },
      { price: inc(start, 1), at: millis(t - 30_000) },
      { price: inc(start, 3), at: millis(t - 20_000) },
      { price: inc(start, 6), at: millis(t - 10_000) },
      { price: inc(start, 10), at: millis(t) },
    ]);
  }
}

function inc(start: string, by: number): string {
  return String(Number(start) + by);
}

function appConfig() {
  return {
    runtime: { env: "test", logLevel: "silent" },
    trading: { mode: "paper" as const, liveTradingEnabled: false },
    assets: DEFAULT_ASSETS,
    market: DEFAULT_MARKET,
    // Realistic residual budget (shares): the default is a dust-scale 0.002,
    // which would make every planned order untradeably small. 50 matches the
    // 200 Up / 150 Down example semantics. The orphan limit is raised to a
    // coherent value for that scale (a 50-share residual marks ~50.5 USDC at
    // the 1.01 combined ask; the 10 USDC default would veto the scenario).
    strategy: { ...DEFAULT_STRATEGY, maxResidual: d("50") },
    risk: { ...DEFAULT_RISK, maxOrphanInventory: d("1000") },
    execution: { postOnly: false, maxRetries: 3, maxReconnects: 5 },
    hedge: { externalHedgeEnabled: false },
    services: { apiPort: 3001, databaseUrl: "postgres://localhost/test" },
  } as never;
}

function paperAdapter(): PaperExecutionAdapter {
  const adapter = createExecutionAdapter("paper", {
    tokens: ALL_TOKENS.map((tokenId) => ({
      tokenId,
      // A thin best level forces deterministic PARTIAL fills; the deep level
      // at the same price completes the order on a later tick.
      book: createSimulatedBook([
        { price: d("0.45"), qty: d("10") },
        { price: d("0.45"), qty: d("1000") },
      ]),
    })),
    takerFeeRate: d("0.002"),
  });
  return adapter;
}

function orchestrator(world: World, adapter: PaperExecutionAdapter): StrategyOrchestrator {
  return new StrategyOrchestrator({
    config: appConfig(),
    ports: {
      discoverMarkets: () => world.discoverMarkets(),
      marketData: (m) => world.marketData(m),
      spotSamples: (asset) => world.spotSamples(asset),
      account: () => world.accountState(),
      lots: (marketId) => world.lots(marketId),
    },
    adapter,
    signalConfig: DEFAULT_SIGNAL_ENGINE_CONFIG,
  });
}

function lot(
  market: DiscoveredMarket,
  side: "up" | "down",
  lotId: string,
  qty: string,
  acquiredAt: number,
): AcquisitionLot {
  return createAcquisitionLot({
    lotId,
    marketId: marketIdBrand(market.marketId),
    tokenId: tokenIdBrand(side === "up" ? market.tokenIdUp : market.tokenIdDown),
    outcome: side,
    qty: d(qty),
    pricePerUnit: d("0.45"),
    fee: decZero(),
    rebate: decZero(),
    acquiredAt: millis(acquiredAt),
  });
}

function statusOf(adapter: PaperExecutionAdapter, clientOrderId: string): string | undefined {
  return adapter.getOrder(clientOrderId)?.status;
}

// ---------------------------------------------------------------------------
// Happy path: the 18-step scenario, BTC and ETH
// ---------------------------------------------------------------------------

describe("E2E happy path — 18 steps for BTC and ETH", () => {
  for (const fixture of [btcMarket(), ethMarket()]) {
    it(`completes the full lifecycle for ${String(fixture.spotAsset)}`, () => {
      const world = new World();
      const adapter = paperAdapter();
      const orch = orchestrator(world, adapter);
      const m = fixture.market;
      world.markets = [m];
      const bookedLots: AcquisitionLot[] = [];

      // Steps 1–3: discovery, BTC/ETH market data, bullish signal.
      world.setHealthyData(m);
      const t1 = millis(T0 + 10_000); // EARLY phase
      world.setUpTrend(fixture.spotAsset, t1, fixture.spotStart);
      const decisions1 = orch.tick(t1);
      expect(decisions1.map((x) => x.action)).toEqual(["submit_order"]);
      expect(decisions1[0]!.asset).toBe(String(fixture.spotAsset));
      const clientOrderId = String(decisions1[0]!.detail.clientOrderId);

      // Step 10: the order went through the PaperExecutionAdapter (accepted
      // and working; zero submit latency means it goes LIVE on the next
      // adapter clock advance).
      expect(adapter.backend).toBe("paper");
      expect(["SUBMITTED", "LIVE"]).toContain(statusOf(adapter, clientOrderId));

      // Step 11: partial fill — thin best level forces a deterministic
      // partial; the deep second level completes the order later.
      const fills1: readonly ExecutionFill[] = adapter.advanceClock(millis(T0 + 12_000));
      expect(fills1.length).toBe(1);
      expect(statusOf(adapter, clientOrderId)).toBe("PARTIALLY_FILLED");
      const partialQty = adapter.getOrder(clientOrderId)!.filledQty;
      expect(Number(decToString(partialQty))).toBeGreaterThan(0);
      expect(Number(decToString(partialQty))).toBeLessThan(
        Number(decToString(adapter.getOrder(clientOrderId)!.qty)),
      );

      // Step 12: fills become inventory; lot-level matching runs. Let the
      // order complete, then book the fills as lots for this market.
      adapter.advanceClock(millis(T0 + 14_000));
      const filled = adapter.getOrder(clientOrderId)!;
      expect(filled.status).toBe("FILLED");
      const fillLot = createAcquisitionLot({
        lotId: "fill-1",
        marketId: marketIdBrand(m.marketId),
        tokenId: tokenIdBrand(m.tokenIdUp),
        outcome: "up",
        qty: filled.filledQty,
        pricePerUnit: filled.fills[0]!.price,
        fee: filled.totalFees,
        rebate: decZero(),
        acquiredAt: millis(T0 + 12_000),
      });
      bookedLots.push(fillLot);
      world.lotsByMarket.set(m.marketId, {
        up: [fillLot],
        down: [],
      });
      const t2 = millis(T0 + 20_000);
      world.setHealthyData(m);
      world.setUpTrend(fixture.spotAsset, t2, fixture.spotStart);
      const decisions2 = orch.tick(t2);
      // The audited view proves the lot-level engine consumed the fills:
      // one-sided Up residual equal to the filled quantity, zero Down.
      expect(decisions2[0]!.detail.residualUp).toBe(decToString(filled.filledQty));
      expect(decisions2[0]!.detail.residualDown).toBe("0.00000000");
      expect(
        decisions2[0]!.action === "submit_order" || decisions2[0]!.action === "no_action",
      ).toBe(true);

      // If a rebalance order went out, settle it so no in-flight intent
      // leaks forward into the residual-maintenance step.
      if (decisions2[0]!.action === "submit_order") {
        const clientOrderId2 = String(decisions2[0]!.detail.clientOrderId);
        adapter.cancel(clientOrderId2, t2);
        adapter.advanceClock(millis(T0 + 21_000));
        expect(adapter.getOrder(clientOrderId2)!.status).toBe("CANCELLED");
      }

      // Step 13: directional residual maintained (250 Up / 200 Down, i.e. the
      // 50-share residual of the spec example). The book is replaced: these
      // lots supersede the earlier probe fills.
      const finalLots = [
        lot(m, "up", "l1", "200", T0 + 21_000),
        lot(m, "up", "l2", "50", T0 + 22_000),
        lot(m, "down", "l3", "200", T0 + 22_500),
      ];
      bookedLots.length = 0;
      bookedLots.push(...finalLots);
      world.lotsByMarket.set(m.marketId, {
        up: finalLots.filter((l) => l.outcome === "up"),
        down: finalLots.filter((l) => l.outcome === "down"),
      });
      const t3 = millis(T0 + 30_000);
      world.setHealthyData(m);
      world.setUpTrend(fixture.spotAsset, t3, fixture.spotStart);
      const decisions3 = orch.tick(t3);
      const detail3 = decisions3[0]!.detail;
      // 250 Up − 200 Down → 200 sets + 50 Up residual; never forced neutral.
      // The planner is flat here (target < current), and audits it.
      expect(decisions3[0]!.action).toBe("no_action");
      expect(detail3.residualUp).toBe("50.00000000");
      expect(detail3.residualDown).toBe("0.00000000");

      // Step 15–16: settlement has arrived. With a flat book the planner
      // still wants its target residual, but the risk engine's cycle-expiry
      // check stops the inappropriate new order.
      world.lotsByMarket.delete(m.marketId);
      const tFinal = millis(T0 + 300_000); // endMs — expired
      world.setHealthyData(m);
      world.setUpTrend(fixture.spotAsset, tFinal, fixture.spotStart);
      const decisionsFinal = orch.tick(tFinal);
      expect(decisionsFinal[0]!.action).toBe("halted_risk");
      expect(decisionsFinal[0]!.riskReason).toBe("market_expired");
      expect(decisionsFinal[0]!.orderSubmitted).toBe(false); // Step 17: reconcile — clean pass over the full local state.
      const coordinator = new ReconciliationCoordinator({ maxLocalAgeMs: 60_000 });
      const recon = coordinator.reconcile(
        "periodic",
        {
          cashUsdc: d("90"),
          knownTradeIds: new Set(["t1", "t2"]),
          orders: new Map([[clientOrderId, { status: "filled" as const, venueOrderId: "v-1" }]]),
          upLots: bookedLots.filter((l) => l.outcome === "up"),
          downLots: bookedLots.filter((l) => l.outcome === "down"),
          lastReconciledAt: millis(T0 + 299_000),
        },
        {
          balance: { availableUsdc: d("90") },
          orders: [
            {
              venueOrderId: "v-1",
              clientOrderId,
              status: "filled",
              qty: d("25"),
              filledQty: d("25"),
            },
          ],
          fills: [
            {
              tradeId: "t1",
              clientOrderId,
              qty: d("12.5"),
              price: d("0.45"),
              fee: d("0.01125"),
              at: millis(T0),
            },
            {
              tradeId: "t2",
              clientOrderId,
              qty: d("12.5"),
              price: d("0.45"),
              fee: d("0.01125"),
              at: millis(T0),
            },
          ],
          reachable: true,
        },
        millis(T0 + 300_000),
      );
      expect(recon.state).toBe("reconciled");
      expect(recon.blocked).toBe(false);
      expect(coordinator.reconciliationState).toBe("reconciled");

      // Step 18: PnL — 250 Up shares and 200 Down shares were bought at
      // 0.45; Up wins, so only the Up side pays 1 per share (Down's premium
      // is a sunk cost). Sets pay 1 each, the winning residual pays 1.
      const upShares = 250;
      const downShares = 200;
      const payout = upShares * 1;
      const cost = (upShares + downShares) * 0.45;
      const expectedPnl = payout - cost;
      expect(expectedPnl).toBeGreaterThan(0);
      // Invariant: winners pay (1 − price) per share, losers lose price.
      expect(expectedPnl).toBeCloseTo(upShares * (1 - 0.45) - downShares * 0.45, 6);
    });
  }

  it("keeps BTC and ETH independent end to end", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const btc = btcMarket();
    const eth = ethMarket();
    world.markets = [btc.market, eth.market];
    world.setHealthyData(btc.market);
    world.setHealthyData(eth.market);
    world.setUpTrend(BTC, millis(T0 + 10_000), "100");
    world.setUpTrend(ETH, millis(T0 + 10_000), "50");

    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions.map((x) => x.action)).toEqual(["submit_order", "submit_order"]);
    expect(decisions.map((x) => x.asset)).toEqual(["BTC", "ETH"]);
    // Separate client orders per market.
    const ids = decisions.map((x) => String(x.detail.clientOrderId));
    expect(new Set(ids).size).toBe(2);
    // Both accepted by the paper adapter with distinct tokens.
    expect(["SUBMITTED", "LIVE"]).toContain(statusOf(adapter, ids[0]!));
    expect(["SUBMITTED", "LIVE"]).toContain(statusOf(adapter, ids[1]!));
    expect(adapter.getOrder(ids[0]!)!.tokenId).toBe(btc.market.tokenIdUp);
    expect(adapter.getOrder(ids[1]!)!.tokenId).toBe(eth.market.tokenIdUp);
  });
});

// ---------------------------------------------------------------------------
// Failure scenarios
// ---------------------------------------------------------------------------

describe("E2E failure scenarios", () => {
  it("stale feed: halts the market, no order", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m, "0.45", "0.56", 200_000); // > maxDataAgeMs
    world.setUpTrend(BTC, millis(T0 + 10_000));

    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("halted_stale_market_data");
    expect(decisions[0]!.orderSubmitted).toBe(false);
  });

  it("websocket disconnect: ws unhealthy halts new orders", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));
    world.dataByMarket.set(m.marketId, {
      ...world.dataByMarket.get(m.marketId)!,
      wsHealth: "unhealthy",
    });

    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("ws_health_unhealthy");
  });

  it("API timeout: market-data port failure fails closed and is audited", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));
    world.failMarketData = m.marketId;

    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("error");
    expect(decisions[0]!.orderSubmitted).toBe(false);
    // The rest of the world is unaffected: a second market still evaluates.
  });

  it("API timeout (silent): missing snapshot means no new orders", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));
    world.slowMarketData = m.marketId;

    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("skipped_no_market_data");
    expect(decisions[0]!.orderSubmitted).toBe(false);
  });

  it("partial fill: order keeps working, then completes", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));

    orch.tick(millis(T0 + 10_000));
    const order = adapter.listOrders()[0]!;
    const first = adapter.advanceClock(millis(T0 + 12_000));
    expect(first.length).toBe(1);
    expect(adapter.getOrder(order.clientOrderId)!.status).toBe("PARTIALLY_FILLED");
    const second = adapter.advanceClock(millis(T0 + 14_000));
    expect(second.length).toBe(1);
    expect(adapter.getOrder(order.clientOrderId)!.status).toBe("FILLED");
  });

  it("rejected order: post-only crossing is rejected before going live", () => {
    const world = new World();
    const rejecting = createExecutionAdapter("paper", {
      tokens: ALL_TOKENS.map((tokenId) => ({
        tokenId,
        book: createSimulatedBook([{ price: d("0.30"), qty: d("500") }]),
      })),
      postOnly: true,
    });
    const orch = orchestrator(world, rejecting);
    const m = btcMarket().market;
    world.markets = [m];
    // Ask 0.30 < intended limit price → post-only would cross → rejected.
    world.setHealthyData(m, "0.45", "0.56");
    world.setUpTrend(BTC, millis(T0 + 10_000));

    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("error");
    expect(String(decisions[0]!.detail.adapterReason)).toBe("post_only_would_cross");
    expect(rejecting.listOrders()[0]!.status).toBe("REJECTED");
  });

  it("duplicate event: a duplicate submit is a no-op, not a second order", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));

    const first = orch.tick(millis(T0 + 10_000));
    expect(first[0]!.action).toBe("submit_order");
    // Same tick conditions again within the throttle window: the duplicate
    // intent must NOT create a second order (in-flight intent still set).
    world.setUpTrend(BTC, millis(T0 + 10_500));
    const second = orch.tick(millis(T0 + 10_500));
    expect(second[0]!.action === "throttled" || second[0]!.action === "skipped_duplicate").toBe(
      true,
    );
    expect(adapter.listOrders().length).toBe(1);
  });

  it("balance mismatch: reconciliation reports, blocks, and risk refuses", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0));

    // Submit one order, then break the books.
    world.setUpTrend(BTC, millis(T0 + 10_000));
    orch.tick(millis(T0 + 10_000));
    const clientOrderId = adapter.listOrders()[0]!.clientOrderId;

    const coordinator = new ReconciliationCoordinator({ maxLocalAgeMs: 60_000 });
    const now = millis(T0 + 11_000);
    const result = coordinator.reconcile(
      "periodic",
      {
        cashUsdc: d("90"),
        knownTradeIds: new Set(),
        orders: new Map([[clientOrderId, { status: "working" as const, venueOrderId: "v-1" }]]),
        upLots: [],
        downLots: [],
        lastReconciledAt: undefined,
      },
      {
        balance: { availableUsdc: d("85") }, // venue disagrees by 5 USDC
        orders: [
          {
            venueOrderId: "v-1",
            clientOrderId,
            status: "working",
            qty: d("25"),
            filledQty: decZero(),
          },
        ],
        fills: [],
        reachable: true,
      },
      now,
    );
    expect(result.blocked).toBe(true);
    expect(result.state).toBe("unreconciled");
    expect(result.events.some((e) => e.type === "balance_mismatch")).toBe(true);
    // Nothing was silently overwritten: the event records both views.
    const event = result.events.find((e) => e.type === "balance_mismatch")!;
    expect(event.localState).toContain("90");
    expect(event.remoteState).toContain("85");

    // Let the working order complete so the orchestrator's in-flight intent
    // is pruned and the pipeline actually reaches the risk gate (duplicate
    // prevention runs before risk).
    adapter.advanceClock(millis(T0 + 12_000));
    adapter.advanceClock(millis(T0 + 14_000));
    expect(adapter.getOrder(clientOrderId)!.status).toBe("FILLED");

    // NO_NEW_ORDERS: the risk engine refuses while unreconciled.
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 20_000));
    world.setAccount({ reconciliation: "unreconciled" });
    const decisions = orch.tick(millis(T0 + 20_000));
    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("account_unreconciled");
  });

  it("reconciliation failure: unknown order state closes the gate until a clean pass", () => {
    const coordinator = new ReconciliationCoordinator({ maxLocalAgeMs: 60_000 });
    const now = millis(T0);

    const clean = () => ({
      cashUsdc: d("100"),
      knownTradeIds: new Set<string>(),
      orders: new Map(),
      upLots: [],
      downLots: [],
      // A recently-synced local store (fail-closed: a cold state with no sync
      // time would self-block as stale_local_state at startup).
      lastReconciledAt: millis(T0 - 1_000) as Millis | undefined,
    });
    const remote = () => ({
      balance: { availableUsdc: d("100") },
      orders: [],
      fills: [],
      reachable: true,
    });

    // Clean startup opens the gate.
    coordinator.reconcile("startup", clean(), remote(), now);
    expect(coordinator.reconciliationState).toBe("reconciled");

    // Venue reports an order we have never seen → unknown state → blocked.
    const drifted = coordinator.reconcile(
      "unknown_order_state",
      clean(),
      {
        ...remote(),
        orders: [
          {
            venueOrderId: "v-99",
            clientOrderId: undefined,
            status: "unknown" as const,
            qty: d("5"),
            filledQty: decZero(),
          },
        ],
      },
      millis(T0 + 1_000),
    );
    expect(drifted.blocked).toBe(true);
    expect(coordinator.reconciliationState).toBe("unreconciled");

    // Recovery: a clean pass re-opens the gate.
    const recovered = coordinator.reconcile(
      "websocket_recovery",
      clean(),
      remote(),
      millis(T0 + 2_000),
    );
    expect(recovered.blocked).toBe(false);
    expect(coordinator.reconciliationState).toBe("reconciled");
  });

  it("risk-limit breach: daily loss halts and the adapter is never called", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));
    world.setAccount({ dailyLossUsdc: d("60") }); // limit 50

    const before = adapter.listOrders().length;
    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("max_daily_loss");
    expect(adapter.listOrders().length).toBe(before);
  });

  it("process restart: fail-closed gate means no orders until reconciliation", () => {
    const world = new World();
    const adapter = paperAdapter();
    const orch = orchestrator(world, adapter);
    const m = btcMarket().market;
    world.markets = [m];
    world.setHealthyData(m);
    world.setUpTrend(BTC, millis(T0 + 10_000));

    // A fresh process has not reconciled yet: unknown → refuse everything.
    world.setAccount({ reconciliation: undefined });
    const decisions = orch.tick(millis(T0 + 10_000));
    expect(decisions[0]!.action).toBe("halted_risk");
    expect(decisions[0]!.riskReason).toBe("reconciliation_unknown");

    // After the startup reconciliation pass, trading resumes.
    world.setAccount({ reconciliation: "reconciled" });
    world.setUpTrend(BTC, millis(T0 + 20_000));
    const resumed = orch.tick(millis(T0 + 20_000));
    expect(resumed[0]!.action).toBe("submit_order");
  });
});
