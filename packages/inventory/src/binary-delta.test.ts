import { describe, expect, it } from "vitest";

import {
  binaryDeltaNotionalUsdc,
  binaryDeltaTerms,
  binaryUpDelta,
  binaryUpProbability,
  erf,
  normalCdf,
  normalPdf,
} from "./binary-delta.js";

// Reference values computed with standard normal tables / erfc.

describe("erf / normalCdf / normalPdf", () => {
  it("matches known erf values", () => {
    expect(erf(0)).toBeCloseTo(0, 8); // A&S approximation carries ~1e-9 bias at 0
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427007929, 6);
    expect(erf(0.5)).toBeCloseTo(0.5204998778, 6);
    expect(erf(3)).toBeCloseTo(0.9999779095, 6);
  });

  it("matches known normal CDF values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8); // ~5e-10 erf bias at 0
    expect(normalCdf(1)).toBeCloseTo(0.8413447461, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249978951, 5);
    expect(normalCdf(4)).toBeCloseTo(0.9999683288, 6);
  });

  it("has a pdf integrating to the right shape (peak at 0, symmetric)", () => {
    expect(normalPdf(0)).toBeCloseTo(0.3989422804, 10);
    expect(normalPdf(1)).toBeCloseTo(normalPdf(-1), 14);
    expect(normalPdf(2)).toBeLessThan(normalPdf(1));
  });
});

describe("binaryDeltaTerms", () => {
  it("derives d2 from spot, strike, vol, and time", () => {
    // 5 minutes to expiry, 60% annualized vol, at-the-money.
    const terms = binaryDeltaTerms({
      spot: 100_000,
      strike: 100_000,
      annualizedVol: 0.6,
      msToExpiry: 150_000,
    });
    expect(terms.yearsToExpiry).toBeCloseTo(150_000 / 31_557_600_000, 15);
    expect(terms.d2).toBeCloseTo(
      (-0.5 * 0.6 ** 2 * terms.yearsToExpiry) / (0.6 * Math.sqrt(terms.yearsToExpiry)),
      12,
    );
  });

  it("is symmetric in the log-moneyness sense: S below K gives negative d2", () => {
    const above = binaryDeltaTerms({
      spot: 101_000,
      strike: 100_000,
      annualizedVol: 0.6,
      msToExpiry: 150_000,
    });
    const below = binaryDeltaTerms({
      spot: 99_000,
      strike: 100_000,
      annualizedVol: 0.6,
      msToExpiry: 150_000,
    });
    expect(above.d2).toBeGreaterThan(below.d2);
  });

  it("rejects invalid inputs", () => {
    expect(() =>
      binaryDeltaTerms({ spot: 0, strike: 1, annualizedVol: 0.6, msToExpiry: 1000 }),
    ).toThrow(/spot/);
    expect(() =>
      binaryDeltaTerms({ spot: 1, strike: -1, annualizedVol: 0.6, msToExpiry: 1000 }),
    ).toThrow(/strike/);
    expect(() =>
      binaryDeltaTerms({ spot: 1, strike: 1, annualizedVol: 0, msToExpiry: 1000 }),
    ).toThrow(/annualizedVol/);
    expect(() =>
      binaryDeltaTerms({ spot: 1, strike: 1, annualizedVol: 0.6, msToExpiry: -5 }),
    ).toThrow(/msToExpiry/);
    expect(() =>
      binaryDeltaTerms({ spot: 1, strike: 1, annualizedVol: 0.6, msToExpiry: Number.NaN }),
    ).toThrow(/msToExpiry/);
  });
});

describe("binaryUpProbability", () => {
  it("is ~0.5 at-the-money and monotone in spot", () => {
    const base = { strike: 100_000, annualizedVol: 0.6, msToExpiry: 150_000 };
    const atm = binaryUpProbability({ ...base, spot: 100_000 });
    expect(atm).toBeGreaterThan(0.45);
    expect(atm).toBeLessThan(0.55);
    const up = binaryUpProbability({ ...base, spot: 100_500 });
    const down = binaryUpProbability({ ...base, spot: 99_500 });
    expect(up).toBeGreaterThan(atm);
    expect(down).toBeLessThan(atm);
  });

  it("saturates to 1/0 deep in/out of the money", () => {
    const base = { strike: 100_000, annualizedVol: 0.6, msToExpiry: 150_000 };
    expect(binaryUpProbability({ ...base, spot: 105_000 })).toBeGreaterThan(0.99);
    expect(binaryUpProbability({ ...base, spot: 95_000 })).toBeLessThan(0.01);
  });

  it("is deterministic at expiry away from the strike (settled step)", () => {
    const base = { strike: 100_000, annualizedVol: 0.6 };
    expect(binaryUpProbability({ ...base, spot: 101_000, msToExpiry: 0 })).toBe(1);
    expect(binaryUpProbability({ ...base, spot: 99_000, msToExpiry: 0 })).toBe(0);
    expect(binaryUpProbability({ ...base, spot: 100_000, msToExpiry: 0 })).toBe(0.5);
  });
});

