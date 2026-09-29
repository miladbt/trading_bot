# SOAK.md — Paper-Trading Soak Test Runbook

Long-running stability validation for the paper-trading stack. The soak drives
the **real** orchestrator + paper adapter continuously, with persistence,
reconciliation, health monitoring, and daily reporting. **Live trading is
never enabled and no strategy parameter is ever adjusted from results** — the
soak is measurement only.

---

## 1. Preconditions

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green.
- [ ] `pnpm audit` reports no known vulnerabilities.
- [ ] `.env` exists (copied from `.env.example`) with **`TRADING_MODE=paper`**
      and **`LIVE_TRADING_ENABLED=false`** — verify before every soak:
      `grep -E "TRADING_MODE|LIVE_TRADING" .env`
- [ ] Credentials section of `.env` is EMPTY (no credentials should exist).
- [ ] Docker host validated (optional container run): `docker compose config`
      and `docker compose up -d --build`; `curl localhost:3001/ready` → 200.
- [ ] Disk space for soak data: ~50 MB/day is a safe budget
      (state.json + JSONL logs + reports).

## 2. Starting a soak run

Native:

```bash
pnpm --filter @bot/soak soak -- --data soak-data --interval 5000
```

- `--data <dir>` — persistence directory (`state.json`, `logs/*.jsonl`,
  `reports/daily-*.json|csv`). Reusing a dir resumes; a new dir starts fresh.
- `--interval <ms>` — wall-clock pace between cycles (default 5000).
- `--cycles <n>` — stop after n cycles (0 = until stopped).
- `--start <ms>` — deterministic feed epoch (defaults to now; fix it, e.g.
  `--start 1800000000000`, to make runs reproducible).

Container (preferred for multi-day runs):

```bash
docker compose up -d --build
docker compose logs -f api
```

The runner validates paper mode at startup and refuses anything else.

## 3. What the soak runs, per cycle

1. **Paper-mode validation** — enforced at construction; a live config throws.
2. **Orchestrator tick** — the full pipeline (signal → phase → inventory →
   complete-set engine → rebalancing → RiskEngine → paper execution); every
   decision appended to `logs/decisions-<date>.jsonl`.
3. **Fill processing** — new adapter fills become acquisition lots and cash
   movements; logged to `logs/fills-<date>.jsonl`.
4. **Automatic reconnect policy** — a failed cycle logs the bounded backoff
   schedule (1s → 30s); the runner never re-opens trading on its own.
5. **Periodic reconciliation** — local lots/known fills vs. the paper adapter
   as the venue of record; appended to `logs/reconciliations-<date>.jsonl`;
   a blocking result enforces NO_NEW_ORDERS until a clean pass.
6. **Daily report** — first cycle of each UTC date writes
   `reports/daily-<date>.json` and `.csv` (activity, sets/residuals, cash,
   fees, exposure).
7. **State persistence** — `state.json` written atomically every cycle.

## 4. Health monitoring

Per-cycle health is logged (`soak health`: ticks, decisions, orders, fills,
lots, reconciliation state, state size). Watch with:

```bash
tail -f soak-data/logs/*.jsonl | jq -c 'select(.summary != null or .action != null)'
```

Signals that demand investigation (stop the soak first):

- `reconciliation: unreconciled` persists for more than one cycle
- `state.json` grows without bound (expect KB-scale; MB-scale means a leak)
- decision volume collapses to `skipped_no_signal`/`error` for hours
- cash drifts without corresponding fills in `fills-*.jsonl`

## 5. Failure recovery

- **Crash / kill:** just restart with the same `--data` dir. State resumes
  (counters, lots, known fills, reported days); the reconciliation gate starts
  CLOSED and reopens only after a clean pass. Duplicate order ids are
  prevented by the persisted `orderSeq` counter.
- **Corrupt `state.json`:** the loader returns undefined and the run starts
  fresh (fail-safe); the JSONL logs remain for forensics. Restore from the
  logs if the interim matters.
- **Graceful stop:** SIGTERM/SIGINT finish the current cycle, persist, and
  exit 0.

## 6. Soak-test checklist

### Stability
- [ ] Runs 24 h continuously without an unhandled exception.
- [ ] Runs 72 h continuously (restart allowed per §5, reason recorded).
- [ ] Memory is flat: RSS at t+24 h within ~20% of RSS at t+1 h.
- [ ] `state.json` size bounded (no growth after the first day's lots).
- [ ] JSONL rotation creates exactly one file per UTC date per stream.

### Correctness
- [ ] Every `decisions-*.jsonl` line has a unique `decisionId`, sequential
      per run; ids continue (not reset) across restarts.
- [ ] Every fill in `fills-*.jsonl` appears exactly once in
      `state.json → knownTradeIds` (dedupe holds across restarts).
- [ ] Every periodic reconciliation with `summary: "clean"` is followed by
      `reconciliation: reconciled` in the next health log.
- [ ] Any blocking reconciliation is followed by zero new orders until a
      clean pass (verify: no `submit_order` decisions between them).
- [ ] Cash in `state.json` equals −Σ(fills notional + fees) from
      `fills-*.jsonl` (exact fixed-point match).

### Safety
- [ ] `/health` reports `tradingMode: "paper"`,
      `liveTradingEnabled: false` for the whole run.
- [ ] No credential material in any log file (spot-check with
      `grep -riE "api[_-]?key|passphrase|private[_-]?key" soak-data` → no hits
      other than redaction markers).
- [ ] Every restart required a clean reconciliation pass before the first new
      order (check the ordering in the logs).
- [ ] No strategy parameter was changed by the soak (git diff of config files
      is empty; reports are write-only).

### Reporting
- [ ] `reports/daily-<date>.json|.csv` exist for every UTC day of the run,
      exactly one each.
- [ ] Daily report counters reconcile with the JSONL logs for that date.
- [ ] The final report summarizes: total ticks, decisions, orders, fills,
      sets matched, residuals, cash, fees — and nothing feeds back into
      strategy parameters.

## 7. Exit criteria

A soak run passes when every box in §6 is checked for the target duration
(recommended: 72 h). Any failure: stop, preserve `soak-data/` untouched for
forensics, file the findings, fix, and restart the clock on a fresh run.
