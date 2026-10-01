# LIVE_READINESS.md — Formal Live-Trading Readiness Audit

**Audit date:** 2026-09-28 (original) · **Re-verified:** 2026-09-29 (T8 program) ·
**Scope:** entire system, audited against `AGENTS.md` ·
**Method:** fresh code-path evidence **now automated** — the structural claims
below are re-proven on every test run by
`packages/orchestrator/src/readiness-structural.test.ts` (T8), which greps the
repository source itself; behavioral claims cite the targeted tests beside each
source. Counts in this file are current as of the T11 commit (692 tests; the
count is itself structurally verified against the live test suite).

**Live trading remains DISABLED.** `TRADING_MODE=paper` and
`LIVE_TRADING_ENABLED=false` are the shipped defaults and were not changed.
No live order path was enabled, created, or exercised during this audit.

---

## Verdict

**STILL NOT READY FOR LIVE TRADING — the system remains paper-only.**
`TRADING_MODE=paper` / `LIVE_TRADING_ENABLED=false` are unchanged. 18 of 19
items are verified by named, always-runnable tests; item 10's transport-level
dependency (mTLS for any networked Hermes deployment) remains open and is
*documented*, not hidden. Remaining pre-live gaps: a real venue transport
behind the Polymarket adapter's seam, transport-level authentication for
networked Hermes, and the ≥ 72 h soak. This report does **not** mark the system
live-ready.

| # | Item | Status | Structural proof (test name in `readiness-structural.test.ts`) |
| --- | --- | --- | --- |
| 1 | RiskEngine cannot be bypassed | ✅ VERIFIED | item 1 — RiskEngine cannot be bypassed (3 checks) |
| 2 | Paper execution cannot reach live | ✅ VERIFIED | items 2–3 — execution factory is fail-closed |
| 3 | Live execution requires explicit config | ✅ VERIFIED | items 2–3 — execution factory is fail-closed |
| 4 | Reconciliation works | ✅ VERIFIED (behavioral) | `packages/inventory/src/reconciliation.test.ts` |
| 5 | Partial fills are handled | ✅ VERIFIED (behavioral) | `packages/execution/src/*.test.ts` + orchestrator E2E |
| 6 | Unknown order states are handled | ✅ VERIFIED (behavioral) | `packages/execution/src/polymarket/*.test.ts`, `packages/persistence` |
| 7 | WebSocket recovery works | ✅ VERIFIED | items 7–8 — recovery and staleness gates exist + provider tests |
| 8 | Stale data stops new orders | ✅ VERIFIED | items 7–8 — recovery and staleness gates exist |
| 9 | Kill switch works | ✅ VERIFIED (behavioral) | `hermes/src/*.test.ts` |
| 10 | Hermes cannot bypass controls | ✅ VERIFIED — HMAC enforced (transport auth still open) | item 10 — hermes isolation |
| 11 | Secrets are not logged | ✅ VERIFIED (behavioral) | shared logger tests + observability `SecretLabelError` tests |
| 12 | Settlement assumptions correct + documented | ✅ VERIFIED | items 12–13 — settlement and set-accounting anchors |
| 13 | Complete-set accounting deterministic | ✅ VERIFIED | items 12–13 — settlement and set-accounting anchors |
| 14 | Directional residual limits work | ✅ VERIFIED (behavioral) | `packages/inventory/src/rebalancing.test.ts`, `packages/risk/src/*.test.ts` |
| 15 | Database recovery works | ✅ VERIFIED (behavioral) — file-backed port implemented | `packages/persistence/src/*.test.ts` (13 recovery tests) |
| 16 | Restart recovery works | ✅ VERIFIED (behavioral) | `packages/soak/src/soak.test.ts` |
| 17 | Tests pass | ✅ VERIFIED (structural doc check + CI gates) | items 17–19 — doc consistency |
| 18 | Typecheck passes | ✅ VERIFIED (CI gates) | root `pnpm typecheck` (strict, 0 errors) |
| 19 | Lint passes | ✅ VERIFIED (CI gates) | root `pnpm lint` + `pnpm format:check` |

A ✅ VERIFIED status means: the claim is proven by the named test(s) —
structural (source-scanned on every run) or behavioral (unit/E2E beside the
source) — and the re-verification date of this file. Nothing is marked PASS on
trust.

---

## Detailed findings

