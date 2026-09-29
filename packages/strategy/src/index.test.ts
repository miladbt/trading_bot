import { describe, expect, it } from "vitest";

import { DEFAULT_SIGNAL_ENGINE_CONFIG, computeAssetSignal, createAssetHistory } from "./index.js";

describe("strategy package API", () => {
  it("exposes the deterministic signal engine", () => {
    expect(typeof computeAssetSignal).toBe("function");
    expect(typeof createAssetHistory).toBe("function");
    expect(DEFAULT_SIGNAL_ENGINE_CONFIG.minSamples).toBeGreaterThan(0);
  });

  it("produces a data-starved signal for an empty history", () => {
    const s = computeAssetSignal(createAssetHistory("BTC", []), undefined, 0 as never);
    expect(s.confidence).toBe(0);
    expect(s.regime).toBe("data-starved");
  });
});
