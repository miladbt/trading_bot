import { describe, expect, it } from "vitest";

import {
  ValidationError,
  decAdd,
  decFromInt,
  decFromString,
  decMulRound,
  decSub,
  decToString,
  marketId,
  millis,
  tokenId,
  type Decimal,
} from "@bot/domain";

import {
  createAcquisitionLot,
  lotGrossCost,
  lotNetCost,
  matchCompleteSets,
  type AcquisitionLot,
  type CompleteSetMatchResult,
  type CreateAcquisitionLotInput,
} from "./index.js";

const MARKET = marketId("703257");
const UP_TOKEN = tokenId("1111111111");
const DOWN_TOKEN = tokenId("2222222222");
const T0 = millis(1_800_000_000_000);

type LotSpec = Omit<CreateAcquisitionLotInput, "marketId" | "tokenId" | "outcome" | "acquiredAt"> &
  Partial<Pick<CreateAcquisitionLotInput, "acquiredAt">>;

function upLot(spec: LotSpec): AcquisitionLot {
  return createAcquisitionLot({
    ...spec,
    marketId: MARKET,
    tokenId: UP_TOKEN,
    outcome: "up",
    acquiredAt: spec.acquiredAt ?? T0,
  });
}

function downLot(spec: LotSpec): AcquisitionLot {
  return createAcquisitionLot({
    ...spec,
    marketId: MARKET,
    tokenId: DOWN_TOKEN,
    outcome: "down",
    acquiredAt: spec.acquiredAt ?? T0,
  });
}

const d = (s: string): Decimal => decFromString(s);

function expectMoney(actual: Decimal, expected: string): void {
  expect(decToString(actual)).toBe(expected);
}

/** Sum a list of quantities. */
function sumQty(qtys: readonly Decimal[]): Decimal {
  return qtys.reduce((acc, q) => decAdd(acc, q), 0n as Decimal);
}

/** Invariants that must hold for every result, including degenerate ones. */
function expectConsistent(r: CompleteSetMatchResult): void {
  expectMoney(r.grossPairCost, decToString(decAdd(r.upCost, r.downCost)));
  expectMoney(r.netPairCost, decToString(decSub(decAdd(r.grossPairCost, r.fees), r.rebates)));
  expectMoney(r.grossEdge, decToString(decSub(r.expectedSettlementValue, r.grossPairCost)));
  expectMoney(r.netEdge, decToString(decSub(r.expectedSettlementValue, r.netPairCost)));
  expectMoney(
    r.expectedSettlementValue,
    decToString(decMulRound(r.settlementValue, r.matchedSets)),
  );
  // Conservation: matched + residual == inventory on each side.
  expectMoney(
    decAdd(r.matchedSets, r.residualUp),
    decToString(
      sumQty([...r.matchedUpLots.map((p) => p.qty), ...r.residualUpLots.map((l) => l.qty)]),
    ),
  );
  expectMoney(
    decAdd(r.matchedSets, r.residualDown),
    decToString(
      sumQty([...r.matchedDownLots.map((p) => p.qty), ...r.residualDownLots.map((l) => l.qty)]),
    ),
  );
}

