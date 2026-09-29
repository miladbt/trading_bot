/**
 * Shared domain types. Deliberately minimal — trading logic comes later.
 * Direction conventions here are the single source of truth for all packages.
 */

export type Side = "buy" | "sell";

export type Outcome = "up" | "down";

/** A token on Polymarket CLOB (one per outcome of a binary market). */
export interface TokenRef {
  tokenId: string;
  outcome: Outcome;
}

export interface PriceQuote {
  tokenId: string;
  price: number;
  /** Epoch ms when the quote was observed. */
  at: number;
}
