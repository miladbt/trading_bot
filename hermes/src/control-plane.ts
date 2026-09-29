/**
 * ControlPlane: the single, audited, fail-safe entry point for Hermes commands.
 *
 * Pipeline (see HERMES.md):
 *
 *   Hermes Client → Authentication → Verified Identity → Role/Permission
 *   Resolution → Closed Command Allowlist → Bot Control API → Risk Engine →
 *   Execution
 *
 * Safety model:
 * - **Authentication first**: every command must present valid HMAC
 *   credentials (see auth.ts). The caller's role is resolved server-side from
 *   the operator registry — a client can never claim a role.
 * - Allow-list: only names in HERMES_COMMANDS exist; anything else is
 *   rejected and audited as "unknown_command".
 * - Permissions: every command is checked against the *verified principal's*
 *   registry-derived role.
 * - Closed params: only schema-declared params, only primitive types.
 * - Safety gate: while paused, mutation commands are refused (`paused`) but
 *   reads, resume, and kill-switch escalation work; while the kill switch is
 *   engaged, EVERY command except `status` and `risk` is refused
 *   (`kill_switch_engaged`).
 * - Audit: every attempt — denied or applied — produces exactly one audit
 *   record containing requestId, principalId, command, authorization result,
 *   UTC timestamp, and the rejection reason. No credential material (secret,
 *   signature, authorization header) is ever stored in the audit record.
 * - Never throws: every failure path returns a CommandResult; a throwing API
 *   method is caught and audited.
 * - Fail-safe defaults: pause and kill-switch are sticky, idempotent, and
 *   tracked by the plane itself.
 */

import type { BotControlApi } from "./api.js";
import type { AuthenticatedPrincipal, HermesAuthenticator, HermesCredentials } from "./auth.js";
import {
  isHermesCommand,
  roleAllows,
  validateParams,
  type CommandResult,
  type HermesCommand,
  type HermesRole,
  type ValidatedParams,
} from "./commands.js";

/** One audit record — every command attempt produces exactly one. */
export interface HermesAuditRecord {
  readonly timestamp: string; // ISO-8601 UTC
  readonly seq: number;
  /** Client-supplied request id (replay key); "unknown" when absent. */
  readonly requestId: string;
  /** Verified principal id; "unauthenticated" when auth failed. */
  readonly principalId: string;
  /** Authentication outcome for this attempt. */
  readonly authResult:
    | "ok"
    | "missing_credentials"
    | "malformed_credentials"
    | "unknown_principal"
    | "invalid_signature"
    | "expired_timestamp"
    | "stale_timestamp"
    | "expired_credential"
    | "replayed_request"
    | "not_attempted";
  /** Registry-derived role of the verified principal. */
  readonly callerRole: HermesRole | "unauthenticated";
  readonly actor: string | undefined;
  readonly command: HermesCommand | "unknown";
  /** "authorization": role lacks the command; "auth": authentication failed. */
  readonly authorizationResult: "granted" | "denied" | "not_attempted";
  readonly params: Readonly<Record<string, string | number>> | "unknown";
  readonly allowed: boolean;
  readonly applied: boolean;
  /** Why the command was blocked ("" when not applicable). */
  readonly blockReason: string;
  readonly durationMs: number;
  readonly outcome: string;
}

export class ControlPlane {
  private readonly api: BotControlApi;
  private readonly authenticator: HermesAuthenticator;
  private readonly auditLog: HermesAuditRecord[] = [];
  private seq = 0;
  /** Fail-safe state tracked by the plane itself (not trusted to the API). */
  private pauseEngaged = false;
  private killEngaged = false;

  constructor(api: BotControlApi, authenticator: HermesAuthenticator) {
    this.api = api;
    this.authenticator = authenticator;
  }

  /** The bounded audit trail (newest last). */
  get audit(): readonly HermesAuditRecord[] {
    return [...this.auditLog];
  }

  /** Whether the kill switch is currently engaged. */
  get killed(): boolean {
    return this.killEngaged;
  }

  /** Whether pause is engaged (always true while killed). */
  get paused(): boolean {
    return this.pauseEngaged;
  }

