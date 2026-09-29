import { describe, expect, it } from "vitest";

import {
  ValidationError,
  canTransitionPhase,
  createMarket,
  createOrderBook,
  bestAsk,
  bestBid,
  costToBuy,
  midPrice,
  outcomeOfToken,
  phaseAt,
  proceedsToSell,
  spread,
  tokenForOutcome,
  transitionPhase,
  millis,
  decFromString,
  decToString,
  decFromInt,
  decZero,
} from "./index.js";

const T0 = millis(1_700_000_000_000);

function makeMarket() {
  return createMarket({
    id: "0xmarket123456",
    slug: "btc-up-down-5m-2026-09-26-1700",
    asset: "btc",
    openAt: T0,
    liveAt: millis(T0 + 240_000),
    settleAt: millis(T0 + 300_000),
    upTokenId: "1111111111",
    downTokenId: "2222222222",
  });
}

describe("createMarket", () => {
  it("builds a market with ordered timestamps and distinct tokens", () => {
    const m = makeMarket();
    expect(m.asset).toBe("BTC");
    expect(m.upToken.outcome).toBe("up");
    expect(m.downToken.outcome).toBe("down");
    expect(m.upToken.tokenId).not.toBe(m.downToken.tokenId);
  });

  it("accepts short numeric venue ids (Gamma-style)", () => {
    const m = createMarket({
      id: "703257",
      slug: "btc-5m-a",
      asset: "btc",
      openAt: T0,
      liveAt: millis(T0 + 240_000),
      settleAt: millis(T0 + 300_000),
      upTokenId: "1111111111",
      downTokenId: "2222222222",
    });
    expect(m.id).toBe("703257");
  });

  it("rejects unordered timestamps and duplicate tokens", () => {
    expect(() =>
      createMarket({
        id: "0xmarket123456",
        slug: "btc-5m-a",
        asset: "btc",
        openAt: millis(T0 + 10),
        liveAt: T0,
        settleAt: millis(T0 + 300_000),
        upTokenId: "1111111111",
        downTokenId: "2222222222",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createMarket({
        id: "0xmarket123456",
        slug: "btc-5m-a",
        asset: "btc",
        openAt: T0,
        liveAt: millis(T0 + 240_000),
        settleAt: millis(T0 + 300_000),
        upTokenId: "same123456",
        downTokenId: "same123456",
      }),
    ).toThrow(ValidationError);
  });
});

describe("market phases", () => {
  it("computes phase from wall clock", () => {
    const m = makeMarket();
    expect(phaseAt(m, millis(T0 - 1))).toBe("announced");
    expect(phaseAt(m, T0)).toBe("open");
    expect(phaseAt(m, millis(T0 + 250_000))).toBe("live");
    expect(phaseAt(m, millis(T0 + 300_000))).toBe("settling");
  });

  it("enforces the phase graph", () => {
    expect(canTransitionPhase("announced", "open")).toBe(true);
    expect(canTransitionPhase("announced", "settled")).toBe(false);
    expect(canTransitionPhase("settled", "open")).toBe(false);
    expect(transitionPhase("open", "live")).toBe("live");
    expect(() => transitionPhase("settled", "open")).toThrow(ValidationError);
  });
});

describe("outcome lookups", () => {
  it("maps tokens to outcomes both ways", () => {
    const m = makeMarket();
    expect(tokenForOutcome(m, "up").tokenId).toBe(m.upToken.tokenId);
    expect(outcomeOfToken(m, m.downToken.tokenId)).toBe("down");
    expect(outcomeOfToken(m, "9999999999" as never)).toBeUndefined();
  });
});

describe("order book", () => {
  const book = createOrderBook({
    tokenId: "1111111111",
    bids: [
      { price: decFromString("0.40"), size: decFromInt(50) },
      { price: decFromString("0.42"), size: decFromInt(30) },
    ],
    asks: [
      { price: decFromString("0.46"), size: decFromInt(20) },
      { price: decFromString("0.48"), size: decFromInt(80) },
    ],
    at: T0,
  });

  it("sorts bids descending and asks ascending", () => {
    expect(bestBid(book)?.price).toEqual(decFromString("0.42"));
    expect(bestAsk(book)?.price).toEqual(decFromString("0.46"));
  });

  it("computes mid and spread", () => {
    expect(decToString(midPrice(book) as never)).toBe("0.44000000");
    expect(decToString(spread(book) as never)).toBe("0.04000000");
  });

  it("sweeps the ask side in price order with VWAP", () => {
    const r = costToBuy(book, decFromInt(30));
    expect(decToString(r.totalSize)).toBe("30.00000000");
    // 20 @ 0.46 + 10 @ 0.48 => vwap = (9.2 + 4.8) / 30 = 0.46666666 (truncated)
    expect(decToString(r.vwap as never)).toBe("0.46666666");
  });

  it("sweeps the bid side for sell proceeds", () => {
    const r = proceedsToSell(book, decFromInt(60));
    expect(decToString(r.totalSize)).toBe("60.00000000");
  });

  it("returns zero size when sweeping more than the book holds", () => {
    const r = costToBuy(book, decFromInt(1000));
    // only 100 shares available
    expect(decToString(r.totalSize)).toBe("100.00000000");
  });

  it("rejects prices outside (0, 1) and negative sizes", () => {
    expect(() =>
      createOrderBook({
        tokenId: "1111111111",
        bids: [{ price: decZero(), size: decFromInt(1) }],
        asks: [],
        at: T0,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createOrderBook({
        tokenId: "1111111111",
        bids: [{ price: decFromString("1.5"), size: decFromInt(1) }],
        asks: [],
        at: T0,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createOrderBook({
        tokenId: "1111111111",
        bids: [{ price: decFromString("0.4"), size: decFromString("-1") }],
        asks: [],
        at: T0,
      }),
    ).toThrow(ValidationError);
  });
});
