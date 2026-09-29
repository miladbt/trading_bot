import { describe, expect, it } from "vitest";

import {
  ValidationError,
  decCompare,
  decFromString,
  decMin,
  decMulRound,
  decToString,
  marketId,
  millis,
  tokenId,
  type Decimal,
  type Millis,
} from "@bot/domain";

import {
  createAcquisitionLot,
  matchCompleteSets,
  type AcquisitionLot,
} from "./complete-set-engine.js";
import {
  phaseMultiplier,
  planRebalance,
  targetResidual,
  type MarketPhase,
  type RebalancePlannerInput,
  type SizingSelection,
  type StrategyDecision,
} from "./index.js";

const MARKET = marketId("703257");
const UP_TOKEN = tokenId("1111111111");
const DOWN_TOKEN = tokenId("2222222222");
const T0 = millis(1_800_000_000_000);

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

interface PlanOpts {
  direction: string;
  confidence: string;
  phase: MarketPhase;
  upLots: readonly AcquisitionLot[];
  downLots: readonly AcquisitionLot[];
  upPrice: string;
  downPrice: string;
  settlement: string;
  maxDirectionalShares: string;
  maxCapital: string;
  availableCapital: string;
  maxResidual: string;
  perSetCosts?: string;
  sizing?: SizingSelection;
}

function makePlan(o: Partial<PlanOpts>): RebalancePlannerInput {
  const opts: PlanOpts = {
    direction: "0",
    confidence: "0",
    phase: "EARLY",
    upLots: [lot("up", "u1", "150", "0.45")],
    downLots: [lot("down", "d1", "150", "0.55")],
    upPrice: "0.45",
    downPrice: "0.55",
    settlement: "1",
    maxDirectionalShares: "500",
    maxCapital: "1000",
    availableCapital: "1000",
    maxResidual: "100",
    ...o,
  };
  return {
    marketId: MARKET,
    signal: { direction: d(opts.direction), confidence: d(opts.confidence) },
    phase: opts.phase,
    upLots: opts.upLots,
    downLots: opts.downLots,
    economics: {
      upPrice: d(opts.upPrice),
      downPrice: d(opts.downPrice),
      settlementValue: d(opts.settlement),
      ...(opts.perSetCosts === undefined ? {} : { perSetCosts: d(opts.perSetCosts) }),
    },
    risk: {
      maxDirectionalShares: d(opts.maxDirectionalShares),
      maxCapital: d(opts.maxCapital),
      availableCapital: d(opts.availableCapital),
    },
    maxResidual: d(opts.maxResidual),
    ...(opts.sizing === undefined ? {} : { sizing: opts.sizing }),
    at: T0,
  };
}

/** Structural invariants every plan must satisfy. */
function expectPlanInvariants(plan: StrategyDecision, input: RebalancePlannerInput): void {
  // Budget: total estimated cost never exceeds min(available, max) capital.
  const budget = decMin(input.risk.availableCapital, input.risk.maxCapital);
  expect(decCompare(plan.estimatedTotalCost, budget) <= 0).toBe(true);
  // No negative inventory: every action is a positive-qty buy.
  for (const action of plan.actions) {
    expect(decCompare(action.qty, d("0"))).toBeGreaterThan(0);
    expect(decCompare(action.price, d("0"))).toBeGreaterThan(0);
    // cost = price * qty exactly at 8 dp.
    expect(decToString(action.estimatedCost)).toBe(
      decToString(decMulRound(action.price, action.qty)),
    );
  }
  // Residuals are never force-neutralized: they mirror the raw matching.
  const match = matchCompleteSets({
    upLots: input.upLots,
    downLots: input.downLots,
    settlementValue: input.economics.settlementValue,
  });
  expect(decToString(plan.residualUp)).toBe(decToString(match.residualUp));
  expect(decToString(plan.residualDown)).toBe(decToString(match.residualDown));
  expect(decToString(plan.currentSets)).toBe(decToString(match.matchedSets));
}

describe("phaseMultiplier", () => {
  it("scales the target down as settlement approaches", () => {
    expect(decToString(phaseMultiplier("EARLY"))).toBe("1.00000000");
    expect(decToString(phaseMultiplier("MID"))).toBe("0.75000000");
    expect(decToString(phaseMultiplier("LATE"))).toBe("0.50000000");
    expect(decToString(phaseMultiplier("FINAL"))).toBe("0.25000000");
  });
});

