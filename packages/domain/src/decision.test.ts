import { describe, expect, it } from "vitest";

import {
  ValidationError,
  createRiskDecision,
  createSignal,
  createTradingDecision,
  decisionNotional,
  decFromInt,
  decFromString,
  decToString,
  decZero,
  marketId,
  millis,
  rejectTradingDecision,
  signalEdge,
  tokenId,
} from "./index.js";

const T0 = millis(1_700_000_000_000);
const M = marketId("0xmarket123456");
const UP = tokenId("1111111111");

function makeSignal() {
  return createSignal({
    reason: "orderbook_imbalance",
    marketId: M,
    tokenId: UP,
    outcome: "up",
    side: "buy",
    confidence: decFromString("0.62"),
    fairValue: decFromString("0.55"),
    at: T0,
  });
}

describe("signal", () => {
  it("computes edge for buys and sells", () => {
    const s = makeSignal();
    // buy edge = 0.55 - 0.45 = 0.10
    expect(decToString(signalEdge(s, decFromString("0.45")))).toBe("0.10000000");
    const sell = createSignal({ ...s, side: "sell" });
    // sell edge = 0.45 - 0.55 = -0.10
    expect(decToString(signalEdge(sell, decFromString("0.45")))).toBe("-0.10000000");
  });

  it("validates confidence and fairValue ranges", () => {
    expect(() =>
      createSignal({
        ...makeSignal(),
        confidence: decFromString("1.5"),
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createSignal({
        ...makeSignal(),
        fairValue: decZero(),
      }),
    ).toThrow(ValidationError);
  });
});

describe("risk decision", () => {
  it("rejects must approve zero; approves must be positive", () => {
    expect(() =>
      createRiskDecision({
        verdict: "reject",
        signal: makeSignal(),
        approvedQty: decFromInt(5),
        approvedPrice: decFromString("0.45"),
        rule: "max_order_usd",
        explanation: "too big",
        at: T0,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createRiskDecision({
        verdict: "approve",
        signal: makeSignal(),
        approvedQty: decZero(),
        approvedPrice: decFromString("0.45"),
        rule: "sizing",
        explanation: "zero",
        at: T0,
      }),
    ).toThrow(ValidationError);
  });

  it("carries the signal for the audit trail", () => {
    const rd = createRiskDecision({
      verdict: "approve",
      signal: makeSignal(),
      approvedQty: decFromInt(10),
      approvedPrice: decFromString("0.45"),
      rule: "default",
      explanation: "ok",
      at: T0,
    });
    expect(rd.signal.tokenId).toBe(UP);
    expect(rd.verdict).toBe("approve");
  });
});

describe("trading decision", () => {
  it("reject decisions carry no order", () => {
    const rd = createRiskDecision({
      verdict: "reject",
      signal: makeSignal(),
      approvedQty: decZero(),
      approvedPrice: decZero(),
      rule: "max_order_usd",
      explanation: "too big",
      at: T0,
    });
    const td = rejectTradingDecision(rd, T0);
    expect(td.order).toBeUndefined();
    expect(decToString(decisionNotional(td))).toBe("0.00000000");
  });

  it("approve decisions carry a consistent order", () => {
    const rd = createRiskDecision({
      verdict: "approve",
      signal: makeSignal(),
      approvedQty: decFromInt(10),
      approvedPrice: decFromString("0.45"),
      rule: "default",
      explanation: "ok",
      at: T0,
    });
    const td = createTradingDecision({
      order: {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        kind: "limit",
        price: decFromString("0.45"),
        qty: decFromInt(10),
      },
      risk: rd,
      decidedAt: T0,
    });
    // notional = 0.45 * 10 = 4.5
    expect(decToString(decisionNotional(td))).toBe("4.50000000");
  });

  it("enforces order/verdict consistency", () => {
    const approve = createRiskDecision({
      verdict: "approve",
      signal: makeSignal(),
      approvedQty: decFromInt(10),
      approvedPrice: decFromString("0.45"),
      rule: "default",
      explanation: "ok",
      at: T0,
    });
    expect(() => createTradingDecision({ order: undefined, risk: approve, decidedAt: T0 })).toThrow(
      ValidationError,
    );

    const reject = createRiskDecision({
      verdict: "reject",
      signal: makeSignal(),
      approvedQty: decZero(),
      approvedPrice: decZero(),
      rule: "r",
      explanation: "no",
      at: T0,
    });
    expect(() =>
      createTradingDecision({
        order: {
          marketId: M,
          tokenId: UP,
          outcome: "up",
          side: "buy",
          kind: "limit",
          price: decFromString("0.45"),
          qty: decFromInt(1),
        },
        risk: reject,
        decidedAt: T0,
      }),
    ).toThrow(ValidationError);
  });
});
