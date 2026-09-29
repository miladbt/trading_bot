# @bot/persistence

Production-oriented persistence and crash recovery (previously a stub).

- **Port, not a database:** `PersistenceAdapter` with a file-backed
  implementation (atomic snapshot + append-only JSONL streams, no driver, no
  credentials) and an in-memory implementation for tests. A future Postgres
  adapter implements the same port.
- **Event-oriented:** fills/executions are an append-only stream keyed by an
  idempotent `fillId`; inventory, matched sets, and residuals rebuild by
  deterministic replay; statuses persist verbatim (`PARTIALLY_FILLED` stays,
  `UNKNOWN` never auto-promotes to `FILLED`).
- **Recovery:** `RecoveryManager` implements the mandated startup flow and
  fails closed on any uncertainty, recording a risk event. Kill-switch state
  survives restart.
- **Exactness:** Decimals as scaled integer strings, UTC epoch ms; no floats
  in financial accounting. Schema rules: `MIGRATIONS.md`.
