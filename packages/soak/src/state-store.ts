/**
 * Soak state store: crash-safe persistence for the long-running runner.
 *
 * Two storage shapes:
 * - **State snapshot** (`state.json`): the full runner state, written
 *   ATOMICALLY (tmp file + rename) after every mutating step so a crash can
 *   never leave a torn file. On resume, this is the source of truth.
 * - **Event logs** (JSONL): `decisions-<date>.jsonl`, `fills-<date>.jsonl`,
 *   `reconciliations-<date>.jsonl` — append-only, one JSON object per line,
 *   rotated by UTC date. Structured and machine-diffable.
 *
 * No credentials pass through here: payloads are plain data (ids, fixed-point
 * decimal strings, counts).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { decFromString, marketId as marketIdBrand, tokenId as tokenIdBrand } from "@bot/domain";
import { createAcquisitionLot, type AcquisitionLot } from "@bot/inventory";

/** Rebuild a validated domain `AcquisitionLot` from its stored plain data. */
export function toAcquisitionLot(l: StoredLot): AcquisitionLot {
  return createAcquisitionLot({
    lotId: l.lotId,
    marketId: marketIdBrand(l.marketId),
    tokenId: tokenIdBrand(l.tokenId),
    outcome: l.outcome,
    qty: decFromString(l.qty),
    pricePerUnit: decFromString(l.pricePerUnit),
    fee: decFromString(l.fee),
    rebate: decFromString(l.rebate),
    acquiredAt: l.acquiredAt as never,
  });
}

/** Plain-data lot as persisted. */
export interface StoredLot {
  readonly lotId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly qty: string;
  readonly pricePerUnit: string;
  readonly fee: string;
  readonly rebate: string;
  readonly acquiredAt: number;
}

/** Everything needed to resume a soak run after restart. */
export interface SoakState {
  readonly startedAtMs: number;
  readonly lastTickMs: number;
  readonly tickCount: number;
  readonly decisionCount: number;
  /** Client order id counter (keeps ids unique across restarts). */
  readonly orderSeq: number;
  readonly lots: readonly StoredLot[];
  readonly knownTradeIds: readonly string[];
  /** UTC dates (yyyy-mm-dd) whose daily report has been written. */
  readonly reportedDays: readonly string[];
  /** Simulated cash balance, USDC (fixed-point string). */
  readonly cashUsdc: string;
}

export const EMPTY_STATE: SoakState = {
  startedAtMs: 0,
  lastTickMs: 0,
  tickCount: 0,
  decisionCount: 0,
  orderSeq: 0,
  lots: [],
  knownTradeIds: [],
  reportedDays: [],
  cashUsdc: "0.00000000",
};

export interface StoredDecision {
  readonly atMs: number;
  readonly decisionId: string;
  readonly asset: string;
  readonly marketId: string;
  readonly action: string;
  readonly orderSubmitted: boolean;
  readonly riskReason: string | undefined;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export interface StoredFill {
  readonly atMs: number;
  readonly clientOrderId: string;
  readonly tokenId: string;
  readonly outcome: "up" | "down";
  readonly side: "buy" | "sell";
  readonly qty: string;
  readonly price: string;
  readonly fee: string;
}

export interface StoredReconciliationEvent {
  readonly type: string;
  readonly localState: string;
  readonly remoteState: string;
  readonly action: string;
}

export interface StoredReconciliation {
  readonly atMs: number;
  readonly trigger: string;
  readonly state: string;
  readonly blocked: boolean;
  readonly eventCount: number;
  readonly summary: string;
  readonly events: readonly StoredReconciliationEvent[];
}

/** JSONL sink with UTC-date rotation: `<prefix>-<yyyy-mm-dd>.jsonl`. */
export class JsonlSink {
  private readonly dir: string;
  private readonly prefix: string;
  private currentDate: string | undefined;
  private currentPath: string | undefined;
  private lines = 0;

  constructor(dir: string, prefix: string) {
    this.dir = dir;
    this.prefix = prefix;
    mkdirSync(dir, { recursive: true });
  }

  /** Append one record; rotates files by UTC date. */
  append(record: object, nowMs: number): void {
    const date = new Date(nowMs).toISOString().slice(0, 10);
    if (this.currentDate !== date) {
      this.currentDate = date;
      this.currentPath = join(this.dir, `${this.prefix}-${date}.jsonl`);
    }
    appendFileSync(this.currentPath as string, `${JSON.stringify(record)}\n`, "utf8");
    this.lines += 1;
  }

  get lineCount(): number {
    return this.lines;
  }

  get path(): string | undefined {
    return this.currentPath;
  }
}

/** State file name inside the data directory. */
const STATE_FILE = "state.json";

export class SoakStateStore {
  private readonly dir: string;
  private readonly sinks: Record<"decisions" | "fills" | "reconciliations", JsonlSink>;
  private state: SoakState;

  constructor(dir: string, initial: SoakState) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.sinks = {
      decisions: new JsonlSink(join(dir, "logs"), "decisions"),
      fills: new JsonlSink(join(dir, "logs"), "fills"),
      reconciliations: new JsonlSink(join(dir, "logs"), "reconciliations"),
    };
    this.state = initial;
  }

  get current(): SoakState {
    return this.state;
  }

  /** Replace the in-memory state (caller mutates via a copy). */
  update(next: SoakState): void {
    this.state = next;
  }

  /** Persist the state atomically: write tmp, then rename over the target. */
  save(): void {
    const finalPath = join(this.dir, STATE_FILE);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmpPath, finalPath);
  }

  /** Read the persisted state; undefined when absent or corrupt. */
  static load(dir: string): SoakState | undefined {
    const path = join(dir, STATE_FILE);
    if (!existsSync(path)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SoakState;
    } catch {
      return undefined; // corrupt file: caller decides (fail-safe default: fresh)
    }
  }

  get sizeBytes(): number {
    const path = join(this.dir, STATE_FILE);
    return existsSync(path) ? statSync(path).size : 0;
  }

  appendDecision(d: StoredDecision): void {
    this.sinks.decisions.append(d, d.atMs);
  }

  appendFill(f: StoredFill): void {
    this.sinks.fills.append(f, f.atMs);
  }

  appendReconciliation(r: StoredReconciliation): void {
    this.sinks.reconciliations.append(r, r.atMs);
  }

  /** Write the daily report files for one UTC date. */
  writeDailyReport(date: string, csv: string, json: string): void {
    const reportsDir = join(this.dir, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, `daily-${date}.csv`), csv, "utf8");
    writeFileSync(join(reportsDir, `daily-${date}.json`), json, "utf8");
  }
}
