/**
 * Hermes command catalog: the allow-list of safe commands.
 *
 * Every Hermes command is a named entry in this table. A command is ONLY
 * executable through the ControlPlane dispatcher, which:
 *
 * 1. validates the command name against this table (unknown → error);
 * 2. validates params against the command's schema (rejecting unknown keys);
 * 3. checks permissions for the caller's role;
 * 4. evaluates the safety gate (paused/kill-switch/refused mutations);
 * 5. appends an audit entry BEFORE the effect is applied;
 * 6. delegates to the controlled BotControlApi.
 *
 * There is deliberately no "submit order" command: Hermes must never submit
 * arbitrary Polymarket orders — the requirement is satisfied by construction.
 */

// ---------------------------------------------------------------------------
// Command catalog
// ---------------------------------------------------------------------------

export const HERMES_COMMANDS = [
  "status",
  "markets",
  "signals",
  "inventory",
  "orders",
  "pnl",
  "risk",
  "reconcile",
  "pause",
  "resume",
  "cancel-all",
  "kill-switch",
  "explain-last-decision",
] as const;

export type HermesCommand = (typeof HERMES_COMMANDS)[number];

export function isHermesCommand(name: string): name is HermesCommand {
  return (HERMES_COMMANDS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

export type HermesRole = "viewer" | "operator" | "admin";

/** Commands each role may run. Viewer = read-only, operator = + control, admin = + emergency. */
export const ROLE_PERMISSIONS: Readonly<Record<HermesRole, readonly HermesCommand[]>> = {
  viewer: [
    "status",
    "markets",
    "signals",
    "inventory",
    "orders",
    "pnl",
    "risk",
    "explain-last-decision",
  ],
  operator: [
    "status",
    "markets",
    "signals",
    "inventory",
    "orders",
    "pnl",
    "risk",
    "explain-last-decision",
    "reconcile",
    "pause",
    "resume",
    "cancel-all",
  ],
  admin: [...HERMES_COMMANDS],
};

/** Whether a role may run a command (pure). */
export function roleAllows(role: HermesRole, command: HermesCommand): boolean {
  return ROLE_PERMISSIONS[role].includes(command);
}

// ---------------------------------------------------------------------------
// Command params (validated, closed)
// ---------------------------------------------------------------------------

/** Per-command param schemas: key → primitive type. Empty = no params. */
const PARAM_TYPES: Readonly<Record<HermesCommand, Readonly<Record<string, "string" | "number">>>> =
  {
    status: {},
    markets: {},
    signals: {},
    inventory: { marketId: "string" },
    orders: { marketId: "string", status: "string" },
    pnl: {},
    risk: {},
    reconcile: {},
    pause: { reason: "string" },
    resume: { reason: "string" },
    "cancel-all": { reason: "string" },
    "kill-switch": { reason: "string" },
    "explain-last-decision": { decisionId: "string" },
  };

export interface ValidatedParams {
  readonly [key: string]: string | number;
}

/**
 * Validate command params against the closed schema. Unknown keys are
 * rejected (fail closed); wrong types are rejected; required-missing is fine
 * (all params are optional hints).
 */
export function validateParams(
  command: HermesCommand,
  params: Readonly<Record<string, unknown>> | undefined,
): { ok: true; params: ValidatedParams } | { ok: false; reason: string } {
  const schema = PARAM_TYPES[command];
  const out: Record<string, string | number> = {};
  const given = params ?? {};

  for (const [key, value] of Object.entries(given)) {
    const expected = schema[key];
    if (expected === undefined) {
      return { ok: false, reason: `unknown_param:${key}` };
    }
    if (expected === "string") {
      if (typeof value !== "string" || value.length === 0 || value.length > 256) {
        return { ok: false, reason: `invalid_param:${key}` };
      }
      out[key] = value;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `invalid_param:${key}` };
      }
      out[key] = value;
    }
  }
  return { ok: true, params: out };
}

// ---------------------------------------------------------------------------
// Results and audit records
// ---------------------------------------------------------------------------

/** Standard result of any Hermes command. */
export interface CommandResult {
  readonly ok: boolean;
  /** "unknown" when the command name was not in the allow-list. */
  readonly command: HermesCommand | "unknown";
  /** Machine-parseable reason (especially when ok === false). */
  readonly reason: string;
  /** Command-specific payload (JSON-safe, already snapshot-shaped). */
  readonly data: unknown;
}

/**
 * One audit record — every command attempt produces exactly one, appended
 * BEFORE any effect is applied, with the full request context. The record is
 * produced by the ControlPlane (see control-plane.ts) and carries the
 * verified principal identity — never a client-claimed role.
 */
export interface HermesAuditRecord {
  readonly timestamp: string; // ISO-8601 UTC
  readonly seq: number;
  readonly command: HermesCommand | "unknown";
  readonly callerRole: HermesRole | "unknown";
  readonly actor: string | undefined;
  /** Command params exactly as validated (or "unknown" when rejected pre-validation). */
  readonly params: Readonly<Record<string, string | number>> | "unknown";
  readonly allowed: boolean;
  readonly applied: boolean;
  /** Why the command was blocked/failed ("" when not applicable). */
  readonly blockReason: string;
  readonly durationMs: number;
  /** "ok" when applied, the failure reason otherwise. */
  readonly outcome: string;
}