describe("createAcquisitionLot", () => {
  it("normalizes fee/rebate defaults to zero", () => {
    const lot = upLot({ lotId: "l1", qty: d("10"), pricePerUnit: d("0.45") });
    expectMoney(lot.fee, "0.00000000");
    expectMoney(lot.rebate, "0.00000000");
    expectMoney(lotGrossCost(lot), "4.50000000");
    expectMoney(lotNetCost(lot), "4.50000000");
  });

  it("computes net cost as gross + fee - rebate", () => {
    const lot = downLot({
      lotId: "l2",
      qty: d("20"),
      pricePerUnit: d("0.55"),
      fee: d("0.10"),
      rebate: d("0.03"),
    });
    expectMoney(lotGrossCost(lot), "11.00000000");
    expectMoney(lotNetCost(lot), "11.07000000");
  });

  it("rejects invalid quantities, prices, fees, rebates, and ids", () => {
    expect(() => upLot({ lotId: "", qty: d("1"), pricePerUnit: d("0.5") })).toThrow(
      ValidationError,
    );
    expect(() => upLot({ lotId: "x", qty: d("0"), pricePerUnit: d("0.5") })).toThrow(
      ValidationError,
    );
    expect(() => upLot({ lotId: "x", qty: d("-5"), pricePerUnit: d("0.5") })).toThrow(
      ValidationError,
    );
    expect(() => upLot({ lotId: "x", qty: d("1"), pricePerUnit: d("0") })).toThrow(ValidationError);
    expect(() => upLot({ lotId: "x", qty: d("1"), pricePerUnit: d("-0.1") })).toThrow(
      ValidationError,
    );
    expect(() =>
      upLot({ lotId: "x", qty: d("1"), pricePerUnit: d("0.5"), fee: d("-0.01") }),
    ).toThrow(ValidationError);
    expect(() =>
      upLot({ lotId: "x", qty: d("1"), pricePerUnit: d("0.5"), rebate: d("-0.01") }),
    ).toThrow(ValidationError);
  });
});

describe("matchCompleteSets — exact matching", () => {
  it("matches equal inventories into full sets with no residuals", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("150"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("150"), pricePerUnit: d("0.53") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "150.00000000");
    expectMoney(r.upCost, "67.50000000");
    expectMoney(r.downCost, "79.50000000");
    expectMoney(r.grossPairCost, "147.00000000");
    expectMoney(r.fees, "0.00000000");
    expectMoney(r.rebates, "0.00000000");
    expectMoney(r.netPairCost, "147.00000000");
    expectMoney(r.expectedSettlementValue, "150.00000000");
    expectMoney(r.grossEdge, "3.00000000");
    expectMoney(r.netEdge, "3.00000000");
    expectMoney(r.residualUp, "0.00000000");
    expectMoney(r.residualDown, "0.00000000");
    expect(r.residualUpLots).toHaveLength(0);
    expect(r.residualDownLots).toHaveLength(0);
    expectMoney(r.settlementValue, "1.00000000");
  });

  it("reports per-lot matched portions and one portfolio per side at a single price", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("25"), pricePerUnit: d("0.40") })],
      downLots: [downLot({ lotId: "d1", qty: d("25"), pricePerUnit: d("0.58") })],
    });
    expectConsistent(r);
    expect(r.matchedUpLots).toHaveLength(1);
    expect(r.matchedDownLots).toHaveLength(1);
    expectMoney(r.matchedUpLots[0]!.qty, "25.00000000");
    expect(r.matchedUpLots[0]!.lotId).toBe("u1");
    expect(r.matchedUpLots[0]!.outcome).toBe("up");
    expect(r.matchedUpLots[0]!.marketId).toBe(String(MARKET));
    expect(r.matchedUpLots[0]!.tokenId).toBe(String(UP_TOKEN));
    expect(r.perPortfolio).toHaveLength(2);
    const up = r.perPortfolio.find((p) => p.side === "up")!;
    const down = r.perPortfolio.find((p) => p.side === "down")!;
    expectMoney(up.qty, "25.00000000");
    expectMoney(up.grossPairCost, "10.00000000");
    expectMoney(down.grossPairCost, "14.50000000");
    // netEdge = (1 - (0.40 + 0.58)) per set, times 25 sets = 0.50
    expectMoney(r.netEdge, "0.50000000");
  });
});

