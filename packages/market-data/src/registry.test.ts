import { describe, expect, it } from "vitest";

import { millis, marketId } from "@bot/domain";

import { FIXTURE_TIMES, gammaBtcMarket } from "./fixtures.js";
import { normalizeMarket } from "./parse.js";
import { MetadataRegistry } from "./registry.js";
import type { DiscoveredMarket } from "./types.js";

const { OPEN } = FIXTURE_TIMES;
const NOW = millis(OPEN + 10_000);

function discovered(slugOverride?: string): DiscoveredMarket {
  const dto = gammaBtcMarket();
  if (slugOverride !== undefined) dto["slug"] = slugOverride;
  const r = normalizeMarket({ payload: dto, fetchedAt: NOW }, undefined, NOW);
  if (!r.ok) throw new Error(`fixture broken: ${r.error.detail}`);
  return r.value;
}

describe("MetadataRegistry", () => {
  it("caches immutable metadata on first observation", () => {
    const reg = new MetadataRegistry();
    const event = reg.observe(discovered(), NOW);
    expect(event.type).toBe("added");
    expect(reg.size()).toBe(1);
    const meta = reg.get(marketId("703257"));
    expect(meta?.upTokenId.length).toBeGreaterThan(10);
    expect(meta?.slug).toContain("bitcoin");
  });

  it("counts reaffirmations for identical observations", () => {
    const reg = new MetadataRegistry();
    reg.observe(discovered(), NOW);
    const event = reg.observe(discovered(), NOW);
    expect(event.type).toBe("reaffirmed");
    expect(reg.stats()).toEqual({ size: 1, conflicts: 0, reaffirmations: 1 });
  });

  it("reports conflicts and keeps the first observation", () => {
    const reg = new MetadataRegistry();
    reg.observe(discovered(), NOW);
    const event = reg.observe(discovered("bitcoin-up-or-down-2026-01-01-different"), NOW);
    expect(event.type).toBe("conflict");
    if (event.type === "conflict") expect(event.fields).toEqual(["slug"]);
    // first observation wins
    expect(reg.get(marketId("703257"))?.slug).not.toContain("different");
    expect(reg.stats().conflicts).toBe(1);
  });

  it("reconstructs the domain market from cached metadata", () => {
    const reg = new MetadataRegistry();
    reg.observe(discovered(), NOW);
    const meta = reg.get(marketId("703257"));
    if (meta === undefined) throw new Error("meta missing");
    const rebuilt = reg.toMarket(meta);
    expect(rebuilt.market.id).toBe("703257");
    expect(rebuilt.market.upToken.tokenId).toBe(meta.upTokenId);
    expect(rebuilt.market.openAt).toBe(meta.openAt);
  });
});
