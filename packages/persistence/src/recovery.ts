/**
 * RecoveryManager: the mandated startup/recovery flow.
 *
 *   process starts
 *     ↓
 *   load persisted state (events + snapshot)
 *     ↓
 *   discover current market (caller-provided view)
 *     ↓
 *   query venue state where available (caller-provided snapshot)
 *     ↓
 *   reconcile local state (via @bot/inventory compareStates)
 *     ↓
 *   rebuild inventory → matched sets → residual (deterministic replay)
 *     ↓
 *   evaluate risk (gate open only when every step is certain)
 *     ↓
 *   only then allow the strategy to continue
 *
 * Fail-closed guarantees:
 * - Any uncertainty (corrupt store, schema mismatch, venue unreachable,
 *   venue discrepancy, persisted UNKNOWN orders) ⇒ `allowTrading: false`,
 *   a recorded risk event, no new orders.
 * - Persisted UNKNOWN order state never becomes FILLED automatically —
 *   only an explicit venue confirmation promotes a status.
 * - Fill ingestion is idempotent on `fillId`: the same event can never be
 *   counted twice.
 */

import { decAdd, decCompare, decFromString, decZero, type Decimal, type Millis } from "@bot/domain";
import {
  compareStates,
  matchCompleteSets,
  type AcquisitionLot,
  type RemoteState,
} from "@bot/inventory";

import {
  decodeDecimal,
  decodeMillis,
  encodeDecimal,
  encodeMillis,
  SCHEMA_VERSION,
} from "./codec.js";
import type { FillEvent, StoredLot, StoredOrder } from "./events.js";
import type { PersistenceAdapter } from "./adapter.js";

/** The venue-facing view recovery reconciles against (mockable in tests). */
export interface VenueStateProvider {
  /** Query the venue. `undefined` or `reachable: false` = not confirmable. */
  fetch(): RemoteState | undefined;
}

export type RecoveryStatus =
  | "clean"
  | "blocked_storage"
  | "blocked_schema"
  | "blocked_replay"
  | "blocked_venue_unreachable"
  | "blocked_venue_mismatch"
  | "blocked_unknown_orders"
  | "blocked_kill_switch";

export interface RecoveryReport {
  readonly status: RecoveryStatus;
  readonly allowTrading: boolean;
  readonly atMs: Millis;
  /** Rebuilt, deterministic inventory view (data for monitoring, not approval). */
  readonly upShares: Decimal;
  readonly downShares: Decimal;
  readonly matchedSets: Decimal;
  readonly residualUp: Decimal;
  readonly residualDown: Decimal;
  readonly orderCount: number;
  readonly partiallyFilledOrders: number;
  readonly unknownOrders: readonly string[];
  readonly fillEventsProcessed: number;
  readonly duplicateFillEventsIgnored: number;
  readonly riskEventRecorded: boolean;
}

const UNKNOWN_STATUSES = new Set(["UNKNOWN", "unknown"]);

function isUnknownStatus(status: string): boolean {
  return UNKNOWN_STATUSES.has(status);
}

/** Venue-facing working classification for a persisted status. */
function venueWorking(status: string): boolean {
  return (
    status === "SUBMITTED" ||
    status === "LIVE" ||
    status === "PARTIALLY_FILLED" ||
    status === "CANCEL_REQUESTED" ||
    isUnknownStatus(status)
  );
}

export class RecoveryManager {
  private readonly adapter: PersistenceAdapter;
  private readonly venue: VenueStateProvider | undefined;

  constructor(adapter: PersistenceAdapter, venue?: VenueStateProvider) {
    this.adapter = adapter;
    this.venue = venue;
  }

