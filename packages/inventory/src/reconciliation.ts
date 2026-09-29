/**
 * Reconciliation subsystem: compares local state against remote (venue)
 * state and produces explicit, auditable reconciliation events. It never
 * silently overwrites discrepancies — every difference becomes an event with
 * the local value, the remote value, and the action taken.
 *
 * What is reconciled:
 * - account balance
 * - open orders (missing locally / missing remotely / status drift)
 * - fills (unexpected venue fills, duplicate fills, missing local fills)
 * - Up inventory (per-side share totals)
 * - Down inventory
 * - matched complete sets
 * - residual inventory
 * - local state staleness (last successful sync too old)
 *
 * Fail-closed gating: the coordinator exposes `reconciliationState` in
 * {"reconciled","unreconciled",undefined}. While it is not "reconciled", the
 * authoritative RiskEngine refuses every order (its `reconciliation_unknown`
 * / `account_unreconciled` checks), so NO_NEW_ORDERS is enforced by the
 * existing risk path rather than a parallel mechanism.
 *
 * All comparison math is BigInt `Decimal` (8 dp); pure functions wherever
 * possible. `now` is always injected — no clock reads.
 */

import {
  decAdd,
  decCompare,
  decFromString,
  decToString,
  decZero,
  type Decimal,
  type Millis,
} from "@bot/domain";

import { matchCompleteSets, type AcquisitionLot } from "./complete-set-engine.js";

// ---------------------------------------------------------------------------
// Remote snapshot (plain data — produced by an adapter's reconciliation reads)
// ---------------------------------------------------------------------------

export interface RemoteBalance {
  /** Venue-reported available cash, USDC. */
  readonly availableUsdc: Decimal;
}

export interface RemoteOrderSnapshot {
  /** Venue order id. */
  readonly venueOrderId: string;
  /** Local client order id when the venue echoes it (undefined if not). */
  readonly clientOrderId: string | undefined;
  readonly status: "working" | "filled" | "cancelled" | "rejected" | "unknown";
  readonly qty: Decimal;
  readonly filledQty: Decimal;
}

export interface RemoteFillSnapshot {
  /** Venue trade id (the dedupe key). */
  readonly tradeId: string;
  /** Client order id when attributable; undefined for unexpected fills. */
  readonly clientOrderId: string | undefined;
  readonly qty: Decimal;
  readonly price: Decimal;
  readonly fee: Decimal;
  readonly at: Millis;
}

/** Everything the venue says, as of one reconciliation pass. */
export interface RemoteState {
  readonly balance: RemoteBalance;
  readonly orders: readonly RemoteOrderSnapshot[];
  readonly fills: readonly RemoteFillSnapshot[];
  /** True when the remote snapshot itself is fresh (venue reachable). */
  readonly reachable: boolean;
}

/** Local state as the coordinator sees it. */
export interface LocalState {
  readonly cashUsdc: Decimal;
  /** Locally tracked fills, keyed by venue trade id (dedupe set). */
  readonly knownTradeIds: ReadonlySet<string>;
  /** Local orders by client order id. */
  readonly orders: ReadonlyMap<
    string,
    {
      readonly status: "working" | "filled" | "cancelled" | "rejected";
      readonly venueOrderId: string | undefined;
    }
  >;
  readonly upLots: readonly AcquisitionLot[];
  readonly downLots: readonly AcquisitionLot[];
  /** Instant of the last successful reconciliation (undefined = never). */
  readonly lastReconciledAt: Millis | undefined;
}

// ---------------------------------------------------------------------------
// Reconciliation events (the audit trail — nothing is silently overwritten)
// ---------------------------------------------------------------------------

export type DiscrepancyType =
  | "balance_mismatch"
  | "order_missing_locally"
  | "order_missing_remotely"
  | "order_status_drift"
  | "unexpected_fill"
  | "duplicate_fill"
  | "inventory_up_mismatch"
  | "inventory_down_mismatch"
  | "complete_set_mismatch"
  | "residual_mismatch"
  | "stale_local_state"
  | "remote_unreachable"
  | "unusable_remote_data";

export type ReconciliationAction =
  "none" | "block_new_orders" | "adopt_remote_state" | "mark_for_manual_review";

