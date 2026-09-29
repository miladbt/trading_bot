# SECURITY.md

Security audit and policy for the `polymarket-bot` monorepo.

**Audit date:** 2026-09-28 · **Scope:** entire repository (all workspaces) ·
**Method:** manual code review (sweeps across every category below) plus
automated dependency auditing (`pnpm audit`).

**Posture:** this codebase cannot trade. `TRADING_MODE=paper` and
`LIVE_TRADING_ENABLED=false` are the shipped defaults; the execution factory
throws on `live` because no live adapter exists; the orchestrator refuses a
live config at construction; the config loader rejects any live-mode/env
inconsistency at startup. The audit found **no Critical findings**.

---

## Summary

| Severity    | Count | Status                                   |
| ----------- | ----- | ---------------------------------------- |
| Critical    | 0     | —                                        |
| High        | 1     | **Fixed** (reflected URL in 404 body)    |
| Medium      | 1     | **Fixed** (vulnerable vitest dev-dep)    |
| Low         | 4     | Documented; fixes deferred with rationale|
| Informational | 8   | Verified-safe observations               |

No trading behavior changed as part of this audit.

---

## High

### H-1 — Reflected request URL in API 404 responses (FIXED)

- **Where:** `apps/api/src/server.ts` (`requestHandler`, 404 branch).
- **Issue:** unknown paths returned `{ error: "not_found", path: url }` where
  `url` is raw, attacker-controlled request input. Reflected input in a JSON
  response body is a phishing/injection foothold (a browser or proxy rendering
  the body unsafely, or log-poisoning via crafted URLs) and violates the
  "log-safe rendering" rule applied everywhere else in the repo.
- **Fix:** the 404 body is now a static `{ error: "not_found" }`; the request
  URL is never echoed. Test suite still passes (404 status asserted, body no
  longer attacker-influenced).

## Medium

### M-1 — Vulnerable dev dependency: vitest path traversal (FIXED)

- **Where:** all 14 workspace `package.json`s (devDependency).
- **Issue:** `pnpm audit` reported 2 moderate advisories — Vitest ≤ 4.1.10
  path traversal / arbitrary file read via `@vitest/mocker` redirect mocks
  (GHSA-82fw-gwwq-j7x9). Dev-only: not reachable from any production code
  path, but present on developer machines and CI.
- **Fix:** bumped `vitest` from `^3.2.4` to `^4.1.11` across all workspaces.
  `pnpm audit` now reports **"No known vulnerabilities found"** for both prod
  and full dependency trees; the entire 546-test suite passes on the new
  major version.

## Low

### L-1 — No Dockerfiles exist (constraint, not a flaw)

There is no container packaging yet, so "unsafe Docker configuration" is
currently impossible rather than fixed. When a Dockerfile is added it must:
run as a non-root `USER`, pin a base-image digest, use `NODE_ENV=production`,
copy only built output plus the production lockfile install, and declare
`read_only: true` where feasible. Recorded here as a pre-registered checklist.

### L-2 — Filesystem permissions rely on the host umask

No file in the repo sets permissive modes (verified: no world-writable paths,
no `chmod` calls), but the replay CLI's `writeFileSync`/`mkdirSync` calls use
default umask-derived permissions. Report files contain no secrets (decimal
strings, counts, ids), so exposure impact is limited to local report
spoofing by a same-machine user. Acceptable for a single-operator setup; a
multi-user host should set a restrictive umask (e.g. `077`) for the bot user.

### L-3 — Replay CLI writes reports only to a caller-chosen directory

`pnpm replay --outdir` accepts any path and will create it. This is the CLI's
purpose (operator-driven, local, no auth surface), so it is not privilege
escalation — but the tool should never be pointed at a shared directory, since
report files are predictable names (`report.csv`, `report.json`). Documented
rather than restricted: restricting would break legitimate workflows for
near-zero security gain in the intended single-operator context.

### L-4 — Process restart clears the Hermes kill switch by design

