import { describe, expect, it } from "vitest";

import {
  LiveExecutionNotImplementedError,
  PaperExecutionAdapter,
  assertPaperBackend,
  canTransitionExecution,
  createExecutionAdapter,
  createSimulatedBook,
  isTerminalExecution,
  matchAgainstBook,
  type ExecutionOrderRequest,
  type PaperAdapterConfig,
} from "./index.js";
import { decFromString, decToString, millis, type Decimal } from "@bot/domain";

const T0 = 1_800_000_000_000;
const d = (s: string): Decimal => decFromString(s);
const at = (ms: number): ReturnType<typeof millis> => millis(T0 + ms);

const ASKS = [
  { price: d("0.45"), qty: d("20") },
  { price: d("0.50"), qty: d("30") },
  { price: d("0.60"), qty: d("50") },
];
const BIDS = [
  { price: d("0.55"), qty: d("25") },
  { price: d("0.40"), qty: d("35") },
];

function paperConfig(over: Partial<PaperAdapterConfig> = {}): PaperAdapterConfig {
  return {
    tokens: [
      {
        tokenId: "1111111111",
        book: createSimulatedBook(ASKS, BIDS),
      },
      {
        tokenId: "2222222222",
        book: createSimulatedBook(
          [{ price: d("0.50"), qty: d("100") }],
          [{ price: d("0.48"), qty: d("100") }],
        ),
      },
    ],
    submitLatencyMs: 0,
    cancelLatencyMs: 0,
    postOnly: false,
    takerFeeRate: d("0.002"),
    makerRebateRate: d("0.001"),
    ...over,
  };
}

function req(over: Partial<ExecutionOrderRequest> = {}): ExecutionOrderRequest {
  return {
    clientOrderId: "c1",
    marketId: "703257",
    tokenId: "1111111111",
    outcome: "up",
    side: "buy",
    kind: "limit",
    price: d("0.50"),
    qty: d("10"),
    at: at(0),
    ...over,
  };
}

describe("lifecycle transitions", () => {
  it("allows the specified flow", () => {
    expect(canTransitionExecution("CREATED", "SUBMITTED")).toBe(true);
    expect(canTransitionExecution("SUBMITTED", "LIVE")).toBe(true);
    expect(canTransitionExecution("LIVE", "PARTIALLY_FILLED")).toBe(true);
    expect(canTransitionExecution("PARTIALLY_FILLED", "FILLED")).toBe(true);
    expect(canTransitionExecution("LIVE", "CANCEL_REQUESTED")).toBe(true);
    expect(canTransitionExecution("CANCEL_REQUESTED", "CANCELLED")).toBe(true);
    expect(canTransitionExecution("SUBMITTED", "REJECTED")).toBe(true);
  });

  it("forbids skipping and reviving", () => {
    expect(canTransitionExecution("CREATED", "FILLED")).toBe(false);
    expect(canTransitionExecution("FILLED", "CANCELLED")).toBe(false);
    expect(canTransitionExecution("CANCELLED", "LIVE")).toBe(false);
    expect(canTransitionExecution("REJECTED", "SUBMITTED")).toBe(false);
  });

  it("marks terminal statuses", () => {
    for (const s of ["FILLED", "CANCELLED", "REJECTED"] as const) {
      expect(isTerminalExecution(s)).toBe(true);
    }
    expect(isTerminalExecution("LIVE")).toBe(false);
  });
});

