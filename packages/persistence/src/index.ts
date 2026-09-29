/**
 * Persistence package: production-oriented state persistence and crash
 * recovery (see MIGRATIONS.md for schema rules).
 *
 * - `PersistenceAdapter` port: file-backed (atomic snapshot + append-only
 *   JSONL streams, no DB driver, no credentials) and in-memory (tests)
 *   implementations; a future database implements the same port.
 * - Append-only event model for fills/executions; orders, inventory, lots,
 *   matched sets, and residuals rebuild deterministically by replay.
 * - `RecoveryManager`: the mandated startup flow — load → venue query →
 *   reconcile → rebuild → risk gate — fail closed on any uncertainty, with
 *   idempotent fill ingestion and persisted kill-switch semantics.
 * - Exactness contract: Decimals as scaled integer strings, UTC epoch ms —
 *   never a JavaScript float in a financial field.
 */

export {
  FilePersistenceAdapter,
  InMemoryPersistenceAdapter,
  type PersistenceAdapter,
} from "./adapter.js";

export {
  decodedFill,
  executionOrderFromStored,
  fillEventFromExecution,
  storedOrderFromExecution,
  type FillEvent,
  type StoredDecision,
  type StoredKillSwitch,
  type StoredLot,
  type StoredMarket,
  type StoredOrder,
  type StoredReconciliation,
  type StoredRiskEvent,
} from "./events.js";

export {
  RecoveryManager,
  type RecoveryReport,
  type RecoveryStatus,
  type VenueStateProvider,
} from "./recovery.js";

export {
  assertSchemaVersion,
  decodeDecimal,
  decodeMillis,
  encodeDecimal,
  encodeMillis,
  SCHEMA_VERSION,
  stableStringify,
} from "./codec.js";
