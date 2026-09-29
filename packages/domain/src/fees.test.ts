import { describe, expect, it } from "vitest";

import { decCompare, decFromString, decToString } from "./decimal.js";
import {
  edgeNetOfTakerFee,
  takerFeePerShare,
  takerFeeQty,
  DEFAULT_CRYPTO_TAKER_FEE_RATE,
} from "./fees.js";

const RATE = decFromString(DEFAULT_CRYPTO_TAKER_FEE_RATE); // 0.07 (docs, crypto)

describe("taker fee model (verified schedule: fee = C x rate x p x (1-p))", () => {
  it("matches the official 100-share crypto table value at p=0.50 ($1.75)", () => {
    // docs.polymarket.com/trading/fees (retrieved 2026-09-29):
    // 100 shares at $0.50 -> $1.75 taker fee (crypto, rate 0.07).
    const fee = takerFeeQty(decFromString("100"), decFromString("0.5"), RATE);
    expect(decToString(fee)).toBe("1.75000000");
  });

  it("matches the table at p=0.30 ($1.47 for 100 shares)", () => {
    const fee = takerFeeQty(decFromString("100"), decFromString("0.3"), RATE);
    // 100 * 0.07 * 0.3 * 0.7 = 1.47
    expect(decToString(fee)).toBe("1.47000000");
  });

  it("per-share fee at 0.50 is 0.0175", () => {
    expect(decToString(takerFeePerShare(decFromString("0.5"), RATE))).toBe("0.01750000");
  });

  it("is symmetric around 0.50 (30c and 70c cost the same fee, per docs)", () => {
    const a = takerFeePerShare(decFromString("0.3"), RATE);
    const b = takerFeePerShare(decFromString("0.7"), RATE);
    expect(decCompare(a, b)).toBe(0);
  });

  it("charges makers nothing: rate 0 gives zero fee", () => {
    const fee = takerFeeQty(decFromString("100"), decFromString("0.5"), decFromString("0"));
    expect(decToString(fee)).toBe("0.00000000");
  });

  it("rejects prices outside (0, 1) and negative rates/qty", () => {
    expect(() => takerFeePerShare(decFromString("0"), RATE)).toThrow();
    expect(() => takerFeePerShare(decFromString("1"), RATE)).toThrow();
    expect(() => takerFeePerShare(decFromString("0.5"), decFromString("-0.01"))).toThrow();
    expect(() => takerFeeQty(decFromString("-1"), decFromString("0.5"), RATE)).toThrow();
  });

  it("edgeNetOfTakerFee = pWin - (ask + fee)", () => {
    // pWin 0.60, ask 0.50: fee 0.0175, edge = 0.60 - 0.5175 = 0.0825
    const edge = edgeNetOfTakerFee(decFromString("0.6"), decFromString("0.5"), RATE);
    expect(decToString(edge)).toBe("0.08250000");
  });

  it("edgeNetOfTakerFee can be negative (fee makes a marginal edge unprofitable)", () => {
    // pWin 0.51, ask 0.50: edge = 0.51 - 0.5175 = -0.0075
    const edge = edgeNetOfTakerFee(decFromString("0.51"), decFromString("0.5"), RATE);
    expect(decCompare(edge, decFromString("0"))).toBeLessThan(0);
  });
});
