import { describe, expect, it } from "vitest";

import { ValidationError, decFromString, decToString, millis, type Decimal } from "@bot/domain";
import { evaluateRiskOrder, riskLimitsFromConfig } from "@bot/risk";
import { DEFAULT_RISK, DEFAULT_STRATEGY } from "@bot/shared";

import { createAcquisitionLot, type AcquisitionLot } from "./lot.js";
import {
  ReconciliationCoordinator,
  compareStates,
  type LocalState,
  type RemoteState,
} from "./index.js";

const T0 = 1_800_000_000_000;
const d = (s: string): Decimal => decFromString(s);

function lot(side: "up" | "down", lotId: string, qty: string, price: string): AcquisitionLot {
  return createAcquisitionLot({
    lotId,
    marketId: "703257" as never,
    tokenId: side === "up" ? ("1111111111" as never) : ("2222222222" as never),
    outcome: side,
    qty: d(qty),
    pricePerUnit: d(price),
    acquiredAt: millis(T0),
  });
}

/** A healthy local/remote pair: everything agrees. */
function localState(over: Partial<LocalState> = {}): LocalState {
  return {
    cashUsdc: d("50"),
    knownTradeIds: new Set(["t1"]),
    orders: new Map([["c1", { status: "working" as const, venueOrderId: "v-1" }]]),
    upLots: [lot("up", "u1", "10", "0.45")],
    downLots: [lot("down", "d1", "10", "0.55")],
    lastReconciledAt: millis(T0 - 1_000),
    ...over,
  };
}

function remoteState(over: Partial<RemoteState> = {}): RemoteState {
  return {
    balance: { availableUsdc: d("50") },
    orders: [
      {
        venueOrderId: "v-1",
        clientOrderId: "c1",
        status: "working",
        qty: d("10"),
        filledQty: d("0"),
      },
    ],
    fills: [
      {
        tradeId: "t1",
        clientOrderId: "c1|up",
        qty: d("10"),
        price: d("0.45"),
        fee: d("0"),
        at: millis(T0 - 2_000),
      },
    ],
    reachable: true,
    ...over,
  };
}

const RECONCILED = { maxLocalAgeMs: 60_000 };

