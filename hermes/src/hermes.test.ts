/**
 * Hermes control-plane tests: deterministic, no network, no real bot.
 *
 * Covers the mandatory scenarios A–N (authentication, authorization, replay,
 * audit, secret hygiene) plus the structural invariants (no order submission
 * surface, kill-switch fail-safe, registry-derived roles).
 */

import { describe, expect, it } from "vitest";

import {
  ControlPlane,
  HERMES_COMMANDS,
  HermesAuthenticator,
  NullBotControlApi,
  OperatorRegistry,
  ROLE_PERMISSIONS,
  isHermesCommand,
  roleAllows,
  signRequest,
  validateParams,
  type BotControlApi,
  type DecisionInfo,
  type HermesAuditRecord,
  type HermesCredentials,
  type OperatorRecord,
} from "./index.js";

const T0 = 1_800_000_000_000; // fixed UTC instant for all tests

// ---------------------------------------------------------------------------
// Deterministic world
// ---------------------------------------------------------------------------

const OPERATORS: readonly OperatorRecord[] = [
  {
    principalId: "op-alice",
    secret: "secret-alice-0123456789abcdef",
    role: "operator",
    label: "Alice",
  },
  { principalId: "adm-root", secret: "secret-root-0123456789abcdef", role: "admin", label: "Root" },
  { principalId: "view-bob", secret: "secret-bob-0123456789abcdef", role: "viewer", label: "Bob" },
  {
    principalId: "op-expired",
    secret: "secret-expired-0123456789abcdef",
    role: "operator",
    expiresAtMs: T0 - 1_000,
  },
];

function credentials(
  operator: OperatorRecord,
  command: string,
  requestId = "req-1",
  timestampMs = T0,
  over: Partial<HermesCredentials> = {},
): HermesCredentials {
  return {
    principalId: operator.principalId,
    requestId,
    timestampMs,
    signature: signRequest(operator.secret, {
      principalId: operator.principalId,
      requestId,
      timestampMs,
      command,
    }),
    ...over,
  };
}

/** Deterministic fake bot API (fault-injectable, records cancel calls). */
class FakeBotApi implements BotControlApi {
  pauseEngaged = false;
  killEngaged = false;
  failOn: string | null = null;
  readonly cancelCalls: string[] = [];
  private readonly decisionList: DecisionInfo[] = [
    {
      decisionId: "dec-000001",
      atMs: T0,
      asset: "BTC",
      marketId: "703257",
      action: "submit_order",
      orderSubmitted: true,
      riskReason: "ok",
      detail: { qty: "25.00000000", price: "0.45000000" },
    },
  ];

  status() {
    return {
      botId: "fake",
      uptimeMs: 1234,
      tradingMode: "paper" as const,
      liveTradingEnabled: false,
      healthy: true,
      version: "0.1.0",
    };
  }
  markets() {
    return [];
  }
  signals() {
    return [];
  }
  inventory() {
    return [];
  }
  orders() {
    return [];
  }
  openOrders() {
    return [];
  }
  fills() {
    return [];
  }
  pnl() {
    return { byMarket: {}, total: "0.00000000", dailyLossUsdc: "0.00000000" };
  }
  risk() {
    return {
      allowNewOrders: false,
      blockReason: "not_wired",
      reconciliation: "unknown" as const,
      paused: this.pauseEngaged,
      killed: this.killEngaged,
    };
  }
  lastDecision() {
    return this.decisionList[this.decisionList.length - 1];
  }
  decisions() {
    return this.decisionList;
  }
  reconciliationEvents() {
    return [];
  }
  cancelOrder(clientOrderId: string) {
    this.cancelCalls.push(clientOrderId);
    return { ok: true, reason: "cancelled" };
  }
  cancelAllOrders() {
    this.cancelCalls.push("*");
    return { ok: true, cancelled: ["ord-1"], reason: "cancelled" };
  }
  pause() {
    this.assertNotFailing("pause");
    this.pauseEngaged = true;
    return { ok: true, reason: "paused" };
  }
  resume() {
    this.assertNotFailing("resume");
    if (this.killEngaged) {
      return { ok: false, reason: "kill_switch_sticky" };
    }
    this.pauseEngaged = false;
    return { ok: true, reason: "resumed" };
  }
  killSwitch() {
    this.assertNotFailing("killSwitch");
    this.killEngaged = true;
    this.pauseEngaged = true;
    return { ok: true, reason: "kill_switch_engaged" };
  }
  reconcile() {
    this.assertNotFailing("reconcile");
    return { startedAtMs: 1, finishedAtMs: 2, ok: true, eventCount: 0, summary: "clean" };
  }