describe("matchCompleteSets — partial matching", () => {
  it("matches the example: Up=200, Down=150 -> matched 150, residualUp 50, residualDown 0", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("200"), pricePerUnit: d("0.48") })],
      downLots: [downLot({ lotId: "d1", qty: d("150"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "150.00000000");
    expectMoney(r.residualUp, "50.00000000");
    expectMoney(r.residualDown, "0.00000000");
    expect(r.residualDownLots).toHaveLength(0);
    expect(r.residualUpLots).toHaveLength(1);
    expectMoney(r.residualUpLots[0]!.qty, "50.00000000");
    expectMoney(r.upCost, "72.00000000"); // 150 * 0.48 (not the full 200)
    expectMoney(r.downCost, "75.00000000"); // 150 * 0.50
    expectMoney(r.grossPairCost, "147.00000000");
    expectMoney(r.grossEdge, "3.00000000");
  });

  it("keeps the surplus on the down side when down outnumbers up (no forced neutrality)", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("40"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "10.00000000");
    expectMoney(r.residualUp, "0.00000000");
    expectMoney(r.residualDown, "30.00000000");
    expect(r.residualDownLots[0]!.lotId).toBe("d1");
    expectMoney(r.residualDownLots[0]!.qty, "30.00000000");
  });

  it("splits a partially consumed lot across the match and the residual", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("7"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("5"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "5.00000000");
    expectMoney(r.matchedUpLots[0]!.qty, "5.00000000");
    expect(r.residualUpLots[0]!.lotId).toBe("u1");
    expectMoney(r.residualUpLots[0]!.qty, "2.00000000");
    // the residual lot keeps its original price
    expectMoney(r.residualUpLots[0]!.pricePerUnit, "0.45000000");
  });
});

