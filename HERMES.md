# HERMES — Operational Control Interface

Hermes is the operational control interface for the trading bot: a **read-mostly,
audited, fail-safe command plane** for humans and automation. It is *not* a
trading terminal: it cannot submit arbitrary Polymarket orders, cannot touch
private keys or secrets, and cannot change risk limits.

---

## Installation

Hermes ships as the `@bot/hermes` workspace package (`hermes/`), already part of
the pnpm monorepo — no separate install is needed:

```bash
pnpm install          # workspace install (from the repo root)
pnpm --filter @bot/hermes test    # verify the control plane
```

Programmatic use (this is the only supported integration path):

```ts
import { ControlPlane, NullBotControlApi } from "@bot/hermes";

// The BOT provides the implementation of BotControlApi (or the shipped
// NullBotControlApi until a real snapshot provider is wired).
const plane = new ControlPlane(new NullBotControlApi("paper-bot"));

// A caller issues a command; the plane validates, gates, audits, applies.
const result = plane.execute("status", undefined, { role: "viewer", actor: "oncall" });
```

The bot side implements the `BotControlApi` interface from `@bot/hermes` and
hands it to the `ControlPlane`. Nothing else is imported from the bot — the
dependency direction stays one-way (apps/packages → hermes).

## Authentication & Authorization

Every command passes through the pipeline:

```
Hermes Client → Authentication → Verified Identity → Role/Permission
Resolution → Closed Command Allowlist → Bot Control API → Risk Engine →
Execution
```

**Authentication (HMAC-SHA256).** Clients present
`{ principalId, requestId, timestampMs, signature }` where `signature` is
HMAC-SHA256 over the canonical string
`hermes:v1:<principalId>:<requestId>:<timestampMs>:<command>`, keyed by a
secret held **only** in the server-side `OperatorRegistry`. Verification is
constant-time (`crypto.timingSafeEqual`). The client **never** declares a
role — the role (and therefore permissions) is resolved from the registry
after the signature verifies. Failures (`missing`, `malformed`,
`unknown_principal`, `invalid_signature`, `expired`/`stale_timestamp`,
`expired_credential`, `replayed_request`) are fail-closed and audited.

**Replay protection.** `(principalId, requestId)` is remembered in a bounded
cache; a replayed requestId is rejected. Timestamps outside the ±60 s skew
window are rejected. Only *verified* requests occupy the cache, so a failed
attempt cannot poison a later valid one.

**Transport limitation (open readiness dependency).** This authenticates the
request payload; Hermes currently runs as an **embedded/in-process interface**
— there is no network listener, no TLS, no transport-level channel security.
Signing secrets must be provisioned out-of-band to the embedding host. Until
Hermes is exposed over a network transport, transport authentication (mTLS or
equivalent) remains an explicit open dependency in `LIVE_READINESS.md`.

## Configuration

| Setting | Values | Effect |
| ------- | ------ | ------ |
| Operator registry | `principalId` → `{ secret, role, expiresAt? }` | Server-side only; resolves identity + role |
| Clock skew window | default ±60 s | Rejects stale/future timestamps |
| Session length | default 5 min | Verified-principal expiry |

What Hermes deliberately cannot configure:

- **Risk limits** — live in the validated `AppConfig` (`@bot/shared`); Hermes
  has no write path to them.
- **Trading mode** — `TRADING_MODE=paper` / `LIVE_TRADING_ENABLED=false` are
  environment-level settings guarded by the config loader and the live-execution
  guard; no Hermes command can flip them.
- **Secrets / private keys** — never present in any Hermes type, snapshot, or
  audit record; the `BotControlApi` port exposes only log-safe plain data.

## Commands

The command catalog is a closed allow-list (`HERMES_COMMANDS`). Anything else is
rejected as `unknown_command` and audited.

