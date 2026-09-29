/**
 * Branded primitives for the strongest-typed identities in the domain.
 *
 * A branded type is a string (or bigint) that TypeScript treats as incompatible
 * with any other string, even though at runtime it is plain JSON-safe data.
 * This prevents the classic bug of passing a tokenId where a marketId is
 * expected, or mixing a Decimal with a raw float, at zero runtime cost.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Opaque string identifier of a given brand. */
export type Tagged<B extends string> = Brand<string, B>;

export type AssetSymbol = Tagged<"AssetSymbol">;
export type MarketId = Tagged<"MarketId">;
export type MarketSlug = Tagged<"MarketSlug">;
export type TokenId = Tagged<"TokenId">;
export type OrderId = Tagged<"OrderId">;
export type FillId = Tagged<"FillId">;
export type PositionId = Tagged<"PositionId">;

/** Milliseconds since the Unix epoch, always UTC. */
export type Millis = Brand<number, "Millis">;

/**
 * UTC ISO-8601 timestamp string, e.g. `2026-09-26T17:00:00.000Z`.
 * The brand guarantees the `Z` suffix so naive (timezone-less) strings cannot
 * flow into the domain.
 */
export type UtcIso = Brand<string, "UtcIso">;