describe("binaryUpDelta — the T6 model", () => {
  const base = { strike: 100_000, annualizedVol: 0.6, msToExpiry: 150_000 };

  it("peaks near the money and decays to ~0 in both tails", () => {
    const deepItm = binaryUpDelta({ ...base, spot: 106_000 });
    const nearTheMoney = binaryUpDelta({ ...base, spot: 100_200 });
    const deepOtm = binaryUpDelta({ ...base, spot: 94_000 });
    expect(nearTheMoney).toBeGreaterThan(deepItm);
    expect(nearTheMoney).toBeGreaterThan(deepOtm);
    expect(deepOtm).toBeLessThan(1e-4);
    expect(deepItm).toBeLessThan(nearTheMoney);
  });

  it("spikes as expiry approaches (1/sqrt(T) growth at the money)", () => {
    const early = binaryUpDelta({ ...base, spot: 100_000, msToExpiry: 240_000 });
    const late = binaryUpDelta({ ...base, spot: 100_000, msToExpiry: 30_000 });
    const final = binaryUpDelta({ ...base, spot: 100_000, msToExpiry: 5_000 });
    expect(late).toBeGreaterThan(early);
    expect(final).toBeGreaterThan(late);
    // sqrt(240/5) = ~6.9x growth from 4 minutes out to 5 seconds out.
    expect(final / early).toBeGreaterThan(5);
    expect(final / early).toBeLessThan(9);
  });

  it("is zero at expiry (settled — nothing left to hedge)", () => {
    expect(binaryUpDelta({ ...base, spot: 100_000, msToExpiry: 0 })).toBe(0);
    expect(binaryDeltaNotionalUsdc({ ...base, spot: 100_000, msToExpiry: 0, shares: 500 })).toBe(0);
  });

  it("does not explode for tiny-but-nonzero time to expiry at sane strikes", () => {
    const delta = binaryUpDelta({ ...base, spot: 100_050, msToExpiry: 1_000 });
    expect(Number.isFinite(delta)).toBe(true);
    expect(delta).toBeGreaterThan(0);
  });
});

describe("binaryDeltaNotionalUsdc", () => {
  const base = { strike: 100_000, annualizedVol: 0.6 };

  it("equals |shares| x phi(d2) / (sigma sqrt(T)) and scales linearly in shares", () => {
    const input = { ...base, spot: 100_000, msToExpiry: 150_000 };
    const one = binaryDeltaNotionalUsdc({ ...input, shares: 1 });
    const fiveHundred = binaryDeltaNotionalUsdc({ ...input, shares: 500 });
    expect(fiveHundred).toBeCloseTo(500 * one, 8);
    // Manual check with the model's own d2 (slightly negative at the money
    // because of the -0.5 sigma^2 T drift term).
    const terms = binaryDeltaTerms(input);
    expect(one).toBeCloseTo(normalPdf(terms.d2) / (0.6 * Math.sqrt(terms.yearsToExpiry)), 6);
  });

  it("grows toward expiry at the money (pin risk becomes expensive to hedge)", () => {
    const early = binaryDeltaNotionalUsdc({
      ...base,
      spot: 100_000,
      msToExpiry: 240_000,
      shares: 100,
    });
    const late = binaryDeltaNotionalUsdc({
      ...base,
      spot: 100_000,
      msToExpiry: 10_000,
      shares: 100,
    });
    expect(late).toBeGreaterThan(early);
  });

  it("collapses away from the money regardless of time", () => {
    const deep = binaryDeltaNotionalUsdc({
      ...base,
      spot: 99_000,
      msToExpiry: 30_000,
      shares: 100,
    });
    expect(deep).toBeLessThan(1);
  });

  it("rejects non-finite shares", () => {
    expect(() =>
      binaryDeltaNotionalUsdc({ ...base, spot: 100_000, msToExpiry: 1000, shares: Number.NaN }),
    ).toThrow(/shares/);
  });
});