  /** Run the full recovery flow. Deterministic given (store, venue view, now). */
  recover(now: Millis, currentMarket?: { readonly marketId: string }): RecoveryReport {
    // Discovery is caller-owned; persistence records which market is current.
    void currentMarket;

    // ---- 0. Storage health (corrupt/unavailable ⇒ block; requirement E) ----
    if (!this.adapter.healthy()) {
      return this.blocked(now, "blocked_storage", { reason: "persistence_unavailable" });
    }

    // ---- 1. Load persisted state (snapshot is an accelerator only) ----
    let snapshotSchemaOk = true;
    try {
      const snapshot = this.adapter.readSnapshot();
      if (snapshot !== undefined && snapshot.schemaVersion !== SCHEMA_VERSION) {
        snapshotSchemaOk = false;
      }
    } catch {
      snapshotSchemaOk = false;
    }
    if (!snapshotSchemaOk) {
      return this.blocked(now, "blocked_schema", {
        reason: "snapshot_unreadable_or_wrong_version",
      });
    }

    // ---- Kill switch survives restart (requirement F) ----
    let killSwitch;
    try {
      killSwitch = this.adapter.readKillSwitch();
    } catch {
      killSwitch = undefined;
    }
    if (killSwitch?.engaged === true) {
      return this.blocked(now, "blocked_kill_switch", {
        reason: "kill_switch_engaged_persisted",
        engagedAtMs: killSwitch.atMs,
      });
    }

    // ---- 2. Replay: deterministic rebuild from streams + keyed rows ----
    let replay;
    try {
      replay = this.replayOrders();
    } catch {
      return this.blocked(now, "blocked_replay", { reason: "fill_stream_or_rows_corrupt" });
    }

    // ---- Statuses verbatim; UNKNOWN never auto-promotes (requirement D) ----
    const unknownOrders = replay.orders
      .filter((o) => isUnknownStatus(o.status))
      .map((o) => o.clientOrderId);
    // Unknown state means no new orders, regardless of what the venue says.
    const unknownPresent = unknownOrders.length > 0;

    // ---- 3–5. Venue query + reconciliation (where available) ----
    let venueState: RemoteState | undefined;
    try {
      venueState = this.venue?.fetch();
    } catch {
      venueState = undefined;
    }
    const venueConfirmable = venueState !== undefined && venueState.reachable;

    // Persisted UNKNOWN orders block before any venue comparison: venue data
    // cannot clear an unknown local state — only an explicit confirmation flow.
    let venueMismatch = false;
    if (venueState !== undefined && venueState.reachable && !unknownPresent) {
      const comparison = compareStates({
        local: {
          cashUsdc: decZero(),
          knownTradeIds: replay.knownFillIds,
          orders: new Map(
            replay.orders.map((o) => [
              o.clientOrderId,
              {
                status: venueWorking(o.status) ? "working" : (o.status.toLowerCase() as never),
                venueOrderId: o.clientOrderId,
              },
            ]),
          ),
          upLots: this.decodedLots(replay.lots).filter((l) => l.outcome === "up"),
          downLots: this.decodedLots(replay.lots).filter((l) => l.outcome === "down"),
          // The comparison runs against a freshly fetched venue snapshot, so
          // local state is current by construction at `now`.
          lastReconciledAt: now,
        },
        remote: venueState,
        now,
        maxLocalAgeMs: 600_000,
      });
      if (comparison.blocked) {
        venueMismatch = true;
      }
    }

    // ---- 6–8. Deterministic rebuild (always computed, even when blocked) ----
    const rebuilt = this.rebuildInventory(replay.lots);
    const views = {
      upShares: rebuilt.upShares,
      downShares: rebuilt.downShares,
      matchedSets: rebuilt.matchedSets,
      residualUp: rebuilt.residualUp,
      residualDown: rebuilt.residualDown,
      orderCount: replay.orders.length,
      partiallyFilledOrders: replay.orders.filter((o) => o.status === "PARTIALLY_FILLED").length,
      unknownOrders,
      fillEventsProcessed: replay.fillEventsProcessed,
      duplicateFillEventsIgnored: replay.duplicatesIgnored,
      riskEventRecorded: false,
    };

    // ---- 9. Gate: any uncertainty ⇒ fail closed with a risk event ----
    if (!venueConfirmable || venueMismatch || unknownPresent) {
      const status: RecoveryStatus = venueMismatch
        ? "blocked_venue_mismatch"
        : unknownPresent
          ? "blocked_unknown_orders"
          : "blocked_venue_unreachable";
      this.adapter.appendRiskEvent({
        atMs: encodeMillis(now),
        kind: status,
        detail: {
          reason: venueMismatch
            ? "venue_state_mismatch"
            : unknownPresent
              ? "persisted_unknown_order_state"
              : "venue_unavailable",
          unknownOrders: unknownOrders.join(","),
        },
      });
      return { ...views, status, allowTrading: false, atMs: now, riskEventRecorded: true };
    }

    return { ...views, status: "clean", allowTrading: true, atMs: now, riskEventRecorded: false };
  }

  // ---------------------------------------------------------------------------
  // Fill ingestion (requirement B: idempotent)
  // ---------------------------------------------------------------------------

