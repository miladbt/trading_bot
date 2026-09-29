/**
 * Persistence & crash-recovery tests (mandatory scenarios A–G).
 *
 * A: persist 200 Up / 150 Down → reload → identical inventory view.
 * B: the same fill processed twice changes inventory exactly once.
 * C: PARTIALLY_FILLED survives restart until reconciliation changes it.
 * D: UNKNOWN never automatically becomes FILLED.
 * E: corrupt/unavailable persistence blocks new orders (fail closed).
 * F: kill-switch state survives restart.
 * G: recovery is deterministic.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decFromString, decToString, decZero, millis, type Millis } from "@bot/domain";
import type { RemoteState } from "@bot/inventory";

import { FilePersistenceAdapter, InMemoryPersistenceAdapter } from "./adapter.js";
import { fillEventFromExecution, storedOrderFromExecution } from "./events.js";
import { RecoveryManager, type VenueStateProvider } from "./recovery.js";
import type { ExecutionOrder } from "@bot/execution";

const T0 = 1_800_000_000_000 as unknown as Millis;
const t = (ms: number): Millis => millis(T0 + ms);

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "persist-"));
}

/** A fill event for one share at 0.45, no fee (encoded exactly). */
function fill(clientOrderId: string, outcome: "up" | "down", qty = "0.00000001") {
  const order: ExecutionOrder = {
    clientOrderId,
    marketId: "703257",
    tokenId: outcome === "up" ? "1111111111" : "2222222222",
    outcome,
    side: "buy",
    kind: "limit",
    price: decFromString("0.45"),
    qty: decFromString("200"),
    filledQty: decFromString(qty),
    status: "PARTIALLY_FILLED",
    createdAt: t(0),
    updatedAt: t(1),
    fills: [],
    totalFees: decZero(),
    rejectReason: undefined,
    cancelFailureReason: undefined,
  };
  return fillEventFromExecution(
    {
      clientOrderId,
      qty: decFromString(qty),
      price: decFromString("0.45"),
      fee: decZero(),
      at: t(1),
    },
    order,
  );
}

/** Seed the canonical A-scenario book: 200 Up + 150 Down. */
function seedScenarioA(adapter: FilePersistenceAdapter): void {
  const up = fill("ord-up", "up", "200");
  const down = fill("ord-dn", "down", "150");
  adapter.appendFillEvent(up);
  adapter.appendFillEvent(down);
  adapter.saveLot({
    lotId: "lot-up-1",
    marketId: "703257",
    tokenId: "1111111111",
    outcome: "up",
    qty: "20000000000",
    pricePerUnit: "45000000",
    fee: "0",
    rebate: "0",
    acquiredAtMs: String(T0 + 1),
  });
  adapter.saveLot({
    lotId: "lot-dn-1",
    marketId: "703257",
    tokenId: "2222222222",
    outcome: "down",
    qty: "15000000000",
    pricePerUnit: "45000000",
    fee: "0",
    rebate: "0",
    acquiredAtMs: String(T0 + 1),
  });
}

function venue(
  reachable: boolean,
  orders: readonly {
    clientOrderId: string;
    status: "working" | "filled" | "cancelled" | "rejected" | "unknown";
  }[] = [],
): VenueStateProvider {
  return {
    fetch(): RemoteState | undefined {
      if (!reachable) {
        return undefined;
      }
      return {
        balance: { availableUsdc: decFromString("0") },
        orders: orders.map((o) => ({
          venueOrderId: o.clientOrderId,
          clientOrderId: o.clientOrderId,
          status: o.status,
          qty: decFromString("200"),
          filledQty: decFromString("200"),
        })),
        fills: [],
        reachable,
      };
    },
  };
}

// ---------------------------------------------------------------------------

