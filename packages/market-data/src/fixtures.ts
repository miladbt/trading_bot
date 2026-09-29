/**
 * Recorded-style Gamma API fixtures for unit tests (no live API involved).
 */

const OPEN = 1_790_000_000_000; // a fixed future-ish epoch, UTC
const LIVE = OPEN + 240_000;
const SETTLE = OPEN + 300_000;

export const FIXTURE_TIMES = { OPEN, LIVE, SETTLE } as const;

export const UP_TOKEN =
  "109460580302978082527056067289042134695668570304443425844122563553893883450";
export const DOWN_TOKEN =
  "60785039055626575385311928813922171223902683676496892458368451549428326525";

/** A well-formed active BTC 5-minute up/down market, Gamma-shaped. */
export function gammaBtcMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "703257",
    slug: `bitcoin-up-or-down-${new Date(OPEN).toISOString().slice(0, 10)}`,
    question: "Bitcoin Up or Down - 5 minute свечи?",
    conditionId: "0xaaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1",
    clobTokenIds: `["${UP_TOKEN}","${DOWN_TOKEN}"]`,
    outcomes: '["Up","Down"]',
    outcomePrices: '["0.5","0.5"]',
    closed: false,
    active: true,
    startDate: new Date(OPEN).toISOString(),
    endDate: new Date(SETTLE).toISOString(),
    gameStartTime: new Date(OPEN).toISOString(),
    ...overrides,
  };
}

/** A well-formed active ETH 5-minute market. */
export function gammaEthMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return gammaBtcMarket({
    id: "703300",
    slug: `ethereum-up-or-down-${new Date(OPEN).toISOString().slice(0, 10)}`,
    question: "Ethereum Up or Down - 5 minute candles?",
    conditionId: "0xbbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2",
    ...overrides,
  });
}

/** Page envelope used by Gamma keyset endpoints. */
export function gammaPage(items: readonly unknown[], nextCursor?: string): unknown {
  return { items, next_cursor: nextCursor };
}