### 1. RiskEngine cannot be bypassed — VERIFIED

Exactly **one** `adapter.submit` call site exists in all non-test sources
(`packages/orchestrator/src/orchestrator.ts`, previously line 347 — now line
~425 after the T1/T2 sizing and calibration wiring), reached only after
`evaluateRiskOrder` returns `allowed`; the same file's structure (risk index
before submit index, `!risk.allowed → halted_risk` with no adapter call) is
asserted by the structural test on every run. Defense in depth unchanged: the
live `PolymarketExecutionAdapter` requires a positive `RiskGate` verdict per
submit and refuses before any transport call. Risk limits come solely from
validated `AppConfig` via `riskLimitsFromConfig`.

### 2. Paper execution cannot accidentally reach live — VERIFIED

`createExecutionAdapter` (`packages/execution/src/factory.ts`) is the only
mode→backend mapping: `paper` → `PaperExecutionAdapter` (simulated books only,
no HTTP/WS client, no credentials); `live` → throws
`LiveExecutionNotImplementedError` unconditionally; anything else throws
(exhaustive switch). `assertPaperBackend` rejects non-paper adapters at
runtime. Structural test asserts the throw in the live branch and the paper
backend guard.

### 3. Live execution requires explicit configuration — VERIFIED

Four independent layers, all structurally checked: (a) config loader guards
(both direction refusals + credentials requirement — exact error strings
asserted by the structural test); (b) execution factory throws on `live`;
(c) orchestrator throws on any live trading config at construction; (d)
`PolymarketExecutionAdapter` re-checks both flags before *every*
submit/cancel. `ENABLE_EXTERNAL_HEDGE=true` is refused outright by the loader.

### 4. Reconciliation works — VERIFIED (behavioral)

`ReconciliationCoordinator` compares local vs remote across balance, orders,
fills, inventory, matched sets, and residuals; every finding is an audited
`ReconciliationEvent`. Fail-closed gate: starts unknown (no orders), closes on
blocking discrepancies, reopens only after a clean pass, and feeds the
RiskEngine's reconciliation input (unreconciled ⇒ every order refused).
Covered by the reconciliation test suite in `packages/inventory`.

### 5. Partial fills are handled — VERIFIED (behavioral)

The paper adapter fills one best crossed level per tick with finite,
never-refilling liquidity → deterministic `PARTIALLY_FILLED` states culminating
in `FILLED` (E2E-verified). In the pessimistic fill model (T4) partial fills
are further scaled by the queue-position factor and gated on trade-through.
Fill accounting is idempotent (soak keys fills by `clientOrderId:at:qty`); the
live adapter accumulates partial fills with exact dedup.

### 6. Unknown order states are handled — VERIFIED (behavioral)

The live adapter keeps local working state on unknown venue statuses
(`unknown_venue_status`), never auto-promoting `UNKNOWN` to `FILLED`; unusable
DTOs are dropped/flagged. The risk engine treats unknown health/reconciliation
as refusal. Persistence stores verbatim statuses.

### 7. WebSocket recovery works — VERIFIED

`UnderlyingMarketDataProvider` reconnects with exponential backoff on abnormal
close/error, force-reconnects on heartbeat silence, never after explicit
`stop()`, and exposes `freshnessMs()`/`stale`. The structural test asserts the
backoff/staleness surface exists; behavioral tests cover the reconnect
sequences with mock sockets.

### 8. Stale data stops new orders — VERIFIED

The risk engine rejects with `stale_market_data` / `stale_underlying_data`
(halted=true), and the orchestrator halts per market *before* proposing orders
(`halted_stale_market_data` / `halted_stale_underlying_data`, audited). Both
the engine strings and the halt-before-propose ordering are structurally
asserted; E2E covers the behavior.

### 9. Kill switch works — VERIFIED (behavioral)

Hermes `kill-switch` engages a plane-tracked sticky lockout: every command
except two reads returns `kill_switch_engaged`; `resume` cannot clear it (only
a restart does, by documented fail-safe design). The soak runner and
orchestrator fail closed on their own gates. Covered by the hermes test suite.

### 10. Hermes cannot bypass controls — VERIFIED (authentication genuinely enforced)

- Every `execute()` verifies HMAC-SHA256 over a canonical request string,
  keyed by a server-held `OperatorRegistry` secret; constant-time comparison;
  the client-claimed-role API does not exist.
