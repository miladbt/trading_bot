import { describe, expect, it } from "vitest";

import { decFromString, decToString, millis, type Decimal } from "@bot/domain";

import { MockClobTransport } from "./transport.js";
import { PolymarketExecutionAdapter, type PolymarketAdapterConfig } from "./polymarket-adapter.js";
import type { ExecutionOrderRequest } from "../adapter.js";
import type { RawOrderDto, RawOrderPostResponse } from "./dto.js";

const T0 = 1_800_000_000_000;
const d = (s: string): Decimal => decFromString(s);

function req(over: Partial<ExecutionOrderRequest> = {}): ExecutionOrderRequest {
  return {
    clientOrderId: "c1",
    marketId: "703257",
    tokenId: "1111111111",
    outcome: "up",
    side: "buy",
    kind: "limit",
    price: d("0.45"),
    qty: d("10"),
    at: millis(T0),
    ...over,
  };
}

const ALLOWING_RISK = {
  evaluate: (_r: ExecutionOrderRequest) => ({ allowed: true, reason: "ok" }),
};
const REJECTING_RISK = {
  evaluate: (_r: ExecutionOrderRequest) => ({ allowed: false, reason: "max_daily_loss" }),
};

function cfg(over: Partial<PolymarketAdapterConfig> = {}): PolymarketAdapterConfig {
  const transport = new MockClobTransport();
  return {
    tradingMode: "live",
    liveTradingEnabled: true, // tests that need the guard override this
    timeoutMs: 1_000,
    maxAttempts: 3,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
    rateLimitCooldownMs: 60_000,
    riskGate: ALLOWING_RISK,
    transport,
    ...over,
    ...(over.transport === undefined ? { transport } : {}),
  };
}

const ACK: RawOrderPostResponse = { success: true, orderId: "v-123" };

function openOrderDto(over: Partial<RawOrderDto> = {}): RawOrderDto {
  return {
    id: "v-123",
    status: "LIVE",
    market: "703257",
    asset_id: "1111111111",
    side: "BUY",
    price: "0.45",
    original_size: "10",
    size_matched: "0",
    created_at: new Date(T0).toISOString(),
    ...over,
  };
}

describe("live-execution guard (fail closed)", () => {
  it("refuses submission when TRADING_MODE=paper (default), even with enabled=true", async () => {
    const a = new PolymarketExecutionAdapter(
      cfg({ tradingMode: "paper", liveTradingEnabled: true }),
    );
    const r = await a.submit(req());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("live_trading_disabled");
  });

  it("refuses submission when LIVE_TRADING_ENABLED=false (shipped default), even in live mode", async () => {
    const a = new PolymarketExecutionAdapter(
      cfg({ tradingMode: "live", liveTradingEnabled: false }),
    );
    const r = await a.submit(req());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("live_trading_disabled");
  });

  it("refuses both submit AND cancel when the guard is closed", async () => {
    const a = new PolymarketExecutionAdapter(
      cfg({ tradingMode: "live", liveTradingEnabled: false }),
    );
    expect((await a.submit(req())).reason).toBe("live_trading_disabled");
    expect((await a.cancel("c1", millis(T0))).reason).toBe("live_trading_disabled");
  });

  it("allows submission only when mode=live AND enabled=true", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    (a as unknown as { cfg: { transport: MockClobTransport } }).cfg.transport.postOrderResults = [
      { ok: true, value: ACK },
    ];
    const r = await a.submit(req());
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("accepted");
  });

  it("never reaches the transport when the guard is closed", async () => {
    const a = new PolymarketExecutionAdapter(cfg({ tradingMode: "paper" }));
    await a.submit(req());
    const t = (a as unknown as { cfg: { transport: MockClobTransport } }).cfg.transport;
    expect(t.postOrderCalls).toHaveLength(0);
  });
});

describe("risk gate — the adapter cannot bypass the RiskEngine", () => {
  it("refuses to place an order without a positive risk verdict", async () => {
    const a = new PolymarketExecutionAdapter(cfg({ riskGate: REJECTING_RISK }));
    const r = await a.submit(req());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("risk_max_daily_loss");
    const t = (a as unknown as { cfg: { transport: MockClobTransport } }).cfg.transport;
    expect(t.postOrderCalls).toHaveLength(0);
  });
});