describe("simulated book matching", () => {
  it("sweeps levels partially then fully, in price order", () => {
    const book = createSimulatedBook(ASKS);
    const m = matchAgainstBook(
      { side: "buy", kind: "limit", price: d("0.50"), qty: d("40"), postOnly: false },
      book,
    );
    // takes 20 @ 0.45 then 20 @ 0.50; 0 rests
    expect(m.takes.map((t) => [decToString(t.price), decToString(t.qty)])).toEqual([
      ["0.45000000", "20.00000000"],
      ["0.50000000", "20.00000000"],
    ]);
    expect(decToString(m.filledQty)).toBe("40.00000000");
    expect(decToString(m.restingQty)).toBe("0.00000000");
  });

  it("leaves the remainder resting when the book is too thin", () => {
    const m = matchAgainstBook(
      { side: "buy", kind: "limit", price: d("0.60"), qty: d("200"), postOnly: false },
      createSimulatedBook(ASKS),
    );
    expect(decToString(m.filledQty)).toBe("100.00000000");
    expect(decToString(m.restingQty)).toBe("100.00000000");
  });

  it("rejects post-only orders that would cross", () => {
    const m = matchAgainstBook(
      { side: "buy", kind: "limit", price: d("0.50"), qty: d("10"), postOnly: true },
      createSimulatedBook(ASKS),
    );
    expect(m.postOnlyCrossed).toBe(true);
    expect(decToString(m.filledQty)).toBe("0.00000000");
  });

  it("lets post-only orders rest when they do not cross", () => {
    const m = matchAgainstBook(
      { side: "buy", kind: "limit", price: d("0.44"), qty: d("10"), postOnly: true },
      createSimulatedBook(ASKS),
    );
    expect(m.postOnlyCrossed).toBe(false);
    expect(decToString(m.filledQty)).toBe("0.00000000");
    expect(decToString(m.restingQty)).toBe("10.00000000");
  });

  it("matches sells against the bid side symmetrically", () => {
    const m = matchAgainstBook(
      { side: "sell", kind: "market", price: d("0.40"), qty: d("30"), postOnly: false },
      createSimulatedBook(ASKS, BIDS),
    );
    // best bid 0.55 (25) then 0.40 (5 of 35)
    expect(decToString(m.filledQty)).toBe("30.00000000");
    expect(decToString(m.takes[0]!.price)).toBe("0.55000000");
    expect(decToString(m.takes[1]!.qty)).toBe("5.00000000");
  });

  it("market orders never rest", () => {
    const m = matchAgainstBook(
      { side: "buy", kind: "market", price: d("0.46"), qty: d("50"), postOnly: false },
      createSimulatedBook(ASKS),
    );
    // only the 0.45 level is <= cap
    expect(decToString(m.filledQty)).toBe("20.00000000");
    expect(decToString(m.restingQty)).toBe("0.00000000");
  });

  it("rejects malformed books", () => {
    expect(() => createSimulatedBook([{ price: d("0"), qty: d("1") }])).toThrow(Error);
    expect(() =>
      createSimulatedBook([
        { price: d("0.50"), qty: d("1") },
        { price: d("0.45"), qty: d("1") },
      ]),
    ).toThrow(Error);
  });
});

