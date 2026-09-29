import { describe, expect, it } from "vitest";

import {
  ValidationError,
  assetSymbol,
  decCompare,
  decFromString,
  decSub,
  decToString,
  marketId,
  millis,
  tokenId,
  type AssetSymbol,
  type Decimal,
  type Millis,
} from "@bot/domain";

import { createAcquisitionLot, type AcquisitionLot } from "./lot.js";
import {
  MIN_HEDGE_NOTIONAL_USDC,
  decideHedge,
  residualExposureUsdc,
  volatilityMultiplier,
  type HedgeEngineInput,
  type HedgeDecision,
} from "./index.js";

const MARKET = marketId("703257");
const UP_TOKEN = tokenId("1111111111");
const DOWN_TOKEN = tokenId("2222222222");
const T0 = millis(1_800_000_000_000);
const BTC: AssetSymbol = assetSymbol("BTC");
const ETH: AssetSymbol = assetSymbol("ETH");

const d = (s: string): Decimal => decFromString(s);

function lot(
  outcome: "up" | "down",
  lotId: string,
  qty: string,
  price: string,
  at: Millis = T0,
): AcquisitionLot {
  return createAcquisitionLot({
    lotId,
    marketId: MARKET,
    tokenId: outcome === "up" ? UP_TOKEN : DOWN_TOKEN,
    outcome,
    qty: d(qty),
    pricePerUnit: d(price),
    acquiredAt: at,
  });
}

interface HedgeOpts {
  asset: AssetSymbol;
  direction: string;
  confidence: string;
  phase: "EARLY" | "MID" | "LATE" | "FINAL";
  upLots: readonly AcquisitionLot[];
  downLots: readonly AcquisitionLot[];
  markPrice: string;
  volatility: string;
  maxNotionalUsdc: string;
  externalHedgeEnabled?: boolean;
}

function makeInput(o: Partial<HedgeOpts>): HedgeEngineInput {
  const opts: HedgeOpts = {
    asset: BTC,
    direction: "1",
    confidence: "0.8",
    phase: "EARLY",
    upLots: [lot("up", "u1", "100", "0.45")],
    downLots: [],
    markPrice: "0.50",
    volatility: "0.50",
    maxNotionalUsdc: "1000",
    ...o,
  };
  return {
    asset: opts.asset,
    signal: { direction: d(opts.direction), confidence: d(opts.confidence) },
    upLots: opts.upLots,
    downLots: opts.downLots,
    markPrice: d(opts.markPrice),
    phase: opts.phase,
    volatility: { fraction: d(opts.volatility) },
    risk: { maxNotionalUsdc: d(opts.maxNotionalUsdc) },
    ...(opts.externalHedgeEnabled === undefined
      ? {}
      : { externalHedgeEnabled: opts.externalHedgeEnabled }),
    at: T0,
  };
}

/** Invariants that must hold for every decision. */
function expectHedgeInvariants(decision: HedgeDecision, input: HedgeEngineInput): void {
  if (decision.required) {
    // Hedge offsets the residual: long-up residual -> short hedge.
    const match = residualExposureUsdc(input.upLots, input.downLots, input.markPrice);
    if (decCompare(match.netShares, d("0")) > 0) {
      expect(decision.direction).toBe("short");
    } else {
      expect(decision.direction).toBe("long");
    }
    // Never above exposure (no leverage) and never above budget.
    expect(decCompare(decision.targetSize, decision.riskImpact.exposureUsdc) <= 0).toBe(true);
    expect(decCompare(decision.targetSize, input.risk.maxNotionalUsdc) <= 0).toBe(true);
    // Accounting identity.
    expect(decToString(decision.riskImpact.remainingExposureUsdc)).toBe(
      decToString(decSub(decision.riskImpact.exposureUsdc, decision.riskImpact.hedgeNotionalUsdc)),
    );
    // Confidence in [0, 1].
    expect(decCompare(decision.confidence, d("0")) >= 0).toBe(true);
    expect(decCompare(decision.confidence, d("1")) <= 0).toBe(true);
  } else {
    expect(decision.direction).toBe("none");
    expect(decToString(decision.targetSize)).toBe("0.00000000");
  }
  expect(decision.asset).toBe(input.asset);
}

describe("volatilityMultiplier", () => {
  it("maps volatility regimes deterministically", () => {
    expect(decToString(volatilityMultiplier({ fraction: d("0.10") }))).toBe("0.50000000");
    expect(decToString(volatilityMultiplier({ fraction: d("0.20") }))).toBe("0.75000000");
    expect(decToString(volatilityMultiplier({ fraction: d("0.40") }))).toBe("1.00000000");
    expect(decToString(volatilityMultiplier({ fraction: d("0.60") }))).toBe("1.25000000");
    expect(decToString(volatilityMultiplier({ fraction: d("2.00") }))).toBe("1.25000000");
    expect(() => volatilityMultiplier({ fraction: d("-0.1") })).toThrow(ValidationError);
  });
});