- Fail closed on missing/malformed/unknown/invalid/expired/replayed input;
  all denials audited, none reach the API.
- Roles are server-resolved from the registry after signature verification.
- **Structural proofs (T8):** hermes imports nothing from
  `@bot/execution|orchestrator|inventory|risk|market-data` and contains no
  `.submit(` call — asserted on every test run.

**Open dependency (documented, not hidden):** Hermes is an embedded/in-process
interface; transport-level authentication (mTLS/network listener, secret
provisioning) does not exist and remains a pre-live requirement for any
networked deployment.

### 11. Secrets are not logged — VERIFIED (behavioral)

pino-level `redact` paths + `redactSecrets`; `toLogSafeConfig` strips the
database URL; the observability `AreaLogger` applies `redactSecrets` itself
and metric labels throw `SecretLabelError` on secret-shaped keys. The config
loader reduces credentials to a presence boolean. Behavioral tests prove each
layer; no hardcoded secrets and no tracked `.env` files (SECURITY.md).

### 12. Settlement assumptions correct and documented — VERIFIED

`packages/domain/src/complete-set.ts` encodes `setPayoutAtSettlement`
(winners pay 1 USDC per share, losers 0); `STRATEGY.md` documents the
capital-neutral property. The structural test anchors both; the E2E suite
verifies the payout math exactly.

### 13. Complete-set accounting deterministic — VERIFIED

`matchCompleteSets` is a pure function over BigInt Decimals (8 dp, exact) —
asserted structurally (export + Decimal usage) and behaviorally (30 dedicated
tests + E2E determinism replay).

### 14. Directional residual limits work — VERIFIED (behavioral)

The planner clamps the signal-derived target to
`[-min(maxResidual, maxDirectionalShares), +…]` (T7: now from the configured
phase-multiplier curve), never proposes negative inventory, and budgets via
truncated division. The risk engine independently rejects limit breaches.
Covered by the rebalancing + risk suites (including the T7 flat/reversed
curve tests).

### 15. Database recovery works — VERIFIED (behavioral; file-backed port)

`packages/persistence` provides the `PersistenceAdapter` port with a
file-backed implementation (atomic snapshot + append-only JSONL event
streams; no DB driver, no credentials), idempotent fill ingestion, verbatim
status survival, deterministic rebuild, `RecoveryManager` fail-closed flow,
and kill-switch persistence — 13 deterministic crash-recovery tests. **This
item previously read both "stub" and "implemented" in the same document; the
contradiction is removed: it is implemented on the file-backed port, and a
durable database adapter remains an optional future hardening step on the
same port.**

### 16. Restart recovery works — VERIFIED (behavioral, file-based)

Soak restart resumes from `state.json` with the reconciliation gate closed
until a clean pass (test-verified, including corrupt-state fail-safety and
cross-restart order-id dedupe).

### 17–19. Tests / typecheck / lint — VERIFIED

- **Tests:** 692 passing at the T11 commit (0 failures), across 14 workspaces;
  the structural suite itself is part of the run.
- **Typecheck:** 0 errors across all workspaces (strict mode, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
- **Lint/format:** clean; `pnpm format:check` clean.

The structural test also guards this document against going stale again: it
fails if a stale historical test count or the persistence "stub/implemented"
contradiction ever reappear, and if `README.md` regresses to the false
"scaffold only" status line.

---

## Pre-live gating requirements (must ALL be closed before enabling live)

1. ~~Implement `packages/persistence` with tested recovery (item 15)~~ **DONE**
   (file-backed port; a durable database adapter is optional hardening).
2. ~~Implement operator-identity/auth for Hermes roles (item 10)~~ **DONE**
   (HMAC request-signature authentication; server-resolved roles; replay
   protection; audited denials). Remaining: transport-level authentication
   (mTLS) when Hermes gains a network listener.
3. Implement a real venue transport behind the Polymarket adapter's existing
   mockable seam, and run the mocked integration suite against it.
4. Run a ≥ 72 h soak per `SOAK.md` with all checklist boxes checked.
5. Re-run this audit with all items VERIFIED against that newer tree.

**Until then, the system stays in `TRADING_MODE=paper` /
`LIVE_TRADING_ENABLED=false` — which is also the only configuration the
current code can start in.**