  /**
   * Execute a command with authentication + authorization. Deterministic
   * given (credentials, api state, command, params, now). Never throws.
   */
  execute(
    commandName: string,
    params: Readonly<Record<string, unknown>> | undefined,
    credentials: HermesCredentials | undefined,
    now: Date = new Date(),
  ): CommandResult {
    const startedAt = Date.now();
    const nowMs = now.getTime();

    // ---- 1. Authentication (fail closed) ----
    const auth = this.authenticator.authenticate(credentials, commandName, nowMs);
    if (!auth.ok) {
      return this.auditAnd(
        {
          ok: false,
          command: isHermesCommand(commandName) ? commandName : "unknown",
          reason: `auth_failed:${auth.reason}`,
          data: null,
        },
        {
          startedAt,
          now,
          requestId: credentials?.requestId ?? "unknown",
          principalId: credentials?.principalId ?? "unauthenticated",
          authResult: auth.reason,
          authorizationResult: "not_attempted",
          callerRole: "unauthenticated",
          actor: undefined,
          command: isHermesCommand(commandName) ? commandName : "unknown",
          params: "unknown",
          allowed: false,
          applied: false,
          blockReason: `auth_failed:${auth.reason}`,
        },
      );
    }
    const principal: AuthenticatedPrincipal = auth.principal;

    // ---- 2. Allow-list ----
    if (!isHermesCommand(commandName)) {
      return this.auditAnd(
        { ok: false, command: "unknown", reason: "unknown_command", data: null },
        {
          startedAt,
          now,
          requestId: principal.requestId,
          principalId: principal.principalId,
          authResult: "ok",
          authorizationResult: "denied",
          callerRole: principal.role,
          actor: undefined,
          command: "unknown",
          params: "unknown",
          allowed: false,
          applied: false,
          blockReason: "unknown_command",
        },
      );
    }
    const command = commandName;

    // ---- 3. Authorization: registry-derived role vs closed allow-list ----
    if (!roleAllows(principal.role, command)) {
      return this.auditAnd(
        { ok: false, command, reason: "permission_denied", data: null },
        {
          startedAt,
          now,
          requestId: principal.requestId,
          principalId: principal.principalId,
          authResult: "ok",
          authorizationResult: "denied",
          callerRole: principal.role,
          actor: undefined,
          command,
          params: "unknown",
          allowed: false,
          applied: false,
          blockReason: "permission_denied",
        },
      );
    }

    // ---- 4. Params (closed schema) ----
    const validated = validateParams(command, params);
    if (!validated.ok) {
      return this.auditAnd(
        { ok: false, command, reason: validated.reason, data: null },
        {
          startedAt,
          now,
          requestId: principal.requestId,
          principalId: principal.principalId,
          authResult: "ok",
          authorizationResult: "granted",
          callerRole: principal.role,
          actor: undefined,
          command,
          params: "unknown",
          allowed: false,
          applied: false,
          blockReason: validated.reason,
        },
      );
    }
    const commandParams: ValidatedParams = validated.params;

    // ---- 5. Safety gate ----
    const gate = this.gate(command);
    if (gate !== "") {
      return this.auditAnd(
        { ok: false, command, reason: gate, data: null },
        {
          startedAt,
          now,
          requestId: principal.requestId,
          principalId: principal.principalId,
          authResult: "ok",
          authorizationResult: "granted",
          callerRole: principal.role,
          actor: undefined,
          command,
          params: commandParams,
          allowed: false,
          applied: false,
          blockReason: gate,
        },
      );
    }

    // ---- 6. Apply (never throws: API faults are caught and audited) ----
    let applied: {
      readonly reason: string;
      readonly data: unknown;
      readonly planeStateChanged: boolean;
    };
    try {
      applied = this.apply(command, commandParams);
    } catch (err) {
      return this.auditAnd(
        {
          ok: false,
          command,
          reason: `api_error:${err instanceof Error ? err.message : String(err)}`,
          data: null,
        },
        {
          startedAt,
          now,
          requestId: principal.requestId,
          principalId: principal.principalId,
          authResult: "ok",
          authorizationResult: "granted",
          callerRole: principal.role,
          actor: undefined,
          command,
          params: commandParams,
          allowed: false,
          applied: false,
          blockReason: "api_error",
        },
      );
    }
    if (applied.planeStateChanged) {
      this.trackSafetyState(command);
    }
    return this.auditAnd(
      { ok: true, command, reason: applied.reason, data: applied.data },
      {
        startedAt,
        now,
        requestId: principal.requestId,
        principalId: principal.principalId,
        authResult: "ok",
        authorizationResult: "granted",
        callerRole: principal.role,
        actor: undefined,
        command,
        params: commandParams,
        allowed: true,
        applied: true,
        blockReason: "",
      },
    );
  }

  // ---- Safety gate -----------------------------------------------------------

  /**
   * Returns "" when the command may run, otherwise the machine-parseable
   * refusal reason. Fail-safe: the killed state blocks everything except the
   * two read commands needed to observe state; the paused state blocks
   * mutations except resume/kill-switch escalation and reads.
   */
  private gate(command: HermesCommand): string {
    if (this.killEngaged) {
      return command === "status" || command === "risk" ? "" : "kill_switch_engaged";
    }
    if (this.pauseEngaged) {
      const reads = new Set([
        "status",
        "markets",
        "signals",
        "inventory",
        "orders",
        "pnl",
        "risk",
        "explain-last-decision",
      ]);
      if (command === "pause" || command === "resume" || command === "kill-switch") {
        return "";
      }
      if (reads.has(command)) {
        return "";
      }
      return "paused";
    }
    return "";
  }