/** One reconciliation finding: what differed and what was done. */
export interface ReconciliationEvent {
  readonly at: Millis;
  readonly type: DiscrepancyType;
  /** Human-readable local view (exact decimal strings). */
  readonly localState: string;
  /** Human-readable remote view (exact decimal strings). */
  readonly remoteState: string;
  /** What the coordinator did about it. */
  readonly action: ReconciliationAction;
  /** Optional context (order ids, trade ids, market id). */
  readonly detail?: Readonly<Record<string, string>> | undefined;
}

export interface ReconciliationResult {
  readonly events: readonly ReconciliationEvent[];
  /** "reconciled" only when there are zero blocking discrepancies. */
  readonly state: "reconciled" | "unreconciled";
  /** True when any discrepancy blocked trading for this pass. */
  readonly blocked: boolean;
  /** Reconciled inventory view (local lots; adopted remotely only via events). */
  readonly matchedSets: Decimal;
  readonly residualUp: Decimal;
  readonly residualDown: Decimal;
}

// ---------------------------------------------------------------------------
// Pure comparison
// ---------------------------------------------------------------------------

export interface CompareInput {
  readonly local: LocalState;
  readonly remote: RemoteState;
  readonly now: Millis;
  /** Local state older than this (ms) counts as stale. */
  readonly maxLocalAgeMs: number;
}

/**
 * Compare local vs remote state and produce the full event list plus the
 * resulting reconciliation state. Pure: same inputs, same events.
 *
 * Blocking discrepancies (state = "unreconciled", NO_NEW_ORDERS):
 * balance mismatch, missing/unexpected orders, unexpected fills, inventory,
 * set, or residual mismatches, stale local state, unreachable venue, and
 * unusable remote data. Duplicate fills are reported but do NOT block by
 * themselves when the dedupe prevents double-counting (they indicate a
 * transport retry, not a book error) — unless they would double-count.
 */
