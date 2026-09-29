/**
 * GammaMarketDiscovery: finds active BTC/ETH 5-minute Up/Down markets via the
 * public Gamma API and normalizes them into domain models.
 *
 * Read-only by construction: the transport only performs GETs against public
 * endpoints, attaches no credentials, and nothing here can place orders or
 * compute signals.
 *
 * Error policy (requirement 7): API errors reject the whole page (the caller
 * retries); malformed individual markets are skipped and counted, never fatal.
 */

import { nowMillis, type MarketId, type Millis } from "@bot/domain";

import { normalizeMarket } from "./parse.js";
import { MetadataRegistry, type RegistryEvent } from "./registry.js";
import { HttpTransport, TransportError, type GammaPage } from "./transport.js";
import type { DiscoveredMarket, DiscoveryPolicy, ParseFailure } from "./types.js";
import { DEFAULT_DISCOVERY_POLICY } from "./types.js";

export interface DiscoveryOptions {
  /** Gamma API host. Defaults to the public production host. */
  readonly host?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly policy?: DiscoveryPolicy;
  /** Milliseconds to look ahead when filtering markets worth returning. */
  readonly lookAheadMs?: number;
}

export interface DiscoveryResult {
  /** Valid, strategy-ready markets (active by venue status and by clock). */
  readonly active: readonly DiscoveredMarket[];
  /** Malformed/unusable markets skipped during this cycle. */
  readonly skipped: readonly ParseFailure[];
  /** Registry events from caching immutable metadata. */
  readonly registryEvents: readonly RegistryEvent[];
  readonly at: Millis;
}

export interface PageFetchResult {
  readonly raw: readonly unknown[];
  readonly at: Millis;
}

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const SLUG_PREFIXES = ["bitcoin-up-or-down", "ethereum-up-or-down"] as const;

export class GammaMarketDiscovery {
  private readonly transport: HttpTransport;
  private readonly policy: DiscoveryPolicy;
  private readonly lookAheadMs: number;
  readonly registry = new MetadataRegistry();

  constructor(options: DiscoveryOptions = {}) {
    this.transport = new HttpTransport({
      host: options.host ?? GAMMA_HOST,
      timeoutMs: options.timeoutMs ?? 10_000,
      fetchImpl: options.fetchImpl,
    });
    this.policy = options.policy ?? DEFAULT_DISCOVERY_POLICY;
    this.lookAheadMs = options.lookAheadMs ?? 3_600_000;
  }

  /** Build the slug-filter query for one asset's 5-minute series. */
  slugQuery(asset: "BTC" | "ETH", at: Millis): string {
    const prefix = asset === "BTC" ? SLUG_PREFIXES[0] : SLUG_PREFIXES[1];
    const day = new Date(at).toISOString().slice(0, 10); // UTC date
    return `${prefix}-${day}`;
  }

  /**
   * Fetch one page of markets by slug prefix. Public endpoint; no credentials.
   * Returns typed failures as rejected promises via TransportError.
   */
  async fetchPage(slugPrefix: string, cursor?: string): Promise<PageFetchResult> {
    const params = new URLSearchParams({ slug: slugPrefix, limit: "100" });
    if (cursor !== undefined) params.set("offset", cursor);
    const at = nowMillis();
    let payload: unknown;
    try {
      payload = await this.transport.getJson(`/markets?${params.toString()}`);
    } catch (e: unknown) {
      if (e instanceof TransportError) throw e;
      throw new TransportError(`unexpected transport failure: ${String(e)}`, "network", undefined);
    }
    const items = Array.isArray(payload)
      ? payload
      : typeof payload === "object" &&
          payload !== null &&
          Array.isArray((payload as GammaPage)["items"])
        ? (payload as GammaPage)["items"]
        : undefined;
    if (items === undefined) {
      throw new TransportError(
        "Gamma response is neither an array nor a page object",
        "http",
        undefined,
      );
    }
    return { raw: items, at };
  }

  /**
   * Discover and normalize markets for the enabled assets.
   * Malformed markets are skipped (returned in `skipped`); valid ones are
   * cached in the registry and filtered to currently/soon-active.
   */
  async discoverActive(
    assets: readonly ("BTC" | "ETH")[],
    now: Millis = nowMillis(),
  ): Promise<DiscoveryResult> {
    const active: DiscoveredMarket[] = [];
    const skipped: ParseFailure[] = [];
    const events: RegistryEvent[] = [];

    for (const asset of assets) {
      const prefix = asset === "BTC" ? SLUG_PREFIXES[0] : SLUG_PREFIXES[1];
      let raw: readonly unknown[];
      try {
        const page = await this.fetchPage(prefix);
        raw = page.raw;
      } catch (e: unknown) {
        // API error for this asset: surface as a skip entry, keep other assets.
        skipped.push({
          reason: "invalid_shape",
          detail: `API error fetching ${asset} markets: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      for (const item of raw) {
        const normalized = normalizeMarket({ payload: item, fetchedAt: now }, this.policy, now);
        if (!normalized.ok) {
          skipped.push(normalized.error);
          continue;
        }
        const d = normalized.value;
        // Only hand the strategy markets that are live now or within the
        // look-ahead window; everything else is cached but not returned.
        const startsSoon = d.market.openAt <= now + this.lookAheadMs;
        const notEnded = d.market.settleAt > now;
        const venueActive = d.status === "active";
        events.push(this.registry.observe(d, now));
        if (venueActive && startsSoon && notEnded) {
          active.push(d);
        }
      }
    }

    return { active, skipped, registryEvents: events, at: now };
  }

  /** Look up cached metadata for a market id. */
  cachedMeta(marketId: MarketId) {
    return this.registry.get(marketId);
  }
}
