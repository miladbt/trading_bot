# polymarket-bot

Trading bot for Polymarket BTC/ETH 5-minute up/down markets.

**Status: scaffold only.** No Polymarket connectivity, no credentials, no strategy,
and no live trading is implemented yet. Everything below is structure and tooling.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/trader` | Long-running trading process (strategy loop, risk, execution). Stub. |
| `apps/api` | HTTP API for status/monitoring/control. Stub. |
| `packages/shared` | Types, config loading, env parsing, shared logging. Implemented (minimal). |
| `packages/domain` | Pure domain models: assets, markets, phases, orders, fills, positions, inventory, complete sets, signals, risk/trading decisions, PnL, balances. Implemented — see `ARCHITECTURE.md`. |
| `packages/strategy` | Deterministic signal engine for BTC/ETH: momentum, return, volatility, book imbalance, acceleration, range position, freshness — configurable thresholds, pure functions. |
| `packages/risk` | The authoritative RiskEngine (`evaluateRiskOrder`): 15 canonical fail-closed checks (capital, order size, open orders, exposure, residual/orphan, losses, stale data, health, market expiry). Pure, deterministic, unknown state ⇒ no new orders. See its README. |
| `packages/execution` | `ExecutionAdapter` port + deterministic `PaperExecutionAdapter` (simulated books, post-only, partial fills, fees, latency, cancels). Fail-closed factory: paper mode can never reach a live venue adapter. |
| `packages/market-data` | Discovery of BTC/ETH 5-minute markets via the public Gamma API, plus the BTCUSDT/ETHUSDT underlying spot feed (`UnderlyingMarketDataProvider`, WebSocket, reconnect/backoff, heartbeat, staleness). Read-only; deterministic + mock-WebSocket tests. |
| `packages/inventory` | Lot-level acquisition tracking, the complete-set accumulation engine (`matchCompleteSets`), the hybrid rebalancing planner (`planRebalance` → `StrategyDecision`), and the decision-only hedging engine (`decideHedge` → `HedgeDecision`; external hedge execution disabled by default). Pure functions; never forces neutrality; never submits orders. See `STRATEGY.md`. |
| `packages/persistence` | State persistence + crash recovery: `PersistenceAdapter` port (file-backed JSONL event streams + atomic snapshot; in-memory for tests), idempotent fill ingestion, deterministic inventory/sets/residual rebuild, fail-closed `RecoveryManager`, persisted kill-switch. Schema: `MIGRATIONS.md`. |
| `packages/orchestrator` | Deterministic strategy orchestrator: full pipeline per market per tick (discovery → data → signal → phase → inventory → complete-set → rebalancing → risk → paper execution), with decision ids, audit trail, duplicate prevention, throttling, and staleness halts. |
| `hermes` | Operational control interface: HMAC-authenticated, audited, fail-safe command plane (see `HERMES.md`). No order submission by design; roles are resolved server-side, never client-claimed. |
| `packages/observability` | Metrics (deterministic Prometheus/JSON registry + typed collectors per concern area) and structured redacting logs. Fail-closed secret hygiene on metric labels. |
| `packages/soak` | Long-running paper-trading soak runner (`pnpm soak`): paper-mode validation, health monitoring, fail-closed reconnect, atomic state persistence, periodic reconciliation, JSONL decision logs, UTC daily reports, restart recovery. Measurement only. See `SOAK.md`. |

## Toolchain

- Node.js ≥ 22, pnpm ≥ 12 (via corepack)
- TypeScript strict (`tsconfig.base.json`), project references for typecheck (`pnpm typecheck`)
- ESLint 9 flat config with type-checked rules (`pnpm lint`)
- Prettier (`pnpm format` / `pnpm format:check`)
- Vitest (`pnpm test`)

## Commands

```bash
pnpm install        # install dependencies
pnpm lint           # eslint across the workspace
pnpm typecheck      # tsc --build across all packages
pnpm test           # vitest across all packages
pnpm format:check   # prettier check
pnpm soak           # long-running paper soak loop (see SOAK.md)
```

See `AGENTS.md` for working conventions, `ARCHITECTURE.md` for the domain
design, and `docs/ENVIRONMENT.md` for env vars.

## Deployment

The repo ships production deployment artifacts (`Dockerfile`,
`docker-compose.yml`, `.dockerignore`). The container **starts in paper
mode** — `TRADING_MODE=paper` and `LIVE_TRADING_ENABLED=false` are baked into
the image *and* re-asserted in compose — and live trading does not exist in
the codebase, so the stack cannot trade.

```bash
cp .env.example .env      # local secrets; git-ignored; never committed
docker compose up -d --build
docker compose ps         # health/readiness status
docker compose logs -f api
docker compose stop       # SIGTERM -> graceful drain -> exit 0
```

- **Endpoints:** `GET /health` (liveness, image `HEALTHCHECK`) and
  `GET /ready` (readiness; `503` until the process reports itself warm).
- **Graceful shutdown:** `dumb-init` forwards SIGTERM/SIGINT; the process
  stops accepting, drains in-flight requests within
  `SHUTDOWN_GRACE_PERIOD_MS` (default 10 s), and exits 0. Compose's
  `stop_grace_period` defaults are respected by `docker compose stop`.
- **Secrets:** injected through the environment only (`env_file: .env`, which
  is git-ignored and excluded from the build context via `.dockerignore`);
  nothing is baked into images. Config reduces credentials to presence flags
  and never logs them.
- **Ports:** exactly one, `127.0.0.1:3001 -> 3001`, loopback-bound on the
  host. Add no others; future internal services use `expose:` only.
- **Resources:** limits `0.50` CPU / `256M` memory, reservations
  `0.10` CPU / `64M` (compose `deploy.resources`).
- **Storage:** the named volume `bot-state` is mounted at `/app/state` for
  future stateful components (persistence package), owned by the non-root
  runtime user (uid 10001).
- **Logging:** JSON lines to stdout; the compose `json-file` driver caps
  growth at 10 MB × 5 files.
- **Image hardening:** multi-stage build (no toolchain in runtime), non-root
  `USER 10001`, `dumb-init` PID 1, base pinned by tag — **pin by digest
  before production use** (instructions in the Dockerfile header and
  `SECURITY.md`).

Note: the dev machine used to author these artifacts has no Docker daemon;
`docker compose config` and a real `up` have not been executed yet. Validate
with `docker compose config && docker compose up -d --build` on a Docker host
before relying on the stack.

See `SECURITY.md` for the threat model and the audit these defaults came
from.