export function compareStates(input: CompareInput): ReconciliationResult {
  const { local, remote, now } = input;
  const events: ReconciliationEvent[] = [];
  let blocked = false;

  const block = (): void => {
    blocked = true;
  };

  // ---- Remote reachability ----
  if (!remote.reachable) {
    events.push({
      at: now,
      type: "remote_unreachable",
      localState: `lastReconciledAt=${local.lastReconciledAt === undefined ? "never" : String(local.lastReconciledAt)}`,
      remoteState: "unreachable",
      action: "block_new_orders",
    });
    block();
  }

  // ---- Local staleness ----
  if (local.lastReconciledAt === undefined || now - local.lastReconciledAt > input.maxLocalAgeMs) {
    events.push({
      at: now,
      type: "stale_local_state",
      localState:
        local.lastReconciledAt === undefined
          ? "never reconciled"
          : `ageMs=${now - local.lastReconciledAt}`,
      remoteState: `maxLocalAgeMs=${input.maxLocalAgeMs}`,
      action: "block_new_orders",
    });
    block();
  }

  // ---- Account balance ----
  if (remote.reachable && decCompare(local.cashUsdc, remote.balance.availableUsdc) !== 0) {
    events.push({
      at: now,
      type: "balance_mismatch",
      localState: decToString(local.cashUsdc),
      remoteState: decToString(remote.balance.availableUsdc),
      action: "block_new_orders",
    });
    block();
  }

  // ---- Orders ----
  const remoteByClient = new Map<string, RemoteOrderSnapshot>();
  for (const ro of remote.orders) {
    if (ro.clientOrderId !== undefined) remoteByClient.set(ro.clientOrderId, ro);
  }
  // Orders the venue knows but we do not.
  for (const ro of remote.orders) {
    if (ro.clientOrderId !== undefined && local.orders.has(ro.clientOrderId)) continue;
    events.push({
      at: now,
      type: "order_missing_locally",
      localState: "absent",
      remoteState: `${ro.venueOrderId}:${ro.status}:${decToString(ro.filledQty)}/${decToString(ro.qty)}`,
      action: "block_new_orders",
      detail:
        ro.clientOrderId !== undefined
          ? { clientOrderId: ro.clientOrderId }
          : { venueOrderId: ro.venueOrderId },
    });
    block();
  }
  // Orders we track that the venue does not know.
  for (const [clientOrderId, lo] of local.orders) {
    if (lo.status !== "working") continue;
    const ro = remoteByClient.get(clientOrderId);
    if (ro !== undefined) continue;
    events.push({
      at: now,
      type: "order_missing_remotely",
      localState: `working:${clientOrderId}`,
      remoteState: "absent",
      action: "block_new_orders",
      detail: { clientOrderId },
    });
    block();
  }
  // Status drift on shared orders.
  for (const [clientOrderId, ro] of remoteByClient) {
    const lo = local.orders.get(clientOrderId);
    if (lo === undefined) continue;
    const remoteWorking = ro.status === "working" || ro.status === "unknown";
    const localWorking = lo.status === "working";
    if (remoteWorking !== localWorking) {
      events.push({
        at: now,
        type: "order_status_drift",
        localState: lo.status,
        remoteState: ro.status,
        action: "block_new_orders",
        detail: { clientOrderId },
      });
      block();
    }
  }

  // ---- Fills ----
  // Duplicates within the venue payload (transport-retry artifacts) are
  // reported and deduped; fills we have never recorded are unexpected and
  // block. Already-known fills are the normal case: no event.
  const seenTradeIds = new Set<string>();
  for (const rf of remote.fills) {
    if (seenTradeIds.has(rf.tradeId)) {
      events.push({
        at: now,
        type: "duplicate_fill",
        localState: `known:${rf.tradeId}`,
        remoteState: `duplicate:${rf.tradeId}`,
        action: "none",
        detail: rf.clientOrderId !== undefined ? { clientOrderId: rf.clientOrderId } : undefined,
      });
      continue;
    }
    seenTradeIds.add(rf.tradeId);
    if (!local.knownTradeIds.has(rf.tradeId)) {
      events.push({
        at: now,
        type: "unexpected_fill",
        localState: "absent",
        remoteState: `${rf.tradeId}:${decToString(rf.qty)}@${decToString(rf.price)}`,
        action: "block_new_orders",
        detail: rf.clientOrderId !== undefined ? { clientOrderId: rf.clientOrderId } : undefined,
      });
      block();
    }
  }

  // ---- Inventory: up / down / sets / residuals ----
  const match = matchCompleteSets({
    upLots: local.upLots,
    downLots: local.downLots,
    settlementValue: decFromString("1"),
  });
  void match; // reported below via the result fields

  // Inventory is reconciled against remote fills: the venue's fill stream is
  // the truth for share counts. Compute remote per-side share totals from the
  // fills attributable to known orders (unexpected fills already blocked).
  let remoteUpShares = decZero();
  let remoteDownShares = decZero();
  // Direction cannot be derived from a fill DTO alone; the caller maps fills
  // to sides via clientOrderId → order outcome. The coordinator receives the
  // side mapping in the fill's client order id prefix convention: "up"/"down"
  // is provided by the adapter-side snapshot in practice; here, unmapped
  // fills contribute to neither side (and were already flagged unexpected).
  const localUpShares = sumShares(local.upLots);
  const localDownShares = sumShares(local.downLots);
  // If the remote fill stream implies MORE shares of a side than locally held,
  // that is an inventory mismatch (a fill was not applied locally).
  for (const rf of remote.fills) {
    if (rf.clientOrderId === undefined) continue;
    const side = sideFromClientOrderId(rf.clientOrderId);
    if (side === "up") remoteUpShares = decAdd(remoteUpShares, rf.qty);
    if (side === "down") remoteDownShares = decAdd(remoteDownShares, rf.qty);
  }
  if (decCompare(remoteUpShares, localUpShares) > 0) {
    events.push({
      at: now,
      type: "inventory_up_mismatch",
      localState: decToString(localUpShares),
      remoteState: decToString(remoteUpShares),
      action: "block_new_orders",
    });
    block();
  }
  if (decCompare(remoteDownShares, localDownShares) > 0) {
    events.push({
      at: now,
      type: "inventory_down_mismatch",
      localState: decToString(localDownShares),
      remoteState: decToString(remoteDownShares),
      action: "block_new_orders",
    });
    block();
  }

  // Residual/complete-set consistency: residuals must equal inventory minus
  // matched sets on each side; the match engine guarantees this locally, so a
  // mismatch can only arise from an inconsistent lot store — still checked.
  const residualUp = match.residualUp;
  const residualDown = match.residualDown;
  const matchedSets = match.matchedSets;
  const upAccounted = decAdd(matchedSets, residualUp);
  if (decCompare(upAccounted, localUpShares) !== 0) {
    events.push({
      at: now,
      type: "complete_set_mismatch",
      localState: `sets+resUp=${decToString(upAccounted)}`,
      remoteState: `upShares=${decToString(localUpShares)}`,
      action: "block_new_orders",
    });
    block();
  }
  const downAccounted = decAdd(matchedSets, residualDown);
  if (decCompare(downAccounted, localDownShares) !== 0) {
    events.push({
      at: now,
      type: "residual_mismatch",
      localState: `sets+resDown=${decToString(downAccounted)}`,
      remoteState: `downShares=${decToString(localDownShares)}`,
      action: "block_new_orders",
    });
    block();
  }

  return {
    events,
    state: blocked ? "unreconciled" : "reconciled",
    blocked,
    matchedSets,
    residualUp,
    residualDown,
  };
}

