import { describe, expect, it } from "vitest";

import {
  InvalidTransitionError,
  ValidationError,
  applyInventoryFill,
  availableBalance,
  createBalance,
  createInventory,
  deposit,
  marketExposure,
  marketId,
  millis,
  openPositions,
  positionKey,
  release,
  reserve,
  settleMarket,
  settleReservation,
  tokenId,
  totalEquity,
  totalRealizedPnl,
  totalUnrealizedPnl,
  decFromInt,
  decFromString,
  decToString,
  decZero,
  withdraw,
} from "./index.js";

const T0 = millis(1_700_000_000_000);
const M = marketId("0xmarket123456");
const UP = tokenId("1111111111");
const DOWN = tokenId("2222222222");

function makeInventory() {
  return createInventory({ cash: decFromInt(100), at: T0 });
}

describe("inventory fills", () => {
  it("buys add shares and remove cash including fees", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.40"),
        qty: decFromInt(10),
        fee: decFromString("0.01"),
      },
      T0,
    );
    // cash = 100 - 10*0.4 - 0.01 = 95.99
    expect(decToString(inv.cash)).toBe("95.99000000");
    expect(openPositions(inv)).toHaveLength(1);
  });

  it("sells return cash and reduce shares", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.40"),
        qty: decFromInt(10),
      },
      T0,
    );
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "sell",
        price: decFromString("0.60"),
        qty: decFromInt(4),
      },
      T0,
    );
    // cash = 100 - 4 + 2.4 = 98.4
    expect(decToString(inv.cash)).toBe("98.40000000");
  });

  it("rejects buys beyond cash and sells beyond holdings", () => {
    const inv = makeInventory();
    expect(() =>
      applyInventoryFill(
        inv,
        {
          marketId: M,
          tokenId: UP,
          outcome: "up",
          side: "buy",
          price: decFromString("0.9"),
          qty: decFromInt(200),
        },
        T0,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      applyInventoryFill(
        inv,
        {
          marketId: M,
          tokenId: UP,
          outcome: "up",
          side: "sell",
          price: decFromString("0.9"),
          qty: decFromInt(1),
        },
        T0,
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("keys positions by market and token", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.4"),
        qty: decFromInt(5),
      },
      T0,
    );
    expect(inv.positions[positionKey(M, UP)]).toBeDefined();
    expect(inv.positions[positionKey(M, DOWN)]).toBeUndefined();
  });
});

describe("settlement", () => {
  it("pays winners, zeroes losers, and books realized PnL", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.4"),
        qty: decFromInt(10),
      },
      T0,
    );
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: DOWN,
        outcome: "down",
        side: "buy",
        price: decFromString("0.6"),
        qty: decFromInt(10),
      },
      T0,
    );
    inv = settleMarket(inv, M, UP, decFromInt(1), T0);
    // cash = 100 - 4 - 6 + 10 = 100; realized = +6 on up, -6 on down = 0
    expect(decToString(inv.cash)).toBe("100.00000000");
    expect(decToString(totalRealizedPnl(inv))).toBe("0.00000000");
    expect(openPositions(inv)).toHaveLength(0);
  });

  it("books a profit when the winner was bought below par", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.4"),
        qty: decFromInt(10),
      },
      T0,
    );
    inv = settleMarket(inv, M, UP, decFromInt(1), T0);
    // cash = 100 - 4 + 10 = 106
    expect(decToString(inv.cash)).toBe("106.00000000");
    expect(decToString(totalRealizedPnl(inv))).toBe("6.00000000");
  });
});

describe("exposure and equity", () => {
  it("computes signed per-market exposure", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.4"),
        qty: decFromInt(10),
      },
      T0,
    );
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: DOWN,
        outcome: "down",
        side: "buy",
        price: decFromString("0.6"),
        qty: decFromInt(5),
      },
      T0,
    );
    const marks: Record<string, ReturnType<typeof decFromString>> = {
      [positionKey(M, UP)]: decFromString("0.7"),
      [positionKey(M, DOWN)]: decFromString("0.3"),
    };
    // up value 7, down value 1.5 => exposure +5.5
    expect(decToString(marketExposure(inv, M, marks))).toBe("5.50000000");
    // equity = cash (100-4-3=93) + 7 + 1.5 = 101.5
    expect(decToString(totalEquity(inv, marks))).toBe("101.50000000");
  });

  it("totals unrealized PnL across open positions only", () => {
    let inv = makeInventory();
    inv = applyInventoryFill(
      inv,
      {
        marketId: M,
        tokenId: UP,
        outcome: "up",
        side: "buy",
        price: decFromString("0.4"),
        qty: decFromInt(10),
      },
      T0,
    );
    const marks = { [positionKey(M, UP)]: decFromString("0.45") };
    expect(decToString(totalUnrealizedPnl(inv, marks))).toBe("0.50000000");
  });
});

describe("account balance", () => {
  it("reserving reduces availability and restores on release", () => {
    let b = createBalance({ total: decFromInt(100), at: T0 });
    expect(decToString(availableBalance(b))).toBe("100.00000000");
    b = reserve(b, decFromInt(30), T0);
    expect(decToString(availableBalance(b))).toBe("70.00000000");
    b = release(b, decFromInt(30), T0);
    expect(decToString(availableBalance(b))).toBe("100.00000000");
  });

  it("rejects over-reserve and over-release", () => {
    let b = createBalance({ total: decFromInt(100), at: T0 });
    expect(() => reserve(b, decFromInt(101), T0)).toThrow(ValidationError);
    b = reserve(b, decFromInt(10), T0);
    expect(() => release(b, decFromInt(11), T0)).toThrow(ValidationError);
  });

  it("settles a reservation into a real outflow", () => {
    let b = createBalance({ total: decFromInt(100), at: T0 });
    b = reserve(b, decFromInt(50), T0);
    b = settleReservation(b, decFromInt(50), decFromInt(40), T0);
    // spent 40 of the reserved 50
    expect(decToString(b.total)).toBe("60.00000000");
    expect(decToString(b.reserved)).toBe("0.00000000");
    expect(decToString(availableBalance(b))).toBe("60.00000000");
  });

  it("withdraw only touches available cash", () => {
    let b = createBalance({ total: decFromInt(100), at: T0 });
    b = reserve(b, decFromInt(40), T0);
    expect(() => withdraw(b, decFromInt(61), T0)).toThrow(ValidationError);
    b = withdraw(b, decFromInt(60), T0);
    expect(decToString(b.total)).toBe("40.00000000");
    b = deposit(b, decFromInt(10), T0);
    expect(decToString(b.total)).toBe("50.00000000");
  });

  it("never allows negative cash or reserved", () => {
    const b = createBalance({ total: decZero(), at: T0 });
    expect(() => reserve(b, decFromString("0.01"), T0)).toThrow(ValidationError);
    expect(() => withdraw(b, decFromString("0.01"), T0)).toThrow(ValidationError);
    expect(() => createBalance({ total: decFromString("-1"), at: T0 })).toThrow(ValidationError);
  });
});