The kill switch is sticky against `resume` (tested) but intentionally
resets when the bot process restarts, matching the fail-safe requirement that
an operator can always regain a known state. The residual risk — an unattended
process auto-restarting after a kill-switch event — belongs to the deployment
layer (process manager), which does not exist yet. When supervision is added,
restart-on-kill-switch must require an explicit operator override flag.

## Informational (verified safe)

1. **No hardcoded secrets** — sweep for secret-shaped literals
   (`api_key`/`secret`/`passphrase`/`private_key`/`password` assignments)
   across all workspaces: zero hits outside test fixtures and redaction
   machinery. `.env.example` contains only empty placeholders; `.gitignore`
   covers `.env`, `.env.local`, `.env.*.local`; `git ls-files` confirms no
   env/secret/key file is tracked.
2. **Secrets never enter the process config** — the config loader reduces
   every credential to a presence boolean (`credentials.polymarketComplete`);
   the raw values are dropped at parse time, so downstream code cannot leak
   what it never holds.
3. **Credentials in logs: protected at two layers** — the shared logger
   redacts secret-shaped keys and pino-level `redact` paths; the config
   renderer (`toLogSafeConfig`) strips the database URL and renders values as
   strings before anything is logged; the observability `AreaLogger` applies
   `redactSecrets` itself (test-proven with a non-redacting sink).
4. **No unsafe environment handling** — only three `process.env` reads exist,
   all in the shared config/logger layer; nothing concatenates env values
   into commands or paths. No `child_process`, `exec`, `spawn`, `eval`, or
   `new Function` anywhere in source.
5. **No shell execution surface** — see (4). The single filesystem writer is
   the replay CLI (L-2/L-3); all other packages are pure or in-memory.
6. **Hermes cannot escalate privileges** — commands are a closed allow-list
   with closed param schemas; callers are **HMAC-SHA256 authenticated**
   (constant-time verification, server-side `OperatorRegistry`, replay cache
   on `(principalId, requestId)`, ±60 s clock-skew window) and the role is
   resolved **only** from the registry after the signature verifies — a client
   cannot claim a role. The kill switch blocks every command except two reads
   and cannot be cleared by `resume`; every attempt (allowed or denied) is
   audited with `requestId`, `principalId`, `authResult`,
   `authorizationResult`, and outcome — never credential material. Transport
   note: Hermes is currently an embedded/in-process interface; transport-level
   authentication (mTLS) remains an open readiness dependency in
   `LIVE_READINESS.md`.
7. **No arbitrary order submission; RiskEngine cannot be bypassed** — there
   is exactly one `adapter.submit` call site in the codebase (the
   orchestrator), and it is reached only after `evaluateRiskOrder` returns
   `allowed` (test-proven with a spy adapter). The paper/Polymarket adapter
   additionally refuses any submit without a positive risk verdict. The
   Hermes surface has no order-intent command or parameter at all. Risk
   limits originate solely from the validated config; no code path mutates
   them after load.
8. **Unsafe live-mode activation is blocked at four independent layers** —
   (a) config loader: `TRADING_MODE=live` requires `LIVE_TRADING_ENABLED=true`
   *and* complete credentials, each inconsistency throwing at startup;
   (b) execution factory: `live` throws `LiveExecutionNotImplementedError`;
   (c) orchestrator: throws on any live trading config;
   (d) `PolymarketExecutionAdapter`: re-checks both flags before *every*
   submit/cancel and refuses without them (transport never touched).
   External hedging is refused outright by the loader (`ENABLE_EXTERNAL_HEDGE`).

## Network surfaces

- **API (`apps/api`):** exactly one endpoint, `GET /health` (static JSON), a
  static 404 for everything else (post H-1). No mutation endpoints, no
  dynamic routing, no CORS headers emitted, no request body parsing — there
  is nothing to authenticate *yet*. Missing authentication is recorded as a
  precondition: any endpoint that reads bot state or triggers commands must
  sit behind authentication and authorization before it exists (none do
  today).
- **Market data outbound:** read-only public endpoints; requests carry only
  `accept: application/json` — no credentials are ever attached to
  market-data traffic.
- **Execution outbound:** the live Polymarket adapter's transport is
  interface-seamed and unimplemented; paper mode is structurally incapable
  of network I/O.