describe("submit lifecycle — acceptance is never a fill", () => {
  it("an accepted order is LIVE (not FILLED) until reconciliation proves fills", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req());
    const o = a.getOrder("c1")!;
    expect(o.status).toBe("LIVE");
    expect(decToString(o.filledQty)).toBe("0.00000000");
    expect(o.fills).toHaveLength(0);
  });

  it("validates price range, qty, kind, and duplicates locally", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    expect((await a.submit(req({ price: d("0") }))).reason).toBe("price_out_of_range");
    expect((await a.submit(req({ price: d("1") }))).reason).toBe("price_out_of_range");
    expect((await a.submit(req({ qty: d("0") }))).reason).toBe("non_positive_qty");
    expect((await a.submit(req({ kind: "market" }))).reason).toBe("unsupported_kind");
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    expect((await a.submit(req())).ok).toBe(true);
    expect((await a.submit(req())).reason).toBe("duplicate_client_order_id");
  });

  it("keeps the order in a conservative non-working state when placement fails", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, {
      postOrder: [
        { ok: false, error: "server_error" },
        { ok: false, error: "server_error" },
        { ok: false, error: "server_error" },
      ],
    });
    const r = await a.submit(req());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("venue_server_error");
    expect(a.getOrder("c1")!.status).toBe("REJECTED");
    expect(a.getOrder("c1")!.rejectReason).toBe("venue_server_error");
  });
});

describe("timeout and retry with bounded exponential backoff", () => {
  it("retries timeouts and succeeds on a later attempt", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, {
      postOrder: [
        { ok: false, error: "timeout" },
        { ok: false, error: "timeout" },
        { ok: true, value: ACK },
      ],
    });
    const r = await a.submit(req());
    expect(r.ok).toBe(true);
    const t = transportOf(a);
    expect(t.postOrderCalls).toHaveLength(3);
  });

  it("gives up after maxAttempts and reports the last failure", async () => {
    const a = new PolymarketExecutionAdapter(cfg({ maxAttempts: 3 }));
    inject(a, {
      postOrder: [
        { ok: false, error: "network" },
        { ok: false, error: "network" },
        { ok: false, error: "network" },
      ],
    });
    const r = await a.submit(req());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("venue_network");
    expect(transportOf(a).postOrderCalls).toHaveLength(3);
  });

  it("never retries authentication failures (fail closed)", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, {
      postOrder: [
        { ok: false, error: "auth_failed" },
        { ok: false, error: "auth_failed" },
      ],
    });
    const r = await a.submit(req());
    expect(r.reason).toBe("venue_auth_failed");
    expect(transportOf(a).postOrderCalls).toHaveLength(1);
  });

  it("applies exponential backoff: base * 2^(attempt-1), capped", async () => {
    const a = new PolymarketExecutionAdapter(
      cfg({ baseBackoffMs: 100, maxBackoffMs: 250, maxAttempts: 4 }),
    );
    const delays: number[] = [];
    const t = transportOf(a);
    inject(a, {
      postOrder: [
        { ok: false, error: "timeout" },
        { ok: false, error: "timeout" },
        { ok: false, error: "timeout" },
        { ok: true, value: ACK },
      ],
    });
    // Monkey-patch backoff through a timing capture: measure via Date.now().
    const orig = setTimeout;
    const spy = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return orig(fn, 0);
    }) as typeof setTimeout;
    try {
      await a.submit(req());
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = spy;
    }
    // 100, 200, then capped at 250.
    expect(delays).toEqual([100, 200, 250]);
    void t;
  });
});

