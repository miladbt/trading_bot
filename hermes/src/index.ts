/**
 * Hermes: the operational control interface for the bot.
 *
 * Safety model (see HERMES.md):
 * - Hermes never submits arbitrary Polymarket orders — the only mutation
 *   surface is the closed `BotControlApi` port (cancel scoped, pause, resume,
 *   kill-switch, reconcile). There is no submit-order method anywhere.
 * - Hermes never touches private keys or secrets: this package's types carry
 *   no credential material and its data sources are log-safe snapshots.
 * - Hermes cannot modify risk limits or enable live trading — those live in
 *   the validated config, which this package never writes.
 * - pause and kill-switch are fail-safe: sticky, idempotent, tracked by the
 *   ControlPlane itself, and the kill switch blocks every command except the
 *   reads needed to observe it.
 * - Every command attempt is audited with timestamp, caller, params, outcome.
 *
 * Dependency direction (AGENTS.md): apps/packages may import hermes; hermes
 * imports nothing from them (only `@bot/shared` types).
 */

export type {
  BotControlApi,
  BotStatusInfo,
  DecisionInfo,
  FillInfo,
  InventoryInfo,
  LotInfo,
  MarketInfo,
  OrderInfo,
  PnlInfo,
  ReconcileResultInfo,
  RiskInfo,
  SignalInfo,
} from "./api.js";
export { NullBotControlApi } from "./api.js";

export {
  HERMES_COMMANDS,
  ROLE_PERMISSIONS,
  isHermesCommand,
  roleAllows,
  validateParams,
} from "./commands.js";
export type { CommandResult, HermesCommand, HermesRole, ValidatedParams } from "./commands.js";

export {
  HermesAuthenticator,
  OperatorRegistry,
  ReplayCache,
  canonicalRequestString,
  signRequest,
  type AuthFailureReason,
  type AuthenticationResult,
  type AuthenticatorConfig,
  type AuthenticatedPrincipal,
  type HermesCredentials,
  type OperatorRecord,
} from "./auth.js";

export { ControlPlane, type HermesAuditRecord } from "./control-plane.js";