describe("targetResidual", () => {
  it("is direction * confidence * maxResidual * phase, clamped by risk", () => {
    const bullish = { direction: d("1"), confidence: d("0.5") };
    const t = targetResidual(bullish, "EARLY", d("100"), d("500"));
    expect(decToString(t.up)).toBe("50.00000000");
    expect(decToString(t.down)).toBe("0.00000000");

    const bearish = { direction: d("-1"), confidence: d("0.5") };
    const b = targetResidual(bearish, "EARLY", d("100"), d("500"));
    expect(decToString(b.up)).toBe("0.00000000");
    expect(decToString(b.down)).toBe("50.00000000");
  });

  it("caps the target at risk's directional limit", () => {
    const t = targetResidual({ direction: d("1"), confidence: d("1") }, "EARLY", d("100"), d("30"));
    expect(decToString(t.up)).toBe("30.00000000");
  });

  it("rejects out-of-range signals and negative limits", () => {
    expect(() =>
      targetResidual({ direction: d("1.5"), confidence: d("0.5") }, "EARLY", d("100"), d("500")),
    ).toThrow(ValidationError);
    expect(() =>
      targetResidual({ direction: d("1"), confidence: d("1.2") }, "EARLY", d("100"), d("500")),
    ).toThrow(ValidationError);
    expect(() =>
      targetResidual({ direction: d("1"), confidence: d("0.5") }, "EARLY", d("-1"), d("500")),
    ).toThrow(ValidationError);
  });
});

describe("planRebalance — signal directions", () => {
  it("bullish signal targets an Up residual and plans a rebalance_up buy", () => {
    const plan = planRebalance(makePlan({ direction: "1", confidence: "0.5" }));
    expectPlanInvariants(plan, makePlan({ direction: "1", confidence: "0.5" }));
    expect(decToString(plan.targetResidualUp)).toBe("50.00000000");
    expect(decToString(plan.targetResidualDown)).toBe("0.00000000");
    expect(decToString(plan.deltaUp)).toBe("50.00000000");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("rebalance_up");
    expect(plan.actions[0]!.outcome).toBe("up");
    expect(decToString(plan.actions[0]!.qty)).toBe("50.00000000");
    expect(decToString(plan.actions[0]!.estimatedCost)).toBe("22.50000000"); // 50 * 0.45
    expect(plan.isFlat).toBe(false);
  });

  it("bearish signal targets a Down residual and plans a rebalance_down buy", () => {
    const plan = planRebalance(makePlan({ direction: "-1", confidence: "0.5" }));
    expect(decToString(plan.targetResidualDown)).toBe("50.00000000");
    expect(decToString(plan.targetResidualUp)).toBe("0.00000000");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("rebalance_down");
    expect(decToString(plan.actions[0]!.qty)).toBe("50.00000000");
    expect(decToString(plan.actions[0]!.estimatedCost)).toBe("27.50000000"); // 50 * 0.55
  });

  it("neutral signal with balanced book proposes nothing", () => {
    const plan = planRebalance(makePlan({}));
    expect(decToString(plan.targetResidualUp)).toBe("0.00000000");
    expect(decToString(plan.targetResidualDown)).toBe("0.00000000");
    expect(plan.actions).toHaveLength(0);
    expect(plan.isFlat).toBe(true);
    expect(decToString(plan.estimatedTotalCost)).toBe("0.00000000");
  });
});

describe("planRebalance — confidence scaling", () => {
  it("high confidence justifies a larger residual than low confidence", () => {
    const high = planRebalance(makePlan({ direction: "1", confidence: "1" }));
    const low = planRebalance(makePlan({ direction: "1", confidence: "0.1" }));
    expect(decToString(high.targetResidualUp)).toBe("100.00000000");
    expect(decToString(low.targetResidualUp)).toBe("10.00000000");
    expect(decToString(high.actions[0]!.qty)).toBe("100.00000000");
    expect(decToString(low.actions[0]!.qty)).toBe("10.00000000");
  });
});

