import { describe, expect, it } from "vitest";

import {
  DecimalParseError,
  SCALE_FACTOR,
  decAbs,
  decAdd,
  decCompare,
  decDivMod,
  decDivRound,
  decDivTrunc,
  decEquals,
  decFromInt,
  decFromNumber,
  decFromString,
  decIsZero,
  decMulRound,
  decMulTrunc,
  decNeg,
  decOne,
  decSub,
  decToString,
  decZero,
} from "./decimal.js";

describe("decFromString", () => {
  it("parses plain decimals", () => {
    expect(decToString(decFromString("0.1"))).toBe("0.10000000");
    expect(decToString(decFromString("-12.5"))).toBe("-12.50000000");
    expect(decToString(decFromString("123"))).toBe("123.00000000");
    expect(decToString(decFromString("0.00000001"))).toBe("0.00000001");
    expect(decToString(decFromString("999999999.99999999"))).toBe("999999999.99999999");
  });

  it("parses exponents", () => {
    expect(decToString(decFromString("1e3"))).toBe("1000.00000000");
    expect(decToString(decFromString("1.5e-2"))).toBe("0.01500000");
    expect(decToString(decFromString("-2E2"))).toBe("-200.00000000");
  });

  it("rounds half-up when more than 8 decimals are supplied", () => {
    expect(decToString(decFromString("0.123456785"))).toBe("0.12345679");
    expect(decToString(decFromString("0.123456784"))).toBe("0.12345678");
  });

  it("rejects garbage", () => {
    expect(() => decFromString("")).toThrow(DecimalParseError);
    expect(() => decFromString("abc")).toThrow(DecimalParseError);
    expect(() => decFromString("1.2.3")).toThrow(DecimalParseError);
    expect(() => decFromString("1,5")).toThrow(DecimalParseError);
    expect(() => decFromString("0.1234567890123")).toThrow(DecimalParseError);
  });
});

describe("exact arithmetic", () => {
  it("adds and subtracts without float error", () => {
    const a = decFromString("0.1");
    const b = decFromString("0.2");
    expect(decToString(decAdd(a, b))).toBe("0.30000000");
    expect(decToString(decSub(decFromString("1"), decFromString("0.00000001")))).toBe("0.99999999");
  });

  it("multiplies exactly when representable", () => {
    // 0.5 * 0.5 = 0.25
    expect(decToString(decMulTrunc(decFromString("0.5"), decFromString("0.5")))).toBe("0.25000000");
    // 10 shares * 0.37 price = 3.7 USDC
    expect(decToString(decMulTrunc(decFromInt(10), decFromString("0.37")))).toBe("3.70000000");
  });

  it("rounds multiplication half-away-from-zero", () => {
    // 0.00000003 * 0.5 = 0.000000015 -> rounds to 0.00000002
    expect(decToString(decMulRound(decFromString("0.00000003"), decFromString("0.5")))).toBe(
      "0.00000002",
    );
    // negative case mirrors
    expect(decToString(decMulRound(decFromString("-0.00000003"), decFromString("0.5")))).toBe(
      "-0.00000002",
    );
  });

  it("divides with re-scaling (the core invariant)", () => {
    // 1 / 3 = 0.33333333 (truncated)
    expect(decToString(decDivTrunc(decOne(), decFromInt(3)))).toBe("0.33333333");
    // 2 / 3 = 0.66666667 (rounded)
    expect(decToString(decDivRound(decFromInt(2), decFromInt(3)))).toBe("0.66666667");
    // 10 / 4 = 2.5 exactly
    expect(decToString(decDivTrunc(decFromInt(10), decFromInt(4)))).toBe("2.50000000");
    // -1 / 3 truncates toward zero
    expect(decToString(decDivTrunc(decFromString("-1"), decFromInt(3)))).toBe("-0.33333333");
    // -1 / 3 rounded half away from zero
    expect(decToString(decDivRound(decFromString("-1"), decFromInt(3)))).toBe("-0.33333333");
  });

  it("decDivMod returns quotient and remainder consistently", () => {
    const { quotient, remainder } = decDivMod(decFromInt(10), decFromInt(4));
    expect(decToString(quotient)).toBe("2.50000000");
    expect(decEquals(remainder, decZero())).toBe(true);

    const r2 = decDivMod(decOne(), decFromInt(3));
    expect(decToString(r2.quotient)).toBe("0.33333333");
    // remainder is non-zero: 1 - 3*0.33333333 = 0.00000001
    const reconstructed = decAdd(decMulTrunc(decFromInt(3), r2.quotient), r2.remainder);
    expect(decEquals(reconstructed, decOne())).toBe(true);
  });

  it("throws on division by zero", () => {
    expect(() => decDivTrunc(decOne(), decZero())).toThrow(DecimalParseError);
    expect(() => decDivRound(decOne(), decZero())).toThrow(DecimalParseError);
  });

  it("compares and predicates correctly", () => {
    expect(decCompare(decFromString("0.5"), decFromString("0.50000000"))).toBe(0);
    expect(decCompare(decFromString("-1"), decZero())).toBe(-1);
    expect(decIsZero(decZero())).toBe(true);
    expect(decEquals(decAdd(decFromString("0.3"), decFromString("0.7")), decOne())).toBe(true);
    expect(decToString(decAbs(decFromString("-3.5")))).toBe("3.50000000");
    expect(decToString(decNeg(decOne()))).toBe("-1.00000000");
  });

  it("decFromNumber is exact for representable values", () => {
    expect(decToString(decFromNumber(0.5))).toBe("0.50000000");
    expect(decToString(decFromNumber(-2.25))).toBe("-2.25000000");
    expect(() => decFromNumber(Number.NaN)).toThrow(DecimalParseError);
    expect(() => decFromNumber(Number.POSITIVE_INFINITY)).toThrow(DecimalParseError);
  });

  it("never loses precision on repeated operations (float regression test)", () => {
    // 0.1 + 0.2 + 0.3 must be exactly 0.60000000, unlike JS floats
    let acc = decZero();
    for (const s of ["0.1", "0.2", "0.3"]) {
      acc = decAdd(acc, decFromString(s));
    }
    expect(decToString(acc)).toBe("0.60000000");
  });

  it("keeps the documented scale factor", () => {
    expect(SCALE_FACTOR).toBe(100_000_000n);
  });
});
