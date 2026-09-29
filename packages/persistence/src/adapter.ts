/**
 * PersistenceAdapter: the storage port. `FilePersistenceAdapter` is the
 * production implementation (atomic snapshot + append-only JSONL event log,
 * no database driver, no credentials); `InMemoryPersistenceAdapter` serves
 * unit tests. Any future database implementation (Postgres etc.) implements
 * the same port — callers never touch storage details.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Millis } from "@bot/domain";

import { assertSchemaVersion, SCHEMA_VERSION, encodeMillis, stableStringify } from "./codec.js";
import type {
  FillEvent,
  PersistedSnapshot,
  StoredDecision,
  StoredKillSwitch,
  StoredLot,
  StoredMarket,
  StoredOrder,
  StoredReconciliation,
  StoredRiskEvent,
} from "./events.js";

export interface PersistenceAdapter {
  /** Append one fill event. Idempotent on `fillId` (implementation-owned). */
  appendFillEvent(event: FillEvent): void;
  /** All fill events in append order. */
  readFillEvents(): readonly FillEvent[];

  /** Upsert an order row (keyed by clientOrderId). */
  saveOrder(order: StoredOrder): void;
  readOrders(): readonly StoredOrder[];

  /** Upsert an acquisition lot (keyed by lotId). */
  saveLot(lot: StoredLot): void;
  readLots(): readonly StoredLot[];

  /** Upsert a market + its cycle bounds (keyed by marketId). */
  saveMarket(market: StoredMarket): void;
  readMarkets(): readonly StoredMarket[];

  /** Append-only records (audit/observability). */
  appendDecision(decision: StoredDecision): void;
  readDecisions(): readonly StoredDecision[];
  appendRiskEvent(event: StoredRiskEvent): void;
  readRiskEvents(): readonly StoredRiskEvent[];
  appendReconciliation(reconciliation: StoredReconciliation): void;
  readReconciliations(): readonly StoredReconciliation[];

  /** Kill-switch state: last write wins. */
  saveKillSwitch(state: StoredKillSwitch): void;
  readKillSwitch(): StoredKillSwitch | undefined;

  /** Point-in-time snapshot (accelerator; never overrides replay). */
  saveSnapshot(
    snapshot: Omit<PersistedSnapshot, "schemaVersion" | "writtenAtMs">,
    atMs: Millis,
  ): void;
  readSnapshot(): PersistedSnapshot | undefined;

  /** Whether the backing store is readable/healthy. */
  healthy(): boolean;
}

// ---------------------------------------------------------------------------
// File implementation
// ---------------------------------------------------------------------------

interface FileLayout {
  readonly root: string;
  readonly eventsDir: string;
  readonly stateDir: string;
}

function ensureLayout(root: string): FileLayout {
  const eventsDir = join(root, "events");
  const stateDir = join(root, "state");
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, eventsDir, stateDir };
}

const FILES = {
  fills: "fill-events.jsonl",
  decisions: "decisions.jsonl",
  riskEvents: "risk-events.jsonl",
  reconciliations: "reconciliations.jsonl",
  orders: "orders.json",
  lots: "lots.json",
  markets: "markets.json",
  killSwitch: "kill-switch.json",
  snapshot: "snapshot.json",
} as const;

/** Read a JSONL file into parsed lines (empty when absent). */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    out.push(JSON.parse(line) as T);
  }
  return out;
}

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stableStringify(value), "utf8");
  renameSync(tmp, path);
}

export class FilePersistenceAdapter implements PersistenceAdapter {
  private readonly layout: FileLayout;

  constructor(root: string) {
    this.layout = ensureLayout(root);
  }

  private path(name: string): string {
    return join(this.layout.root, name);
  }

  // ---- Append-only streams ---------------------------------------------------

  appendFillEvent(event: FillEvent): void {
    appendFileSync(this.path(FILES.fills), `${stableStringify(event)}\n`, "utf8");
  }

  readFillEvents(): readonly FillEvent[] {
    return readJsonl<FillEvent>(this.path(FILES.fills));
  }

  appendDecision(decision: StoredDecision): void {
    appendFileSync(this.path(FILES.decisions), `${stableStringify(decision)}\n`, "utf8");
  }

  readDecisions(): readonly StoredDecision[] {
    return readJsonl<StoredDecision>(this.path(FILES.decisions));
  }

  appendRiskEvent(event: StoredRiskEvent): void {
    appendFileSync(this.path(FILES.riskEvents), `${stableStringify(event)}\n`, "utf8");
  }

  readRiskEvents(): readonly StoredRiskEvent[] {
    return readJsonl<StoredRiskEvent>(this.path(FILES.riskEvents));
  }

  appendReconciliation(reconciliation: StoredReconciliation): void {
    appendFileSync(
      this.path(FILES.reconciliations),
      `${stableStringify(reconciliation)}\n`,
      "utf8",
    );
  }

  readReconciliations(): readonly StoredReconciliation[] {
    return readJsonl<StoredReconciliation>(this.path(FILES.reconciliations));
  }

  // ---- Keyed state (last write wins) ------------------------------------------