describe("PaperExecutionAdapter — lifecycle and fills", () => {
  it("goes through SUBMITTED→LIVE→PARTIALLY_FILLED→FILLED", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    expect(a.submit(req({ qty: d("40"), price: d("0.50") })).ok).toBe(true);
    expect(a.getOrder("c1")!.status).toBe("SUBMITTED");
    // Tick 1: becomes LIVE, fills 20 at 0.45 (best level, partial).
    let fills = a.advanceClock(at(0));
    expect(fills).toHaveLength(1);
    expect(decToString(fills[0]!.qty)).toBe("20.00000000");
    expect(a.getOrder("c1")!.status).toBe("PARTIALLY_FILLED");
    expect(decToString(a.getOrder("c1")!.filledQty)).toBe("20.00000000");
    // Tick 2: next best level (0.50, 30 available) completes the order.
    fills = a.advanceClock(at(1));
    expect(a.getOrder("c1")!.status).toBe("FILLED");
    expect(decToString(fills[0]!.qty)).toBe("20.00000000");
    expect(decToString(a.getOrder("c1")!.totalFees)).not.toBe("0.00000000");
  });

  it("charges fees per fill at the configured taker rate", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    a.submit(req({ qty: d("20"), price: d("0.45") }));
    const fills = a.advanceClock(at(0));
    // Limit order → maker rate = 0.002 − 0.001 = 0.001; 20 × 0.45 × 0.001.
    expect(decToString(fills[0]!.fee)).toBe("0.00900000");
    expect(decToString(a.getOrder("c1")!.totalFees)).toBe("0.00900000");
  });

  it("charges market orders the full taker rate with no rebate", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    a.submit(req({ clientOrderId: "m1", kind: "market", price: d("0.50"), qty: d("20") }));
    const fills = a.advanceClock(at(0));
    // Taker rate 0.002: 20 × 0.45 × 0.002 = 0.018.
    expect(decToString(fills[0]!.fee)).toBe("0.01800000");
    expect(decToString(a.getOrder("m1")!.totalFees)).toBe("0.01800000");
  });

  it("clamps net maker fee at zero when the rebate exceeds the fee", () => {
    const a = new PaperExecutionAdapter(
      paperConfig({ takerFeeRate: d("0.001"), makerRebateRate: d("0.002") }),
    );
    a.submit(req({ qty: d("20"), price: d("0.45") }));
    const fills = a.advanceClock(at(0));
    expect(decToString(fills[0]!.fee)).toBe("0.00000000");
  });

  it("rejects post-only orders that would cross at submit time", () => {
    const a = new PaperExecutionAdapter(paperConfig({ postOnly: true }));
    const r = a.submit(req({ price: d("0.50") }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("post_only_would_cross");
    expect(a.getOrder("c1")!.status).toBe("REJECTED");
    expect(a.getOrder("c1")!.rejectReason).toBe("post_only_would_cross");
  });

  it("lets post-only orders rest when they do not cross", () => {
    const a = new PaperExecutionAdapter(paperConfig({ postOnly: true }));
    expect(a.submit(req({ price: d("0.44") })).ok).toBe(true);
    a.advanceClock(at(0));
    expect(a.getOrder("c1")!.status).toBe("LIVE");
    expect(a.getOrder("c1")!.filledQty.toString()).toBe("0");
  });

  it("rejects unknown tokens, duplicate ids, bad prices, and non-marketable market orders", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    expect(a.submit(req({ tokenId: "9999999999" })).reason).toBe("unknown_token");
    expect(a.submit(req()).ok).toBe(true);
    expect(a.submit(req()).reason).toBe("duplicate_client_order_id");
    expect(a.submit(req({ clientOrderId: "c3", price: d("0") })).reason).toBe("price_out_of_range");
    expect(a.submit(req({ clientOrderId: "c3", price: d("1.5") })).reason).toBe(
      "price_out_of_range",
    );
    expect(a.submit(req({ clientOrderId: "c4", qty: d("0") })).reason).toBe("non_positive_qty");
    expect(a.submit(req({ clientOrderId: "c5", kind: "market", price: d("0.40") })).reason).toBe(
      "market_order_not_marketable",
    );
  });

  it("handles full cancellation of a resting order", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    a.submit(req({ price: d("0.44") }));
    a.advanceClock(at(0));
    expect(a.getOrder("c1")!.status).toBe("LIVE");
    const r = a.cancel("c1", at(1));
    expect(r.ok).toBe(true);
    expect(a.getOrder("c1")!.status).toBe("CANCEL_REQUESTED");
    a.advanceClock(at(2));
    expect(a.getOrder("c1")!.status).toBe("CANCELLED");
    expect(decToString(a.getOrder("c1")!.filledQty)).toBe("0.00000000");
  });

  it("cancels a partially filled order, keeping the fills", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    a.submit(req({ qty: d("40"), price: d("0.50") }));
    a.advanceClock(at(0)); // 20 filled
    a.cancel("c1", at(1));
    a.advanceClock(at(2)); // cancel completes before further matching
    const o = a.getOrder("c1")!;
    expect(o.status).toBe("CANCELLED");
    expect(decToString(o.filledQty)).toBe("20.00000000");
    expect(o.fills).toHaveLength(1);
  });

  it("lets a completing fill win the race against a cancel in its latency window", () => {
    const a = new PaperExecutionAdapter(paperConfig({ cancelLatencyMs: 100 }));
    a.submit(req({ qty: d("40"), price: d("0.50") }));
    a.advanceClock(at(0)); // 20 filled, PARTIALLY_FILLED
    a.cancel("c1", at(1)); // cancel lands at t=101
    // Matching at t=2 (cancel still in flight) completes the order first.
    a.advanceClock(at(2));
    expect(a.getOrder("c1")!.status).toBe("FILLED");
  });

  it("refuses to cancel unknown, terminal, or already-requested orders", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    expect(a.cancel("nope", at(0)).reason).toBe("unknown_order");
    a.submit(req({ price: d("0.44") }));
    a.advanceClock(at(0));
    expect(a.cancel("c1", at(1)).ok).toBe(true);
    expect(a.cancel("c1", at(2)).reason).toBe("cancel_already_requested");
    a.advanceClock(at(3));
    expect(a.cancel("c1", at(4)).reason).toBe("not_cancellable_in_status_CANCELLED");
  });

  it("applies submit latency: the order cannot fill before goLive", () => {
    const a = new PaperExecutionAdapter(paperConfig({ submitLatencyMs: 100 }));
    a.submit(req({ qty: d("20"), price: d("0.45") }));
    expect(a.advanceClock(at(50))).toHaveLength(0);
    expect(a.getOrder("c1")!.status).toBe("SUBMITTED");
    a.advanceClock(at(100));
    expect(a.getOrder("c1")!.status).toBe("FILLED");
  });

  it("applies cancel latency: CANCEL_REQUESTED persists until the latency elapses", () => {
    const a = new PaperExecutionAdapter(paperConfig({ cancelLatencyMs: 50 }));
    a.submit(req({ price: d("0.44") }));
    a.advanceClock(at(0));
    a.cancel("c1", at(1));
    a.advanceClock(at(30));
    expect(a.getOrder("c1")!.status).toBe("CANCEL_REQUESTED");
    a.advanceClock(at(51));
    expect(a.getOrder("c1")!.status).toBe("CANCELLED");
  });

  it("is deterministic: identical call sequences produce identical results", () => {
    const run = (): string[] => {
      const a = new PaperExecutionAdapter(paperConfig());
      a.submit(req({ qty: d("40"), price: d("0.50") }));
      a.advanceClock(at(0));
      a.cancel("c1", at(1));
      a.advanceClock(at(2));
      return a
        .listOrders()
        .map((o) => `${o.status}:${decToString(o.filledQty)}:${decToString(o.totalFees)}`);
    };
    expect(run()).toEqual(run());
  });

  it("snapshots are copies: mutating getOrder output does not affect the adapter", () => {
    const a = new PaperExecutionAdapter(paperConfig());
    a.submit(req({ price: d("0.44") }));
    a.advanceClock(at(0));
    const snap = a.getOrder("c1")!;
    (snap.fills as unknown as unknown[]).push("junk");
    expect(a.getOrder("c1")!.fills).toHaveLength(0);
  });
});

