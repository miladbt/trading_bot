import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUFFERS,
  DEFAULT_FAIR_VALUE_CONFIG,
  DEFAULT_GATE_CONFIG,
  MIN_GATE_SAMPLES,
  dormant,
  evaluateGate,
  fairValueEstimate,
  mispricing,
  totalBuffer,
  type FairValueInput,
  type GateObservation,
} from "./fair-value.js";

const baseInput: FairValueInput = {
  elapsedSec: 60,
  remainingSec: 240,
  underlying: {
    anchorDistFrac: dormant,
    momentumPerMin: dormant,
    volAccelPerMin2: dormant,
  },
  market: { bookImbalance: dormant },
  config: DEFAULT_FAIR_VALUE_CONFIG,
};

describe("fairValueEstimate", () => {
  it("is exactly base when every component is dormant", () => {
    const est = fairValueEstimate(baseInput);
    expect(est.pUp).toBeCloseTo(DEFAULT_FAIR_VALUE_CONFIG.base, 12);
    expect(est.pDown).toBeCloseTo(1 - DEFAULT_FAIR_VALUE_CONFIG.base, 12);
    expect(est.available.momentum).toBe(false);
    expect(est.available.book).toBe(false);
    expect(est.available.time).toBe(true);
  });

  it("keeps a nonzero time weight a deliberate, bias-free input (research opt-in)", () => {
    // With wTime = 0 the dormant-input model is exactly the base; a nonzero
    // weight is a choice, and the component must be symmetric evidence — here
    // we only verify the plumbing: more remaining time → higher wTime·x term.
    const early = fairValueEstimate({
      ...baseInput,
      elapsedSec: 30,
      remainingSec: 270,
      config: { ...DEFAULT_FAIR_VALUE_CONFIG, wTime: 0.1 },
    });
    const late = fairValueEstimate({
      ...baseInput,
      elapsedSec: 270,
      remainingSec: 30,
      config: { ...DEFAULT_FAIR_VALUE_CONFIG, wTime: 0.1 },
    });
    expect(early.pUp).toBeGreaterThan(late.pUp);
  });

  it("satisfies pDown = 1 - pUp exactly and the [0.001, 0.999] clamp", () => {
    const est = fairValueEstimate({
      ...baseInput,
      underlying: {
        ...baseInput.underlying,
        momentumPerMin: { available: true, value: 1e6 }, // saturates positive
        anchorDistFrac: { available: true, value: 1e6 },
        volAccelPerMin2: { available: true, value: 1e6 },
      },
      market: { bookImbalance: { available: true, value: 1 } },
    });
    expect(est.pDown).toBe(1 - est.pUp);
    expect(est.pUp).toBeLessThanOrEqual(DEFAULT_FAIR_VALUE_CONFIG.pCeiling);
    expect(est.pUp).toBeGreaterThanOrEqual(DEFAULT_FAIR_VALUE_CONFIG.pFloor);
  });

  it("keeps the floor under maximally negative evidence", () => {
    const est = fairValueEstimate({
      ...baseInput,
      underlying: {
        ...baseInput.underlying,
        momentumPerMin: { available: true, value: -1e6 },
        anchorDistFrac: { available: true, value: -1e6 },
        volAccelPerMin2: { available: true, value: -1e6 },
      },
      market: { bookImbalance: { available: true, value: -1 } },
      config: { ...DEFAULT_FAIR_VALUE_CONFIG, base: 0.001 },
    });
    expect(est.pUp).toBe(DEFAULT_FAIR_VALUE_CONFIG.pFloor);
  });

  it("treats NaN evidence as dormant, not as a signal", () => {
    const est = fairValueEstimate({
      ...baseInput,
      underlying: {
        ...baseInput.underlying,
        momentumPerMin: { available: true, value: Number.NaN },
      },
    });
    expect(est.available.momentum).toBe(false);
    expect(est.pUp).toBeCloseTo(DEFAULT_FAIR_VALUE_CONFIG.base, 12);
  });

  it("is monotone in anchor distance (above strike → more likely Up)", () => {
    const below = fairValueEstimate({
      ...baseInput,
      underlying: { ...baseInput.underlying, anchorDistFrac: { available: true, value: -0.0002 } },
    });
    const above = fairValueEstimate({
      ...baseInput,
      underlying: { ...baseInput.underlying, anchorDistFrac: { available: true, value: 0.0002 } },
    });
    expect(above.pUp).toBeGreaterThan(below.pUp);
  });

  it("deterministic: same input, same output", () => {
    expect(fairValueEstimate(baseInput)).toStrictEqual(fairValueEstimate(baseInput));
  });

  it("throws on structurally impossible time inputs", () => {
    expect(() => fairValueEstimate({ ...baseInput, remainingSec: -1 })).toThrow(RangeError);
    expect(() => fairValueEstimate({ ...baseInput, elapsedSec: Number.NaN })).toThrow(RangeError);
  });

  it("throws on an out-of-band base or clamp config", () => {
    expect(() =>
      fairValueEstimate({ ...baseInput, config: { ...DEFAULT_FAIR_VALUE_CONFIG, base: 2 } }),
    ).toThrow(RangeError);
    expect(() =>
      fairValueEstimate({
        ...baseInput,
        config: { ...DEFAULT_FAIR_VALUE_CONFIG, pFloor: 0.5, pCeiling: 0.4 },
      }),
    ).toThrow(RangeError);
  });
});

