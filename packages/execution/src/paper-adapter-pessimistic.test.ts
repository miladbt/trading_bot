import { describe, expect, it } from "vitest";

import { decFromString, decToString, millis, type Decimal } from "@bot/domain";

import { createSimulatedBook } from "./book.js";
import {
  DEFAULT_PESSIMISTIC_FILL_PARAMS,
  PaperExecutionAdapter,
  type ExecutionFill,
} from "./index.js";

const T0 = millis(1_800_000_000_000);
const d = (s: string): Decimal => decFromString(s);

const TOKEN = "tok-up";

function adapterWith(
  asks: readonly { price: string; qty: string }[],
  opts: {
    fillModel?: "optimistic" | "pessimistic";
    pessimistic?: {
      tradeThrough?: string;
      queuePositionFactor?: string;
      adverseMoveThreshold?: string;
    };
    bids?: readonly { price: string; qty: string }[];
  } = {},
): PaperExecutionAdapter {
  return new PaperExecutionAdapter({
    tokens: [
      {
        tokenId: TOKEN,
        book: createSimulatedBook(
          asks.map((a) => ({ price: d(a.price), qty: d(a.qty) })),
          (opts.bids ?? []).map((b) => ({ price: d(b.price), qty: d(b.qty) })),
        ),
      },
    ],
    fillModel: opts.fillModel,
    ...(opts.pessimistic === undefined
      ? {}
      : {
          pessimistic: {
            ...(opts.pessimistic.tradeThrough === undefined
              ? {}
              : { tradeThrough: d(opts.pessimistic.tradeThrough) }),
            ...(opts.pessimistic.queuePositionFactor === undefined
              ? {}
              : { queuePositionFactor: d(opts.pessimistic.queuePositionFactor) }),
            ...(opts.pessimistic.adverseMoveThreshold === undefined
              ? {}
              : { adverseMoveThreshold: d(opts.pessimistic.adverseMoveThreshold) }),
          },
        }),
  });
}

