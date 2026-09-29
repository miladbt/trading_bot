import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISCOVERY_POLICY,
  GammaMarketDiscovery,
  MetadataRegistry,
  normalizeMarket,
} from "./index.js";

describe("market-data public API", () => {
  it("exposes the discovery client, registry, parser, and policy", () => {
    expect(GammaMarketDiscovery).toBeTypeOf("function");
    expect(MetadataRegistry).toBeTypeOf("function");
    expect(typeof normalizeMarket).toBe("function");
    expect(DEFAULT_DISCOVERY_POLICY.cycleMs).toBe(300_000);
  });

  it("constructs a client with defaults and no credentials", () => {
    const discovery = new GammaMarketDiscovery();
    expect(discovery.registry.size()).toBe(0);
  });
});
