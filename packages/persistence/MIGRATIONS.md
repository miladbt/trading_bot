# Persistence — Schema & Migrations

Storage layout produced by `FilePersistenceAdapter` under the data directory:

```
<root>/
  fill-events.jsonl        # append-only execution stream (source of truth)
  decisions.jsonl          # append-only strategy decisions (audit)
  risk-events.jsonl        # append-only risk events (audit, incl. recovery blocks)
  reconciliations.jsonl    # append-only reconciliation results (audit)
  orders.json              # keyed rows: clientOrderId → StoredOrder
  lots.json                # keyed rows: lotId → StoredLot (inventory lots)
  markets.json             # keyed rows: marketId → StoredMarket (market cycles)
  kill-switch.json         # last write wins (survives restart)
  snapshot.json            # accelerator: schemaVersion + full projection
```

## Exactness contract

| Field class | On-disk form | Why |
| --- | --- | --- |
| Money / shares | **Scaled integer strings** (`decToScaled`, scale 1e8) — e.g. `"0.45"` → `"45000000"` | Round-trip exact through BigInt; a JavaScript `number`/float can never appear in a financial field (parsing goes through domain `dec*` helpers, never `parseFloat`). |
| Timestamps | **UTC epoch ms** integer strings (ISO-8601 UTC accepted on input) | Millisecond double precision is exact ≤ 2^53; UTC only (AGENTS.md rule 2). |
| Envelopes | `schemaVersion` on every snapshot | Readers refuse unknown major versions (fail closed). |

## Schema version policy

- The current version is **1** (`SCHEMA_VERSION` in `codec.ts`).
- Readers accept exactly their own major version; anything else is
  `blocked_schema` — a recorded risk event, no new orders.
- **Additive changes** (new optional fields) bump the minor expectations inside
  the same version: writers may add fields, readers must ignore unknown ones.
- **Breaking changes** bump `SCHEMA_VERSION` and require a migration: read the
  old version, transform, write the new, then atomically swap. A recovery run
  that encounters an un-migrated file must fail closed, never guess.

## Event-oriented model

Fills/executions are append-only (`fill-events.jsonl`); `fillId`
(`clientOrderId:atMs:qty`) is the idempotency key — replaying the stream can
never double-count a fill. Orders, lots, markets are keyed rows (last write
wins) that the fill stream can refine (`filledQty`); **statuses are persisted
verbatim** and only an explicit venue confirmation may change them.

## Recovery semantics

`RecoveryManager.recover()` runs the mandated flow (load → discover → venue
query → reconcile → rebuild inventory/sets/residual → risk gate). Any
uncertainty — unhealthy store, wrong schema version, venue unreachable, venue
mismatch, persisted `UNKNOWN` orders, engaged kill switch — fails closed with
`allowTrading: false` and an appended risk event. See `LIVE_READINESS.md`.