describe("factory — paper mode cannot reach the live adapter", () => {
  it("returns a paper adapter for TRADING_MODE=paper", () => {
    const a = createExecutionAdapter("paper", paperConfig());
    expect(a.backend).toBe("paper");
    expect(assertPaperBackend(a)).toBeInstanceOf(PaperExecutionAdapter);
  });

  it("throws for TRADING_MODE=live: no live execution exists", () => {
    expect(() => createExecutionAdapter("live", paperConfig())).toThrow(
      LiveExecutionNotImplementedError,
    );
    expect(() => createExecutionAdapter("live", paperConfig())).toThrow(/TRADING_MODE=live/);
  });

  it("paper adapter is structurally incapable of venue calls", () => {
    const a = createExecutionAdapter("paper", paperConfig());
    // The public surface is exactly the port + the simulation driver.
    for (const method of ["submit", "cancel", "getOrder", "listOrders", "advanceClock"]) {
      expect(typeof (a as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    expect(a.backend).toBe("paper");
    // No network primitives or credential fields anywhere on the object.
    for (const key of ["fetch", "ws", "http", "socket", "client", "credentials", "apiKey"]) {
      expect(key in a).toBe(false);
    }
  });

  it("LiveExecutionAdapter type exists but no value can be constructed", () => {
    // Type-level: a LiveExecutionAdapter requires backend === "live".
    // Runtime: nothing in the package exports a constructor producing one.
    // The only adapter class in the package hard-codes backend = "paper".
    const a = new PaperExecutionAdapter(paperConfig());
    expect(a.backend).toBe("paper");
    expect(() => assertPaperBackend(a)).not.toThrow();
  });
});