describe("compareStates — clean pass", () => {
  it("reports zero events and a reconciled state when local matches remote", () => {
    const r = compareStates({
      local: localState(),
      remote: remoteState(),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(r.state).toBe("reconciled");
    expect(r.blocked).toBe(false);
    expect(r.events).toHaveLength(0);
    expect(decToString(r.matchedSets)).toBe("10.00000000");
    expect(decToString(r.residualUp)).toBe("0.00000000");
    expect(decToString(r.residualDown)).toBe("0.00000000");
  });

  it("is deterministic", () => {
    const a = compareStates({
      local: localState(),
      remote: remoteState(),
      now: millis(T0),
      ...RECONCILED,
    });
    const b = compareStates({
      local: localState(),
      remote: remoteState(),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(a).toEqual(b);
  });
});

describe("compareStates — discrepancy types", () => {
  it("missing order locally (venue knows an order we do not)", () => {
    const r = compareStates({
      local: localState(),
      remote: remoteState({
        orders: [
          ...remoteState().orders,
          {
            venueOrderId: "v-2",
            clientOrderId: "c9",
            status: "working",
            qty: d("5"),
            filledQty: d("0"),
          },
        ],
      }),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(r.events.some((e) => e.type === "order_missing_locally")).toBe(true);
    expect(r.blocked).toBe(true);
    expect(r.state).toBe("unreconciled");
  });

  it("unexpected fill (venue traded, we have no record)", () => {
    const r = compareStates({
      local: localState(),
      remote: remoteState({
        fills: [
          ...remoteState().fills,
          {
            tradeId: "t-unknown",
            clientOrderId: "c1|up",
            qty: d("3"),
            price: d("0.45"),
            fee: d("0"),
            at: millis(T0),
          },
        ],
      }),
      now: millis(T0),
      ...RECONCILED,
    });
    const e = r.events.find((x) => x.type === "unexpected_fill");
    expect(e).toBeDefined();
    expect(e!.action).toBe("block_new_orders");
    expect(r.blocked).toBe(true);
  });

  it("duplicate fill is reported and deduped without double-counting", () => {
    const r = compareStates({
      local: localState(),
      remote: remoteState({
        // same trade id twice in the venue payload (transport retry artifact)
        fills: [
          ...remoteState().fills,
          {
            tradeId: "t1",
            clientOrderId: "c1|up",
            qty: d("10"),
            price: d("0.45"),
            fee: d("0"),
            at: millis(T0 - 2_000),
          },
        ],
      }),
      now: millis(T0),
      ...RECONCILED,
    });
    const e = r.events.find((x) => x.type === "duplicate_fill");
    expect(e).toBeDefined();
    // Duplicate is acknowledged but does NOT block (no double-count occurs).
    expect(decToString(r.matchedSets)).toBe("10.00000000");
  });

  it("balance mismatch blocks", () => {
    const r = compareStates({
      local: localState({ cashUsdc: d("48") }),
      remote: remoteState({ balance: { availableUsdc: d("50") } }),
      now: millis(T0),
      ...RECONCILED,
    });
    const e = r.events.find((x) => x.type === "balance_mismatch");
    expect(e).toBeDefined();
    expect(e!.localState).toBe("48.00000000");
    expect(e!.remoteState).toBe("50.00000000");
    expect(r.blocked).toBe(true);
  });

  it("stale local state blocks (and never-reconciled blocks)", () => {
    const stale = compareStates({
      local: localState({ lastReconciledAt: millis(T0 - 120_000) }),
      remote: remoteState(),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(stale.events.some((e) => e.type === "stale_local_state")).toBe(true);
    expect(stale.blocked).toBe(true);

    const never = compareStates({
      local: localState({ lastReconciledAt: undefined }),
      remote: remoteState(),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(never.events.some((e) => e.type === "stale_local_state")).toBe(true);
    expect(never.blocked).toBe(true);
  });

  it("order status drift and order missing remotely block", () => {
    const drift = compareStates({
      local: localState(),
      remote: remoteState({
        orders: [
          {
            venueOrderId: "v-1",
            clientOrderId: "c1",
            status: "filled",
            qty: d("10"),
            filledQty: d("10"),
          },
        ],
      }),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(drift.events.some((e) => e.type === "order_status_drift")).toBe(true);

    const gone = compareStates({
      local: localState(),
      remote: remoteState({ orders: [] }),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(gone.events.some((e) => e.type === "order_missing_remotely")).toBe(true);
    expect(gone.blocked).toBe(true);
  });

  it("inventory up/down mismatches block (fill not applied locally)", () => {
    const up = compareStates({
      local: localState({ upLots: [lot("up", "u1", "7", "0.45")] }),
      remote: remoteState(),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(up.events.some((e) => e.type === "inventory_up_mismatch")).toBe(true);
    expect(up.blocked).toBe(true);

    const down = compareStates({
      local: localState({ downLots: [] }),
      remote: remoteState({
        fills: [
          {
            tradeId: "t1",
            clientOrderId: "c1|down",
            qty: d("10"),
            price: d("0.55"),
            fee: d("0"),
            at: millis(T0 - 2_000),
          },
        ],
      }),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(down.events.some((e) => e.type === "inventory_down_mismatch")).toBe(true);
  });

  it("unreachable venue blocks", () => {
    const r = compareStates({
      local: localState(),
      remote: remoteState({ reachable: false }),
      now: millis(T0),
      ...RECONCILED,
    });
    expect(r.events.some((e) => e.type === "remote_unreachable")).toBe(true);
    expect(r.blocked).toBe(true);
  });
});

describe("ReconciliationCoordinator — triggers and gate", () => {
  it("starts fail-closed: gate undefined before any pass", () => {
    const c = new ReconciliationCoordinator(RECONCILED);
    expect(c.reconciliationState).toBeUndefined();
  });

  it("records the trigger on every event", () => {
    const c = new ReconciliationCoordinator(RECONCILED);
    const r = c.reconcile("startup", localState({ cashUsdc: d("1") }), remoteState(), millis(T0));
    expect(r.blocked).toBe(true);
    for (const e of c.eventLog) {
      expect(e.detail?.["trigger"]).toBe("startup");
    }
  });

  it.each([
    "startup",
    "reconnect",
    "unknown_order_state",
    "api_failure",
    "websocket_recovery",
    "periodic",
  ] as const)("accepts the %s trigger", (trigger) => {
    const c = new ReconciliationCoordinator(RECONCILED);
    const r = c.reconcile(trigger, localState(), remoteState(), millis(T0));
    expect(r.state).toBe("reconciled");
    expect(c.reconciliationState).toBe("reconciled");
  });

  it("keeps the gate closed after a failed pass (never silently overwritten)", () => {
    const c = new ReconciliationCoordinator(RECONCILED);
    c.reconcile("startup", localState(), remoteState(), millis(T0));
    expect(c.reconciliationState).toBe("reconciled");
    // A discrepancy appears (balance drift).
    c.reconcile("periodic", localState({ cashUsdc: d("10") }), remoteState(), millis(T0 + 5_000));
    expect(c.reconciliationState).toBe("unreconciled");
    // A subsequent clean pass recovers the gate.
    c.reconcile("periodic", localState(), remoteState(), millis(T0 + 6_000));
    expect(c.reconciliationState).toBe("reconciled");
  });

  it("bounds nothing away: all events of a pass are retained in the log", () => {
    const c = new ReconciliationCoordinator(RECONCILED);
    c.reconcile(
      "api_failure",
      localState({ cashUsdc: d("1"), lastReconciledAt: undefined }),
      remoteState({ reachable: false }),
      millis(T0),
    );
    // unreachable + stale at minimum (balance is not compared when the
    // venue is unreachable — there is no remote data to compare against).
    expect(c.eventLog.length).toBeGreaterThanOrEqual(2);
    expect(c.eventLog.every((e) => e.at === millis(T0))).toBe(true);
  });
});

describe("NO_NEW_ORDERS enforcement through the RiskEngine", () => {
  function appConfig() {
    return { risk: DEFAULT_RISK, strategy: DEFAULT_STRATEGY } as never;
  }

  function riskRequest(reconciliation: "reconciled" | "unreconciled" | undefined) {
    return {
      marketId: "703257",
      tokenId: "1111111111",
      outcome: "up" as const,
      side: "buy" as const,
      qty: d("1"),
      price: d("0.5"),
      openOrderCount: 0,
      totalCapitalDeployed: d("0"),
      marketCapitalDeployed: d("0"),
      directionalExposureAfter: d("0.5"),
      residualShares: d("0"),
      orphanInventoryUsdc: d("0"),
      dailyLossUsdc: d("0"),
      marketLossUsdc: d("0"),
      marketDataAgeMs: 0,
      underlyingDataAgeMs: 0,
      reconciliation,
      apiHealth: "healthy" as const,
      wsHealth: "healthy" as const,
      marketExpired: false,
    };
  }

  it("risk refuses orders while the gate is not reconciled", () => {
    const limits = riskLimitsFromConfig(appConfig());
    const c = new ReconciliationCoordinator(RECONCILED);
    // Startup: no pass yet → undefined → refused.
    expect(evaluateRiskOrder(riskRequest(c.reconciliationState), limits).allowed).toBe(false);
    // Failed pass → "unreconciled" → refused.
    c.reconcile("reconnect", localState({ cashUsdc: d("1") }), remoteState(), millis(T0));
    const ev = evaluateRiskOrder(riskRequest(c.reconciliationState), limits);
    expect(ev.allowed).toBe(false);
    expect(["reconciliation_unknown", "account_unreconciled"]).toContain(ev.reason);
  });

  it("risk allows orders once reconciliation recovers", () => {
    const limits = riskLimitsFromConfig(appConfig());
    const c = new ReconciliationCoordinator(RECONCILED);
    c.reconcile("startup", localState(), remoteState(), millis(T0));
    expect(c.reconciliationState).toBe("reconciled");
    const ev = evaluateRiskOrder(riskRequest(c.reconciliationState), limits);
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe("ok");
  });
});

describe("event shape", () => {
  it("every event carries timestamp, type, local state, remote state, action", () => {
    const r = compareStates({
      local: localState({ cashUsdc: d("1") }),
      remote: remoteState({ reachable: false }),
      now: millis(T0 + 123),
      ...RECONCILED,
    });
    expect(r.events.length).toBeGreaterThan(0);
    for (const e of r.events) {
      expect(e.at).toBe(millis(T0 + 123));
      expect(e.type).toBeTypeOf("string");
      expect(e.localState).toBeTypeOf("string");
      expect(e.remoteState).toBeTypeOf("string");
      expect(e.action).toBeTypeOf("string");
    }
  });

  it("throws on invalid lot data (validation still applies)", () => {
    expect(() => lot("up", "bad", "0", "0.45")).toThrow(ValidationError);
  });
});