  saveOrder(order: StoredOrder): void {
    const path = this.path(FILES.orders);
    const all = readJson<Record<string, StoredOrder>>(path) ?? {};
    all[order.clientOrderId] = order;
    writeJsonAtomic(path, all);
  }

  readOrders(): readonly StoredOrder[] {
    const all = readJson<Record<string, StoredOrder>>(this.path(FILES.orders)) ?? {};
    return Object.values(all);
  }

  saveLot(lot: StoredLot): void {
    const path = this.path(FILES.lots);
    const all = readJson<Record<string, StoredLot>>(path) ?? {};
    all[lot.lotId] = lot;
    writeJsonAtomic(path, all);
  }

  readLots(): readonly StoredLot[] {
    const all = readJson<Record<string, StoredLot>>(this.path(FILES.lots)) ?? {};
    return Object.values(all);
  }

  saveMarket(market: StoredMarket): void {
    const path = this.path(FILES.markets);
    const all = readJson<Record<string, StoredMarket>>(path) ?? {};
    all[market.marketId] = market;
    writeJsonAtomic(path, all);
  }

  readMarkets(): readonly StoredMarket[] {
    const all = readJson<Record<string, StoredMarket>>(this.path(FILES.markets)) ?? {};
    return Object.values(all);
  }

  saveKillSwitch(state: StoredKillSwitch): void {
    writeJsonAtomic(this.path(FILES.killSwitch), state);
  }

  readKillSwitch(): StoredKillSwitch | undefined {
    return readJson<StoredKillSwitch>(this.path(FILES.killSwitch));
  }

  saveSnapshot(
    snapshot: Omit<PersistedSnapshot, "schemaVersion" | "writtenAtMs">,
    atMs: Millis,
  ): void {
    const full: PersistedSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      writtenAtMs: encodeMillis(atMs),
      ...snapshot,
    };
    writeJsonAtomic(this.path(FILES.snapshot), full);
  }

  readSnapshot(): PersistedSnapshot | undefined {
    const snapshot = readJson<PersistedSnapshot>(this.path(FILES.snapshot));
    if (snapshot === undefined) {
      return undefined;
    }
    assertSchemaVersion(snapshot);
    return snapshot;
  }

  healthy(): boolean {
    try {
      return existsSync(this.layout.root) && statSync(this.layout.root).isDirectory();
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests)
// ---------------------------------------------------------------------------

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  private readonly fills: FillEvent[] = [];
  private readonly decisions: StoredDecision[] = [];
  private readonly riskEvents: StoredRiskEvent[] = [];
  private readonly reconciliations: StoredReconciliation[] = [];
  private readonly orders = new Map<string, StoredOrder>();
  private readonly lots = new Map<string, StoredLot>();
  private readonly markets = new Map<string, StoredMarket>();
  private killSwitch: StoredKillSwitch | undefined;
  private snapshot: PersistedSnapshot | undefined;
  private healthyFlag = true;

  appendFillEvent(event: FillEvent): void {
    this.fills.push(event);
  }
  readFillEvents(): readonly FillEvent[] {
    return [...this.fills];
  }
  saveOrder(order: StoredOrder): void {
    this.orders.set(order.clientOrderId, order);
  }
  readOrders(): readonly StoredOrder[] {
    return [...this.orders.values()];
  }
  saveLot(lot: StoredLot): void {
    this.lots.set(lot.lotId, lot);
  }
  readLots(): readonly StoredLot[] {
    return [...this.lots.values()];
  }
  saveMarket(market: StoredMarket): void {
    this.markets.set(market.marketId, market);
  }
  readMarkets(): readonly StoredMarket[] {
    return [...this.markets.values()];
  }
  appendDecision(decision: StoredDecision): void {
    this.decisions.push(decision);
  }
  readDecisions(): readonly StoredDecision[] {
    return [...this.decisions];
  }
  appendRiskEvent(event: StoredRiskEvent): void {
    this.riskEvents.push(event);
  }
  readRiskEvents(): readonly StoredRiskEvent[] {
    return [...this.riskEvents];
  }
  appendReconciliation(reconciliation: StoredReconciliation): void {
    this.reconciliations.push(reconciliation);
  }
  readReconciliations(): readonly StoredReconciliation[] {
    return [...this.reconciliations];
  }
  saveKillSwitch(state: StoredKillSwitch): void {
    this.killSwitch = state;
  }
  readKillSwitch(): StoredKillSwitch | undefined {
    return this.killSwitch;
  }
  saveSnapshot(
    snapshot: Omit<PersistedSnapshot, "schemaVersion" | "writtenAtMs">,
    atMs: Millis,
  ): void {
    this.snapshot = {
      schemaVersion: SCHEMA_VERSION,
      writtenAtMs: encodeMillis(atMs),
      ...snapshot,
    };
  }
  readSnapshot(): PersistedSnapshot | undefined {
    return this.snapshot;
  }
  healthy(): boolean {
    return this.healthyFlag;
  }

  /** Test hook: simulate storage corruption/unavailability. */
  setHealthy(healthy: boolean): void {
    this.healthyFlag = healthy;
  }
}
