// Public API of @bot/market-data.
// Discovery and underlying feeds are read-only: no order submission, no
// wallets, no trading. Signals are computed downstream from these inputs.

import type { Millis } from "@bot/domain";
import type { DiscoveryResult } from "./discover.js";

export * from "./underlying/index.js";

export {
  GammaMarketDiscovery,
  type DiscoveryOptions,
  type DiscoveryResult,
  type PageFetchResult,
} from "./discover.js";
export { MetadataRegistry, type RegistryEvent, type RegistryStats } from "./registry.js";
export {
  HttpTransport,
  TransportError,
  type TransportOptions,
  type GammaPage,
} from "./transport.js";
export {
  normalizeMarket,
  parseRawMarket,
  toDiscoveredMarket,
  type ParsedMarketParts,
} from "./parse.js";
export {
  DEFAULT_DISCOVERY_POLICY,
  isBtcOrEth,
  type DiscoveredMarket,
  type DiscoveryPolicy,
  type ImmutableMarketMeta,
  type MarketStatus,
  type ParseFailure,
  type ParseFailureReason,
  type RawMarketRecord,
  type ResolutionMetadata,
} from "./types.js";
export {
  dtoConditionId,
  dtoId,
  dtoQuestion,
  dtoResolution,
  dtoSlug,
  dtoTiming,
  dtoTokenIds,
  type ParsedTokenIds,
} from "./dto.js";

/** Integration-test seam: a minimal contract any discovery backend must satisfy. */
export interface MarketDiscoveryBackend {
  discoverActive(assets: readonly ("BTC" | "ETH")[], now?: Millis): Promise<DiscoveryResult>;
}