describe("planRebalance — phases", () => {
  it("early phase allows the full target; late phase halves it", () => {
    const early = planRebalance(makePlan({ direction: "1", confidence: "0.5", phase: "EARLY" }));
    const late = planRebalance(makePlan({ direction: "1", confidence: "0.5", phase: "LATE" }));
    expect(decToString(early.targetResidualUp)).toBe("50.00000000");
    expect(decToString(late.targetResidualUp)).toBe("25.00000000");
    expect(decToString(late.actions[0]!.qty)).toBe("25.00000000");
  });

  it("final phase shrinks the target the most", () => {
    const final = planRebalance(makePlan({ direction: "1", confidence: "1", phase: "FINAL" }));
    expect(decToString(final.targetResidualUp)).toBe("25.00000000");
  });
});

describe("planRebalance — the 200/150 example (residual preserved)", () => {
  it("represents 200 Up + 150 Down as 150 sets + 50 residual Up and never forces neutrality", () => {
    const input = makePlan({
      upLots: [lot("up", "u1", "200", "0.48")],
      downLots: [lot("down", "d1", "150", "0.52")],
    });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    expect(decToString(plan.currentSets)).toBe("150.00000000");
    expect(decToString(plan.residualUp)).toBe("50.00000000");
    expect(decToString(plan.residualDown)).toBe("0.00000000");
    expect(decToString(plan.netResidual)).toBe("50.00000000");
    // Neutral signal, no set edge (0.48 + 0.52 = 1.00): nothing to do, and the
    // 50 Up residual is NOT sold off or neutralized.
    expect(plan.isFlat).toBe(true);
    expect(plan.actions).toHaveLength(0);
  });

  it("supports a Down residual symmetrically (150 Up / 200 Down)", () => {
    const input = makePlan({
      upLots: [lot("up", "u1", "150", "0.48")],
      downLots: [lot("down", "d1", "200", "0.52")],
    });
    const plan = planRebalance(input);
    expect(decToString(plan.currentSets)).toBe("150.00000000");
    expect(decToString(plan.residualUp)).toBe("0.00000000");
    expect(decToString(plan.residualDown)).toBe("50.00000000");
    expect(decToString(plan.netResidual)).toBe("-50.00000000");
  });
});