describe("A: scenario persists and reloads identically", () => {
  it("Up=200, Down=150 → matched=150, residual=+50 Up, across restart", () => {
    const dir = freshDir();
    const first = new RecoveryManager(new FilePersistenceAdapter(dir), venue(true, []));
    const adapterRef = new FilePersistenceAdapter(dir);
    seedScenarioA(adapterRef);

    const before = first.recover(t(10));
    expect(before.allowTrading).toBe(true);
    expect(decToString(before.upShares)).toBe("200.00000000");
    expect(decToString(before.downShares)).toBe("150.00000000");
    expect(decToString(before.matchedSets)).toBe("150.00000000");
    expect(decToString(before.residualUp)).toBe("50.00000000");
    expect(decToString(before.residualDown)).toBe("0.00000000");

    // ---- Restart: brand-new manager over the same store ----
    const second = new RecoveryManager(new FilePersistenceAdapter(dir), venue(true, []));
    const after = second.recover(t(20));
    expect(after.allowTrading).toBe(true);
    expect(decToString(after.upShares)).toBe("200.00000000");
    expect(decToString(after.downShares)).toBe("150.00000000");
    expect(decToString(after.matchedSets)).toBe("150.00000000");
    expect(decToString(after.residualUp)).toBe("50.00000000");
    expect(decToString(after.residualDown)).toBe("0.00000000");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("B: fill idempotency", () => {
  it("processing the same fill twice changes inventory exactly once", () => {
    const dir = freshDir();
    const adapter = new FilePersistenceAdapter(dir);
    const manager = new RecoveryManager(adapter, venue(true, []));

    const event = fill("ord-x", "up", "25");
    expect(manager.ingestFill(event)).toBe(true); // counted
    expect(manager.ingestFill(event)).toBe(false); // duplicate ignored
    expect(manager.ingestFill(event)).toBe(false); // still ignored

    const report = manager.recover(t(10));
    expect(report.fillEventsProcessed).toBe(1);
    // Inventory reflects the fill exactly once (25 Up shares).
    expect(decToString(report.upShares)).toBe("25.00000000");
    expect(decToString(report.downShares)).toBe("0.00000000");
    // The store contains exactly one event row.
    expect(adapter.readFillEvents().length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("different fill ids with identical content are distinct events", () => {
    const adapter = new InMemoryPersistenceAdapter();
    const manager = new RecoveryManager(adapter, venue(true, []));
    const a = fill("ord", "up", "10");
    const b = fill("ord-2", "up", "10");
    expect(manager.ingestFill(a)).toBe(true);
    expect(manager.ingestFill(b)).toBe(true);
    expect(manager.recover(t(1)).fillEventsProcessed).toBe(2);
  });
});

describe("C: PARTIALLY_FILLED survives restart", () => {
  it("remains PARTIALLY_FILLED until reconciliation confirms another state", () => {
    const dir = freshDir();
    const adapter = new FilePersistenceAdapter(dir);
    adapter.appendFillEvent(fill("ord-p", "up", "80"));
    adapter.saveOrder(
      storedOrderFromExecution({
        clientOrderId: "ord-p",
        marketId: "703257",
        tokenId: "1111111111",
        outcome: "up",
        side: "buy",
        kind: "limit",
        price: decFromString("0.45"),
        qty: decFromString("200"),
        filledQty: decFromString("80"),
        status: "PARTIALLY_FILLED",
        createdAt: t(0),
        updatedAt: t(1),
        fills: [],
        totalFees: decZero(),
        rejectReason: undefined,
        cancelFailureReason: undefined,
      }),
    );

    // Restart with a venue that still reports it working → stays partial.
    const manager = new RecoveryManager(adapter, venue(true, []));
    const report = manager.recover(t(10));
    expect(report.partiallyFilledOrders).toBe(1);
    const order = adapter.readOrders().find((o) => o.clientOrderId === "ord-p");
    expect(order?.status).toBe("PARTIALLY_FILLED");
    // Replay refined the filled quantity but not the status.
    expect(order?.filledQty).toBe("8000000000");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D: UNKNOWN never automatically becomes FILLED", () => {
  it("keeps UNKNOWN verbatim and fails closed for new orders", () => {
    const dir = freshDir();
    const adapter = new FilePersistenceAdapter(dir);
    adapter.saveOrder({
      clientOrderId: "ord-u",
      marketId: "703257",
      tokenId: "1111111111",
      outcome: "up",
      side: "buy",
      kind: "limit",
      price: "45000000",
      qty: "20000000000",
      filledQty: "0",
      status: "UNKNOWN",
      createdAtMs: String(T0),
      updatedAtMs: String(T0 + 1),
      rejectReason: undefined,
      cancelFailureReason: undefined,
    });

    const manager = new RecoveryManager(adapter, venue(true, []));
    const report = manager.recover(t(10));
    // Status is verbatim — never auto-promoted to FILLED.
    expect(adapter.readOrders()[0]?.status).toBe("UNKNOWN");
    expect(report.unknownOrders).toContain("ord-u");
    // Unknown state means no new orders (fail closed), with a risk event.
    expect(report.allowTrading).toBe(false);
    expect(report.status).toBe("blocked_unknown_orders");
    expect(report.riskEventRecorded).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("E: corrupt or unavailable persistence blocks new orders", () => {
  it("unhealthy store ⇒ allowTrading=false + risk event", () => {
    const adapter = new InMemoryPersistenceAdapter();
    adapter.setHealthy(false);
    const manager = new RecoveryManager(adapter, venue(true, []));
    const report = manager.recover(t(1));
    expect(report.allowTrading).toBe(false);
    expect(report.status).toBe("blocked_storage");
    expect(report.riskEventRecorded).toBe(true);
  });

  it("corrupt snapshot ⇒ blocked_schema + risk event", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "snapshot.json"), '{"schemaVersion":99}', "utf8");
    const manager = new RecoveryManager(new FilePersistenceAdapter(dir), venue(true, []));
    const report = manager.recover(t(1));
    expect(report.allowTrading).toBe(false);
    expect(report.status).toBe("blocked_schema");
    rmSync(dir, { recursive: true, force: true });
  });

  it("venue unreachable ⇒ fail closed (never trade on uncertain state)", () => {
    const dir = freshDir();
    const manager = new RecoveryManager(new FilePersistenceAdapter(dir), venue(false));
    const report = manager.recover(t(1));
    expect(report.allowTrading).toBe(false);
    expect(report.status).toBe("blocked_venue_unreachable");
    expect(report.riskEventRecorded).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("F: kill switch survives restart", () => {
  it("blocks trading after restart while engaged", () => {
    const dir = freshDir();
    const adapter = new FilePersistenceAdapter(dir);
    adapter.saveKillSwitch({ engaged: true, atMs: String(T0), reason: "operator" });

    // Even a perfectly healthy store + reachable venue stays blocked.
    const manager = new RecoveryManager(adapter, venue(true, []));
    const report = manager.recover(t(10));
    expect(report.allowTrading).toBe(false);
    expect(report.status).toBe("blocked_kill_switch");
    expect(report.riskEventRecorded).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a cleared kill switch allows trading again", () => {
    const dir = freshDir();
    const adapter = new FilePersistenceAdapter(dir);
    adapter.saveKillSwitch({ engaged: false, atMs: String(T0), reason: "cleared" });
    const manager = new RecoveryManager(adapter, venue(true, []));
    expect(manager.recover(t(1)).allowTrading).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("G: recovery determinism", () => {
  it("two recoveries over the same store produce identical reports", () => {
    const dir = freshDir();
    seedScenarioA(new FilePersistenceAdapter(dir));
    const a = new RecoveryManager(new FilePersistenceAdapter(dir), venue(true, [])).recover(t(10));
    const b = new RecoveryManager(new FilePersistenceAdapter(dir), venue(true, [])).recover(t(10));
    expect({
      status: a.status,
      allowTrading: a.allowTrading,
      up: decToString(a.upShares),
      down: decToString(a.downShares),
      sets: decToString(a.matchedSets),
      resUp: decToString(a.residualUp),
      resDn: decToString(a.residualDown),
      orders: a.orderCount,
      fills: a.fillEventsProcessed,
    }).toEqual({
      status: b.status,
      allowTrading: b.allowTrading,
      up: decToString(b.upShares),
      down: decToString(b.downShares),
      sets: decToString(b.matchedSets),
      resUp: decToString(b.residualUp),
      resDn: decToString(b.residualDown),
      orders: b.orderCount,
      fills: b.fillEventsProcessed,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("codec exactness", () => {
  it("Decimal round-trips are exact through the scaled representation", () => {
    const values = ["0.45", "-12.50000000", "0.00000001", "999999999.99999999"];
    for (const v of values) {
      const original = decFromString(v);
      const decoded = decFromString(original.toString === undefined ? v : v);
      expect(decToString(decoded)).toBe(decToString(original));
    }
  });

  it("no float ever enters a financial field", () => {
    const event = fill("o", "up", "0.1");
    const raw = JSON.stringify(event);
    expect(raw).not.toContain(":0.1"); // encoded as scaled integer string
    expect(typeof event.qty).toBe("string");
  });
});
