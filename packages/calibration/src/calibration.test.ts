import { describe, expect, it } from "vitest";

import { millis } from "@bot/domain";

import {
  brierScore,
  deserializeCalibration,
  evaluateCalibration,
  fitBinnedCalibration,
  fitIsotonicCalibration,
  logLoss,
  reliabilityTable,
  serializeCalibration,
  CalibrationFormatError,
  type CalibrationSample,
} from "./calibration.js";

/** Deterministic PRNG-free sample builder: score -> P(up | score). */
function makeSamples(
  spec: readonly { raw: number; pUp: number; n: number }[],
): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (const { raw, pUp, n } of spec) {
    for (let i = 0; i < n; i++) {
      // Deterministic pseudo-outcome: Bernoulli draw replaced by a threshold
      // pattern over i so the sample set is exactly reproducible.
      const outcome: 0 | 1 = (i + 1) / (n + 1) < pUp ? 1 : 0;
      out.push({ raw, outcome, at: millis(1_700_000_000_000 + i * 1000) });
    }
  }
  return out;
}

describe("binned calibration", () => {
  it("maps a perfectly separating score to ~0 and ~1 at the extremes", () => {
    const samples: CalibrationSample[] = [
      { raw: 0.2, outcome: 0 },
      { raw: 0.2, outcome: 0 },
      { raw: 0.2, outcome: 0 },
      { raw: 0.2, outcome: 0 },
      { raw: 0.8, outcome: 1 },
      { raw: 0.8, outcome: 1 },
      { raw: 0.8, outcome: 1 },
      { raw: 0.8, outcome: 1 },
    ];
    const model = fitBinnedCalibration({ samples, bins: 4, asset: "BTC" });
    // Scores in the lowest band get the lowest bin's (monotone-repaired) value.
    const low = evaluateCalibration(model, 0.2);
    const high = evaluateCalibration(model, 0.8);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
  });

  it("is monotone non-decreasing across the score domain", () => {
    const samples = makeSamples([
      { raw: 0.1, pUp: 0.9, n: 6 }, // deliberately wrong on purpose
      { raw: 0.5, pUp: 0.3, n: 6 },
      { raw: 0.9, pUp: 0.8, n: 6 },
    ]);
    const model = fitBinnedCalibration({ samples, bins: 6, asset: "BTC" });
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const v = evaluateCalibration(model, Math.min(x, 1));
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("produces valid versioned JSON that round-trips", () => {
    const samples = makeSamples([
      { raw: 0.3, pUp: 0.2, n: 8 },
      { raw: 0.7, pUp: 0.9, n: 8 },
    ]);
    const model = fitBinnedCalibration({ samples, bins: 4, asset: "ETH", version: "1.2.3" });
    const json = serializeCalibration(model);
    const parsed = deserializeCalibration(json);
    expect(parsed.schema).toBe(1);
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.method).toBe("binned");
    for (const raw of [0, 0.25, 0.5, 0.75, 1]) {
      expect(evaluateCalibration(parsed, raw)).toBeCloseTo(evaluateCalibration(model, raw), 12);
    }
  });

  it("records fit metadata: sample count, first/last sample time", () => {
    const samples = makeSamples([
      { raw: 0.3, pUp: 0.2, n: 4 },
      { raw: 0.7, pUp: 0.9, n: 4 },
    ]);
    const model = fitBinnedCalibration({ samples, bins: 4, asset: "BTC" });
    expect(model.fit.sampleCount).toBe(8);
    expect(model.fit.firstAt).toBe(1_700_000_000_000);
    expect(model.fit.lastAt).toBe(1_700_000_003_000);
    expect(model.fit.brier).toBeGreaterThanOrEqual(0);
    expect(model.fit.logLoss).toBeGreaterThan(0);
    expect(model.fit.reliability.length).toBeGreaterThan(0);
  });

  it("rejects degenerate inputs", () => {
    expect(() => fitBinnedCalibration({ samples: [], bins: 4, asset: "BTC" })).toThrow(
      /at least one sample/,
    );
    expect(() =>
      fitBinnedCalibration({ samples: [{ raw: 0.5, outcome: 1 }], bins: 1, asset: "BTC" }),
    ).toThrow(/bins must be an integer >= 2/);
    expect(() =>
      fitBinnedCalibration({ samples: [{ raw: 0.5, outcome: 1 }], bins: 2, asset: "BTC" }),
    ).toThrow(/scoreMax must be > scoreMin/);
    expect(() =>
      fitBinnedCalibration({ samples: [{ raw: 1.5, outcome: 1 }], bins: 2, asset: "BTC" }),
    ).toThrow(/must be in \[0, 1\]/);
    expect(() =>
      fitBinnedCalibration({
        samples: [{ raw: 0.5, outcome: 2 as never }],
        bins: 2,
        asset: "BTC",
      }),
    ).toThrow(/outcome must be 0 or 1/);
  });
});

describe("isotonic calibration (PAVA)", () => {
  it("is the least-squares monotone fit and repairs a non-monotone sample", () => {
    const samples: CalibrationSample[] = [
      { raw: 0.1, outcome: 0 },
      { raw: 0.2, outcome: 0 },
      { raw: 0.3, outcome: 1 }, // violation: 1 above but 0.3 < 0.7
      { raw: 0.7, outcome: 0 },
      { raw: 0.8, outcome: 0 },
    ];
    const model = fitIsotonicCalibration({ samples, asset: "BTC" });
    // The 0.3/0.7 violation pools to 0.5; monotone everywhere.
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.02) {
      const v = evaluateCalibration(model, Math.min(x, 1));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    // The violation pools {0.3:1, 0.7:0, 0.8:0} to the weighted mean 1/3.
    expect(evaluateCalibration(model, 0.3)).toBeCloseTo(1 / 3, 12);
    expect(evaluateCalibration(model, 0.7)).toBeCloseTo(1 / 3, 12);
    expect(evaluateCalibration(model, 0.8)).toBeCloseTo(1 / 3, 12);
  });

  it("keeps extremes clamped beyond the fitted score range", () => {
    const samples: CalibrationSample[] = [
      { raw: 0.4, outcome: 0 },
      { raw: 0.4, outcome: 0 },
      { raw: 0.4, outcome: 0 },
      { raw: 0.4, outcome: 1 },
      { raw: 0.6, outcome: 1 },
      { raw: 0.6, outcome: 1 },
      { raw: 0.6, outcome: 1 },
      { raw: 0.6, outcome: 1 },
    ];
    const model = fitIsotonicCalibration({ samples, asset: "BTC" });
    const low = evaluateCalibration(model, 0.0); // below range -> first block
    const high = evaluateCalibration(model, 1.0); // above range -> last block
    expect(low).toBeCloseTo(0.25, 12); // (0+0+0+1)/4
    expect(high).toBe(1);
    expect(evaluateCalibration(model, 0.4)).toBeCloseTo(0.25, 12);
    expect(evaluateCalibration(model, 0.6)).toBe(1);
  });

  it("round-trips through versioned JSON", () => {
    const samples = makeSamples([
      { raw: 0.2, pUp: 0.1, n: 6 },
      { raw: 0.8, pUp: 0.9, n: 6 },
    ]);
    const model = fitIsotonicCalibration({ samples, asset: "BTC", version: "2.0.0" });
    const parsed = deserializeCalibration(serializeCalibration(model));
    for (const raw of [0, 0.2, 0.5, 0.8, 1]) {
      expect(evaluateCalibration(parsed, raw)).toBeCloseTo(evaluateCalibration(model, raw), 12);
    }
    expect(parsed.method).toBe("isotonic");
  });
});

describe("metrics", () => {
  it("brier score: perfect predictions -> 0, coin flip -> 0.25", () => {
    expect(
      brierScore([
        { predicted: 1, outcome: 1 },
        { predicted: 0, outcome: 0 },
      ]),
    ).toBe(0);
    expect(
      brierScore([
        { predicted: 0.5, outcome: 1 },
        { predicted: 0.5, outcome: 0 },
      ]),
    ).toBeCloseTo(0.25, 12);
  });

  it("log loss: confident-correct < uncertain < confident-wrong", () => {
    const correct = logLoss([{ predicted: 0.99, outcome: 1 }]);
    const uncertain = logLoss([{ predicted: 0.5, outcome: 1 }]);
    const wrong = logLoss([{ predicted: 0.01, outcome: 1 }]);
    expect(correct).toBeLessThan(uncertain);
    expect(uncertain).toBeLessThan(wrong);
    expect(Number.isFinite(wrong)).toBe(true); // clipped, never infinite
  });

  it("reliability table counts and averages per bin", () => {
    const rows = reliabilityTable(
      [
        { predicted: 0.05, outcome: 0 },
        { predicted: 0.15, outcome: 0 },
        { predicted: 0.55, outcome: 1 },
        { predicted: 0.95, outcome: 1 },
      ],
      4,
    );
    // Width-0.25 bins: both 0.05 and 0.15 fall into bin 0.
    expect(rows).toHaveLength(4);
    expect(rows[0]?.count).toBe(2);
    expect(rows[1]?.count).toBe(0);
    expect(rows[2]?.count).toBe(1);
    expect(rows[3]?.count).toBe(1);
    expect(rows[0]?.observed).toBe(0);
    expect(rows[3]?.observed).toBe(1);
    expect(rows[2]?.meanPredicted).toBeCloseTo(0.55, 12);
  });
});

describe("serialized-model validation", () => {
  const valid = JSON.stringify({
    schema: 1,
    version: "1.0.0",
    method: "binned",
    asset: "BTC",
    scoreRange: { min: 0, max: 1 },
    bins: [
      { lower: 0, upper: 0.5, value: 0.4 },
      { lower: 0.5, upper: 1, value: 0.6 },
    ],
    fit: {
      sampleCount: 10,
      firstAt: 1,
      lastAt: 2,
      brier: 0.2,
      logLoss: 0.6,
      reliability: [],
    },
  });

  it("accepts a well-formed model and evaluates it", () => {
    const model = deserializeCalibration(valid);
    expect(evaluateCalibration(model, 0.25)).toBeCloseTo(0.4, 12);
    expect(evaluateCalibration(model, 0.75)).toBeCloseTo(0.6, 12);
  });

  it("rejects wrong schema version, bad bins, out-of-range values", () => {
    const badSchema = JSON.stringify({ ...JSON.parse(valid), schema: 999 });
    expect(() => deserializeCalibration(badSchema)).toThrow(/unsupported schema/);
    const badBins = JSON.stringify({
      ...JSON.parse(valid),
      bins: [{ lower: 0, upper: "x", value: 0.5 }],
    });
    expect(() => deserializeCalibration(badBins)).toThrow(/numeric lower\/upper\/value/);
    const badValue = JSON.stringify({
      ...JSON.parse(valid),
      bins: [{ lower: 0, upper: 0.5, value: 1.5 }],
    });
    expect(() => deserializeCalibration(badValue)).toThrow(/must be in \[0, 1\]/);
    expect(() => deserializeCalibration("{not json")).toThrow();
    expect(() => deserializeCalibration("[]")).toThrow(/must be an object/);
    expect(new CalibrationFormatError("x").name).toBe("CalibrationFormatError");
  });
});