function submitBuy(adapter: PaperExecutionAdapter, price: string, qty = "100", at = T0): string {
  const result = adapter.submit({
    clientOrderId: `o-${price}-${String(at)}-${Math.random().toString(36).slice(2, 8)}`,
    marketId: "m1",
    tokenId: TOKEN,
    outcome: "up",
    side: "buy",
    kind: "limit",
    price: d(price),
    qty: d(qty),
    at,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.clientOrderId;
}

function filledQty(adapter: PaperExecutionAdapter, id: string): Decimal {
  const order = adapter.getOrder(id);
  return order?.filledQty ?? d("0");
}

function advance(adapter: PaperExecutionAdapter, at: number): readonly ExecutionFill[] {
  return adapter.advanceClock(millis(at));
}

describe("pessimistic fill model (T4)", () => {
  it("optimistic model (default) fills on touch — legacy behavior unchanged", () => {
    const adapter = adapterWith([{ price: "0.50", qty: "100" }], { fillModel: "optimistic" });
    const id = submitBuy(adapter, "0.50");
    advance(adapter, T0 + 1000);
    expect(decToString(filledQty(adapter, id))).toBe("100.00000000");
  });

  it("pessimistic model does NOT fill when the market merely touches the price", () => {
    const adapter = adapterWith([{ price: "0.50", qty: "100" }], { fillModel: "pessimistic" });
    const id = submitBuy(adapter, "0.50");
    advance(adapter, T0 + 1000);
    // Best ask == order price (touch): no trade-through, no fill.
    expect(decToString(filledQty(adapter, id))).toBe("0.00000000");
  });

  it("fills when the ask trades THROUGH the order price by one tick", () => {
    const adapter = adapterWith([{ price: "0.50", qty: "100" }], { fillModel: "pessimistic" });
    const id = submitBuy(adapter, "0.50");
    // Ask drops a tick below our price: 0.50 - 0.001 = 0.499 trade-through.
    adapter.setBook(TOKEN, createSimulatedBook([{ price: d("0.499"), qty: d("100") }]));
    advance(adapter, T0 + 1000);
    expect(Number(filledQty(adapter, id).toString()) > 0).toBe(true);
  });

  it("scales fills by the queue-position factor (truncated)", () => {
    const adapter = adapterWith([{ price: "0.499", qty: "100" }], {
      fillModel: "pessimistic",
      pessimistic: { queuePositionFactor: "0.25" },
    });
    const id = submitBuy(adapter, "0.50");
    advance(adapter, T0 + 1000);
    // min(remaining 100, level 100) x 0.25 = 25.
    expect(decToString(filledQty(adapter, id))).toBe("25.00000000");
  });

  it("never claims more than the level offers across repeated events", () => {
    const adapter = adapterWith([{ price: "0.499", qty: "30" }], {
      fillModel: "pessimistic",
      pessimistic: { queuePositionFactor: "0.5" },
    });
    const id = submitBuy(adapter, "0.50", "500");
    advance(adapter, T0 + 1000);
    advance(adapter, T0 + 2000);
    // Event 1: min(500, 30) x 0.5 = 15. Event 2: min(485, 15) x 0.5 = 7.5.
    // The queue factor applies to what remains each event; the level's
    // unconsumed size is never exceeded (28.5 < 30).
    expect(decToString(filledQty(adapter, id))).toBe("22.50000000");
  });

  it("applies adverse selection: a mid moving against the resting order relaxes touch back to a fill", () => {
    // Initially mid = (0.51 + 0.55)/2 = 0.53.
    const adapter = adapterWith([{ price: "0.55", qty: "100" }], {
      fillModel: "pessimistic",
      pessimistic: { adverseMoveThreshold: "0.01" },
      bids: [{ price: "0.51", qty: "100" }],
    });
    const id = submitBuy(adapter, "0.55");
    advance(adapter, T0 + 1000);
    // Touch only: no fill yet.
    expect(decToString(filledQty(adapter, id))).toBe("0.00000000");
    // Mid moves DOWN (against a buy) to 0.53 - 0.02 = 0.51: ask 0.55, bid 0.47.
    adapter.setBook(
      TOKEN,
      createSimulatedBook(
        [{ price: d("0.55"), qty: d("100") }],
        [{ price: d("0.47"), qty: d("100") }],
      ),
    );
    advance(adapter, T0 + 2000);
    // Adverse drift >= threshold: the sweep reaches us at touch, scaled by
    // the default queue factor 0.5.
    expect(decToString(filledQty(adapter, id))).toBe("50.00000000");
  });

  it("keeps cancel races: a cancel completing this tick beats same-tick fills; an earlier completed fill beats the cancel", () => {
    const adapter = new PaperExecutionAdapter({
      tokens: [
        { tokenId: TOKEN, book: createSimulatedBook([{ price: d("0.499"), qty: d("100") }]) },
      ],
      fillModel: "pessimistic",
      cancelLatencyMs: 500,
    });
    const id = submitBuy(adapter, "0.50", "100");
    adapter.cancel(id, T0);
    // Cancel latency elapsed before any fill event: CANCELLED wins.
    advance(adapter, T0 + 1000);
    expect(adapter.getOrder(id)?.status).toBe("CANCELLED");
    // A fill in an earlier tick than the cancel-completion beats it instead
    // (the CANCEL_REQUESTED -> FILLED transition in lifecycle.ts).
    const adapter2 = new PaperExecutionAdapter({
      tokens: [
        { tokenId: TOKEN, book: createSimulatedBook([{ price: d("0.499"), qty: d("100") }]) },
      ],
      fillModel: "pessimistic",
      cancelLatencyMs: 500,
      pessimistic: { queuePositionFactor: d("1") },
    });
    const id2 = submitBuy(adapter2, "0.50", "100");
    adapter2.cancel(id2, T0);
    // Fill event BEFORE the cancel completes (100 < 500): full fill wins.
    void adapter2.advanceClock(millis(Number(T0) + 100));
    expect(adapter2.getOrder(id2)?.status).toBe("FILLED");
    expect(adapter2.cancel(id2, millis(Number(T0) + 200)).ok).toBe(false);
  });

  it("setBook moves the market deterministically between ticks", () => {
    const adapter = adapterWith([{ price: "0.50", qty: "100" }], {
      fillModel: "pessimistic",
      pessimistic: { queuePositionFactor: "1" },
    });
    const id = submitBuy(adapter, "0.50");
    advance(adapter, T0 + 1000);
    adapter.setBook(
      TOKEN,
      createSimulatedBook([
        { price: d("0.49"), qty: d("50") },
        { price: d("0.499"), qty: d("50") },
      ]),
    );
    advance(adapter, T0 + 2000);
    // One fill event per tick, best (0.49) first: 50 now.
    expect(decToString(filledQty(adapter, id))).toBe("50.00000000");
    advance(adapter, T0 + 3000);
    expect(decToString(filledQty(adapter, id))).toBe("100.00000000");
  });

  it("defaults match the documented parameter set", () => {
    expect(decToString(DEFAULT_PESSIMISTIC_FILL_PARAMS.tradeThrough)).toBe("0.00100000");
    expect(decToString(DEFAULT_PESSIMISTIC_FILL_PARAMS.queuePositionFactor)).toBe("0.50000000");
    expect(decToString(DEFAULT_PESSIMISTIC_FILL_PARAMS.adverseMoveThreshold)).toBe("0.01000000");
  });

  it("rejects out-of-range pessimistic parameters", () => {
    expect(
      () =>
        new PaperExecutionAdapter({
          tokens: [
            { tokenId: TOKEN, book: createSimulatedBook([{ price: d("0.5"), qty: d("1") }]) },
          ],
          fillModel: "pessimistic",
          pessimistic: { queuePositionFactor: d("0") },
        }),
    ).toThrow(/queuePositionFactor/);
    expect(
      () =>
        new PaperExecutionAdapter({
          tokens: [
            { tokenId: TOKEN, book: createSimulatedBook([{ price: d("0.5"), qty: d("1") }]) },
          ],
          fillModel: "pessimistic",
          pessimistic: { tradeThrough: d("1.5") },
        }),
    ).toThrow(/tradeThrough/);
    expect(
      () =>
        new PaperExecutionAdapter({
          tokens: [
            { tokenId: TOKEN, book: createSimulatedBook([{ price: d("0.5"), qty: d("1") }]) },
          ],
          fillModel: "pessimistic",
          pessimistic: { adverseMoveThreshold: d("-0.01") },
        }),
    ).toThrow(/adverseMoveThreshold/);
  });

  it("setBook on an unknown token throws (harness bug, not a market condition)", () => {
    const adapter = adapterWith([{ price: "0.5", qty: "1" }]);
    expect(() =>
      adapter.setBook("unknown-token", createSimulatedBook([{ price: d("0.5"), qty: d("1") }])),
    ).toThrow(/unknown token/);
  });

  it("prefers adverse-relaxed fills in moneyness order and never fills better-than-touch through relaxation alone", () => {
    // Relaxation only relaxes the trade-through requirement of levels the
    // order already crosses at touch; it must not fill levels BEYOND the
    // order price (which the crossing check still forbids).
    const adapter = adapterWith([{ price: "0.60", qty: "100" }], {
      fillModel: "pessimistic",
      pessimistic: { adverseMoveThreshold: "0.01" },
      bids: [{ price: "0.50", qty: "100" }],
    });
    const id = submitBuy(adapter, "0.55");
    advance(adapter, T0 + 1000);
    expect(decToString(filledQty(adapter, id))).toBe("0.00000000");
    // Mid falls hard (0.55 -> 0.55): ask 0.60, bid 0.50, mid 0.55 = unchanged... construct an adverse move:
    adapter.setBook(
      TOKEN,
      createSimulatedBook(
        [{ price: d("0.60"), qty: d("100") }],
        [{ price: d("0.44"), qty: d("100") }],
      ),
    );
    advance(adapter, T0 + 2000);
    // Mid = 0.52, buy suffered 0.03 >= 0.01, but the ask (0.60) is still
    // beyond our 0.55 cap: crossing still forbids the fill.
    expect(decToString(filledQty(adapter, id))).toBe("0.00000000");
  });
});
