/**
 * Input model for the signal engine: a bounded, time-ordered price history
 * plus optional book context. Pure data; the engine never mutates it.
 */

import type { AssetSymbol, Millis } from "@bot/domain";

/** One spot observation for an underlying. */
export interface PriceSample {
  /** Venue/normalized last price as a decimal string (exactness preserved). */
  readonly price: string;
  /** Event timestamp (UTC ms). Must be non-decreasing across the array. */
  readonly at: Millis;
}

/** Optional order-book context at a point in time (depth-agnostic). */
export interface BookTop {
  readonly bid: string;
  readonly ask: string;
  readonly bidSize: string;
  readonly askSize: string;
  readonly at: Millis;
}

export interface AssetHistory {
  readonly asset: AssetSymbol;
  /** Time-ascending samples; the engine rejects out-of-order input. */
  readonly samples: readonly PriceSample[];
  /** Most recent book top, when available. */
  readonly book: BookTop | undefined;
}

/** Build a history, verifying the time-order invariant. Throws on violation. */
export function createAssetHistory(
  asset: string,
  samples: readonly { price: string; at: number }[],
  book?: { bid: string; ask: string; bidSize: string; askSize: string; at: number },
): AssetHistory {
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1]?.at;
    const curr = samples[i]?.at;
    if (prev !== undefined && curr !== undefined && curr < prev) {
      throw new Error(`asset ${asset} history is not time-ordered at index ${i}`);
    }
  }
  return {
    asset: asset as AssetSymbol,
    samples: samples.map((s) => ({ price: s.price, at: s.at as Millis })),
    book: book === undefined ? undefined : { ...book, at: book.at as Millis },
  };
}
