import { describe, expect, it } from "vitest";

import { decCompare, decEquals, decFromString, decToString } from "@bot/domain";

import { edgeTargetResidual } from "./sizing.js";

const RATE = decFromString("0.07");
const KELLY = decFromString("0.25");
const MIN_EDGE = decFromString("0.01");
const MAX_RESIDUAL = decFromString("100");
const MAX_DIR = decFromString("50");

function size(input: Partial<Parameters<typeof edgeTargetResidual>[0]>) {
  return edgeTargetResidual({
    pUp: decFromString("0.6"),
    askUp: decFromString("0.5"),
    askDown: decFromString("0.5"),
    takerFeeRate: RATE,
    kellyFraction: KELLY,
    minEdge: MIN_EDGE,
    maxResidual: MAX_RESIDUAL,
    maxDirectionalShares: MAX_DIR,
    ...input,
  });
}

describe("edgeTargetResidual (T1)", () => {
  it("prices the edge net of fees: p 0.60 vs ask 0.50 -> edge 0.0825", () => {
    const r = size({});
    // fee(0.5)=0.0175; edge = 0.60 - 0.5175 = 0.0825 (matches domain test)
    expect(decToString(r.edgeUp)).toBe("0.08250000");
    expect(r.side).toBe("up");
    expect(decCompare(r.target, decFromString("0"))).toBeGreaterThan(0);
  });

  it("same signal at price 0.50 vs 0.90 gives different sizes (requirement)", () => {
    // p_up 0.6: edge at ask 0.50 = 0.0825 (tradeable); at ask 0.90 the Up edge
    // is deeply negative and the Down edge is (1-0.6) - (0.1+fee(0.1)) = 0.2655,
    // so both price regimes produce a position but on different sides/sizes.
    const at050 = size({ askUp: decFromString("0.5"), askDown: decFromString("0.5") });
    const at090 = size({ askUp: decFromString("0.9"), askDown: decFromString("0.1") });
    expect(at050.side).toBe("up");
    expect(at090.side).toBe("down");
    // A same-side check too: two asks on the Up side with the same signal.
    const a = size({ askUp: decFromString("0.4"), askDown: decFromString("0.61") });
    const b = size({ askUp: decFromString("0.45"), askDown: decFromString("0.61") });
    expect(a.side).toBe("up");
    expect(b.side).toBe("up");
    expect(decCompare(a.target, b.target)).toBeGreaterThan(0); // cheaper -> bigger
  });

  it("zero edge gives zero size", () => {
    // p 0.6 at ask 0.5825: fee(0.5825)=0.07*0.5825*0.4175=0.017005...; the
    // edge is exactly the fee-only boundary, so use a clean zero case:
    // p 0.535 vs ask 0.5: fee 0.0175, edge 0.0175 -> tradeable, so instead use
    // p = cost exactly: p 0.5175, ask 0.5 -> edge = 0.
    const r = size({ pUp: decFromString("0.5175"), askUp: decFromString("0.5") });
    expect(r.side).toBe("none");
    expect(decEquals(r.target, decFromString("0"))).toBe(true);
  });

  it("negative edge gives zero size", () => {
    // p 0.51 at ask 0.55: edge = 0.51 - (0.55 + 0.07*0.55*0.45) < 0
    const r = size({ pUp: decFromString("0.51"), askUp: decFromString("0.55") });
    expect(r.side).toBe("none");
    expect(decEquals(r.target, decFromString("0"))).toBe(true);
  });

  it("edge exactly at minEdge (<=) does not trade; above it does", () => {
    // cost at ask 0.5 = 0.5175; edge == minEdge (0.01) when p = 0.5275.
    const atMin = size({ pUp: decFromString("0.5275"), askUp: decFromString("0.5") });
    expect(atMin.side).toBe("none"); // edge <= minEdge -> no trade
    const justAbove = size({ pUp: decFromString("0.5276"), askUp: decFromString("0.5") });
    expect(justAbove.side).toBe("up");
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    const a = size({});
    const b = size({});
    expect(a).toEqual(b);
  });

  it("clamps to maxResidual and maxDirectionalShares", () => {
    // Huge Kelly share with a large fraction must not exceed the caps.
    const r = size({
      pUp: decFromString("0.95"),
      askUp: decFromString("0.5"),
      askDown: decFromString("0.5"),
      kellyFraction: decFromString("1"),
      maxResidual: decFromString("100"),
      maxDirectionalShares: decFromString("50"),
    });
    expect(decCompare(r.target, decFromString("50"))).toBeLessThanOrEqual(0);
    expect(decCompare(r.target, decFromString("0"))).toBeGreaterThanOrEqual(0);
    expect(decCompare(r.target, decFromString("25"))).toBeGreaterThan(0);
  });

  it("keeps the target within maxResidual when the caps are loose", () => {
    const r = size({ maxResidual: decFromString("10"), maxDirectionalShares: decFromString("50") });
    expect(decCompare(r.target, decFromString("10"))).toBeLessThanOrEqual(0);
    expect(decCompare(r.target, decFromString("0"))).toBeGreaterThan(0);
  });

  it("chooses the better side on the same book (Down when Up ask is dear)", () => {
    // p_up 0.3: edge_up at 0.5 is negative; edge_down = 0.7 - 0.5175 = 0.1825.
    const r = size({ pUp: decFromString("0.3") });
    expect(r.side).toBe("down");
    expect(decToString(r.edgeDown)).toBe("0.18250000");
  });

  it("rejects invalid inputs (fail closed)", () => {
    expect(() => size({ pUp: decFromString("1.2") })).toThrow(/pUp/);
    expect(() => size({ askUp: decFromString("0") })).toThrow(/askUp/);
    expect(() => size({ askDown: decFromString("1") })).toThrow(/askDown/);
    expect(() => size({ kellyFraction: decFromString("0") })).toThrow(/kellyFraction/);
    expect(() => size({ minEdge: decFromString("-0.01") })).toThrow(/minEdge/);
    expect(() => size({ maxResidual: decFromString("-1") })).toThrow(/maxResidual/);
  });
});
