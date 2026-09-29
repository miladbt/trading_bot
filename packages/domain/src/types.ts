/**
 * Canonical enum-like unions shared across the domain. Defined once here;
 * every other module re-uses these rather than redeclaring them.
 */

/** What an order wants to do. */
export type Side = "buy" | "sell";

/** The two binary outcomes of an up/down market. */
export type Outcome = "up" | "down";
