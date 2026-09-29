/**
 * Authentication for the Hermes control plane.
 *
 * Architecture (see HERMES.md):
 *
 *   Hermes Client → Authentication → Verified Identity → Role/Permission
 *   Resolution → Closed Command Allowlist → Bot Control API → Risk Engine →
 *   Execution
 *
 * Security model:
 * - Credentials are **HMAC-SHA256 request signatures** over a canonical
 *   request string. The signing key lives ONLY in a server-side operator
 *   registry (per principalId); clients present
 *   `{ principalId, requestId, timestampMs, signature }`.
 * - The caller NEVER declares its role: the role is resolved from the
 *   server-side registry after the signature verifies (requirement 4).
 * - Signature verification uses `crypto.timingSafeEqual` (no string compare).
 * - Replay protection: `(principalId, requestId)` is remembered for the
 *   clock-skew window; a replayed requestId is rejected. Timestamps outside
 *   the window are rejected as expired/stale.
 * - Every failure path fails closed and returns a stable machine-parseable
 *   reason. No credential material is ever logged (reasons carry no secret
 *   data; signature strings are never echoed).
 * - Transport note: this authenticates the *request payload*; the in-process
 *   embed boundary is documented in LIVE_READINESS.md as an open transport
 *   dependency (no TLS/network listener exists yet).
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { HermesRole } from "./commands.js";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** What an unauthenticated client presents. Never contains a role. */
export interface HermesCredentials {
  readonly principalId: string;
  /** Client-generated unique request id (replay key). */
  readonly requestId: string;
  /** Client clock in UTC epoch ms (bounded skew window). */
  readonly timestampMs: number;
  /** Hex-encoded HMAC-SHA256 over the canonical request string. */
  readonly signature: string;
}

/** The verified identity handed to the control plane after authentication. */
export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly authenticationMethod: "hmac-sha256";
  /** Resolved server-side — the client cannot choose this. */
  readonly role: HermesRole;
  readonly permissions: readonly string[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly requestId: string;
}

// ---------------------------------------------------------------------------
// Operator registry (server-side only)
// ---------------------------------------------------------------------------

export interface OperatorRecord {
  readonly principalId: string;
  /** Server-held shared secret (never sent to the client, never logged). */
  readonly secret: string;
  /** Role resolved ONLY from this registry. */
  readonly role: HermesRole;
  /** Optional display name for the audit trail (not secret). */
  readonly label?: string | undefined;
  /** Optional credential expiry (UTC epoch ms); undefined = no expiry. */
  readonly expiresAtMs?: number | undefined;
}

export class OperatorRegistry {
  private readonly operators = new Map<string, OperatorRecord>();

  constructor(operators: readonly OperatorRecord[]) {
    for (const operator of operators) {
      this.operators.set(operator.principalId, operator);
    }
  }

  /** Server-side lookup; undefined for unknown principals. */
  lookup(principalId: string): OperatorRecord | undefined {
    return this.operators.get(principalId);
  }

  /** Permission list derived from the registry role (never client input). */
  permissionsFor(
    role: HermesRole,
    allow: (role: HermesRole, command: string) => boolean,
  ): readonly string[] {
    return HERMES_COMMAND_NAMES.filter((c) => allow(role, c));
  }
}

/**
 * Command names the permission derivation iterates. Kept in sync with
 * `HERMES_COMMANDS` (imported lazily to avoid a cycle at module init).
 */
import { HERMES_COMMANDS as HERMES_COMMAND_NAMES } from "./commands.js";

// ---------------------------------------------------------------------------
// Canonical request string + signature
// ---------------------------------------------------------------------------

