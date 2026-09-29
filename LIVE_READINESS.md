# LIVE_READINESS.md — Formal Live-Trading Readiness Audit

**Audit date:** 2026-09-28 (updated: persistence program) · **Scope:** entire system, audited against
`AGENTS.md` · **Method:** fresh code-path evidence (grep-verified call sites
and guards), targeted test re-runs, and full gate runs.

**Live trading remains DISABLED.** `TRADING_MODE=paper` and
`LIVE_TRADING_ENABLED=false` are the shipped defaults and were not changed.
No live order path was enabled, created, or exercised during this audit.

---

## Verdict

**STILL NOT READY FOR LIVE TRADING — the persistence blocker (item 15) and
the Hermes authentication blocker (item 10) are now closed (18 of 19 items
verified, with item 10's transport-level dependency documented), and the
system remains paper-only.** `TRADING_MODE=paper` / `LIVE_TRADING_ENABLED=false`
are unchanged. Remaining pre-live gaps: a real venue transport behind the
Polymarket adapter's seam, transport-level authentication for any networked
Hermes deployment, and the 72 h soak. This report does **not** mark the system
live-ready. The safety architecture is otherwise sound and fully verified:
ready to keep running paper/soak indefinitely.

| # | Item | Status |
| --- | --- | --- |
| 1 | RiskEngine cannot be bypassed | ✅ PASS (verified) |
| 2 | Paper execution cannot reach live | ✅ PASS (verified) |
| 3 | Live execution requires explicit config | ✅ PASS (verified) |
| 4 | Reconciliation works | ✅ PASS (verified) |
| 5 | Partial fills are handled | ✅ PASS (verified) |
| 6 | Unknown order states are handled | ✅ PASS (verified) |
| 7 | WebSocket recovery works | ✅ PASS (verified) |
| 8 | Stale data stops new orders | ✅ PASS (verified) |
| 9 | Kill switch works | ✅ PASS (verified) |
| 10 | Hermes cannot bypass controls | ✅ PASS — HMAC authentication enforced (transport-level auth remains open) |
| 11 | Secrets are not logged | ✅ PASS (verified) |
| 12 | Settlement assumptions correct + documented | ✅ PASS (verified) |
| 13 | Complete-set accounting deterministic | ✅ PASS (verified) |
| 14 | Directional residual limits work | ✅ PASS (verified) |
| 15 | Database recovery works | ✅ PASS — `packages/persistence` implemented (file-backed port; see below) |
| 16 | Restart recovery works | ✅ PASS (verified, file-based state) |
| 17 | Tests pass | ✅ 536 passed, 0 failed |
| 18 | Typecheck passes | ✅ 0 errors |
| 19 | Lint passes | ✅ clean (+ format & `pnpm audit` clean) |

---

## Detailed findings

### 1. RiskEngine cannot be bypassed — PASS

There is exactly **one** `adapter.submit` call site in the entire repository:
`packages/orchestrator/src/orchestrator.ts:347`, reached only after
`evaluateRiskOrder` (line 313) returns `allowed` (test-proven with a spy
adapter: no risk approval → no adapter call). Defense in depth: the live
`PolymarketExecutionAdapter` additionally requires a positive `RiskGate`
verdict per submit (`polymarket-adapter.ts:198`) and refuses without one
*before* any transport call. Risk limits are built solely from the validated
`AppConfig` via `riskLimitsFromConfig`; no code path mutates them after load.

### 2. Paper execution cannot accidentally reach live — PASS

`createExecutionAdapter` (`packages/execution/src/factory.ts`) is the only
mode→backend mapping: `paper` → `PaperExecutionAdapter` (simulated books only,
no HTTP/WS client, no credentials — structurally incapable of network I/O);
`live` → throws `LiveExecutionNotImplementedError` unconditionally (no live
adapter exists to fall back to); anything else throws (exhaustive switch).
`assertPaperBackend` rejects any non-paper adapter at runtime. The paper
adapter holds no venue code by construction (verified in source).

### 3. Live execution requires explicit configuration — PASS

Four independent layers: (a) config loader — `TRADING_MODE=live` requires
`LIVE_TRADING_ENABLED=true` **and** all four Polymarket credentials, and
rejects each inconsistency at startup; (b) execution factory — `live` throws;
(c) orchestrator — throws on any live trading config; (d)
`PolymarketExecutionAdapter` — re-checks **both** flags before *every*
submit/cancel (`tradingMode === "live" && liveTradingEnabled === true`,
lines 168/178/186) and otherwise returns `live_trading_disabled` without
touching the transport. `ENABLE_EXTERNAL_HEDGE=true` is rejected outright by
the loader (no hedge implementation exists).

### 4. Reconciliation works — PASS

`ReconciliationCoordinator` (`packages/inventory/src/reconciliation.ts`)
compares local vs remote across balance, orders (missing/extra/status drift),
fills (unexpected/duplicate/known), Up/Down inventory, matched sets, and
residuals; every finding becomes an audited `ReconciliationEvent` (timestamp,
type, local, remote, action) — nothing silently overwritten. All six mandated
triggers supported. Fail-closed: the gate starts `undefined` (unknown = no
orders), closes on any blocking discrepancy, and reopens only after a clean
pass. The gate feeds the RiskEngine's `reconciliation` input: while not
`"reconciled"`, risk refuses every order (`account_unreconciled` /
`reconciliation_unknown`) — proven end-to-end in tests.

### 5. Partial fills are handled — PASS

The paper adapter fills one best crossed level per tick with finite,
never-refilling liquidity → deterministic `PARTIALLY_FILLED` states culminating
in `FILLED` (E2E-verified). Fill accounting is idempotent: soak processing keys
fills by `clientOrderId:at:qty` (dedupe across restarts, test-verified). The
live adapter accumulates partial fills with exact dedup and keeps remaining
quantity working; venue `FILLED` with disagreeing quantities downgrades
conservatively to `PARTIALLY_FILLED`.

### 6. Unknown order states are handled — PASS

The live adapter keeps local working state on unknown venue statuses, flagged
`unknown_venue_status` — never `FILLED` (`dto.ts:185`,
`polymarket-adapter.ts:344`). Unusable DTOs are dropped/flagged, not guessed.
The risk engine treats unknown health/reconciliation as refusal
(`reconciliation_unknown`, `api_health_unknown`, `ws_health_unknown`) —
unknown state means no new orders.

### 7. WebSocket recovery works — PASS

`UnderlyingMarketDataProvider` (`packages/market-data/src/underlying/provider.ts`)
reconnects with exponential backoff on abnormal close or socket error, never
after explicit `stop()`, force-reconnects on heartbeat silence (a hung socket
equals a closed one), and exposes `freshnessMs()`/`stale` for the staleness
gate. Reconnect counts are surfaced as metrics (`market_ws_reconnects_total`).

### 8. Stale data stops new orders — PASS

The risk engine rejects with `stale_market_data` / `stale_underlying_data`
(`engine.ts:269,272`, halted=true), and the orchestrator halts per market
*before* proposing orders (`halted_stale_market_data` /
`halted_stale_underlying_data`, audited). Limits come from
`RISK_MAX_DATA_AGE_MS`. E2E-verified.

### 9. Kill switch works — PASS

Hermes `kill-switch` engages a plane-tracked (never API-trusted) sticky
lockout: every command except `status`/`risk` reads returns
`kill_switch_engaged`; `resume` cannot clear it (only a restart does, per the
documented fail-safe design). Tested including the escalation path while
paused. The soak runner and orchestrator additionally fail closed on their own
gates.

### 10. Hermes cannot bypass controls — PASS (authentication genuinely enforced)

Implemented in this program (`hermes/src/auth.ts`, rewritten
`control-plane.ts`):

- **Authentication is enforced, not represented.** Every `execute()` call
  first verifies HMAC-SHA256 credentials over a canonical request string
  (`hermes:v1:<principalId>:<requestId>:<timestampMs>:<command>`), keyed by a
  secret held only in the server-side `OperatorRegistry`. Verification uses
  `crypto.timingSafeEqual`; the legacy client-claimed-role
  (`CommandCaller`) API was **removed** — a caller can no longer even express
  a role.
- **Fail closed** on: missing, malformed, unknown-principal,
  invalid-signature, expired/stale timestamp (±60 s skew), expired
  credential, and replayed `requestId` (bounded replay cache). All denials
  are audited; none reach the API.
- **Roles are server-resolved** from the registry after signature
  verification; permissions derive from the closed allow-list per role.
- **Audit** carries `requestId`, `principalId`, `authResult`,
  `authorizationResult`, command, role, params, applied flag, block reason,
  UTC timestamp — never credential material (test-proven by serializing the
  full audit trail and asserting no secret/signature/token appears).
- **No bypass path exists**: hermes imports nothing from execution/orchestrator
  packages; repo-wide there is exactly one `adapter.submit` call site (the
  orchestrator, behind the RiskEngine); the `BotControlApi` port has no order-
  submission, mode-change, or credential methods (test-proven structurally).
- **32 deterministic tests** cover scenarios A–N (valid operator pass; missing/
  invalid/expired credentials; role-claim attempt; unauthorized command;
  unknown command; order-submission attempt; risk-disable attempt;
  live-trading-enable attempt; malformed params; replay denial; audit on
  denial; secret-free audit).

**Open dependency (documented, not hidden):** Hermes is currently an
embedded/in-process interface. Request signing authenticates the *payload*;
transport-level authentication (mTLS/network listener, secret provisioning)
does not exist yet and remains a pre-live requirement for any networked
deployment. The in-process boundary is acceptable only while Hermes has no
network exposure.

### 11. Secrets are not logged — PASS

Three layers: pino-level `redact` paths + `redactSecrets` in the shared logger;
`toLogSafeConfig` strips the database URL and renders config log-safely; the
observability `AreaLogger` applies `redactSecrets` itself (test-proven with a
non-redacting sink) and metric labels throw `SecretLabelError` on
secret-shaped keys/values. The config loader reduces credentials to a presence
boolean — raw values are dropped at parse time. Audit found zero hardcoded
secrets and no tracked `.env` files (SECURITY.md).

### 12. Settlement assumptions correct and documented — PASS

Domain (`packages/domain/src/complete-set.ts`): a complete set pays exactly its
settlement value (1 USDC default) regardless of outcome — `setPayoutAtSettlement`
encodes it, and `STRATEGY.md` documents the capital-neutral property explicitly
("at settlement they return exactly their settlement value regardless of
outcome"). The E2E suite verifies the payout math exactly: winners pay
(1 − price) per share, losers forfeit their premium
(`250×(1−0.45) − 200×0.45 = 47.5`). Residual winners pay 1/share, residual
losers 0 — matching the documented parity helpers.

### 13. Complete-set accounting deterministic — PASS

`matchCompleteSets` is a pure function over BigInt `Decimal`s (8 dp, exact) —
no floats anywhere in the pipeline (AGENTS.md domain rule 1). 30 dedicated
tests cover exact/partial/multi-lot/unequal matching, fees, and decimal
precision; 28 rebalancing planner tests; determinism is additionally proven
end-to-end (byte-identical replay reports; the E2E asserts exact residual
arithmetic: 250 Up / 200 Down → 200 sets + 50 Up residual).

### 14. Directional residual limits work — PASS

The planner clamps the signal-derived target residual to
`[-cap, +cap]` (`cap = min(maxResidual, maxDirectionalShares)`, validated
inputs, tested), never proposes negative inventory, and budgets via truncated
division so spend never exceeds capital. The risk engine independently rejects
breaches of directional exposure, residual, and orphan limits in its canonical
check order. The engine never forces neutrality (residuals preserved as data).

### 15. Database recovery works — PASS (implemented in this program)

`packages/persistence` (previously the declared stub) now provides:

- **Port + implementations** — `PersistenceAdapter` with `FilePersistenceAdapter`
  (atomic snapshot + append-only JSONL event streams; no DB driver, no
  credentials) and `InMemoryPersistenceAdapter` (tests); a future database
  adapter implements the same port.
- **Event-oriented execution storage** — fills are an append-only stream with
  an idempotent `fillId`; replay can never double-count a fill.
- **Verbatim statuses** — persisted `PARTIALLY_FILLED` survives restart until
  reconciliation confirms otherwise; persisted `UNKNOWN` never auto-promotes
  to `FILLED` and fails closed.
- **Deterministic rebuild** — inventory, matched sets, and residual rebuild
  identically across restarts (test A: 200 Up / 150 Down → 150 sets + 50 Up
  residual, exact across reload).
- **Mandated recovery flow** — `RecoveryManager`: load → discover → venue
  query → reconcile → rebuild → risk gate; any uncertainty (unhealthy store,
  schema mismatch, venue unreachable/mismatched, unknown orders, engaged kill
  switch) fails closed with a recorded risk event.
- **Kill-switch persistence** — engaged state survives restart (test F).
- **Exactness** — Decimals as scaled integer strings, UTC epoch ms; no floats
  in financial accounting. Schema/migration rules: `MIGRATIONS.md`.
- **Tests** — 13 deterministic crash-recovery tests covering scenarios A–G
  (persist/reload equality, double-fill idempotency, partial-fill survival,
  UNKNOWN never FILLED, corrupt storage blocked, kill-switch survival,
  determinism).

Remaining for production hardening (not a correctness gap): replace the
file-backed adapter with a durable database implementation of the same port
when multi-process durability is required — callers do not change.

### 16. Restart recovery works — PASS (file-based)

Soak restart resumes from `state.json` (counters, lots, known fills, reported
days) with the reconciliation gate closed until a clean pass — test-verified,
including corrupt-state fail-safety. Duplicate order ids are prevented across
restarts by the persisted id sequence. Process-restart semantics for the kill
switch are documented (sticky in-process; cleared by restart by design).

### 17–19. Tests / typecheck / lint — PASS

- **Tests:** 536 passed, 0 failed (plus 5 environment-gated live integration
  tests skipped by design).
- **Typecheck:** 0 errors across all workspaces (strict mode).
- **Lint:** clean; `pnpm format:check` clean; `pnpm audit --prod`: no known
  vulnerabilities.

### AGENTS.md compliance notes

- Rules 0–8 (phase-engine canon, Decimal money, UTC, package boundaries,
  immutable models, tests beside sources) verified in force; the rule-4
  documentation gap found during this audit (`SHUTDOWN_GRACE_PERIOD_MS` missing
  from `docs/ENVIRONMENT.md`) was **fixed**.
- One intentional AGENTS.md deviation stands: `packages/persistence` remains a
  stub, declared as such in AGENTS.md itself.

---

## Pre-live gating requirements (must ALL be closed before enabling live)

1. ~~Implement `packages/persistence` with tested database recovery (item 15)~~
   **DONE** — implemented and verified this program; a durable database
   adapter for the same port remains an optional hardening step.
2. ~~Implement an operator-identity/auth host binding for Hermes roles (item 10)~~
   **DONE** — HMAC request-signature authentication enforced in the control
   plane; registry-resolved roles; replay protection; audited denials.
   Remaining: transport-level authentication (mTLS) when Hermes gains a
   network listener.
3. Implement a real venue transport behind the Polymarket adapter's existing
   mockable seam, and run the mocked integration suite against it.
4. Run a ≥ 72 h soak per `SOAK.md` with all checklist boxes checked.
5. Re-run this audit with all items PASS.

**Until then, the system stays in `TRADING_MODE=paper` /
`LIVE_TRADING_ENABLED=false` — which is also the only configuration the
current code can start in.**
