import { describe, expect, it } from "vitest";

import {
  InvalidTransitionError,
  ValidationError,
  applyFill,
  createPosition,
  millis,
  marketId,
  tokenId,
  decFromInt,
  decFromString,
  decToString,
  decZero,
  positionUnrealizedPnl,
  positionMarketValue,
  costBasis,
} from "./index.js";

const T0 = millis(1_700_000_000_000);

function makePosition() {
  return createPosition({
    id: "pos-000001",
    marketId: marketId("0xmarket123456"),
    tokenId: tokenId("1111111111"),
    outcome: "up",
    openedAt: T0,
  });
}

describe("position average-cost accounting", () => {
  it("accumulates weighted average price on buys", () => {
    let p = makePosition();
    p = applyFill(p, { side: "buy", price: decFromString("0.40"), qty: decFromInt(10) }, T0);
    p = applyFill(p, { side: "buy", price: decFromString("0.60"), qty: decFromInt(10) }, T0);
    expect(decToString(p.qty)).toBe("20.00000000");
    // avg = (10*0.4 + 10*0.6)/20 = 0.5
    expect(decToString(p.avgPrice)).toBe("0.50000000");
  });

  it("includes fees in the average cost", () => {
    let p = makePosition();
    p = applyFill(
      p,
      {
        side: "buy",
        price: decFromString("0.40"),
        qty: decFromInt(10),
        fee: decFromString("0.10"),
      },
      T0,
    );
    // avg = (10*0.4 + 0.1)/10 = 0.41
    expect(decToString(p.avgPrice)).toBe("0.41000000");
  });

  it("realizes PnL on sells and preserves avgPrice while open", () => {
    let p = makePosition();
    p = applyFill(p, { side: "buy", price: decFromString("0.40"), qty: decFromInt(10) }, T0);
    p = applyFill(p, { side: "sell", price: decFromString("0.70"), qty: decFromInt(4) }, T0);
    // realized = 4*0.7 - 4*0.4 = 1.2
    expect(decToString(p.realizedPnl)).toBe("1.20000000");
    expect(decToString(p.qty)).toBe("6.00000000");
    expect(decToString(p.avgPrice)).toBe("0.40000000");
  });

  it("closing the position resets avgPrice but keeps realized PnL", () => {
    let p = makePosition();
    p = applyFill(p, { side: "buy", price: decFromString("0.40"), qty: decFromInt(10) }, T0);
    p = applyFill(p, { side: "sell", price: decFromString("0.55"), qty: decFromInt(10) }, T0);
    expect(decToString(p.qty)).toBe("0.00000000");
    expect(decToString(p.avgPrice)).toBe("0.00000000");
    expect(decToString(p.realizedPnl)).toBe("1.50000000");
  });

  it("rejects overdraw sells and non-positive quantities", () => {
    const p = makePosition();
    expect(() =>
      applyFill(p, { side: "sell", price: decFromString("0.5"), qty: decFromInt(1) }, T0),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      applyFill(p, { side: "buy", price: decFromString("0.5"), qty: decZero() }, T0),
    ).toThrow(ValidationError);
  });

  it("computes unrealized PnL and market value at a mark", () => {
    let p = makePosition();
    p = applyFill(p, { side: "buy", price: decFromString("0.40"), qty: decFromInt(10) }, T0);
    expect(decToString(positionUnrealizedPnl(p, decFromString("0.5")))).toBe("1.00000000");
    expect(decToString(positionMarketValue(p, decFromString("0.5")))).toBe("5.00000000");
    expect(decToString(costBasis(p))).toBe("4.00000000");
    // flat position has zero unrealized PnL
    const flat = makePosition();
    expect(decToString(positionUnrealizedPnl(flat, decFromString("0.9")))).toBe("0.00000000");
  });

  it("is immutable: applyFill returns a new object", () => {
    const p0 = makePosition();
    const p1 = applyFill(p0, { side: "buy", price: decFromString("0.4"), qty: decFromInt(5) }, T0);
    expect(p0.qty).not.toBe(p1.qty);
    expect(decToString(p0.qty)).toBe("0.00000000");
  });
});