describe("matchCompleteSets — multiple price lots and FIFO order", () => {
  it("consumes the earliest-acquired lots first (FIFO)", () => {
    const r = matchCompleteSets({
      upLots: [
        upLot({
          lotId: "u-cheap",
          qty: d("10"),
          pricePerUnit: d("0.30"),
          acquiredAt: millis(T0 + 1),
        }),
        upLot({ lotId: "u-rich", qty: d("10"), pricePerUnit: d("0.60"), acquiredAt: T0 }),
      ],
      downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "10.00000000");
    // FIFO: u-rich was acquired first despite being listed second.
    expectMoney(r.upCost, "6.00000000");
    expect(r.matchedUpLots[0]!.lotId).toBe("u-rich");
    expect(r.residualUpLots.map((l) => l.lotId)).toEqual(["u-cheap"]);
    expectMoney(r.grossPairCost, "11.00000000");
  });

  it("splits a pair across several price lots with partial consumption", () => {
    const r = matchCompleteSets({
      upLots: [
        upLot({ lotId: "u1", qty: d("60"), pricePerUnit: d("0.40"), acquiredAt: T0 }),
        upLot({
          lotId: "u2",
          qty: d("60"),
          pricePerUnit: d("0.50"),
          acquiredAt: millis(T0 + 1000),
        }),
      ],
      downLots: [
        downLot({ lotId: "d1", qty: d("50"), pricePerUnit: d("0.55"), acquiredAt: T0 }),
        downLot({
          lotId: "d2",
          qty: d("50"),
          pricePerUnit: d("0.60"),
          acquiredAt: millis(T0 + 1000),
        }),
      ],
    });
    expectConsistent(r);
    // Up=120, Down=100 -> 100 sets.
    expectMoney(r.matchedSets, "100.00000000");
    // Up consumed: all of u1 (60) + 40 of u2. Down consumed: all of d1 (50) + 50 of d2.
    expectMoney(r.upCost, "44.00000000"); // 60*0.40 + 40*0.50
    expectMoney(r.downCost, "57.50000000"); // 50*0.55 + 50*0.60
    expectMoney(r.grossPairCost, "101.50000000");
    expectMoney(r.residualUp, "20.00000000");
    expectMoney(r.residualDown, "0.00000000");
    expect(r.residualUpLots.map((l) => l.lotId)).toEqual(["u2"]);
    expectMoney(r.residualUpLots[0]!.qty, "20.00000000");
    expect(r.residualDownLots).toHaveLength(0);
    // Portfolios: one per (side, price) that contributed: u@0.40, u@0.50, d@0.55, d@0.60.
    expect(r.perPortfolio).toHaveLength(4);
    expect(r.perPortfolio.map((p) => `${p.side}@${decToString(p.pricePerUnit)}`)).toEqual([
      "up@0.40000000",
      "up@0.50000000",
      "down@0.55000000",
      "down@0.60000000",
    ]);
  });

  it("breaks FIFO ties by input order deterministically", () => {
    const lots = () => [
      upLot({ lotId: "first", qty: d("5"), pricePerUnit: d("0.45"), acquiredAt: T0 }),
      upLot({ lotId: "second", qty: d("5"), pricePerUnit: d("0.55"), acquiredAt: T0 }),
    ];
    const a = matchCompleteSets({
      upLots: lots(),
      downLots: [downLot({ lotId: "d1", qty: d("5"), pricePerUnit: d("0.50") })],
    });
    const b = matchCompleteSets({
      upLots: lots(),
      downLots: [downLot({ lotId: "d1", qty: d("5"), pricePerUnit: d("0.50") })],
    });
    expect(a.matchedUpLots[0]!.lotId).toBe("first");
    expect(a).toEqual(b); // deterministic: same inputs, same outputs
    expectMoney(a.upCost, "2.25000000");
  });
});

describe("matchCompleteSets — fees and rebates", () => {
  it("amortizes per-lot fees pro-rata into the matched quantity", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("100"), pricePerUnit: d("0.45"), fee: d("1.00") })],
      downLots: [downLot({ lotId: "d1", qty: d("80"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "80.00000000");
    // Up fee amortized to 80/100 of 1.00 = 0.80; down has none.
    expectMoney(r.fees, "0.80000000");
    expectMoney(r.rebates, "0.00000000");
    expectMoney(r.upCost, "36.00000000");
    expectMoney(r.downCost, "40.00000000");
    expectMoney(r.grossPairCost, "76.00000000");
    expectMoney(r.netPairCost, "76.80000000");
    expectMoney(r.grossEdge, "4.00000000");
    expectMoney(r.netEdge, "3.20000000");
    // The residual 20 up shares keep their lot fee out of the matched books.
    expectMoney(r.residualUpLots[0]!.qty, "20.00000000");
  });

  it("amortizes rebates as a cost reduction", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("50"), pricePerUnit: d("0.45"), rebate: d("0.50") })],
      downLots: [
        downLot({ lotId: "d1", qty: d("50"), pricePerUnit: d("0.50"), rebate: d("0.25") }),
      ],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "50.00000000");
    expectMoney(r.rebates, "0.75000000");
    expectMoney(r.grossPairCost, "47.50000000");
    expectMoney(r.netPairCost, "46.75000000");
    expectMoney(r.netEdge, "3.25000000");
  });

  it("combines fees and rebates across lots and keeps the exact net identity", () => {
    const r = matchCompleteSets({
      upLots: [
        upLot({
          lotId: "u1",
          qty: d("30"),
          pricePerUnit: d("0.47"),
          fee: d("0.60"),
          rebate: d("0.15"),
        }),
        upLot({
          lotId: "u2",
          qty: d("20"),
          pricePerUnit: d("0.52"),
          fee: d("0.10"),
          acquiredAt: millis(T0 + 5),
        }),
      ],
      downLots: [
        downLot({ lotId: "d1", qty: d("40"), pricePerUnit: d("0.50"), rebate: d("0.20") }),
      ],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "40.00000000");
    // Up: all of u1 (fee 0.60, rebate 0.15) + 10 of u2 (fee 0.10 * 10/20 = 0.05).
    expectMoney(r.fees, "0.65000000");
    expectMoney(r.rebates, "0.35000000");
    expectMoney(r.grossPairCost, "39.30000000"); // 30*0.47 + 10*0.52 + 40*0.50
    expectMoney(r.netPairCost, "39.60000000"); // 39.30 + 0.65 - 0.35
    expectMoney(r.grossEdge, "0.70000000"); // 40 - 39.30
    expectMoney(r.netEdge, "0.40000000"); // 40 - 39.60
  });

  it("keeps a negative edge negative (costs above settlement are a loss, not hidden)", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.70") })],
      downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.60") })],
    });
    expectConsistent(r);
    expectMoney(r.grossPairCost, "13.00000000");
    expectMoney(r.expectedSettlementValue, "10.00000000");
    expectMoney(r.grossEdge, "-3.00000000");
  });
});

