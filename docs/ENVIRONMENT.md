# Environment variables

Copy `.env.example` to `.env` and fill in values. `.env` is git-ignored.

Configuration is validated at startup by `@bot/shared`'s config loader
(`packages/shared/src/config/`). Invalid configuration **refuses to start** and
reports every violation at once. Booleans accept only `true`/`false` (any
casing) — typos are rejected, not coerced. Decimal values are parsed with
exact 8-decimal-place arithmetic (`@bot/domain`), never floats.

Every variable below is optional with a safe default; unset credentials simply
report as "not present".

## Runtime

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` / `test` / `production`. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

## Trading

| Variable | Default | Description |
| --- | --- | --- |
| `TRADING_MODE` | `paper` | `paper` or `live`. |
| `LIVE_TRADING_ENABLED` | `false` | Master switch. See the guard below. |

**Live-trading guard.** `LIVE_TRADING_ENABLED=true` and `TRADING_MODE=live`
must be set together, and live mode additionally requires all four Polymarket
credential variables; anything else refuses to start. Live trading is not
implemented, and no credentials should exist during scaffold phase.

## Assets

| Variable | Default | Description |
| --- | --- | --- |
| `ASSETS` | `BTC,ETH` | Comma-separated subset of `BTC`, `ETH`. Duplicates/unknowns rejected. |

## Market

| Variable | Default | Description |
| --- | --- | --- |
| `MARKET_CYCLE_MS` | `300000` | Cycle length; the bot trades 5-minute markets. |
| `MARKET_LIVE_OFFSET_MS` | `240000` | Open → live offset (last 60s is live). |
| `MARKET_SETTLE_OFFSET_MS` | `300000` | Open → settlement offset. Must be ≥ live offset. |
| `MARKET_SETTLE_GRACE_MS` | `15000` | Grace after settlement before "overdue". |
| `MARKET_PHASE_MID` | `0.5` | EARLY→MID boundary as a cycle fraction (`mid < late < final`). |
| `MARKET_PHASE_LATE` | `0.75` | MID→LATE boundary as a cycle fraction. |
| `MARKET_PHASE_FINAL` | `0.9` | LATE→FINAL boundary as a cycle fraction. |
| `MARKET_DATA_POLL_INTERVAL_MS` | `1000` | Public market-data polling interval. |

## Strategy

| Variable | Default | Description |
| --- | --- | --- |
| `STRATEGY_MIN_CS_GROSS_EDGE` | `0.01` | Minimum complete-set gross edge (\|1 − up − down\|). |
| `STRATEGY_MIN_CS_NET_EDGE` | `0.005` | Minimum complete-set net edge (after fees). ≤ gross. |
| `STRATEGY_MAX_RESIDUAL` | `0.002` | Maximum acceptable merge/mint residual. |
| `STRATEGY_QUOTE_SIZE` | `25` | Default quote size (shares). ≤ max order size. |
| `STRATEGY_MAX_ORDER_SIZE` | `50` | Hard cap on a single order's size (shares); USDC caps live in the risk group. |
| `STRATEGY_MIN_QUOTE_LIFETIME_MS` | `2000` | Minimum resting time before a quote may be repriced. |
| `STRATEGY_MIN_REPRICE_INTERVAL_MS` | `1000` | Minimum interval between repricing actions. |
| `STRATEGY_SIZING_MODEL` | `directional` | Target-residual sizing model: `directional` (legacy `direction × confidence × maxResidual × phase`) or `edge` (fractional Kelly on the net edge vs the executable ask). |
| `STRATEGY_KELLY_FRACTION` | `0.25` | Kelly fraction in (0, 1] for the `edge` model. |
| `STRATEGY_MIN_EDGE` | `0.01` | Minimum net edge (probability units) required to trade at all; edge ≤ this means no order. |
| `CALIBRATION_FILE` | _(empty)_ | Optional path to a probability-calibration model (versioned JSON produced by `@bot/calibration`, T2). Empty = raw signal prior, no calibration. A configured file that fails to parse refuses to start. |

## Fees

Verified Polymarket crypto fee schedule — see `docs/RESOLUTION_AND_FEES.md`
for the official citations (docs.polymarket.com/trading/fees, retrieved
2026-09-29). A per-market Gamma `feeSchedule`, when present, is authoritative
at runtime.

| Variable | Default | Description |
| --- | --- | --- |
| `FEE_TAKER_RATE` | `0.07` | Crypto taker fee rate in `fee = C × rate × p × (1 − p)`. |
| `FEE_TAKER_ONLY` | `true` | Docs: makers are never charged; only takers pay. |
| `FEE_REBATE_RATE` | `0.2` | Informational maker-rebate share. |

## Risk

| Variable | Default | Description |
| --- | --- | --- |
| `RISK_MAX_TOTAL_CAPITAL` | `100` | Maximum total deployed capital (USDC). |
| `RISK_MAX_MARKET_CAPITAL` | `25` | Maximum capital per market. ≤ total capital. |
| `RISK_MAX_DIRECTIONAL_EXPOSURE` | `50` | Maximum signed directional exposure per asset. |
| `RISK_MAX_ORPHAN_INVENTORY` | `10` | Maximum unhedged inventory past the cycle. ≤ market capital. |
| `RISK_MAX_DAILY_LOSS` | `50` | Daily loss cutoff; trading halts when reached. ≤ total capital. |
| `RISK_MAX_OPEN_ORDERS` | `8` | Maximum concurrently open orders. |
| `RISK_MAX_DATA_AGE_MS` | `5000` | Max age of market data before trading pauses. |

## Execution

| Variable | Default | Description |
| --- | --- | --- |
| `EXECUTION_POST_ONLY` | `true` | Prefer post-only (maker) orders. |
| `EXECUTION_MAX_RETRIES` | `3` | Per-order submit/amend retry attempts. |
| `EXECUTION_MAX_RECONNECTS` | `5` | Reconnect attempts before hard backoff. |

## Hedge

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_EXTERNAL_HEDGE` | `false` | External hedge venue. **Must stay `false`** — no hedge implementation exists; `true` refuses to start. |

## Services

| Variable | Default | Description |
| --- | --- | --- |
| `API_PORT` | `3001` | Port for `apps/api` (0–65535). |
| `DATABASE_URL` | `postgres://localhost:5432/polymarket_bot` | Persistence connection. Never logged. |
| `SHUTDOWN_GRACE_PERIOD_MS` | `10000` | Grace period for graceful shutdown on SIGTERM/SIGINT (drain in-flight requests before exit). |

## Credentials (leave empty)

| Variable | Description |
| --- | --- |
| `POLYMARKET_API_KEY` | L2 API key. Do not create or set during scaffold phase. |
| `POLYMARKET_API_SECRET` | L2 API secret. |
| `POLYMARKET_API_PASSPHRASE` | L2 passphrase. |
| `POLYMARKET_WALLET_PRIVATE_KEY` | Wallet key. |

**Secret handling.** Credential values are never placed into the parsed
configuration — the loader reduces them to a single boolean
(`credentials.polymarketComplete`). The logger additionally redacts
secret-shaped keys (`apiKey`, `*passphrase`, `privateKey`, `databaseUrl`, …)
from every context object, and `toLogSafeConfig()` strips the services group
(database URL may embed a password) from anything destined for logs.