describe("planRebalance — excessive residual (dynamic hedging)", () => {
  it("hedges an Up orphan above maxResidual by buying the light side", () => {
    const input = makePlan({
      upLots: [lot("up", "u1", "80", "0.45")],
      downLots: [],
      maxResidual: "50",
    });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    // No sell of the orphan: the hedge is a buy of the light side.
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("rebalance_down");
    expect(plan.actions[0]!.reason).toBe("hedge_orphan_residual");
    expect(decToString(plan.actions[0]!.qty)).toBe("30.00000000"); // 80 - 50
    expect(decToString(plan.actions[0]!.estimatedCost)).toBe("16.50000000"); // 30 * 0.55
    // The orphan stays in the decision untouched.
    expect(decToString(plan.residualUp)).toBe("80.00000000");
  });

  it("hedges a Down orphan symmetrically", () => {
    const plan = planRebalance(
      makePlan({ downLots: [lot("down", "d1", "80", "0.55")], upLots: [], maxResidual: "50" }),
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("rebalance_up");
    expect(plan.actions[0]!.reason).toBe("hedge_orphan_residual");
    expect(decToString(plan.actions[0]!.qty)).toBe("30.00000000");
  });

  it("does not hedge when the residual is within maxResidual", () => {
    const plan = planRebalance(
      makePlan({ upLots: [lot("up", "u1", "40", "0.45")], downLots: [], maxResidual: "50" }),
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.isFlat).toBe(true);
  });
});

describe("planRebalance — complete-set accumulation", () => {
  it("buys full sets first when the combined ask is below settlement value", () => {
    const input = makePlan({
      upPrice: "0.40",
      downPrice: "0.50",
      availableCapital: "45.00",
    });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    expect(plan.setEdgePositive).toBe(true);
    expect(decToString(plan.setEdgePerSet)).toBe("0.10000000");
    expect(decToString(plan.accumulationSets)).toBe("50.00000000"); // 45 / 0.90
    expect(plan.actions[0]!.kind).toBe("accumulate_sets");
    expect(decToString(plan.actions[0]!.estimatedCost)).toBe("45.00000000");
    expect(plan.actions).toHaveLength(1); // budget fully consumed by sets
  });

  it("does not accumulate without a positive set edge", () => {
    const plan = planRebalance(makePlan({}));
    expect(plan.setEdgePositive).toBe(false);
    expect(decToString(plan.accumulationSets)).toBe("0.00000000");
  });

  it("includes per-set costs in the edge check", () => {
    const plan = planRebalance(
      makePlan({ upPrice: "0.40", downPrice: "0.50", perSetCosts: "0.10" }),
    );
    expect(decToString(plan.setEdgePerSet)).toBe("0.00000000");
    expect(plan.setEdgePositive).toBe(false);
  });

  it("spends the whole budget on sets when the edge is positive (no leftover)", () => {
    const input = makePlan({
      direction: "1",
      confidence: "0.5",
      upPrice: "0.40",
      downPrice: "0.50",
      availableCapital: "46.50",
    });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    // 46.50 / 0.90 = 51.66666666 sets at 8 dp; the truncated product rounds
    // to 46.49999999, leaving no room for another worthwhile action.
    expect(decToString(plan.accumulationSets)).toBe("51.66666666");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("accumulate_sets");
    expect(decToString(plan.estimatedTotalCost)).toBe("46.49999999");
  });

  it("prefers the residual target when set edge exists but budget is pre-committed", () => {
    // Tiny budget: the set edge exists but a single set costs 0.90; with 0.40
    // available, no set fits, so the whole budget goes to the residual target.
    const input = makePlan({
      direction: "1",
      confidence: "0.5",
      upPrice: "0.40",
      downPrice: "0.50",
      availableCapital: "0.40",
    });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    expect(decToString(plan.accumulationSets)).toBe("0.00000000");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("rebalance_up");
    expect(decToString(plan.actions[0]!.qty)).toBe("1.00000000"); // 0.40 / 0.40
    expect(decToString(plan.estimatedTotalCost)).toBe("0.40000000");
  });
});

describe("planRebalance — insufficient capital", () => {
  it("truncates the rebalance to what the budget affords (8 dp shares)", () => {
    const input = makePlan({ direction: "1", confidence: "0.5", availableCapital: "4.00" });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    // 4.00 / 0.45 = 8.88888888 shares -> cost rounds to exactly 4.00, never above.
    expect(decToString(plan.actions[0]!.qty)).toBe("8.88888888");
    expect(decToString(plan.actions[0]!.estimatedCost)).toBe("4.00000000");
    expect(decToString(plan.estimatedTotalCost)).toBe("4.00000000");
  });

  it("proposes nothing when capital is zero", () => {
    const plan = planRebalance(
      makePlan({ direction: "1", confidence: "0.5", availableCapital: "0" }),
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.isFlat).toBe(true);
    expect(decToString(plan.estimatedTotalCost)).toBe("0.00000000");
  });

  it("respects maxCapital as an additional budget ceiling", () => {
    const input = makePlan({
      direction: "1",
      confidence: "0.5",
      availableCapital: "1000",
      maxCapital: "2.00",
    });
    const plan = planRebalance(input);
    expect(decToString(plan.actions[0]!.qty)).toBe("4.44444444"); // 2.00 / 0.45 at 8 dp
    expect(decToString(plan.estimatedTotalCost)).toBe("2.00000000");
  });
});

describe("planRebalance — risk limits and invariants", () => {
  it("never exceeds the directional cap", () => {
    const input = makePlan({
      direction: "1",
      confidence: "1",
      maxResidual: "100",
      maxDirectionalShares: "20",
      upLots: [lot("up", "u1", "150", "0.45"), lot("up", "u2", "20", "0.46", millis(T0 + 1))],
      downLots: [lot("down", "d1", "150", "0.55")],
    });
    const plan = planRebalance(input);
    expectPlanInvariants(plan, input);
    // Residual is already 20 == cap; no further directional buy is proposed.
    expect(plan.actions).toHaveLength(0);
    expect(decToString(plan.residualUp)).toBe("20.00000000");
  });

  it("never proposes negative quantities or sells (buy-side intents only)", () => {
    const plan = planRebalance(
      makePlan({
        direction: "-1",
        confidence: "1",
        upLots: [lot("up", "u1", "300", "0.45")],
        downLots: [lot("down", "d1", "100", "0.55")],
        maxResidual: "20",
      }),
    );
    for (const action of plan.actions) {
      expect(decCompare(action.qty, d("0"))).toBeGreaterThan(0);
    }
    // 200 residual Up vs target 0: no sell is proposed; hedging is a buy.
    // (All planner kinds are buy-side by construction.)
    expect(plan.actions.every((a) => a.kind === "rebalance_down")).toBe(true);
  });

  it("is deterministic: identical inputs produce identical decisions", () => {
    const input = makePlan({ direction: "1", confidence: "0.5", upPrice: "0.40" });
    expect(planRebalance(input)).toEqual(planRebalance(input));
  });
});

describe("planRebalance — invalid inputs", () => {
  it("rejects non-positive prices, settlement, and negative limits", () => {
    expect(() => planRebalance(makePlan({ upPrice: "0" }))).toThrow(ValidationError);
    expect(() => planRebalance(makePlan({ downPrice: "-0.5" }))).toThrow(ValidationError);
    expect(() => planRebalance(makePlan({ settlement: "0" }))).toThrow(ValidationError);
    expect(() => planRebalance(makePlan({ maxResidual: "-1" }))).toThrow(ValidationError);
    expect(() => planRebalance(makePlan({ maxDirectionalShares: "-1" }))).toThrow(ValidationError);
    expect(() => planRebalance(makePlan({ availableCapital: "-5" }))).toThrow(ValidationError);
  });

  it("rejects out-of-range signal values", () => {
    expect(() => planRebalance(makePlan({ direction: "1.5" }))).toThrow(ValidationError);
    expect(() => planRebalance(makePlan({ confidence: "-0.2" }))).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// T1: edge-based sizing model (selectable; legacy default unchanged)
// ---------------------------------------------------------------------------

describe("planRebalance — edge sizing model (T1)", () => {
  const edgeParams = {
    pUp: d("0.6"),
    takerFeeRate: d("0.07"),
    kellyFraction: d("0.25"),
    minEdge: d("0.01"),
  };

  it("sizes from the net edge against the executable asks, not direction x confidence", () => {
    // p_up 0.6, asks 0.50/0.50: edge_up = 0.0825 -> Up target (Kelly-sized).
    const plan = planRebalance(
      makePlan({
        direction: "1",
        confidence: "1",
        upPrice: "0.50",
        downPrice: "0.50",
        sizing: { model: "edge", edge: edgeParams },
      }),
    );
    expect(plan.targetResidualUp > d("0")).toBe(true);
    expect(plan.targetResidualDown.toString()).toBe("0");
    // Legacy directional model with direction=1, confidence=1 would target the
    // full maxResidual (100); the Kelly-sized target must be strictly smaller.
    expect(decCompare(plan.targetResidualUp, d("100"))).toBeLessThan(0);
    // And a rebalance_up action exists with a positive qty.
    const act = plan.actions.find((a) => a.kind === "rebalance_up");
    expect(act !== undefined).toBe(true);
  });

  it("gives no target action when the net edge is below minEdge", () => {
    // p_up 0.51 vs ask 0.55: edge_up < 0 and edge_down (0.49 - 0.55 - fee) < 0.
    const plan = planRebalance(
      makePlan({
        direction: "1",
        confidence: "1",
        upPrice: "0.55",
        downPrice: "0.55",
        sizing: { model: "edge", edge: { ...edgeParams, pUp: d("0.51") } },
      }),
    );
    expect(plan.targetResidualUp.toString()).toBe("0");
    expect(plan.targetResidualDown.toString()).toBe("0");
    expect(plan.actions.find((a) => a.kind.startsWith("rebalance_"))).toBeUndefined();
  });

  it("respects a positive set edge: accumulate_sets still fires under the edge model", () => {
    // Asks 0.45/0.50 sum to 0.95 -> set edge 0.05 per set.
    const plan = planRebalance(
      makePlan({ upPrice: "0.45", downPrice: "0.50", sizing: { model: "edge", edge: edgeParams } }),
    );
    expect(plan.setEdgePositive).toBe(true);
    expect(plan.actions.find((a) => a.kind === "accumulate_sets")).toBeDefined();
  });

  it("keeps the legacy directional target identical when sizing is omitted", () => {
    const legacy = planRebalance(makePlan({ direction: "1", confidence: "0.8" }));
    const explicit = planRebalance(
      makePlan({ direction: "1", confidence: "0.8", sizing: { model: "directional" } }),
    );
    expect(legacy.targetResidualUp.toString()).toBe(explicit.targetResidualUp.toString());
    expect(decCompare(legacy.targetResidualUp, d("80"))).toBe(0); // 1 x 0.8 x 100 x 1.0
  });
});