| Command                | Params (optional)        | Role required | Effect                                                     |
| ---------------------- | ------------------------ | ------------- | ---------------------------------------------------------- |
| `status`               | —                        | viewer        | Bot identity, mode, uptime, health                          |
| `markets`              | —                        | viewer        | Discovered 5-minute markets and their phase                 |
| `signals`              | —                        | viewer        | Latest per-asset signal (direction, confidence, regime)     |
| `inventory`            | `marketId`               | viewer        | Lots, matched sets, residual Up/Down per market             |
| `orders`               | `marketId`, `status`     | viewer        | Orders known to the adapter (filterable)                    |
| `pnl`                  | —                        | viewer        | Realized PnL per market, total, daily loss                  |
| `risk`                 | —                        | viewer        | `allowNewOrders`, block reason, reconciliation, pause/kill  |
| `explain-last-decision`| `decisionId`             | viewer        | Latest (or specific) audited orchestrator decision          |
| `reconcile`            | —                        | operator      | Run a reconciliation pass now                               |
| `pause`                | `reason`                 | operator      | Fail-safe: stop NEW orders, keep managing open ones         |
| `resume`               | `reason`                 | operator      | Release a pause (never a kill switch)                       |
| `cancel-all`           | `reason`                 | operator      | Request cancellation of every working order                 |
| `kill-switch`          | `reason`                 | admin         | Fail-safe: no new orders + cancel all, sticky until restart |

There is **no `submit-order` command and no order-intent parameter** — this is
enforced by construction (closed catalog + closed param schema) and verified by
tests that attempt to smuggle order intents through every command.

## Permissions

`ROLE_PERMISSIONS` is the single source of truth:

- **viewer** — read-only observability (`status`, `markets`, `signals`,
  `inventory`, `orders`, `pnl`, `risk`, `explain-last-decision`).
- **operator** — everything above plus risk-reduction controls: `reconcile`,
  `pause`, `resume`, `cancel-all`.
- **admin** — everything, including `kill-switch`.

Permission checks happen at dispatch time inside the `ControlPlane`, before the
API is touched, and every denial is audited with the caller's role.

## Safety model

1. **Strong authentication before anything.** A command without valid HMAC
   credentials never reaches the allow-list, the API, or any state. Every
   authentication failure is fail-closed with a stable reason.
2. **No arbitrary orders.** The only mutation surface is the closed
   `BotControlApi` port: scoped cancel, `pause`, `resume`, `kill-switch`,
   `reconcile`. There is no method that places an order, so Hermes cannot be
   used to trade — even by an authenticated admin. Execution paths remain
   exclusively `StrategyEngine → RiskEngine → ExecutionAdapter`.
3. **Roles are server-resolved.** A client-claimed role does not exist in the
   protocol; `viewer`/`operator`/`admin` come from the `OperatorRegistry` only,
   verified by signature.
4. **Fail-safe pause / kill switch.** Both are sticky and idempotent and
   tracked by the plane itself. While paused, reads, `resume`, and escalation
   work. The kill switch blocks everything except `status`/`risk` and can only
   be cleared by a restart.
5. **Audit everything.** Every attempt produces one `HermesAuditRecord` with
   `requestId`, `principalId`, `authResult`, `authorizationResult`, command,
   registry-derived role, validated params, applied flag, block reason, UTC
   timestamp, duration, and outcome — never any credential material.
6. **Fail-closed reads.** Until a real snapshot provider is wired,
   `NullBotControlApi` reports `allowNewOrders: false` with `not_wired` and
   `reconciliation: "unknown"` — unknown state means no new orders.
7. **No secrets by type.** All port payloads are plain JSON-safe data.
   Credential material cannot pass through the interface because no type has a
   place for it.

## Troubleshooting

| Symptom                                     | Meaning / fix                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `unknown_command`                           | Command is not in the allow-list (note: there is no `submit-order`, by design).     |
| `auth_failed:missing_credentials` … `replayed_request` | Authentication failed — see the reasons in HERMES.md § Authentication. |
| `unknown_param:<key>` / `invalid_param:<key>` | Params must match the closed schema exactly; keys are case-sensitive.             |
| `permission_denied`                         | The verified principal's registry role lacks the command.                          |
| `paused`                                    | Pause is engaged — reads still work; `resume` releases it.                          |
| `kill_switch_engaged`                       | Sticky lockout; restart the bot process to clear, then investigate before resuming. |
| `api_error:<message>`                       | The bot's API implementation threw; the audit record has the command context.       |
| `risk` shows `allowNewOrders: false, not_wired` | No real `BotControlApi` implementation is registered yet.                        |
| `reconcile_failed:<summary>`                | The reconciliation pass found discrepancies (`NO_NEW_ORDERS` until a clean pass).   |

The audit trail (`plane.audit`) is the first place to look for any incident: it
contains exactly what was attempted, by whom, when, and what happened.