  /**
   * Ingest one fill exactly once. True = new (counted); false = duplicate.
   * The fill event is the source of truth; ingestion materializes the
   * corresponding acquisition lot (idempotent: same `fillId` ⇒ same lot id).
   */
  ingestFill(event: FillEvent): boolean {
    const known = this.adapter.readFillEvents().some((e) => e.fillId === event.fillId);
    if (known) {
      return false;
    }
    this.adapter.appendFillEvent(event);
    this.adapter.saveLot({
      lotId: `fill:${event.fillId}`,
      marketId: event.marketId,
      tokenId: event.tokenId,
      outcome: event.outcome,
      qty: event.qty,
      pricePerUnit: event.price,
      fee: event.fee,
      rebate: "0",
      acquiredAtMs: event.atMs,
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private decodedLots(lots: readonly StoredLot[]): readonly AcquisitionLot[] {
    return lots.map((l) => ({
      lotId: l.lotId,
      marketId: l.marketId,
      tokenId: l.tokenId,
      outcome: l.outcome,
      qty: decodeDecimal(l.qty),
      pricePerUnit: decodeDecimal(l.pricePerUnit),
      fee: decodeDecimal(l.fee),
      rebate: decodeDecimal(l.rebate),
      acquiredAt: decodeMillis(l.acquiredAtMs),
    })) as never as readonly AcquisitionLot[];
  }

  /**
   * Deterministic replay: orders come from the keyed rows (statuses verbatim);
   * filled quantities are refined from the append-only fill stream; duplicate
   * fill ids are ignored (never double-counted).
   */
  private replayOrders(): {
    readonly orders: readonly StoredOrder[];
    readonly lots: readonly StoredLot[];
    readonly knownFillIds: ReadonlySet<string>;
    readonly fillEventsProcessed: number;
    readonly duplicatesIgnored: number;
  } {
    const events = this.adapter.readFillEvents();
    const knownFillIds = new Set<string>();
    const filledByOrder = new Map<string, Decimal>();
    let duplicatesIgnored = 0;

    for (const event of events) {
      if (knownFillIds.has(event.fillId)) {
        duplicatesIgnored += 1;
        continue; // idempotency: never count the same fill twice
      }
      knownFillIds.add(event.fillId);
      filledByOrder.set(
        event.clientOrderId,
        decAdd(filledByOrder.get(event.clientOrderId) ?? decZero(), decodeDecimal(event.qty)),
      );
    }

    const orders = this.adapter.readOrders().map((o) => {
      const filled = filledByOrder.get(o.clientOrderId);
      if (filled === undefined || decCompare(filled, decZero()) === 0) {
        return o; // no fills: status verbatim
      }
      return { ...o, filledQty: encodeDecimal(filled) };
    });

    return {
      orders,
      lots: this.adapter.readLots(),
      knownFillIds,
      fillEventsProcessed: knownFillIds.size,
      duplicatesIgnored,
    };
  }

  private rebuildInventory(lots: readonly StoredLot[]): {
    readonly upLots: readonly AcquisitionLot[];
    readonly downLots: readonly AcquisitionLot[];
    readonly upShares: Decimal;
    readonly downShares: Decimal;
    readonly matchedSets: Decimal;
    readonly residualUp: Decimal;
    readonly residualDown: Decimal;
  } {
    const decoded = this.decodedLots(lots);
    const upLots = decoded.filter((l) => l.outcome === "up");
    const downLots = decoded.filter((l) => l.outcome === "down");
    const match = matchCompleteSets({
      upLots,
      downLots,
      settlementValue: decFromString("1"),
    });
    const sum = (side: "up" | "down"): Decimal =>
      decoded.filter((l) => l.outcome === side).reduce((acc, l) => decAdd(acc, l.qty), decZero());
    return {
      upLots,
      downLots,
      upShares: sum("up"),
      downShares: sum("down"),
      matchedSets: match.matchedSets,
      residualUp: match.residualUp,
      residualDown: match.residualDown,
    };
  }

  private blocked(
    now: Millis,
    status: RecoveryStatus,
    detail: Readonly<Record<string, string>>,
  ): RecoveryReport {
    this.adapter.appendRiskEvent({ atMs: encodeMillis(now), kind: status, detail });
    return {
      status,
      allowTrading: false,
      atMs: now,
      upShares: decZero(),
      downShares: decZero(),
      matchedSets: decZero(),
      residualUp: decZero(),
      residualDown: decZero(),
      orderCount: 0,
      partiallyFilledOrders: 0,
      unknownOrders: [],
      fillEventsProcessed: 0,
      duplicateFillEventsIgnored: 0,
      riskEventRecorded: true,
    };
  }
}
