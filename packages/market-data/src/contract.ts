/**
 * Integration-test interfaces (requirement 10).
 *
 * `runDiscoveryBackendContract` is a reusable contract suite: any discovery
 * backend (the Gamma client, a stub for tests, or a future venue adapter) must
 * satisfy it. Unit tests run it against a stubbed backend; the live suite runs
 * it against the real API only when RUN_INTEGRATION_TESTS=true is set — no
 * credentials are required either way (public endpoints only).
 */

import { describe, expect, it } from "vitest";

import type { Millis } from "@bot/domain";

import type { MarketDiscoveryBackend } from "./index.js";

export interface ContractContext {
  readonly assets: readonly ("BTC" | "ETH")[];
  readonly now: Millis;
}

/**
 * Contract every discovery backend must satisfy. Deliberately conservative:
 * a backend serving zero markets right now (e.g. venue offline between
 * series) must still pass — discovery degrades to "no active markets".
 */
export function runDiscoveryBackendContract(
  makeBackend: (ctx: ContractContext) => MarketDiscoveryBackend,
  ctx: ContractContext,
): void {
  describe("discovery backend contract", () => {
    it("returns a well-formed result without throwing", async () => {
      const backend = makeBackend(ctx);
      const result = await backend.discoverActive(ctx.assets, ctx.now);
      expect(Array.isArray(result.active)).toBe(true);
      expect(Array.isArray(result.skipped)).toBe(true);
      expect(Array.isArray(result.registryEvents)).toBe(true);
      expect(result.at).toBe(ctx.now);
    });

    it("only ever returns BTC/ETH 5-minute markets", async () => {
      const backend = makeBackend(ctx);
      const result = await backend.discoverActive(ctx.assets, ctx.now);
      for (const d of result.active) {
        expect(["BTC", "ETH"]).toContain(d.market.asset);
        const duration = Number(d.market.settleAt - d.market.openAt);
        expect(duration).toBeGreaterThan(240_000);
        expect(duration).toBeLessThan(360_000);
        expect(d.market.upToken.tokenId).not.toBe(d.market.downToken.tokenId);
      }
    });

    it("never returns closed or already-ended markets as active", async () => {
      const backend = makeBackend(ctx);
      const result = await backend.discoverActive(ctx.assets, ctx.now);
      for (const d of result.active) {
        expect(d.status).not.toBe("closed");
        expect(d.market.settleAt).toBeGreaterThan(ctx.now);
      }
    });

    it("records resolution metadata without inventing an oracle", async () => {
      const backend = makeBackend(ctx);
      const result = await backend.discoverActive(ctx.assets, ctx.now);
      for (const d of result.active) {
        // Either the venue reported a source, or it is undefined — never a guess.
        if (d.resolution.oracleSource !== undefined) {
          expect(typeof d.resolution.oracleSource).toBe("string");
          expect(d.resolution.oracleSource.length).toBeGreaterThan(0);
        }
      }
    });
  });
}
