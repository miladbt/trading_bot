# @bot/hermes

Operational control interface for the trading bot: a **read-mostly, audited,
fail-safe command plane**. See [HERMES.md](../HERMES.md) for the full
documentation (installation, configuration, commands, permissions, safety
model, troubleshooting).

## Safety by construction

- **No arbitrary orders** — the command catalog is a closed allow-list with no
  order-submission command and no order-intent parameters; the only mutation
  surface is the closed `BotControlApi` port (scoped cancel, pause, resume,
  kill-switch, reconcile).
- **No secrets** — no type in this package has a place for credential material;
  payloads are log-safe plain data.
- **No risk-limit or mode changes** — Hermes has no write path to `AppConfig`.
- **Fail-safe controls** — `pause` and `kill-switch` are sticky and idempotent;
  the kill switch blocks everything except `status`/`risk` reads and can only
  be cleared by a restart. The `ControlPlane` tracks the state itself.
- **Fully audited** — every attempt (allowed, denied, failed, unknown) produces
  one `HermesAuditRecord` before/outcome-complete; the plane never throws.

## Usage

```ts
import { ControlPlane, NullBotControlApi } from "@bot/hermes";

const plane = new ControlPlane(new NullBotControlApi("paper-bot"));
const result = plane.execute("status", undefined, { role: "viewer", actor: "oncall" });
```

The bot implements `BotControlApi` (snapshots + closed mutation set) and hands
it to the plane. Dependency direction: apps/packages → hermes, never the
reverse.

## Tests

24 deterministic tests cover the allow-list, closed param validation, role
permissions, the paused/kill-switch gates, fail-safe semantics (sticky
kill-switch, idempotent pause, resume-vs-kill precedence), audit completeness,
never-throws behavior under API faults, and a proof that no command can carry
an order intent.