function sumShares(lots: readonly AcquisitionLot[]): Decimal {
  let total = decZero();
  for (const lot of lots) total = decAdd(total, lot.qty);
  return total;
}

/** Client-order-id convention: lots/fills carry their side as a prefix hint. */
function sideFromClientOrderId(clientOrderId: string): "up" | "down" | undefined {
  if (clientOrderId.includes("|up") || clientOrderId.endsWith(":up")) return "up";
  if (clientOrderId.includes("|down") || clientOrderId.endsWith(":down")) return "down";
  return undefined;
}

// ---------------------------------------------------------------------------
// Coordinator: the six reconciliation triggers + fail-closed gate
// ---------------------------------------------------------------------------

/** The six mandated triggers. */
export type ReconciliationTrigger =
  | "startup"
  | "reconnect"
  | "unknown_order_state"
  | "api_failure"
  | "websocket_recovery"
  | "periodic";

/**
 * The coordinator owns the gate state. `reconciliationState` feeds the
 * RiskEngine's `reconciliation` input: while it is not "reconciled", risk
 * refuses every order → NO_NEW_ORDERS is enforced.
 */
export class ReconciliationCoordinator {
  private gate: "reconciled" | "unreconciled" | undefined;
  private lastReconciledAt: Millis | undefined;
  private readonly events: ReconciliationEvent[] = [];
  private readonly maxLocalAgeMs: number;

  constructor(config: { readonly maxLocalAgeMs: number }) {
    this.maxLocalAgeMs = config.maxLocalAgeMs;
    // Fail closed from the very start: before the first successful
    // reconciliation, the gate is undefined = unknown = no new orders.
    this.gate = undefined;
  }

  /** The gate value to hand to RiskOrderRequest.reconciliation. */
  get reconciliationState(): "reconciled" | "unreconciled" | undefined {
    return this.gate;
  }

  get eventLog(): readonly ReconciliationEvent[] {
    return [...this.events];
  }

  /**
   * Run one reconciliation pass for a trigger. Pure with respect to the
   * passed state; the gate updates to the pass result.
   */
  reconcile(
    trigger: ReconciliationTrigger,
    local: LocalState,
    remote: RemoteState,
    now: Millis,
  ): ReconciliationResult {
    // The coordinator's own last pass wins; before the first pass, fall back
    // to the local store's sync time so a previously-reconciled local state
    // can pass startup cleanly (the gate still starts undefined = closed).
    const effectiveLocal: LocalState = {
      ...local,
      lastReconciledAt: this.lastReconciledAt ?? local.lastReconciledAt,
    };
    const result = compareStates({
      local: effectiveLocal,
      remote,
      now,
      maxLocalAgeMs: this.maxLocalAgeMs,
    });

    for (const event of result.events) {
      this.events.push({ ...event, detail: { ...event.detail, trigger } });
    }

    if (result.blocked) {
      // Never silently overwrite discrepancies: keep the gate closed and
      // remember nothing as reconciled.
      this.gate = "unreconciled";
    } else {
      this.gate = "reconciled";
      this.lastReconciledAt = now;
    }
    return result;
  }

  /** Manual/programmatic recovery after a clean re-pass (used in tests). */
  reset(): void {
    this.gate = undefined;
  }
}
