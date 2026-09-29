# AGENTS.md — polymarket-bot

Conventions for agents and humans working in this repository.

## Status

Scaffold phase. **Do not** implement trading logic, connect to Polymarket,
create/request API credentials, or add live-trading code until explicitly asked.

## Repository layout

- pnpm workspace (Node ≥ 22): `apps/*`, `packages/*`, `hermes`.
- `apps/trader` — trading process entrypoint (stub).
- `apps/api` — HTTP API (stub).
- `packages/shared` — types, config/env loading, logging (implemented minimally).
- `packages/domain` — pure domain models and money math (implemented; see
  `ARCHITECTURE.md`). Depends only on types from `@bot/shared`.
- `packages/strategy` — deterministic signal engine (implemented, pure
  functions; see its README). Emits `AssetSignal`s only — never orders.
- `packages/risk` — the authoritative RiskEngine
  (`evaluateRiskOrder`: 15 canonical fail-closed checks — capital, order-size,
  open-order, directional-exposure, residual/orphan, loss limits, stale data,
  reconciliation/API/WS health, market expiry; unknown state ⇒ no new orders).
  Pure and deterministic; emits `RiskEvaluation` data, never orders.
  See its README.
- `packages/execution` — execution ports + the deterministic
  `PaperExecutionAdapter` (simulated books, post-only, partial fills, fees,
  latency, cancels) and the isolated `PolymarketExecutionAdapter`
  (`src/polymarket/`: DTO normalization, mockable transport, retry/backoff,
  rate limits, reconciliation). The live-execution guard is fail closed:
  real submission requires BOTH `TRADING_MODE=live` AND
  `LIVE_TRADING_ENABLED=true` (defaults are `paper`/`false`), and every submit
  must carry a positive RiskEngine verdict. Defaults never reach the venue.
  See its README.
- `packages/persistence` — production-oriented state persistence + crash
  recovery (`RecoveryManager`; port `PersistenceAdapter` with file-backed and
  in-memory implementations, no DB driver/credentials). Event-oriented fills
  (idempotent `fillId`), verbatim order statuses, deterministic inventory/
  sets/residual rebuild, fail-closed recovery gate, persisted kill switch.
  Schema rules: its `MIGRATIONS.md`.
- `packages/inventory` — lot-level acquisition tracking + complete-set
  accumulation engine (`matchCompleteSets`: FIFO matching of up/down lots into
  1-up-+-1-down sets, cost/edge breakdown, preserved residuals) and the hybrid
  rebalancing planner (`planRebalance`: signal/phase-derived target residual,
  budget/risk-clamped actions, `StrategyDecision` data — never orders), the
  decision-only hedging engine (`decideHedge`: `HedgeDecision` for external
  BTC/ETH hedges; `ENABLE_EXTERNAL_HEDGE=false` by default, no venue
  connection, no orders, no leverage), and the reconciliation subsystem
  (`ReconciliationCoordinator`: local-vs-remote comparison with audited
  events; fail-closed gate feeding the RiskEngine's reconciliation input —
  while not reconciled, NO_NEW_ORDERS). Implemented as pure functions; see its
  README and `STRATEGY.md`. Never forces neutrality; never submits orders.
- `packages/market-data` — Polymarket market discovery adapter + underlying
  BTCUSDT/ETHUSDT WebSocket feed (implemented, read-only; see its README).
  The strategy consumes `UnderlyingMarketDataProvider`, never an exchange SDK.
  No order submission.
- `packages/orchestrator` — the deterministic strategy orchestrator: one
  `tick(now)` runs Discovery → Market Data → Signal → Phase → Inventory →
  Complete-Set → Rebalancing → RiskEngine → ExecutionAdapter per market, with
  decision ids, audit trail, duplicate prevention, quote throttling, and
  staleness halts. Paper mode only; risk is never bypassed. See its README.
- `hermes` — operational control interface (`ControlPlane`, closed `BotControlApi`
  port; see `HERMES.md`). Commands are HMAC-SHA256-authenticated (server-held
  operator registry, server-resolved roles, replay protection, closed
  allow-list); no order submission, no secrets, no risk-limit changes;
  pause/kill-switch are fail-safe and every command is audited.
- `@bot/observability` — deterministic metrics registry (Prometheus/JSON) with
  typed collectors per concern area, system probe, and structured redacting
  logs. Metric labels are fail-closed: secret-shaped keys/values throw.
- `@bot/soak` — long-running paper-trading soak runner (`pnpm soak`; runbook
  and checklist in `SOAK.md`). Drives the real orchestrator + paper adapter
  with paper-mode validation, health monitoring, fail-closed reconnect policy,
  atomic state persistence, periodic reconciliation, JSONL decision logs, and
  UTC daily reports. Measurement only: never adjusts strategy parameters from
  results; the reconciliation gate starts closed on every (re)start.

## Rules

1. Never delete or overwrite user files; preserve existing working code.
2. TypeScript strict mode is mandatory (`tsconfig.base.json`). Do not weaken flags
   (e.g. no `any`, no non-null `!` assertions, no disabling strictness locally).
3. Dependencies are declared in the package that uses them. Keep the dependency
   direction one-way: `apps → packages → shared`. `hermes` is used by apps/packages
   but must not import from them.
4. All runtime values come from environment variables; `.env` files are never
   committed. Extend `.env.example` alongside `docs/ENVIRONMENT.md`.
5. Public packages export via `src/index.ts` only.
6. Every package runs `lint`, `typecheck`, and `test` via root scripts
   (`pnpm lint`, `pnpm typecheck`, `pnpm test`). Keep them green.
7. Unit tests live beside sources as `*.test.ts` (Vitest). Network access is not
   allowed in unit tests.
8. Formatting is Prettier (`pnpm format`); line width 100, double quotes.

## Domain rules (`packages/domain`)

See `ARCHITECTURE.md` for the full design. Hard rules:

0. The 5-minute **phase engine** (`EARLY`/`MID`/`LATE`/`FINAL`) is canonical in
   `@bot/domain` (`phase-engine.ts`). Strategy, inventory, and risk must use it
   for all intra-cycle phase questions — do not reimplement phase logic.
1. Financial values use `Decimal` (BigInt, 8 dp) — never `number`. Use the
   `dec*` helpers; no arithmetic on raw floats anywhere in the pipeline.
2. Timestamps are `Millis` or `UtcIso` (UTC only; no local-time strings).
3. External API/SDK types stop at package boundaries. Adapters translate DTOs
   into domain models; domain models never leak outward as API responses.
4. Models are immutable data; behavior is pure functions. No I/O, no clock
   reads (except `nowMillis()`), no network calls, no order submission in the
   domain.
5. Invariant violations throw `ValidationError`/`InvalidTransitionError`;
   expected failures (DTO parsing) use `Result`/`tryParse`.
6. Keep `packages/domain/src/*.test.ts` green — they encode the domain
   invariants. New models need invariant tests in the same style.

## Logging

Use `createLogger` from `@bot/shared` (pino under the hood). Log with structured
context objects; never log secrets or private keys. Child loggers carry
`component`/`module` context, e.g. `log.child({ module: "strategy" })`.

## Package naming

Scoped as `@bot/<name>`: `@bot/trader`, `@bot/api`, `@bot/shared`, `@bot/domain`,
`@bot/strategy`, `@bot/risk`, `@bot/execution`, `@bot/market-data`,
`@bot/inventory`, `@bot/persistence`, `@bot/hermes`.
