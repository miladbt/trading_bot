import { describe, expect, it } from "vitest";

import {
  ValidationError,
  createCompleteSet,
  decZero,
  createEquitySnapshot,
  createPnL,
  decFromInt,
  decFromString,
  decToString,
  drawdown,
  emptyPnL,
  grossPnL,
  isMergeArb,
  isMintArb,
  marketId,
  mergeProfit,
  millis,
  mintProfit,
  netPnL,
  addPnL,
  setCost,
  setPayoutAtSettlement,
  updateHighWaterMark,
} from "./index.js";

const T0 = millis(1_700_000_000_000);
const M = marketId("0xmarket123456");

function makeSet(upPrice: string, downPrice: string) {
  return createCompleteSet({
    marketId: M,
    upTokenId: "1111111111",
    upPrice: decFromString(upPrice),
    downTokenId: "2222222222",
    downPrice: decFromString(downPrice),
  });
}

describe("complete sets", () => {
  it("costs the sum of both legs", () => {
    const s = makeSet("0.45", "0.55");
    expect(decToString(setCost(s))).toBe("1.00000000");
  });

  it("detects merge arbitrage when both asks cost less than 1", () => {
    const s = makeSet("0.40", "0.50");
    // profit = 1 - 0.90 = 0.10
    expect(decToString(mergeProfit(s))).toBe("0.10000000");
    expect(isMergeArb(s, decFromString("0.05"))).toBe(true);
    expect(isMergeArb(s, decFromString("0.10"))).toBe(false);
  });

  it("detects mint arbitrage when both bids total more than 1", () => {
    const s = makeSet("0.55", "0.55");
    // profit = 1.10 - 1 = 0.10
    expect(decToString(mintProfit(s))).toBe("0.10000000");
    expect(isMintArb(s, decFromString("0.05"))).toBe(true);
    expect(isMintArb(s, decFromString("0.10"))).toBe(false);
  });

  it("pays 1 per winning share and 0 for the loser at settlement", () => {
    const s = makeSet("0.45", "0.55");
    expect(decToString(setPayoutAtSettlement(s, "up", decFromInt(10)))).toBe("10.00000000");
    expect(decToString(setPayoutAtSettlement(s, "down", decFromInt(10)))).toBe("0.00000000");
  });

  it("rejects non-positive leg prices", () => {
    expect(() => makeSet("0", "0.5")).toThrow(ValidationError);
    expect(() => makeSet("0.5", "-0.1")).toThrow(ValidationError);
  });
});

describe("pnl", () => {
  it("composes net and gross views", () => {
    const p = createPnL({
      realized: decFromString("1.5"),
      unrealized: decFromString("-0.25"),
      fees: decFromString("0.1"),
    });
    expect(decToString(netPnL(p))).toBe("1.25000000");
    expect(decToString(grossPnL(p))).toBe("1.35000000");
  });

  it("adds and empties", () => {
    const a = createPnL({
      realized: decFromInt(1),
      unrealized: decZero(),
      fees: decFromString("0.05"),
    });
    const total = addPnL(addPnL(emptyPnL(), a), a);
    expect(decToString(total.realized)).toBe("2.00000000");
    expect(decToString(total.fees)).toBe("0.10000000");
  });

  it("tracks drawdown against a high-water mark", () => {
    const snap = createEquitySnapshot({
      at: T0,
      cash: decFromInt(90),
      positionsValue: decFromInt(5),
      pnl: emptyPnL(),
    });
    expect(decToString(snap.equity)).toBe("95.00000000");
    // hwm 100 -> dd = -5
    expect(decToString(drawdown(snap, decFromInt(100)))).toBe("-5.00000000");
    // hwm 90 -> dd = 0 (above the mark)
    expect(decToString(drawdown(snap, decFromInt(90)))).toBe("0.00000000");
    expect(decToString(updateHighWaterMark(decFromInt(90), snap))).toBe("95.00000000");
    expect(() => drawdown(snap, decZero())).toThrow(ValidationError);
  });
});
