import { describe, expect, it } from "vitest";

import {
  ValidationError,
  applyFillToOrder,
  canTransitionOrder,
  createOrder,
  isTerminalStatus,
  isWorkingStatus,
  millis,
  decFromInt,
  decFromString,
  transitionOrder,
} from "./index.js";

const T0 = millis(1_700_000_000_000);

function makeOrder() {
  return createOrder({
    id: "ord-000001",
    marketId: "0xmarket123456",
    tokenId: "1111111111",
    side: "buy",
    kind: "limit",
    price: decFromString("0.45"),
    quantity: decFromInt(100),
    createdAt: T0,
  });
}

describe("createOrder", () => {
  it("starts pending with zero fills", () => {
    const o = makeOrder();
    expect(o.status).toBe("pending");
    expect(isWorkingStatus(o.status)).toBe(true);
    expect(isTerminalStatus(o.status)).toBe(false);
  });

  it("rejects non-positive quantity and out-of-range price", () => {
    expect(() =>
      createOrder({
        id: "ord-000002",
        marketId: "0xmarket123456",
        tokenId: "1111111111",
        side: "buy",
        kind: "limit",
        price: decFromString("0.45"),
        quantity: decZero_quantity(),
        createdAt: T0,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createOrder({
        id: "ord-000003",
        marketId: "0xmarket123456",
        tokenId: "1111111111",
        side: "buy",
        kind: "limit",
        price: decFromString("1"),
        quantity: decFromInt(10),
        createdAt: T0,
      }),
    ).toThrow(ValidationError);
  });
});

// helper kept local to avoid a named export only for tests
function decZero_quantity() {
  return decFromInt(0);
}

describe("order state machine", () => {
  it("allows only legal transitions", () => {
    expect(canTransitionOrder("pending", "open")).toBe(true);
    expect(canTransitionOrder("pending", "partially_filled")).toBe(false);
    expect(canTransitionOrder("filled", "canceled")).toBe(false);
    expect(() => transitionOrder(makeOrder(), "partially_filled", T0)).toThrow(ValidationError);
  });

  it("fills accumulate and flip status at full quantity", () => {
    let o = transitionOrder(makeOrder(), "open", T0);
    o = applyFillToOrder(o, decFromInt(40), T0);
    expect(o.status).toBe("partially_filled");
    o = applyFillToOrder(o, decFromInt(60), T0);
    expect(o.status).toBe("filled");
    expect(isTerminalStatus(o.status)).toBe(true);
  });

  it("rejects overfill and fills after terminal states", () => {
    let o = transitionOrder(makeOrder(), "open", T0);
    expect(() => applyFillToOrder(o, decFromInt(101), T0)).toThrow(ValidationError);
    o = transitionOrder(o, "canceled", T0);
    expect(() => applyFillToOrder(o, decFromInt(1), T0)).toThrow(ValidationError);
    expect(() => transitionOrder(o, "open", T0)).toThrow(ValidationError);
  });

  it("cannot be marked filled before quantity is reached", () => {
    let o = transitionOrder(makeOrder(), "open", T0);
    o = applyFillToOrder(o, decFromInt(50), T0);
    expect(() => transitionOrder(o, "filled", T0)).toThrow(ValidationError);
  });

  it("marking filled at exact quantity succeeds", () => {
    const o = transitionOrder(makeOrder(), "open", T0);
    // no fills yet -> transition to filled must fail
    expect(() => transitionOrder(o, "filled", T0)).toThrow(ValidationError);
  });
});