describe("matchCompleteSets — zero inventory", () => {
  it("returns an all-zero result for empty inputs", () => {
    const r = matchCompleteSets({ upLots: [], downLots: [] });
    expectConsistent(r);
    expectMoney(r.matchedSets, "0.00000000");
    expectMoney(r.upCost, "0.00000000");
    expectMoney(r.downCost, "0.00000000");
    expectMoney(r.grossPairCost, "0.00000000");
    expectMoney(r.netPairCost, "0.00000000");
    expectMoney(r.expectedSettlementValue, "0.00000000");
    expectMoney(r.grossEdge, "0.00000000");
    expectMoney(r.netEdge, "0.00000000");
    expectMoney(r.residualUp, "0.00000000");
    expectMoney(r.residualDown, "0.00000000");
    expect(r.perPortfolio).toHaveLength(0);
    expect(r.matchedUpLots).toHaveLength(0);
    expect(r.matchedDownLots).toHaveLength(0);
  });

  it("preserves the full inventory when one side is empty (no forced neutrality)", () => {
    const r = matchCompleteSets({
      upLots: [
        upLot({ lotId: "u1", qty: d("25"), pricePerUnit: d("0.45") }),
        upLot({ lotId: "u2", qty: d("15"), pricePerUnit: d("0.48"), acquiredAt: millis(T0 + 1) }),
      ],
      downLots: [],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "0.00000000");
    expectMoney(r.residualUp, "40.00000000");
    expectMoney(r.residualDown, "0.00000000");
    expect(r.residualUpLots.map((l) => l.lotId)).toEqual(["u1", "u2"]);
    expectMoney(r.upCost, "0.00000000");
    expect(r.perPortfolio).toHaveLength(0);
  });

  it("preserves down-only inventory symmetrically", () => {
    const r = matchCompleteSets({
      upLots: [],
      downLots: [downLot({ lotId: "d1", qty: d("9"), pricePerUnit: d("0.55") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "0.00000000");
    expectMoney(r.residualDown, "9.00000000");
    expect(r.residualDownLots[0]!.lotId).toBe("d1");
  });
});

describe("matchCompleteSets — invalid quantities and inputs", () => {
  it("rejects zero or negative lot quantities", () => {
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("0"), pricePerUnit: d("0.45") })],
        downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50") })],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") })],
        downLots: [downLot({ lotId: "d1", qty: d("-3"), pricePerUnit: d("0.50") })],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects non-positive prices and negative fees/rebates", () => {
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0") })],
        downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50") })],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45"), fee: d("-1") })],
        downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50") })],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") })],
        downLots: [
          downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50"), rebate: d("-0.01") }),
        ],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an outcome mismatch on either side", () => {
    const wrongSide = createAcquisitionLot({
      lotId: "w1",
      marketId: MARKET,
      tokenId: UP_TOKEN,
      outcome: "up",
      qty: d("10"),
      pricePerUnit: d("0.45"),
      acquiredAt: T0,
    });
    expect(() => matchCompleteSets({ upLots: [wrongSide], downLots: [wrongSide] })).toThrow(
      ValidationError,
    );
  });

  it("rejects lots from different markets", () => {
    const otherMarket = marketId("703999");
    const foreignDown = createAcquisitionLot({
      lotId: "d1",
      marketId: otherMarket,
      tokenId: DOWN_TOKEN,
      outcome: "down",
      qty: d("10"),
      pricePerUnit: d("0.50"),
      acquiredAt: T0,
    });
    const foreignUp = createAcquisitionLot({
      lotId: "u2",
      marketId: otherMarket,
      tokenId: UP_TOKEN,
      outcome: "up",
      qty: d("10"),
      pricePerUnit: d("0.45"),
      acquiredAt: T0,
    });
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") })],
        downLots: [foreignDown],
      }),
    ).toThrow(ValidationError);
    // also within one side
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") }), foreignUp],
        downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50") })],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a non-positive settlement value", () => {
    expect(() =>
      matchCompleteSets({
        upLots: [upLot({ lotId: "u1", qty: d("1"), pricePerUnit: d("0.45") })],
        downLots: [downLot({ lotId: "d1", qty: d("1"), pricePerUnit: d("0.50") })],
        settlementValue: d("0"),
      }),
    ).toThrow(ValidationError);
  });
});

