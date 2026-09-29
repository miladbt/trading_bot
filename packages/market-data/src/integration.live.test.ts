/**
 * Live integration suite (no credentials needed — public Gamma endpoints).
 *
 * Skipped entirely unless RUN_INTEGRATION_TESTS=true. This keeps `pnpm test`
 * fully offline (AGENTS.md rule) while providing a one-command live check:
 *
 *   RUN_INTEGRATION_TESTS=true pnpm --filter @bot/market-data test
 */

import { describe, expect, it } from "vitest";

import { nowMillis } from "@bot/domain";

import { GammaMarketDiscovery } from "./discover.js";
import { runDiscoveryBackendContract } from "./contract.js";

const ENABLED = process.env["RUN_INTEGRATION_TESTS"] === "true";

describe.skipIf(!ENABLED)("live Gamma discovery (public, no credentials)", () => {
  const now = nowMillis();
  const discovery = new GammaMarketDiscovery({ timeoutMs: 15_000 });

  runDiscoveryBackendContract(
    () => ({
      discoverActive: (assets, at) => discovery.discoverActive(assets, at ?? now),
    }),
    { assets: ["BTC", "ETH"], now },
  );

  it("reaches the live Gamma API and returns a page or a typed error", async () => {
    try {
      const page = await discovery.fetchPage("bitcoin-up-or-down");
      expect(Array.isArray(page.raw)).toBe(true);
    } catch (e: unknown) {
      // Network/HTTP problems are acceptable in a live environment check;
      // protocol violations are not — normalizeMarket would have caught those.
      expect((e as Error).name).toBe("TransportError");
    }
  });
});