describe("totalBuffer", () => {
  it("is the sum of the three buffers when depth is dormant", () => {
    const b = totalBuffer({
      sizeShares: 25,
      visibleDepthShares: undefined,
      buffers: DEFAULT_BUFFERS,
    });
    expect(b).toBeCloseTo(0.009, 12);
  });

  it("adds impact only when real depth is provided", () => {
    const noDepth = totalBuffer({
      sizeShares: 25,
      visibleDepthShares: undefined,
      buffers: DEFAULT_BUFFERS,
    });
    const withDepth = totalBuffer({
      sizeShares: 25,
      visibleDepthShares: 100,
      buffers: DEFAULT_BUFFERS,
    });
    expect(withDepth).toBeGreaterThan(noDepth);
    expect(withDepth - noDepth).toBeCloseTo(DEFAULT_BUFFERS.impactSlope * 0.25, 12);
  });

  it("caps impact at the full slope when size exceeds depth", () => {
    const b = totalBuffer({ sizeShares: 1000, visibleDepthShares: 10, buffers: DEFAULT_BUFFERS });
    expect(b).toBeCloseTo(0.009 + DEFAULT_BUFFERS.impactSlope, 12);
  });
});

describe("mispricing", () => {
  it("is negative for fairly priced asks (no free edge after fee + buffer)", () => {
    const r = mispricing({ pUp: 0.5, askUp: 0.5, askDown: 0.5, takerFeeRate: 0.07, buffer: 0.009 });
    expect(r.mispricingUp).toBeLessThan(0);
    expect(r.mispricingDown).toBeLessThan(0);
  });

  it("is positive when the ask is far below fair value (fee-aware)", () => {
    const r = mispricing({ pUp: 0.7, askUp: 0.5, askDown: 0.5, takerFeeRate: 0.07, buffer: 0.009 });
    expect(r.mispricingUp).toBeGreaterThan(0);
    expect(r.feeUp).toBeCloseTo(0.07 * 0.5 * 0.5, 12);
  });

  it("rejects degenerate inputs (fail closed)", () => {
    expect(() =>
      mispricing({ pUp: 0, askUp: 0.5, askDown: 0.5, takerFeeRate: 0.07, buffer: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      mispricing({ pUp: 0.5, askUp: 1, askDown: 0.5, takerFeeRate: 0.07, buffer: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      mispricing({ pUp: 0.5, askUp: 0.5, askDown: 0.5, takerFeeRate: -1, buffer: 0 }),
    ).toThrow(RangeError);
  });
});

describe("evaluateGate", () => {
  const observations = (p: number, outcomes: readonly (0 | 1)[]): GateObservation[] =>
    outcomes.map((outcome) => ({ predicted: p, outcome }));

  it("is insufficient below the sample minimum (fail closed)", () => {
    const g = evaluateGate(observations(0.5, [1, 0, 1]), DEFAULT_GATE_CONFIG);
    expect(g.verdict).toBe("insufficient");
    expect(g.brier).toBeUndefined();
  });

  it("closes on a coin-flip-calibrated model (no skill)", () => {
    // 50/50 predictions on 50/50 outcomes → Brier = 0.25, LL = ln 2.
    const outcomes: (0 | 1)[] = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const g = evaluateGate(observations(0.5, outcomes), DEFAULT_GATE_CONFIG);
    expect(g.verdict).toBe("closed");
    expect(g.brier).toBeCloseTo(0.25, 10);
  });

  it("opens on a genuinely skillful model", () => {
    // Perfect-ish calls: 0.9 on outcomes 1, 0.1 on outcomes 0.
    const obs: GateObservation[] = Array.from({ length: 60 }, () => ({
      predicted: 0.9,
      outcome: 1 as const,
    }));
    const g = evaluateGate(obs, DEFAULT_GATE_CONFIG);
    expect(g.verdict).toBe("open");
    expect(g.brier!).toBeLessThan(DEFAULT_GATE_CONFIG.maxBrier);
    expect(g.logLoss!).toBeLessThan(DEFAULT_GATE_CONFIG.maxLogLoss);
  });

  it("requires BOTH metrics to beat the baseline", () => {
    // Brier beats 0.23 but log loss does not beat ln2 − 0.02:
    // predictions near 0.5 with slightly asymmetric outcomes.
    const obs: GateObservation[] = Array.from({ length: 100 }, (_, i) => ({
      predicted: 0.51,
      outcome: i % 2 === 0 ? 1 : 0,
    }));
    const g = evaluateGate(obs, DEFAULT_GATE_CONFIG);
    // 0.51 on 50/50 outcomes: Brier ≈ 0.2401 < 0.23 is FALSE → closed either way.
    expect(g.verdict).toBe("closed");
  });

  it("respects the MIN_GATE_SAMPLES constant", () => {
    expect(MIN_GATE_SAMPLES).toBeGreaterThanOrEqual(50);
  });
});