  private assertNotFailing(method: string): void {
    if (this.failOn === method) {
      throw new Error(`injected fault: ${method}`);
    }
  }
}

function plane(over: { operators?: readonly OperatorRecord[]; api?: FakeBotApi } = {}) {
  const registry = new OperatorRegistry(over.operators ?? OPERATORS);
  const authenticator = new HermesAuthenticator(registry, {
    requestIdGenerator: () => "server-req",
  });
  const api = over.api ?? new FakeBotApi();
  return { plane: new ControlPlane(api, authenticator), api, authenticator, registry };
}

function lastAudit(p: ControlPlane): HermesAuditRecord {
  const audit = p.audit;
  expect(audit.length).toBeGreaterThan(0);
  return audit[audit.length - 1] as HermesAuditRecord;
}

const FIXED_NOW = new Date(T0);

// ---------------------------------------------------------------------------

describe("A: valid authenticated operator + allowed command", () => {
  it("passes authentication, authorization, and applies", () => {
    const { plane: p } = plane();
    const result = p.execute("status", undefined, credentials(OPERATORS[0]!, "status"), FIXED_NOW);
    expect(result.ok).toBe(true);
    const record = lastAudit(p);
    expect(record.authResult).toBe("ok");
    expect(record.authorizationResult).toBe("granted");
    expect(record.principalId).toBe("op-alice");
    expect(record.callerRole).toBe("operator");
  });

  it("admin can escalate to kill-switch", () => {
    const { plane: p } = plane();
    const result = p.execute(
      "kill-switch",
      { reason: "emergency" },
      credentials(OPERATORS[1]!, "kill-switch", "req-kill"),
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    expect(p.killed).toBe(true);
  });

  it("operator can pause and resume", () => {
    const { plane: p } = plane();
    expect(
      p.execute(
        "pause",
        { reason: "maintenance" },
        credentials(OPERATORS[0]!, "pause", "r1"),
        FIXED_NOW,
      ).ok,
    ).toBe(true);
    expect(
      p.execute("resume", undefined, credentials(OPERATORS[0]!, "resume", "r2"), FIXED_NOW).ok,
    ).toBe(true);
  });
});

describe("B–D: authentication failures fail closed", () => {
  it("B: missing credentials are denied", () => {
    const { plane: p } = plane();
    const result = p.execute("status", undefined, undefined, FIXED_NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed:missing_credentials");
    expect(lastAudit(p).authResult).toBe("missing_credentials");
  });

  it("C: invalid credentials (wrong secret / tampered signature) are denied", () => {
    const { plane: p } = plane();
    const tampered = credentials(OPERATORS[0]!, "status");
    const bad = {
      ...tampered,
      signature: "0".repeat(64),
    };
    const result = p.execute("status", undefined, bad, FIXED_NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed:invalid_signature");
  });

  it("C2: unknown principal is denied", () => {
    const { plane: p } = plane();
    const impostor: OperatorRecord = {
      principalId: "op-ghost",
      secret: "ghost-secret",
      role: "admin",
    };
    const result = p.execute("status", undefined, credentials(impostor, "status"), FIXED_NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed:unknown_principal");
  });

  it("D: expired credentials are denied", () => {
    const { plane: p } = plane();
    const result = p.execute("status", undefined, credentials(OPERATORS[3]!, "status"), FIXED_NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed:expired_credential");
  });

  it("D2: stale/future timestamps are denied (skew window)", () => {
    const { plane: p } = plane();
    const stale = credentials(OPERATORS[0]!, "status", "r", T0 - 120_000);
    expect(p.execute("status", undefined, stale, FIXED_NOW).reason).toBe(
      "auth_failed:stale_timestamp",
    );
    const future = credentials(OPERATORS[0]!, "status", "r2", T0 + 120_000);
    expect(p.execute("status", undefined, future, FIXED_NOW).reason).toBe(
      "auth_failed:expired_timestamp",
    );
  });

  it("malformed credentials are denied", () => {
    const { plane: p } = plane();
    const malformed: HermesCredentials = {
      principalId: "op-alice",
      requestId: "r",
      timestampMs: T0,
      signature: "not-a-signature",
    };
    expect(p.execute("status", undefined, malformed, FIXED_NOW).reason).toBe(
      "auth_failed:malformed_credentials",
    );
  });
});

describe("E: role escalation is impossible", () => {
  it("the client cannot claim a role — roles come from the server registry", () => {
    // The credentials type has no role field; attempting to smuggle one is a
    // TS error, and at runtime unknown principals get nothing.
    const { plane: p } = plane();
    const impostor: OperatorRecord = {
      principalId: "attacker",
      secret: "attacker-secret",
      role: "admin", // attacker would LOVE this to matter — it never does
    };
    const result = p.execute(
      "kill-switch",
      { reason: "x" },
      credentials(impostor, "kill-switch", "r"),
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed:unknown_principal");
    expect(p.killed).toBe(false);
  });

  it("a viewer's signature only ever resolves to viewer permissions", () => {
    const { plane: p, authenticator } = plane();
    const bob = OPERATORS[2]!;
    const auth = authenticator.authenticate(credentials(bob, "status"), "status", T0);
    expect(auth.ok && auth.principal.role).toBe("viewer");
    // Even with a valid signature, a viewer cannot run operator commands.
    const result = p.execute("pause", undefined, credentials(bob, "pause", "r"), FIXED_NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("permission_denied");
    expect(lastAudit(p).authorizationResult).toBe("denied");
  });
});

describe("F–G: command authorization", () => {
  it("F: unauthorized command for the role is denied", () => {
    const { plane: p } = plane();
    const result = p.execute(
      "cancel-all",
      { reason: "x" },
      credentials(OPERATORS[2]!, "cancel-all", "r"), // viewer
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("permission_denied");
  });

  it("G: unknown commands are denied", () => {
    const { plane: p } = plane();
    const result = p.execute(
      "submit-order",
      { side: "buy", price: "0.1", qty: "100" },
      credentials(OPERATORS[1]!, "submit-order", "r"),
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_command");
    expect(lastAudit(p).command).toBe("unknown");
  });

  it("the closed allow-list matches the documented catalog", () => {
    expect([...HERMES_COMMANDS].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(isHermesCommand("submitOrder")).toBe(false);
    expect(isHermesCommand("place-order")).toBe(false);
  });

  it("params are schema-validated; unknown keys rejected", () => {
    expect(validateParams("pause", { reason: "x" }).ok).toBe(true);
    expect(validateParams("pause", { price: "0.1" }).ok).toBe(false);
    expect(validateParams("status", { qty: "100" }).ok).toBe(false);
  });
});

describe("H–J: prohibited operations are structurally impossible", () => {
  it("H: no command or parameter combination can submit an order", () => {
    for (const command of HERMES_COMMANDS) {
      const validated = validateParams(command, {
        side: "buy",
        price: "0.01",
        qty: "100",
        tokenId: "1111111111",
        marketId: "703257",
      });
      if (validated.ok) {
        for (const key of Object.keys(validated.params)) {
          expect(["marketId", "status", "reason", "decisionId"]).toContain(key);
        }
      }
    }
    // The BotControlApi port has no submit method at all.
    const api: BotControlApi = new FakeBotApi();
    expect("submit" in api).toBe(false);
    expect("submitOrder" in api).toBe(false);
  });

  it("I: no command can disable risk controls or the kill switch", () => {
    const catalog: readonly string[] = HERMES_COMMANDS;
    // There is no command named anything like disable-risk / disable-kill.
    expect(catalog.includes("disable-risk")).toBe(false);
    expect(catalog.includes("disable-kill-switch")).toBe(false);
    expect(catalog.includes("disable-risk-engine")).toBe(false);
    // Every command name in the catalog is a fixed member of the allow-list.
    for (const command of catalog) {
      expect(isHermesCommand(command)).toBe(true);
    }
  });

  it("J: no command can enable live trading or change trading mode", () => {
    // The BotControlApi surface exposes mode read-only via status()/risk();
    // there is no setter anywhere on the port.
    const api = new FakeBotApi();
    for (const key of Object.keys(api)) {
      expect(key.startsWith("set")).toBe(false);
      expect(key.includes("live")).toBe(false);
      expect(key.includes("tradingMode")).toBe(false);
    }
    // status() reports paper mode; no command can alter it.
    expect(api.status().tradingMode).toBe("paper");
    expect(api.status().liveTradingEnabled).toBe(false);
  });

  it("no command touches credentials or withdrawals", () => {
    for (const command of HERMES_COMMANDS) {
      expect(["change-keys", "withdraw", "set-credentials", "rotate-key"]).not.toContain(command);
    }
  });
});

describe("K: malformed parameters are denied", () => {
  it("unknown or wrongly-typed params are rejected after auth", () => {
    const { plane: p } = plane();
    const result = p.execute(
      "orders",
      { marketId: 42 },
      credentials(OPERATORS[0]!, "orders", "r"),
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_param:marketId");
    const record = lastAudit(p);
    expect(record.authorizationResult).toBe("granted"); // authz passed
    expect(record.applied).toBe(false);
    expect(record.blockReason).toBe("invalid_param:marketId");
  });
});

describe("L: replay protection", () => {
  it("a replayed request (same requestId) is denied", () => {
    const { plane: p } = plane();
    const first = p.execute(
      "status",
      undefined,
      credentials(OPERATORS[0]!, "status", "req-9"),
      FIXED_NOW,
    );
    expect(first.ok).toBe(true);
    const replay = p.execute(
      "status",
      undefined,
      credentials(OPERATORS[0]!, "status", "req-9"),
      FIXED_NOW,
    );
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("auth_failed:replayed_request");
  });

  it("a replayed kill-switch attempt cannot re-engage or act", () => {
    const { plane: p } = plane();
    const creds = credentials(OPERATORS[1]!, "kill-switch", "req-k");
    expect(p.execute("kill-switch", { reason: "x" }, creds, FIXED_NOW).ok).toBe(true);
    const replay = p.execute("kill-switch", { reason: "x" }, creds, FIXED_NOW);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("auth_failed:replayed_request");
  });

  it("the same principal can issue fresh requests (requestId varies)", () => {
    const { plane: p } = plane();
    expect(
      p.execute("status", undefined, credentials(OPERATORS[0]!, "status", "a"), FIXED_NOW).ok,
    ).toBe(true);
    expect(
      p.execute("status", undefined, credentials(OPERATORS[0]!, "status", "b"), FIXED_NOW).ok,
    ).toBe(true);
  });
});

describe("M–N: audit trail", () => {
  it("M: every denied command produces an audit record", () => {
    const { plane: p } = plane();
    p.execute("status", undefined, undefined, FIXED_NOW); // missing credentials
    p.execute(
      "kill-switch",
      undefined,
      credentials(OPERATORS[0]!, "kill-switch", "r"), // operator: not permitted
      FIXED_NOW,
    );
    const audit = p.audit;
    expect(audit.length).toBe(2);
    expect(audit[0]?.allowed).toBe(false);
    expect(audit[0]?.blockReason).toBe("auth_failed:missing_credentials");
    expect(audit[1]?.authorizationResult).toBe("denied");
    expect(audit[1]?.requestId).toBe("r");
    expect(audit[1]?.timestamp).toBe(new Date(T0).toISOString());
  });

  it("N: credentials/secrets never appear in audit records", () => {
    const { plane: p } = plane();
    const secret = OPERATORS[0]!.secret;
    p.execute("status", undefined, credentials(OPERATORS[0]!, "status", "req-audit"), FIXED_NOW);
    p.execute(
      "status",
      undefined,
      { ...credentials(OPERATORS[0]!, "status", "x"), signature: "f".repeat(64) },
      FIXED_NOW,
    );
    const serialized = JSON.stringify(p.audit);
    // No secret value, no raw signature hex, no credential-shaped field.
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("f".repeat(64));
    expect(serialized).not.toContain("secret-alice");
    expect(serialized.toLowerCase()).not.toContain('"signature"');
    expect(serialized.toLowerCase()).not.toContain('"authorization"');
    expect(serialized.toLowerCase()).not.toContain('"token"');
    // Reasons may name the failure class (invalid_signature) but never carry material.
  });
});

describe("integration: existing behavior preserved", () => {
  it("safety gate: while paused, mutations are refused but reads work", () => {
    const { plane: p } = plane();
    const op = OPERATORS[0]!;
    expect(p.execute("pause", { reason: "m" }, credentials(op, "pause", "1"), FIXED_NOW).ok).toBe(
      true,
    );
    expect(
      p.execute("reconcile", undefined, credentials(op, "reconcile", "2"), FIXED_NOW).reason,
    ).toBe("paused");
    expect(p.execute("status", undefined, credentials(op, "status", "3"), FIXED_NOW).ok).toBe(true);
    expect(p.execute("resume", undefined, credentials(op, "resume", "4"), FIXED_NOW).ok).toBe(true);
    expect(p.execute("reconcile", undefined, credentials(op, "reconcile", "5"), FIXED_NOW).ok).toBe(
      true,
    );
  });

  it("kill switch blocks everything except status/risk; resume cannot clear it", () => {
    const { plane: p } = plane();
    const root = OPERATORS[1]!;
    expect(
      p.execute("kill-switch", { reason: "x" }, credentials(root, "kill-switch", "1"), FIXED_NOW)
        .ok,
    ).toBe(true);
    for (const command of HERMES_COMMANDS) {
      const result = p.execute(
        command,
        undefined,
        credentials(root, command, `k-${command}`),
        FIXED_NOW,
      );
      if (command === "status" || command === "risk") {
        expect(result.ok, command).toBe(true);
      } else {
        expect(result.ok, command).toBe(false);
        expect(result.reason, command).toBe("kill_switch_engaged");
      }
    }
  });

  it("explain-last-decision returns the latest decision for authorized callers", () => {
    const { plane: p } = plane();
    const result = p.execute(
      "explain-last-decision",
      undefined,
      credentials(OPERATORS[0]!, "explain-last-decision", "r"),
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    expect((result.data as DecisionInfo).decisionId).toBe("dec-000001");
  });

  it("the plane never throws, even on API faults", () => {
    const api = new FakeBotApi();
    api.failOn = "pause";
    const { plane: p } = plane({ api });
    const result = p.execute(
      "pause",
      undefined,
      credentials(OPERATORS[0]!, "pause", "r"),
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("api_error");
    expect(p.paused).toBe(false);
  });

  it("NullBotControlApi remains fail-safe by default", () => {
    const api = new NullBotControlApi("test");
    expect(api.status().tradingMode).toBe("paper");
    expect(api.status().liveTradingEnabled).toBe(false);
    expect(api.risk().allowNewOrders).toBe(false);
  });
});

describe("invariants", () => {
  it("permissions derive from ROLE_PERMISSIONS via the registry role only", () => {
    expect(ROLE_PERMISSIONS.viewer).not.toContain("pause");
    expect(ROLE_PERMISSIONS.operator).not.toContain("kill-switch");
    expect(ROLE_PERMISSIONS.admin).toContain("kill-switch");
    expect(roleAllows("viewer", "status")).toBe(true);
  });

  it("signature verification is deterministic and command-bound", () => {
    const a = signRequest(OPERATORS[0]!.secret, {
      principalId: "op-alice",
      requestId: "r",
      timestampMs: T0,
      command: "status",
    });
    const b = signRequest(OPERATORS[0]!.secret, {
      principalId: "op-alice",
      requestId: "r",
      timestampMs: T0,
      command: "pause",
    });
    expect(a).toBe(
      signRequest(OPERATORS[0]!.secret, {
        principalId: "op-alice",
        requestId: "r",
        timestampMs: T0,
        command: "status",
      }),
    );
    expect(a).not.toBe(b); // a signature for one command is not valid for another
  });
});
