import { describe, expect, it, vi } from "vitest";

import { millis } from "@bot/domain";

import { FIXTURE_TIMES, gammaBtcMarket, gammaEthMarket, gammaPage } from "./fixtures.js";
import { GammaMarketDiscovery } from "./discover.js";
import { TransportError } from "./transport.js";
import { DOWN_TOKEN, UP_TOKEN } from "./fixtures.js";

const { OPEN } = FIXTURE_TIMES;
const NOW = millis(OPEN + 10_000);

type FetchHandler = (url: string) => Response | Promise<Response>;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchFrom(handler: FetchHandler): typeof fetch {
  return vi.fn((input: string | URL | Request) =>
    handler(requestUrl(input)),
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route by slug query so each asset's fetch sees its own JSON body. */
function assetAwareFetch(btc: unknown, eth: unknown): typeof fetch {
  return fetchFrom((url) => {
    if (url.includes("slug=bitcoin")) return jsonResponse(btc);
    if (url.includes("slug=ethereum")) return jsonResponse(eth);
    return jsonResponse([], 404);
  });
}

function makeDiscovery(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new GammaMarketDiscovery({
    fetchImpl,
    timeoutMs: 1_000,
    policy: {
      cycleMs: 300_000,
      liveOffsetMs: 240_000,
      settleOffsetMs: 300_000,
      durationTolerancePct: 0.25,
      maxAgeMs: 3_600_000,
    },
    lookAheadMs: 3_600_000,
    ...overrides,
  });
}

describe("GammaMarketDiscovery", () => {
  it("discovers active BTC and ETH markets from mocked pages", async () => {
    const discovery = makeDiscovery(assetAwareFetch([gammaBtcMarket()], [gammaEthMarket()]));
    const result = await discovery.discoverActive(["BTC", "ETH"], NOW);
    expect(result.active).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    const assets = result.active.map((d) => d.market.asset).sort();
    expect(assets).toEqual(["BTC", "ETH"]);
    expect(result.active[0]?.market.upToken.tokenId.length).toBeGreaterThan(10);
  });

  it("skips malformed markets and still returns valid ones", async () => {
    const discovery = makeDiscovery(
      assetAwareFetch(
        [gammaBtcMarket(), { id: "999999", slug: "bitcoin-up-or-down-x" }, "garbage"],
        [gammaEthMarket({ endDate: null })],
      ),
    );
    const result = await discovery.discoverActive(["BTC", "ETH"], NOW);
    expect(result.active).toHaveLength(1);
    expect(result.skipped).toHaveLength(3);
    expect(result.active[0]?.market.asset).toBe("BTC");
  });

  it("does not return expired markets", async () => {
    const discovery = makeDiscovery(
      assetAwareFetch(
        [
          gammaBtcMarket({
            startDate: new Date(OPEN - 3_600_000).toISOString(),
            endDate: new Date(OPEN - 3_300_000).toISOString(),
            gameStartTime: new Date(OPEN - 3_600_000).toISOString(),
          }),
        ],
        [],
      ),
    );
    const result = await discovery.discoverActive(["BTC"], NOW);
    expect(result.active).toHaveLength(0);
  });

  it("does not return closed markets", async () => {
    const discovery = makeDiscovery(assetAwareFetch([gammaBtcMarket({ closed: true })], []));
    const result = await discovery.discoverActive(["BTC"], NOW);
    expect(result.active).toHaveLength(0);
  });

  it("deduplicates duplicate markets into the registry without conflict", async () => {
    const discovery = makeDiscovery(assetAwareFetch([gammaBtcMarket(), gammaBtcMarket()], []));
    const result = await discovery.discoverActive(["BTC"], NOW);
    expect(result.active).toHaveLength(2);
    const added = result.registryEvents.filter((e) => e.type === "added");
    const reaffirmed = result.registryEvents.filter((e) => e.type === "reaffirmed");
    expect(added).toHaveLength(1);
    expect(reaffirmed).toHaveLength(1);
    expect(discovery.registry.size()).toBe(1);
  });

  it("surfaces conflicting immutable metadata instead of overwriting", async () => {
    const tampered = gammaBtcMarket({
      clobTokenIds: `["${DOWN_TOKEN}","${UP_TOKEN}"]`,
      outcomes: '["Up","Down"]',
    });
    const discovery = makeDiscovery(assetAwareFetch([gammaBtcMarket(), tampered], []));
    const result = await discovery.discoverActive(["BTC"], NOW);
    const conflicts = result.registryEvents.filter((e) => e.type === "conflict");
    expect(conflicts).toHaveLength(1);
    if (conflicts[0]?.type === "conflict") {
      expect(conflicts[0].fields).toContain("upTokenId");
    }
  });

  it("maps API errors to a skipped entry and keeps other assets", async () => {
    const discovery = makeDiscovery(
      fetchFrom((url) => {
        if (url.includes("slug=bitcoin")) return jsonResponse({ error: "boom" }, 500);
        return jsonResponse([gammaEthMarket()]);
      }),
    );
    const result = await discovery.discoverActive(["BTC", "ETH"], NOW);
    expect(result.active).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.detail).toContain("API error");
  });

  it("propagates TransportError on timeout", async () => {
    // Mock a real fetch: it rejects with AbortError when the signal fires.
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    const discovery = new GammaMarketDiscovery({ fetchImpl, timeoutMs: 25 });
    await expect(discovery.fetchPage("bitcoin-up-or-down")).rejects.toThrow(TransportError);
  });

  it("parses page-envelope responses as well as plain arrays", async () => {
    const discovery = makeDiscovery(assetAwareFetch(gammaPage([gammaBtcMarket()]), []));
    const result = await discovery.discoverActive(["BTC"], NOW);
    expect(result.active).toHaveLength(1);
  });

  it("builds UTC-date slug queries per asset", () => {
    const discovery = makeDiscovery(assetAwareFetch([], []));
    const q = discovery.slugQuery("BTC", NOW);
    expect(q).toContain("bitcoin-up-or-down-");
    expect(q).toMatch(/\d{4}-\d{2}-\d{2}$/);
    expect(discovery.slugQuery("ETH", NOW)).toContain("ethereum-up-or-down-");
  });
});