describe("decideHedge — required hedge", () => {
  it("long-up residual -> short hedge, sized as exposure x urgency", () => {
    const input = makeInput({
      upLots: [lot("up", "u1", "100", "0.45")],
      downLots: [],
      markPrice: "0.50",
      direction: "1",
      confidence: "0.8",
      phase: "EARLY",
      volatility: "0.50",
    });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    expect(decision.required).toBe(true);
    expect(decision.asset).toBe("BTC");
    expect(decision.direction).toBe("short");
    // exposure = 100 shares x 0.50 = 50 USDC
    expect(decToString(decision.riskImpact.exposureUsdc)).toBe("50.00000000");
    // urgency = 1 x 0.8 x 1(EARLY) x 1(50% vol) = 0.8
    expect(decToString(decision.confidence)).toBe("0.80000000");
    expect(decToString(decision.targetSize)).toBe("40.00000000");
    expect(decision.reason).toBe("residual_hedge_below_max");
    expect(decToString(decision.riskImpact.hedgeNotionalUsdc)).toBe("40.00000000");
    expect(decToString(decision.riskImpact.remainingExposureUsdc)).toBe("10.00000000");
    expect(decision.riskImpact.budgetCapped).toBe(false);
    expect(decision.riskImpact.atFullCoverage).toBe(false);
    expect(decision.phase).toBe("EARLY");
  });

  it("long-down residual -> long hedge, symmetric sizing", () => {
    const input = makeInput({
      upLots: [],
      downLots: [lot("down", "d1", "100", "0.55")],
      markPrice: "0.50",
      direction: "-1",
      confidence: "0.8",
    });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    expect(decision.direction).toBe("long");
    expect(decToString(decision.targetSize)).toBe("40.00000000");
  });

  it("uses ETH as the asset when given", () => {
    const decision = decideHedge(
      makeInput({ asset: ETH, upLots: [], downLots: [lot("down", "d1", "50", "0.5")] }),
    );
    expect(decision.asset).toBe("ETH");
    expect(decision.direction).toBe("long");
  });

  it("reports full coverage without exceeding the exposure (no leverage)", () => {
    const input = makeInput({ direction: "1", confidence: "1", volatility: "0.90" });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    // urgency = 1 x 1 x 1 x 1.25 = 1.25 -> model target 62.5, capped at 50.
    expect(decToString(decision.targetSize)).toBe("50.00000000");
    expect(decision.riskImpact.atFullCoverage).toBe(true);
    expect(decToString(decision.riskImpact.coverageFraction)).toBe("1.00000000");
  });
});

describe("decideHedge — signal, phase, and volatility scaling", () => {
  it("scales with |direction| x confidence", () => {
    const full = decideHedge(makeInput({ direction: "1", confidence: "1" }));
    const half = decideHedge(makeInput({ direction: "0.5", confidence: "1" }));
    expect(decToString(full.targetSize)).toBe("50.00000000");
    expect(decToString(half.targetSize)).toBe("25.00000000");

    const lowConf = decideHedge(makeInput({ direction: "1", confidence: "0.5" }));
    expect(decToString(lowConf.targetSize)).toBe("25.00000000");
  });

  it("later phases shrink the hedge (less time to act, less justified)", () => {
    const early = decideHedge(makeInput({ phase: "EARLY", confidence: "0.8" }));
    const late = decideHedge(makeInput({ phase: "LATE", confidence: "0.8" }));
    const final = decideHedge(makeInput({ phase: "FINAL", confidence: "0.8" }));
    expect(decToString(early.targetSize)).toBe("40.00000000");
    expect(decToString(late.targetSize)).toBe("20.00000000");
    expect(decToString(final.targetSize)).toBe("10.00000000");
  });

  it("higher volatility raises the hedge urgency", () => {
    const calm = decideHedge(makeInput({ volatility: "0.10", confidence: "0.8" }));
    const wild = decideHedge(makeInput({ volatility: "0.80", confidence: "0.8" }));
    expect(decToString(calm.targetSize)).toBe("20.00000000"); // 0.5x
    expect(decToString(wild.targetSize)).toBe("50.00000000"); // 1.25x -> capped
  });

  it("neutral or zero-confidence signals propose no hedge even with exposure", () => {
    const neutral = decideHedge(makeInput({ direction: "0", confidence: "1" }));
    const noConf = decideHedge(makeInput({ direction: "1", confidence: "0" }));
    expect(neutral.required).toBe(false);
    expect(noConf.required).toBe(false);
    // The exposure is still reported.
    expect(decToString(neutral.riskImpact.exposureUsdc)).toBe("50.00000000");
  });
});

