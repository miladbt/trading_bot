/**
 * Historical replay data model and loader.
 *
 * Replay input is plain JSON (no credentials, no network): a list of 5-minute
 * market windows, each with underlying spot samples, optional order-book
 * snapshots, the executable up/down asks per phase, and a settlement result.
 * The loader validates shapes and time-ordering, then hands immutable data to
 * the engine.
 */

import { ValidationError, decCompare, decFromString, type Decimal, millis } from "@bot/domain";

/** One order-book snapshot (depth-1 top of book is sufficient for replay). */
export interface HistoricalBookEvent {
  readonly at: number;
  readonly bid: string;
  readonly ask: string;
  readonly bidSize: string;
  readonly askSize: string;
}

/** One underlying spot sample (BTC or ETH), time-ascending within a window. */
export interface HistoricalSpotSample {
  readonly at: number;
  readonly price: string;
}

/** Executable up/down asks at a moment of the cycle. */
export interface HistoricalAskSnapshot {
  readonly at: number;
  readonly upAsk: string;
  readonly downAsk: string;
}

/** One replayed 5-minute market window. */
export interface HistoricalMarketWindow {
  readonly marketId: string;
  readonly asset: "BTC" | "ETH";
  readonly tokenIdUp: string;
  readonly tokenIdDown: string;
  /** Cycle open, epoch ms. */
  readonly startMs: number;
  /** Cycle close (settlement), epoch ms. */
  readonly endMs: number;
  /** Which token actually won at settlement ("up" | "down"). */
  readonly winningOutcome: "up" | "down";
  /** Underlying spot samples, time-ascending. */
  readonly spot: readonly HistoricalSpotSample[];
  /** Order-book snapshots/events for the underlying, time-ascending. */
  readonly book: readonly HistoricalBookEvent[];
  /** Polymarket-style executable asks through the cycle, time-ascending. */
  readonly asks: readonly HistoricalAskSnapshot[];
}

export interface HistoricalDataset {
  readonly name: string;
  readonly windows: readonly HistoricalMarketWindow[];
}

/** Parsed asks with Decimals, ready for the engine. */
export interface ParsedAskSnapshot {
  readonly at: number;
  readonly upAsk: Decimal;
  readonly downAsk: Decimal;
}

export interface ParsedWindow {
  readonly marketId: string;
  readonly asset: "BTC" | "ETH";
  readonly tokenIdUp: string;
  readonly tokenIdDown: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly winningOutcome: "up" | "down";
  readonly spot: readonly { at: number; price: string }[];
  readonly book: readonly HistoricalBookEvent[];
  readonly asks: readonly ParsedAskSnapshot[];
}

function assertAscending(values: readonly number[], label: string): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[i - 1]!) {
      throw new ValidationError(`${label} must be time-ascending (index ${i})`);
    }
  }
}

function requirePositiveFraction(value: string, label: string): void {
  const v = decFromString(value);
  const zero = decFromString("0");
  const one = decFromString("1");
  if (decCompare(v, zero) <= 0 || decCompare(v, one) >= 0) {
    throw new ValidationError(`${label} must be a price in (0, 1), got ${value}`);
  }
}

/** Validate and parse a raw dataset into engine-ready windows. */
export function parseDataset(raw: HistoricalDataset): ParsedWindow[] {
  if (raw.windows.length === 0) {
    throw new ValidationError("replay dataset must contain at least one market window");
  }
  return raw.windows.map((w) => {
    if (w.endMs <= w.startMs) {
      throw new ValidationError(`window ${w.marketId}: endMs must be after startMs`);
    }
    if (w.winningOutcome !== "up" && w.winningOutcome !== "down") {
      throw new ValidationError(`window ${w.marketId}: winningOutcome must be "up" or "down"`);
    }
    assertAscending(
      w.spot.map((s) => s.at),
      `window ${w.marketId} spot samples`,
    );
    assertAscending(
      w.book.map((b) => b.at),
      `window ${w.marketId} book events`,
    );
    assertAscending(
      w.asks.map((a) => a.at),
      `window ${w.marketId} ask snapshots`,
    );
    for (const a of w.asks) {
      requirePositiveFraction(a.upAsk, `window ${w.marketId} upAsk`);
      requirePositiveFraction(a.downAsk, `window ${w.marketId} downAsk`);
    }
    return {
      marketId: w.marketId,
      asset: w.asset,
      tokenIdUp: w.tokenIdUp,
      tokenIdDown: w.tokenIdDown,
      startMs: w.startMs,
      endMs: w.endMs,
      winningOutcome: w.winningOutcome,
      spot: w.spot.map((s) => ({ at: s.at, price: s.price })),
      book: w.book,
      asks: w.asks.map((a) => ({
        at: a.at,
        upAsk: decFromString(a.upAsk),
        downAsk: decFromString(a.downAsk),
      })),
    };
  });
}

/** Load a dataset from a JSON string (no credentials, no network). */
export function loadDatasetJson(json: string): HistoricalDataset {
  const raw = JSON.parse(json) as HistoricalDataset;
  if (typeof raw.name !== "string" || !Array.isArray(raw.windows)) {
    throw new ValidationError("dataset JSON must be { name: string, windows: [...] }");
  }
  return raw;
}

/** Convenience: epoch ms helper for fixture authors. */
export { millis as replayMillis };
