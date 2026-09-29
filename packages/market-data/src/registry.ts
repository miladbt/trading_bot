/**
 * Metadata registry: the safe-cache layer for discovery results.
 *
 * Only immutable, venue-verified metadata is cached (ids, token pair, time
 * window, slug, asset) — never status, resolution, or anything time-dependent.
 * Duplicate observations are deduplicated by market id; conflicts on immutable
 * fields are surfaced, not silently overwritten.
 */

import { createMarket, type MarketId, type Millis } from "@bot/domain";

import type { DiscoveredMarket, ImmutableMarketMeta } from "./types.js";

export type RegistryEvent =
  | { readonly type: "added"; readonly marketId: MarketId }
  | { readonly type: "reaffirmed"; readonly marketId: MarketId }
  | {
      readonly type: "conflict";
      readonly marketId: MarketId;
      readonly fields: readonly string[];
    };

export interface RegistryStats {
  readonly size: number;
  readonly conflicts: number;
  readonly reaffirmations: number;
}

export class MetadataRegistry {
  private readonly byId = new Map<MarketId, ImmutableMarketMeta>();
  private conflictCount = 0;
  private reaffirmCount = 0;

  /**
   * Record a discovery observation. First verified observation wins; later
   * conflicting observations are dropped and counted, never merged.
   */
  observe(discovered: DiscoveredMarket, _at: Millis): RegistryEvent {
    const meta: ImmutableMarketMeta = {
      marketId: discovered.market.id,
      conditionId: discovered.conditionId,
      upTokenId: discovered.market.upToken.tokenId,
      downTokenId: discovered.market.downToken.tokenId,
      slug: discovered.market.slug,
      asset: discovered.market.asset,
      openAt: discovered.market.openAt,
      liveAt: discovered.market.liveAt,
      settleAt: discovered.market.settleAt,
    };
    const existing = this.byId.get(meta.marketId);
    if (existing === undefined) {
      this.byId.set(meta.marketId, meta);
      return { type: "added", marketId: meta.marketId };
    }
    const conflicts: string[] = [];
    if (existing.upTokenId !== meta.upTokenId) conflicts.push("upTokenId");
    if (existing.downTokenId !== meta.downTokenId) conflicts.push("downTokenId");
    if (existing.conditionId !== meta.conditionId) conflicts.push("conditionId");
    if (existing.openAt !== meta.openAt) conflicts.push("openAt");
    if (existing.liveAt !== meta.liveAt) conflicts.push("liveAt");
    if (existing.settleAt !== meta.settleAt) conflicts.push("settleAt");
    if (existing.slug !== meta.slug) conflicts.push("slug");
    if (existing.asset !== meta.asset) conflicts.push("asset");
    if (conflicts.length === 0) {
      this.reaffirmCount += 1;
      return { type: "reaffirmed", marketId: meta.marketId };
    }
    this.conflictCount += 1;
    return { type: "conflict", marketId: meta.marketId, fields: conflicts };
  }

  /** Snapshot of all cached metadata, in insertion order. */
  all(): readonly ImmutableMarketMeta[] {
    return [...this.byId.values()];
  }

  get(marketId: MarketId): ImmutableMarketMeta | undefined {
    return this.byId.get(marketId);
  }

  /**
   * Rebuild the domain model from cached immutable metadata. Cached meta was
   * validated at parse time, so domain construction cannot fail here.
   */
  toMarket(meta: ImmutableMarketMeta) {
    const market = createMarket({
      id: meta.marketId,
      slug: meta.slug,
      asset: meta.asset,
      openAt: meta.openAt,
      liveAt: meta.liveAt,
      settleAt: meta.settleAt,
      upTokenId: meta.upTokenId,
      downTokenId: meta.downTokenId,
      phase: "announced",
    });
    return {
      market,
      conditionId: meta.conditionId,
      status: "active" as const,
      resolution: {
        winningOutcome: undefined,
        oracleSource: undefined,
        resolvedAt: undefined,
      },
      discoveredAt: meta.openAt,
    };
  }

  size(): number {
    return this.byId.size;
  }

  stats(): RegistryStats {
    return {
      size: this.byId.size,
      conflicts: this.conflictCount,
      reaffirmations: this.reaffirmCount,
    };
  }
}