describe("matchCompleteSets — decimal precision", () => {
  it("carries 8-dp values exactly (no float drift)", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("0.00000003"), pricePerUnit: d("0.12345678") })],
      downLots: [downLot({ lotId: "d1", qty: d("0.00000003"), pricePerUnit: d("0.87654321") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "0.00000003");
    // 0.00000003 * 0.12345678 = 0.0000000037... -> rounds to 0.00000000 at 8 dp
    expectMoney(r.upCost, "0.00000000");
    // 0.00000003 * 0.87654321 = 0.0000000263... -> rounds to 0.00000003
    expectMoney(r.downCost, "0.00000003");
    expectMoney(r.grossEdge, "0.00000000");
  });

  it("computes a third-of-a-unit match with exact rounding at 8 dp", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("1"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("0.33333333"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "0.33333333");
    expectMoney(r.upCost, "0.15000000"); // 0.45 * 0.33333333 = 0.1499999985 -> 0.15000000
    expectMoney(r.downCost, "0.16666667"); // 0.50 * 0.33333333 = 0.166666665 -> 0.16666667
    expectMoney(r.grossPairCost, "0.31666667");
    expectMoney(r.expectedSettlementValue, "0.33333333");
    expectMoney(r.grossEdge, "0.01666666");
    expectMoney(r.residualUp, "0.66666667");
  });

  it("splits fractional fees across match and residual without drift", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("3"), pricePerUnit: d("0.45"), fee: d("0.01") })],
      downLots: [downLot({ lotId: "d1", qty: d("1"), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "1.00000000");
    // fee amortized: 0.01 * 1 / 3 = 0.00333333 (rounded half away from zero)
    expectMoney(r.fees, "0.00333333");
    expectMoney(r.netPairCost, "0.95333333"); // 0.45 + 0.50 + fee
    expectMoney(r.residualUp, "2.00000000");
  });

  it("scales the expected settlement value by the matched quantity", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.52") })],
      settlementValue: d("1.02"),
    });
    expectConsistent(r);
    expectMoney(r.expectedSettlementValue, "10.20000000");
    expectMoney(r.grossPairCost, "9.70000000");
    expectMoney(r.grossEdge, "0.50000000");
  });

  it("supports whole-share Decimals built from integers", () => {
    const r = matchCompleteSets({
      upLots: [upLot({ lotId: "u1", qty: decFromInt(5), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: decFromInt(7), pricePerUnit: d("0.50") })],
    });
    expectConsistent(r);
    expectMoney(r.matchedSets, "5.00000000");
    expectMoney(r.residualDown, "2.00000000");
  });
});

describe("matchCompleteSets — purity", () => {
  it("does not mutate the input lots and returns fresh residual objects", () => {
    const up = upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") });
    const down = downLot({ lotId: "d1", qty: d("4"), pricePerUnit: d("0.50") });
    const upQtyBefore = decToString(up.qty);
    const downQtyBefore = decToString(down.qty);
    const r = matchCompleteSets({ upLots: [up], downLots: [down] });
    expect(decToString(up.qty)).toBe(upQtyBefore);
    expect(decToString(down.qty)).toBe(downQtyBefore);
    // residual lots are new objects, never aliases of the inputs
    expect(r.residualUpLots[0]).not.toBe(up);
    expect(r.matchedDownLots[0]).not.toBe(down);
  });

  it("is deterministic across repeated calls", () => {
    const input = {
      upLots: [
        upLot({ lotId: "u1", qty: d("30"), pricePerUnit: d("0.45"), acquiredAt: T0 }),
        upLot({ lotId: "u2", qty: d("30"), pricePerUnit: d("0.47"), acquiredAt: millis(T0 + 1) }),
      ],
      downLots: [downLot({ lotId: "d1", qty: d("45"), pricePerUnit: d("0.50") })],
    };
    const a = matchCompleteSets(input);
    const b = matchCompleteSets(input);
    expect(a).toEqual(b);
  });
});