describe("rate limits", () => {
  it("enters a cooldown after a rate-limit response and refuses further submits", async () => {
    const a = new PolymarketExecutionAdapter(cfg({ maxAttempts: 2 }));
    inject(a, {
      postOrder: [
        { ok: false, error: "rate_limited" },
        { ok: false, error: "rate_limited" },
      ],
    });
    expect((await a.submit(req({ clientOrderId: "c0" }))).ok).toBe(false);
    // Cooldown active: next submit is refused locally without transport calls.
    const r = await a.submit(req({ clientOrderId: "c2" }));
    expect(r.reason).toBe("rate_limited_cooldown");
    expect(transportOf(a).postOrderCalls).toHaveLength(2); // no new calls
  });
});

describe("reconciliation — partial fills, full fills, unknown states", () => {
  it("accumulates partial fills across syncs and stays PARTIALLY_FILLED", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req({ qty: d("10") }));

    inject(a, {
      getOrder: [
        {
          ok: true,
          value: openOrderDto({
            status: "PARTIALLY_FILLED",
            size_matched: "4",
            associate_trades: [
              {
                trade_id: "t1",
                size: "4",
                price: "0.45",
                fee_rate_bps: "20",
                match_time: String(T0 + 1),
              },
            ],
          }),
        },
      ],
    });
    const afterFirst = await a.syncOrder("c1");
    expect(afterFirst!.status).toBe("PARTIALLY_FILLED");
    expect(decToString(afterFirst!.filledQty)).toBe("4.00000000");
    expect(afterFirst!.fills).toHaveLength(1);

    inject(a, {
      getOrder: [
        {
          ok: true,
          value: openOrderDto({
            status: "PARTIALLY_FILLED",
            size_matched: "7",
            associate_trades: [
              {
                trade_id: "t1",
                size: "4",
                price: "0.45",
                fee_rate_bps: "20",
                match_time: String(T0 + 1),
              },
              {
                trade_id: "t2",
                size: "3",
                price: "0.45",
                fee_rate_bps: "20",
                match_time: String(T0 + 2),
              },
            ],
          }),
        },
      ],
    });
    const afterSecond = await a.syncOrder("c1");
    expect(decToString(afterSecond!.filledQty)).toBe("7.00000000");
    expect(afterSecond!.fills).toHaveLength(2); // deduped: no double-count
    expect(a.listOpenOrders().map((o) => o.clientOrderId)).toEqual(["c1"]);
  });

  it("moves to FILLED only when the venue confirms the full quantity", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req({ qty: d("10") }));
    inject(a, {
      getOrder: [
        {
          ok: true,
          value: openOrderDto({
            status: "FILLED",
            size_matched: "10",
            associate_trades: [
              { trade_id: "t1", size: "6", price: "0.45", match_time: String(T0 + 1) },
              { trade_id: "t2", size: "4", price: "0.45", match_time: String(T0 + 2) },
            ],
          }),
        },
      ],
    });
    const o = await a.syncOrder("c1");
    expect(o!.status).toBe("FILLED");
    expect(decToString(o!.filledQty)).toBe("10.00000000");
  });

  it("never claims FILLED when the venue status and quantities disagree", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req({ qty: d("10") }));
    inject(a, {
      getOrder: [
        {
          ok: true,
          value: openOrderDto({
            status: "FILLED", // venue lies / stale
            size_matched: "3",
            associate_trades: [
              { trade_id: "t1", size: "3", price: "0.45", match_time: String(T0 + 1) },
            ],
          }),
        },
      ],
    });
    const o = await a.syncOrder("c1");
    expect(o!.status).toBe("PARTIALLY_FILLED"); // conservative
  });

  it("treats unknown venue statuses conservatively (never FILLED)", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req());
    inject(a, {
      getOrder: [{ ok: true, value: openOrderDto({ status: "SOMETHING_NEW" as never }) }],
    });
    const o = await a.syncOrder("c1");
    expect(o!.status).toBe("LIVE"); // unchanged, still working
    expect(a.getOrder("c1")!.rejectReason).toBe("unknown_venue_status");
    expect(decToString(a.getOrder("c1")!.filledQty)).toBe("0.00000000");
  });

  it("keeps local state on transport failure (order not assumed anything)", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req());
    inject(a, { getOrder: [{ ok: false, error: "timeout" }] });
    const o = await a.syncOrder("c1");
    expect(o!.status).toBe("LIVE");
    expect(a.getOrder("c1")!.fills).toHaveLength(0);
  });

  it("normalizes venue DTOs into internal models (price/qty/fees exact)", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req({ qty: d("10") }));
    inject(a, {
      getOrder: [
        {
          ok: true,
          value: openOrderDto({
            status: "FILLED",
            size_matched: "10",
            associate_trades: [
              {
                trade_id: "t1",
                size: "10",
                price: "0.45",
                fee_rate_bps: "20",
                match_time: String(T0 + 5),
              },
            ],
          }),
        },
      ],
    });
    const o = await a.syncOrder("c1");
    expect(decToString(o!.price)).toBe("0.45000000");
    expect(decToString(o!.qty)).toBe("10.00000000");
    // fee = 10 * 0.45 * 20bps = 0.009 USDC
    expect(decToString(o!.totalFees)).toBe("0.00900000");
    const fills = a.getFills("c1");
    expect(fills).toHaveLength(1);
    expect(decToString(fills[0]!.qty)).toBe("10.00000000");
  });
});