describe("decideHedge — risk budget", () => {
  it("caps the target at the risk budget and flags budgetCapped", () => {
    const input = makeInput({ direction: "1", confidence: "1", maxNotionalUsdc: "12.50" });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    // model 50 -> budget 12.50
    expect(decToString(decision.targetSize)).toBe("12.50000000");
    expect(decision.riskImpact.budgetCapped).toBe(true);
    expect(decision.riskImpact.atFullCoverage).toBe(false);
    expect(decToString(decision.riskImpact.coverageFraction)).toBe("0.25000000");
    expect(decToString(decision.riskImpact.remainingExposureUsdc)).toBe("37.50000000");
  });

  it("zero risk budget means no hedge", () => {
    const decision = decideHedge(makeInput({ maxNotionalUsdc: "0" }));
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("risk_budget_exhausted");
    expect(decision.direction).toBe("none");
  });
});

describe("decideHedge — no-hedge cases", () => {
  it("flat book (matched sets only) needs no hedge", () => {
    const input = makeInput({
      upLots: [lot("up", "u1", "100", "0.45")],
      downLots: [lot("down", "d1", "100", "0.55")],
    });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("no_residual_exposure");
    expect(decToString(decision.riskImpact.exposureUsdc)).toBe("0.00000000");
  });

  it("200 Up / 150 Down reports a 25-share net exposure and hedges the residual only", () => {
    const input = makeInput({
      upLots: [lot("up", "u1", "200", "0.48")],
      downLots: [lot("down", "d1", "150", "0.52")],
      markPrice: "0.50",
      direction: "1",
      confidence: "1",
    });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    // Only the 50-share residual is exposure; the 150 sets are neutral.
    expect(decToString(decision.riskImpact.exposureUsdc)).toBe("25.00000000");
    expect(decToString(decision.targetSize)).toBe("25.00000000"); // urgency 1
    expect(decision.direction).toBe("short");
  });

  it("tiny hedge below the minimum notional is declined explicitly", () => {
    const input = makeInput({
      upLots: [lot("up", "u1", "1", "0.45")],
      markPrice: "0.50",
      direction: "1",
      confidence: "1",
    });
    const decision = decideHedge(input);
    expectHedgeInvariants(decision, input);
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("below_min_hedge_notional");
    expect(decToString(decision.riskImpact.exposureUsdc)).toBe("0.50000000");
    expect(decToString(MIN_HEDGE_NOTIONAL_USDC)).toBe("1.00000000");
  });
});

describe("decideHedge — decision-only guards", () => {
  it("rejects externalHedgeEnabled=true (decision-only component)", () => {
    expect(() => decideHedge(makeInput({ externalHedgeEnabled: true }))).toThrow(ValidationError);
    expect(() => decideHedge(makeInput({ externalHedgeEnabled: true }))).toThrow(
      /ENABLE_EXTERNAL_HEDGE/,
    );
  });

  it("defaults to decision-only when the flag is absent", () => {
    const input = makeInput({});
    expect(input.externalHedgeEnabled).toBeUndefined();
    expect(() => decideHedge(input)).not.toThrow();
  });

  it("never produces an order: the decision carries no venue, order, or leverage fields", () => {
    const decision = decideHedge(makeInput({}));
    const keys = Object.keys(decision).sort();
    expect(keys).toEqual(
      [
        "asset",
        "confidence",
        "decidedAt",
        "direction",
        "phase",
        "reason",
        "required",
        "riskImpact",
        "targetSize",
      ].sort(),
    );
    expect(keys).not.toContain("order");
    expect(keys).not.toContain("venue");
    expect(keys).not.toContain("leverage");
  });

  it("rejects invalid inputs", () => {
    expect(() => decideHedge(makeInput({ markPrice: "0" }))).toThrow(ValidationError);
    expect(() => decideHedge(makeInput({ markPrice: "-1" }))).toThrow(ValidationError);
    expect(() => decideHedge(makeInput({ maxNotionalUsdc: "-5" }))).toThrow(ValidationError);
    expect(() => decideHedge(makeInput({ direction: "1.5" }))).toThrow(ValidationError);
    expect(() => decideHedge(makeInput({ confidence: "-0.2" }))).toThrow(ValidationError);
  });
});

describe("decideHedge — purity", () => {
  it("is deterministic: identical inputs produce identical decisions", () => {
    const input = makeInput({ direction: "1", confidence: "0.7" });
    expect(decideHedge(input)).toEqual(decideHedge(input));
  });

  it("does not mutate the input lots", () => {
    const up = lot("up", "u1", "30", "0.45");
    const down = lot("down", "d1", "12", "0.55");
    const upBefore = up.qty;
    const downBefore = down.qty;
    decideHedge(makeInput({ upLots: [up], downLots: [down] }));
    expect(up.qty).toBe(upBefore);
    expect(down.qty).toBe(downBefore);
  });
});