/** The exact byte string that is signed. Both sides must agree on this. */
export function canonicalRequestString(input: {
  readonly principalId: string;
  readonly requestId: string;
  readonly timestampMs: number;
  readonly command: string;
}): string {
  return `hermes:v1:${input.principalId}:${input.requestId}:${String(input.timestampMs)}:${input.command}`;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Constant-time string equality (both fixed-length hex digests). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still perform a comparison to keep timing flat for mismatched lengths.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Client-side helper (tests/tools): compute a valid signature. */
export function signRequest(
  secret: string,
  input: {
    readonly principalId: string;
    readonly requestId: string;
    readonly timestampMs: number;
    readonly command: string;
  },
): string {
  return hmacHex(secret, canonicalRequestString(input));
}

// ---------------------------------------------------------------------------
// Replay cache
// ---------------------------------------------------------------------------

/** Bounded replay cache: remembers seen (principalId|requestId) keys. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  private readonly capacity: number;

  constructor(capacity = 4096) {
    this.capacity = capacity;
  }

  /** Record a key; returns false when it was already present (replay). */
  record(key: string): boolean {
    if (this.seen.has(key)) {
      return false;
    }
    if (this.seen.size >= this.capacity) {
      // Evict oldest insertion (Map preserves insertion order).
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    this.seen.set(key, Date.now());
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  /** Test hook: clear the cache. */
  clear(): void {
    this.seen.clear();
  }
}

// ---------------------------------------------------------------------------
// The authenticator
// ---------------------------------------------------------------------------

export interface AuthenticatorConfig {
  /** Max client-clock skew accepted for `timestampMs`. Default 60_000 ms. */
  readonly maxClockSkewMs?: number | undefined;
  /** Credential session length. Default 300_000 ms (5 min). */
  readonly sessionMs?: number | undefined;
  /** Replay cache capacity. Default 4096. */
  readonly replayCapacity?: number | undefined;
  /** Test hook: deterministic request-id generator. */
  readonly requestIdGenerator?: (() => string) | undefined;
}

export type AuthFailureReason =
  | "missing_credentials"
  | "malformed_credentials"
  | "unknown_principal"
  | "invalid_signature"
  | "expired_timestamp"
  | "stale_timestamp"
  | "expired_credential"
  | "replayed_request";

export type AuthenticationResult =
  | { readonly ok: true; readonly principal: AuthenticatedPrincipal }
  | { readonly ok: false; readonly reason: AuthFailureReason };

export class HermesAuthenticator {
  private readonly registry: OperatorRegistry;
  private readonly replay: ReplayCache;
  private readonly maxClockSkewMs: number;
  private readonly sessionMs: number;
  private readonly newRequestId: () => string;

  constructor(registry: OperatorRegistry, config: AuthenticatorConfig = {}) {
    this.registry = registry;
    this.maxClockSkewMs = config.maxClockSkewMs ?? 60_000;
    this.sessionMs = config.sessionMs ?? 300_000;
    this.replay = new ReplayCache(config.replayCapacity ?? 4096);
    this.newRequestId = config.requestIdGenerator ?? (() => randomUUID());
  }

  /**
   * Canonical signature for the command a client intends to run — used by
   * the legitimate client tooling and by tests.
   */
  sign(
    secret: string,
    principalId: string,
    requestId: string,
    timestampMs: number,
    command: string,
  ): string {
    return signRequest(secret, { principalId, requestId, timestampMs, command });
  }

  /** Fresh request id (server-side helper for clients). */
  createRequestId(): string {
    return this.newRequestId();
  }

  /**
   * Verify credentials and resolve the verified principal. Fail closed:
   * every failure returns a stable reason and records nothing.
   */
  authenticate(
    credentials: HermesCredentials | undefined,
    command: string,
    nowMs: number,
  ): AuthenticationResult {
    // ---- Presence & shape (fail closed on anything unexpected) ----
    if (credentials === undefined || credentials === null) {
      return { ok: false, reason: "missing_credentials" };
    }
    const shapeOk =
      typeof credentials.principalId === "string" &&
      credentials.principalId.length > 0 &&
      credentials.principalId.length <= 128 &&
      typeof credentials.requestId === "string" &&
      credentials.requestId.length > 0 &&
      credentials.requestId.length <= 128 &&
      Number.isInteger(credentials.timestampMs) &&
      typeof credentials.signature === "string" &&
      /^[0-9a-f]{64}$/.test(credentials.signature);
    if (!shapeOk) {
      return { ok: false, reason: "malformed_credentials" };
    }

    // ---- Principal: resolved server-side, role NEVER from the client ----
    const operator = this.registry.lookup(credentials.principalId);
    if (operator === undefined) {
      return { ok: false, reason: "unknown_principal" };
    }
    if (operator.expiresAtMs !== undefined && nowMs >= operator.expiresAtMs) {
      return { ok: false, reason: "expired_credential" };
    }

    // ---- Timestamp window ----
    const skew = nowMs - credentials.timestampMs;
    if (skew > this.maxClockSkewMs) {
      return { ok: false, reason: "stale_timestamp" };
    }
    if (skew < -this.maxClockSkewMs) {
      return { ok: false, reason: "expired_timestamp" };
    }

    // ---- Signature (constant time) ----
    const expected = signRequest(operator.secret, {
      principalId: credentials.principalId,
      requestId: credentials.requestId,
      timestampMs: credentials.timestampMs,
      command,
    });
    if (!safeEqual(expected, credentials.signature)) {
      return { ok: false, reason: "invalid_signature" };
    }

    // ---- Replay protection (after signature: only verified requests occupy
    // the cache; a failed attempt cannot poison a future valid one) ----
    const replayKey = `${credentials.principalId}|${credentials.requestId}`;
    if (!this.replay.record(replayKey)) {
      return { ok: false, reason: "replayed_request" };
    }

    // ---- Verified identity: role from the registry, never the client ----
    return {
      ok: true,
      principal: {
        principalId: operator.principalId,
        authenticationMethod: "hmac-sha256",
        role: operator.role,
        permissions: this.registry.permissionsFor(operator.role, (role, command2) =>
          roleAllows(role, command2 as HermesCommand),
        ),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + this.sessionMs,
        requestId: credentials.requestId,
      },
    };
  }
}

// Late imports (kept at bottom to make the dependency direction explicit).
import { roleAllows, type HermesCommand } from "./commands.js";