describe("cancel", () => {
  it("cancels a live order after venue confirmation", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req());
    inject(a, { cancel: [{ ok: true, value: { canceled: ["v-123"] } }] });
    const r = await a.cancel("c1", millis(T0 + 1));
    expect(r.ok).toBe(true);
    expect(a.getOrder("c1")!.status).toBe("CANCELLED");
  });

  it("restores LIVE when the venue rejects the cancel (order still working)", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, { postOrder: [{ ok: true, value: ACK }] });
    await a.submit(req());
    inject(a, { cancel: [{ ok: false, error: "server_error" }] });
    const r = await a.cancel("c1", millis(T0 + 1));
    expect(r.ok).toBe(false);
    expect(a.getOrder("c1")!.status).toBe("LIVE");
  });

  it("refuses to cancel unknown orders", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    expect((await a.cancel("nope", millis(T0))).reason).toBe("unknown_order");
  });
});

describe("getOrder / open orders / fills", () => {
  it("lists open orders only and all fills", async () => {
    const a = new PolymarketExecutionAdapter(cfg());
    inject(a, {
      postOrder: [
        { ok: true, value: { success: true, orderId: "v-1" } },
        { ok: true, value: { success: true, orderId: "v-2" } },
      ],
    });
    await a.submit(req({ clientOrderId: "c1" }));
    await a.submit(req({ clientOrderId: "c2" }));
    inject(a, {
      getOrder: [
        {
          ok: true,
          value: openOrderDto({
            id: "v-1",
            status: "FILLED",
            size_matched: "10",
            associate_trades: [
              { trade_id: "t1", size: "10", price: "0.45", match_time: String(T0 + 1) },
            ],
          }),
        },
      ],
    });
    await a.syncOrder("c1");
    expect(a.listOpenOrders().map((o) => o.clientOrderId)).toEqual(["c2"]);
    expect(a.listOrders()).toHaveLength(2);
    expect(a.getFills()).toHaveLength(1);
    expect(a.getFills("c1")).toHaveLength(1);
    expect(a.getFills("c2")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Inject = {
  postOrder?: MockClobTransport["postOrderResults"];
  cancel?: MockClobTransport["cancelResults"];
  getOrder?: MockClobTransport["getOrderResults"];
  openOrders?: MockClobTransport["openOrdersResults"];
  trades?: MockClobTransport["tradesResults"];
};

function transportOf(a: PolymarketExecutionAdapter): MockClobTransport {
  return (a as unknown as { cfg: { transport: MockClobTransport } }).cfg.transport;
}

function inject(a: PolymarketExecutionAdapter, results: Inject): void {
  const t = transportOf(a);
  if (results.postOrder !== undefined) t.postOrderResults = results.postOrder;
  if (results.cancel !== undefined) t.cancelResults = results.cancel;
  if (results.getOrder !== undefined) t.getOrderResults = results.getOrder;
  if (results.openOrders !== undefined) t.openOrdersResults = results.openOrders;
  if (results.trades !== undefined) t.tradesResults = results.trades;
}