describe("matchCompleteSets — invariants across scenarios", () => {
  const scenarios: readonly {
    readonly name: string;
    readonly upLots: readonly AcquisitionLot[];
    readonly downLots: readonly AcquisitionLot[];
  }[] = [
    {
      name: "exact match",
      upLots: [upLot({ lotId: "u1", qty: d("10"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("10"), pricePerUnit: d("0.50") })],
    },
    {
      name: "unequal match (example 200/150)",
      upLots: [upLot({ lotId: "u1", qty: d("200"), pricePerUnit: d("0.45") })],
      downLots: [downLot({ lotId: "d1", qty: d("150"), pricePerUnit: d("0.50") })],
    },
    {
      name: "multi-lot with fees and rebates",
      upLots: [
        upLot({
          lotId: "u1",
          qty: d("12.5"),
          pricePerUnit: d("0.43"),
          fee: d("0.05"),
          rebate: d("0.01"),
        }),
        upLot({ lotId: "u2", qty: d("7.5"), pricePerUnit: d("0.49"), fee: d("0.02") }),
      ],
      downLots: [
        downLot({ lotId: "d1", qty: d("14"), pricePerUnit: d("0.51"), rebate: d("0.03") }),
      ],
    },
    {
      name: "one-sided up-only inventory",
      upLots: [upLot({ lotId: "u1", qty: d("5"), pricePerUnit: d("0.45") })],
      downLots: [],
    },
  ];

  it.each(scenarios)("$name: conservation and identity hold", ({ upLots, downLots }) => {
    const r = matchCompleteSets({ upLots, downLots });
    expectConsistent(r);

    // Conservation against the raw input totals.
    expectMoney(decAdd(r.matchedSets, r.residualUp), decToString(sumQty(upLots.map((l) => l.qty))));
    expectMoney(
      decAdd(r.matchedSets, r.residualDown),
      decToString(sumQty(downLots.map((l) => l.qty))),
    );

    // Matched portions sum to the matched quantity per side.
    expectMoney(sumQty(r.matchedUpLots.map((p) => p.qty)), decToString(r.matchedSets));
    expectMoney(sumQty(r.matchedDownLots.map((p) => p.qty)), decToString(r.matchedSets));

    // Residual lot quantities sum to the residual totals.
    expectMoney(sumQty(r.residualUpLots.map((l) => l.qty)), decToString(r.residualUp));
    expectMoney(sumQty(r.residualDownLots.map((l) => l.qty)), decToString(r.residualDown));

    // Portfolio quantities reconcile with the matched portions.
    const upPortfolioQty = r.perPortfolio
      .filter((p) => p.side === "up")
      .reduce((acc, p) => decAdd(acc, p.qty), 0n as Decimal);
    const downPortfolioQty = r.perPortfolio
      .filter((p) => p.side === "down")
      .reduce((acc, p) => decAdd(acc, p.qty), 0n as Decimal);
    expectMoney(upPortfolioQty, decToString(r.matchedSets));
    expectMoney(downPortfolioQty, decToString(r.matchedSets));

    // Portfolio gross costs reconcile with the per-side costs.
    const upPortfolioGross = r.perPortfolio
      .filter((p) => p.side === "up")
      .reduce((acc, p) => decAdd(acc, p.grossPairCost), 0n as Decimal);
    const downPortfolioGross = r.perPortfolio
      .filter((p) => p.side === "down")
      .reduce((acc, p) => decAdd(acc, p.grossPairCost), 0n as Decimal);
    expectMoney(upPortfolioGross, decToString(r.upCost));
    expectMoney(downPortfolioGross, decToString(r.downCost));
  });
});
