# @bot/market-data

Two read-only data subsystems:

1. **Polymarket market discovery** — finds active BTC/ETH 5-minute Up/Down
   markets via the public Gamma API and normalizes them into `@bot/domain`
   models (see below).
2. **Underlying spot data (`src/underlying/`)** — BTCUSDT/ETHUSDT WebSocket
   feed via a normalized `UnderlyingMarketDataProvider` interface, for signal
   generation only.

**Read-only by construction.** No order submission, no wallets, no trading, no
signal calculation, no credentials. The strategy depends only on the provider
interfaces here — never on an exchange SDK.

## Underlying market data (`src/underlying/`)

- `UnderlyingMarketDataProvider` — normalized seam: `start/stop`,
  `snapshot(symbol)` (last price, bid, ask, spread, volume, timestamp,
  staleness), `freshnessMs`, connection `status`, and event/status listeners.
- `BinanceUnderlyingProvider` — the concrete provider:
  - combined-stream `@ticker` subscription for the configured symbols
  - **reconnect with exponential backoff** (base → cap, announced in the
    status detail) on abnormal close, error, or factory failure
  - **heartbeat**: silence beyond `heartbeatIntervalMs` forces a reconnect
  - **staleness detection**: `stale`/`ageMs` vs `maxDataAgeMs`
  - **out-of-order rejection**: strictly older venue timestamps are dropped
    and counted; equal timestamps re-apply idempotently
  - malformed/unattributable payloads are counted, never fatal
- `MockWebSocket` / `MockSocketFactory` — deterministic test doubles; the
  full lifecycle (open/message/close/error, backoff timing via fake timers,
  injected clock for staleness) is covered by deterministic unit tests.

## Polymarket discovery (Gamma)

## How it works

1. `HttpTransport` fetches public Gamma endpoints (injectable `fetch`, timeout,
   typed `TransportError`s).
2. `dto.ts` accessors defensively flatten the loosely typed DTO (stringified
   JSON arrays like `clobTokenIds`/`outcomes`, nullable everything).
3. `parse.ts` validates market metadata and produces `DiscoveredMarket` via
   `Result` — malformed markets never throw and never reach the strategy:
   - requires id, a complete distinct up/down token pair, BTC/ETH asset,
     and a ~5-minute (`cycleMs` ± tolerance) window
   - derives `openAt`/`liveAt`/`settleAt` from `gameStartTime ?? startDate`
     and `endDate`
   - skips markets that ended longer than `maxAgeMs` ago
4. `MetadataRegistry` caches only immutable, venue-verified metadata
   (ids, token pair, window, slug, asset). Duplicates are deduplicated;
   conflicting observations are counted and dropped, never merged.
5. `GammaMarketDiscovery.discoverActive()` orchestrates per-asset fetches,
   returning `{ active, skipped, registryEvents, at }` — API errors degrade to
   skip entries instead of failing the whole cycle.

## What is captured per market

| Field | Source |
| --- | --- |
| market id | Gamma `id` |
| condition id | Gamma `conditionId` (optional) |
| Up / Down token ids | Gamma `clobTokenIds` paired with `outcomes` labels |
| start / end time | `gameStartTime ?? startDate` / `endDate` |
| active / closed state | `active` + `closed` flags, plus clock checks |
| resolution metadata | `winningOutcome`, `resolutionSource` (verbatim; never inferred, **no oracle assumed**) |

## Testing

- `pnpm test` — fully offline, deterministic unit tests: mocked Gamma API
  responses (`fixtures.ts`), the reusable backend contract (`contract.ts`),
  and mock-WebSocket underlying-feed lifecycle tests.
- `RUN_INTEGRATION_TESTS=true pnpm --filter @bot/market-data test` — runs the
  discovery contract against the live public Gamma API. No credentials
  required or used.