  // ---- Application --------------------------------------------------------------

  private apply(
    command: HermesCommand,
    params: ValidatedParams,
  ): { readonly reason: string; readonly data: unknown; readonly planeStateChanged: boolean } {
    switch (command) {
      case "status":
        return { reason: "ok", data: this.api.status(), planeStateChanged: false };
      case "markets":
        return { reason: "ok", data: this.api.markets(), planeStateChanged: false };
      case "signals":
        return { reason: "ok", data: this.api.signals(), planeStateChanged: false };
      case "inventory":
        return {
          reason: "ok",
          data: filterInventory(this.api.inventory(), asString(params.marketId)),
          planeStateChanged: false,
        };
      case "orders":
        return {
          reason: "ok",
          data: filterOrders(this.api.orders(), asString(params.marketId), asString(params.status)),
          planeStateChanged: false,
        };
      case "pnl":
        return { reason: "ok", data: this.api.pnl(), planeStateChanged: false };
      case "risk":
        return { reason: "ok", data: this.api.risk(), planeStateChanged: false };
      case "explain-last-decision": {
        const requested = asString(params.decisionId);
        const decision =
          requested === undefined
            ? this.api.lastDecision()
            : this.api.decisions().find((d) => d.decisionId === requested);
        return {
          reason: decision === undefined ? "no_decision" : "ok",
          data: decision ?? null,
          planeStateChanged: false,
        };
      }
      case "reconcile": {
        const r = this.api.reconcile();
        return {
          reason: r.ok ? "ok" : `reconcile_failed:${r.summary}`,
          data: r,
          planeStateChanged: false,
        };
      }
      case "pause": {
        const r = this.api.pause();
        return { reason: r.reason, data: r, planeStateChanged: r.ok };
      }
      case "resume": {
        const r = this.api.resume();
        return { reason: r.reason, data: r, planeStateChanged: r.ok };
      }
      case "cancel-all": {
        const r = this.api.cancelAllOrders();
        return { reason: r.reason, data: r, planeStateChanged: false };
      }
      case "kill-switch": {
        const r = this.api.killSwitch();
        return { reason: r.reason, data: r, planeStateChanged: r.ok };
      }
    }
  }

  /** Mirror mutation outcomes into the plane's own fail-safe state. */
  private trackSafetyState(command: HermesCommand): void {
    if (command === "pause") {
      this.pauseEngaged = true;
    } else if (command === "resume") {
      this.pauseEngaged = false;
    } else if (command === "kill-switch") {
      this.killEngaged = true;
      this.pauseEngaged = true;
    }
  }

  // ---- Audit ----------------------------------------------------------------

  private auditAnd(
    result: CommandResult,
    ctx: {
      startedAt: number;
      now: Date;
      requestId: string;
      principalId: string;
      authResult: HermesAuditRecord["authResult"];
      authorizationResult: HermesAuditRecord["authorizationResult"];
      callerRole: HermesRole | "unauthenticated";
      actor: string | undefined;
      command: HermesCommand | "unknown";
      params: Readonly<Record<string, string | number>> | "unknown";
      allowed: boolean;
      applied: boolean;
      blockReason: string;
    },
  ): CommandResult {
    const durationMs = Date.now() - ctx.startedAt;
    this.seq += 1;
    const record: HermesAuditRecord = {
      timestamp: ctx.now.toISOString(),
      seq: this.seq,
      requestId: ctx.requestId,
      principalId: ctx.principalId,
      authResult: ctx.authResult,
      authorizationResult: ctx.authorizationResult,
      callerRole: ctx.callerRole,
      actor: ctx.actor,
      command: ctx.command,
      params: ctx.params,
      allowed: ctx.allowed,
      applied: ctx.applied,
      blockReason: ctx.blockReason,
      durationMs,
      outcome: result.ok ? "ok" : result.reason,
    };
    this.auditLog.push(record);
    if (this.auditLog.length > 1024) {
      this.auditLog.splice(0, this.auditLog.length - 1024);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: string | number | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function filterInventory(
  all: readonly { readonly marketId: string }[],
  marketId: string | undefined,
): readonly unknown[] {
  return marketId === undefined ? all : all.filter((i) => i.marketId === marketId);
}

function filterOrders(
  all: readonly { readonly marketId: string; readonly status: string }[],
  marketId: string | undefined,
  status: string | undefined,
): readonly unknown[] {
  let out = all;
  if (marketId !== undefined) {
    out = out.filter((o) => o.marketId === marketId);
  }
  if (status !== undefined) {
    out = out.filter((o) => o.status === status);
  }
  return out;
}

// Re-export for embedding hosts building an authenticator.
export { HermesAuthenticator, type OperatorRecord } from "./auth.js";
