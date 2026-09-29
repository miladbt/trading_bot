# @bot/soak

Long-running paper-trading soak-test infrastructure. Drives the **real**
orchestrator + `PaperExecutionAdapter` continuously with operational plumbing:
paper-mode validation, health monitoring, a fail-closed reconnect policy,
crash-safe state persistence (`state.json` atomic writes + JSONL event logs),
periodic reconciliation, structured decision logging, UTC daily reports, and
restart recovery. Runbook and checklist: [`SOAK.md`](../../SOAK.md).

**Measurement only** — nothing adjusts strategy parameters from results.

```bash
pnpm soak -- --data soak-data --interval 5000 --cycles 100
```

Safety: the runner refuses non-paper configuration at construction; the
reconciliation gate starts closed on every (re)start and reopens only after a
clean pass; live trading is never enabled.
