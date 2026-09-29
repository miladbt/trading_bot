import { describe, expect, it } from "vitest";

import { ValidationError, decFromString, decToString, type Decimal } from "@bot/domain";

import { evaluateRiskOrder, validateRiskOrderRequest, type RiskOrderRequest } from "./engine.js";
import { riskLimitsFromConfig, type RiskLimits } from "./limits.js";
import { DEFAULT_RISK, DEFAULT_STRATEGY, type AppConfig } from "@bot/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const d = (s: string): Decimal => decFromString(s);

/** A config-derived limit set with values convenient for boundary testing. */
function makeLimits(over: Partial<RiskLimits> = {}): RiskLimits {
  return {
    maxTotalCapital: d("100"),
    maxMarketCapital: d("25"),
    maxOrderSize: d("50"),
    maxOpenOrders: 3,
    maxDirectionalExposure: d("40"),
    maxResidualShares: d("10"),
    maxOrphanInventory: d("5"),
    maxDailyLoss: d("20"),
    maxMarketLoss: d("10"),
    maxDataAgeMs: 5_000,
    maxUnderlyingAgeMs: 5_000,
    ...over,
  };
}

/** A healthy, empty-book request: everything comfortably within limits. */
function makeRequest(over: Partial<RiskOrderRequest> = {}): RiskOrderRequest {
  return {
    marketId: "703257",
    tokenId: "1111111111",
    outcome: "up",
    side: "buy",
    qty: d("10"),
    price: d("0.50"),
    openOrderCount: 0,
    totalCapitalDeployed: d("0"),
    marketCapitalDeployed: d("0"),
    directionalExposureAfter: d("5"), // 10 shares x 0.50 signed for the asset
    residualShares: d("0"),
    orphanInventoryUsdc: d("0"),
    dailyLossUsdc: d("0"),
    marketLossUsdc: d("0"),
    marketDataAgeMs: 100,
    underlyingDataAgeMs: 100,
    reconciliation: "reconciled",
    apiHealth: "healthy",
    wsHealth: "healthy",
    marketExpired: false,
    ...over,
  };
}

describe("riskLimitsFromConfig", () => {
  it("maps the validated AppConfig onto the engine limit set", () => {
    const config = {
      risk: DEFAULT_RISK,
      strategy: DEFAULT_STRATEGY,
    } as AppConfig;
    const limits = riskLimitsFromConfig(config);
    expect(decToString(limits.maxTotalCapital)).toBe("100.00000000");
    expect(decToString(limits.maxMarketCapital)).toBe("25.00000000");
    expect(decToString(limits.maxOrderSize)).toBe("50.00000000");
    expect(limits.maxOpenOrders).toBe(8);
    expect(decToString(limits.maxDirectionalExposure)).toBe("50.00000000");
    expect(decToString(limits.maxResidualShares)).toBe("0.00200000");
    expect(decToString(limits.maxOrphanInventory)).toBe("10.00000000");
    expect(decToString(limits.maxDailyLoss)).toBe("50.00000000");
    expect(limits.maxDataAgeMs).toBe(5_000);
  });
});

describe("evaluateRiskOrder — happy path", () => {
  it("allows a healthy order well within all limits", () => {
    const r = evaluateRiskOrder(makeRequest(), makeLimits());
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.halted).toBe(false);
    expect(decToString(r.exposure.orderNotionalUsdc)).toBe("5.00000000");
    expect(decToString(r.limits.maxTotalCapital)).toBe("100.00000000");
    expect(decToString(r.exposure.directionalExposureAfter)).toBe("5.00000000");
  });

  it("echoes the limits and exposure snapshot for the audit trail", () => {
    const limits = makeLimits();
    const req = makeRequest({ totalCapitalDeployed: d("12.5") });
    const r = evaluateRiskOrder(req, limits);
    expect(r.limits).toEqual(limits);
    expect(decToString(r.exposure.totalCapitalDeployed)).toBe("12.50000000");
    expect(decToString(r.exposure.marketCapitalDeployed)).toBe("0.00000000");
  });
});

describe("evaluateRiskOrder — market expiration", () => {
  it("rejects an expired market as a halt", () => {
    const r = evaluateRiskOrder(makeRequest({ marketExpired: true }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("market_expired");
    expect(r.halted).toBe(true);
  });
});

describe("evaluateRiskOrder — reconciliation (fail closed)", () => {
  it("rejects when reconciliation has never run (unknown)", () => {
    const r = evaluateRiskOrder(makeRequest({ reconciliation: undefined }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("reconciliation_unknown");
    expect(r.halted).toBe(true);
  });

  it("rejects an unreconciled account", () => {
    const r = evaluateRiskOrder(makeRequest({ reconciliation: "unreconciled" }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("account_unreconciled");
  });

  it("accepts a reconciled account", () => {
    const r = evaluateRiskOrder(makeRequest(), makeLimits());
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateRiskOrder — API and WebSocket health (fail closed)", () => {
  it("rejects unknown API health", () => {
    const r = evaluateRiskOrder(makeRequest({ apiHealth: undefined }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("api_health_unknown");
  });

  it("rejects degraded and unhealthy API", () => {
    for (const state of ["degraded", "unhealthy"] as const) {
      const r = evaluateRiskOrder(makeRequest({ apiHealth: state }), makeLimits());
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe(`api_health_${state}`);
    }
  });

  it("rejects unknown WS health", () => {
    const r = evaluateRiskOrder(makeRequest({ wsHealth: undefined }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("ws_health_unknown");
  });

  it("rejects degraded and unhealthy WS", () => {
    for (const state of ["degraded", "unhealthy"] as const) {
      const r = evaluateRiskOrder(makeRequest({ wsHealth: state }), makeLimits());
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe(`ws_health_${state}`);
    }
  });
});

describe("evaluateRiskOrder — data freshness", () => {
  it("rejects market data older than the limit", () => {
    const r = evaluateRiskOrder(makeRequest({ marketDataAgeMs: 5_001 }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("stale_market_data");
  });

  it("accepts market data exactly at the limit (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ marketDataAgeMs: 5_000 }), makeLimits());
    expect(r.allowed).toBe(true);
  });

  it("rejects underlying data older than the limit", () => {
    const r = evaluateRiskOrder(makeRequest({ underlyingDataAgeMs: 5_001 }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("stale_underlying_data");
  });

  it("accepts underlying data exactly at the limit (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ underlyingDataAgeMs: 5_000 }), makeLimits());
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateRiskOrder — loss limits", () => {
  it("rejects when the daily loss reaches the cutoff", () => {
    const r = evaluateRiskOrder(makeRequest({ dailyLossUsdc: d("20") }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_daily_loss");
  });

  it("rejects when the daily loss exceeds the cutoff", () => {
    const r = evaluateRiskOrder(makeRequest({ dailyLossUsdc: d("20.01") }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_daily_loss");
  });

  it("accepts a daily loss just below the cutoff", () => {
    const r = evaluateRiskOrder(makeRequest({ dailyLossUsdc: d("19.99") }), makeLimits());
    expect(r.allowed).toBe(true);
  });

  it("rejects when the market loss reaches its cutoff", () => {
    const r = evaluateRiskOrder(makeRequest({ marketLossUsdc: d("10") }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_market_loss");
  });
});

describe("evaluateRiskOrder — capital limits", () => {
  it("rejects when the projected total capital would exceed the limit", () => {
    // deployed 96 + notional 5 = 101 > 100
    const r = evaluateRiskOrder(makeRequest({ totalCapitalDeployed: d("96") }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_total_capital");
  });

  it("accepts when the projected total lands exactly on the limit (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ totalCapitalDeployed: d("95") }), makeLimits());
    expect(r.allowed).toBe(true);
  });

  it("rejects when the projected market capital would exceed the limit", () => {
    // deployed 21 + notional 5 = 26 > 25
    const r = evaluateRiskOrder(makeRequest({ marketCapitalDeployed: d("21") }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_market_capital");
  });

  it("accepts when the projected market lands exactly on the limit (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ marketCapitalDeployed: d("20") }), makeLimits());
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateRiskOrder — order size and count", () => {
  it("rejects an order larger than maxOrderSize", () => {
    // Price small enough that the notional stays inside the capital checks,
    // isolating the order-size rule.
    const r = evaluateRiskOrder(
      makeRequest({ qty: d("50.00000001"), price: d("0.10") }),
      makeLimits(),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_order_size");
  });

  it("accepts an order exactly at maxOrderSize (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ qty: d("50"), price: d("0.50") }), makeLimits());
    expect(r.allowed).toBe(true);
  });

  it("rejects when the new order would exceed maxOpenOrders", () => {
    const r = evaluateRiskOrder(makeRequest({ openOrderCount: 3 }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_open_orders");
  });

  it("accepts when the new order fills the last open slot exactly", () => {
    const r = evaluateRiskOrder(makeRequest({ openOrderCount: 2 }), makeLimits());
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateRiskOrder — directional exposure", () => {
  it("rejects exposure above the positive cap", () => {
    const r = evaluateRiskOrder(
      makeRequest({ directionalExposureAfter: d("40.00000001") }),
      makeLimits(),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_directional_exposure");
  });

  it("rejects exposure below the negative cap (short side)", () => {
    const r = evaluateRiskOrder(
      makeRequest({ directionalExposureAfter: d("-40.00000001") }),
      makeLimits(),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_directional_exposure");
  });

  it("accepts exposure exactly at either cap (boundary)", () => {
    const up = evaluateRiskOrder(makeRequest({ directionalExposureAfter: d("40") }), makeLimits());
    const down = evaluateRiskOrder(
      makeRequest({ directionalExposureAfter: d("-40") }),
      makeLimits(),
    );
    expect(up.allowed).toBe(true);
    expect(down.allowed).toBe(true);
  });
});

describe("evaluateRiskOrder — residual and orphan inventory", () => {
  it("rejects residual shares above the limit", () => {
    const r = evaluateRiskOrder(makeRequest({ residualShares: d("10.00000001") }), makeLimits());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_residual_inventory");
  });

  it("accepts residual exactly at the limit (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ residualShares: d("10") }), makeLimits());
    expect(r.allowed).toBe(true);
  });

  it("rejects orphan inventory above the USDC limit", () => {
    const r = evaluateRiskOrder(
      makeRequest({ orphanInventoryUsdc: d("5.00000001") }),
      makeLimits(),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("max_orphan_inventory");
  });

  it("accepts orphan inventory exactly at the limit (boundary)", () => {
    const r = evaluateRiskOrder(makeRequest({ orphanInventoryUsdc: d("5") }), makeLimits());
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateRiskOrder — canonical precedence", () => {
  it("market expiration wins over everything", () => {
    const r = evaluateRiskOrder(
      makeRequest({
        marketExpired: true,
        reconciliation: undefined,
        apiHealth: "unhealthy",
        wsHealth: "unhealthy",
        dailyLossUsdc: d("999"),
        qty: d("999"),
      }),
      makeLimits(),
    );
    expect(r.reason).toBe("market_expired");
  });

  it("reconciliation unknown wins over health unknown and losses", () => {
    const r = evaluateRiskOrder(
      makeRequest({ reconciliation: undefined, apiHealth: undefined, dailyLossUsdc: d("999") }),
      makeLimits(),
    );
    expect(r.reason).toBe("reconciliation_unknown");
  });

  it("api health unknown wins over ws health unknown", () => {
    const r = evaluateRiskOrder(
      makeRequest({ apiHealth: undefined, wsHealth: undefined }),
      makeLimits(),
    );
    expect(r.reason).toBe("api_health_unknown");
  });

  it("ws health unknown wins over stale data", () => {
    const r = evaluateRiskOrder(
      makeRequest({ wsHealth: undefined, marketDataAgeMs: 99_999, underlyingDataAgeMs: 99_999 }),
      makeLimits(),
    );
    expect(r.reason).toBe("ws_health_unknown");
  });

  it("stale market data wins over stale underlying data", () => {
    const r = evaluateRiskOrder(
      makeRequest({ marketDataAgeMs: 99_999, underlyingDataAgeMs: 99_999 }),
      makeLimits(),
    );
    expect(r.reason).toBe("stale_market_data");
  });

  it("daily loss wins over market loss and capital limits", () => {
    const r = evaluateRiskOrder(
      makeRequest({ dailyLossUsdc: d("20"), marketLossUsdc: d("10"), qty: d("999") }),
      makeLimits(),
    );
    expect(r.reason).toBe("max_daily_loss");
  });

  it("total capital wins over market capital and order size", () => {
    const r = evaluateRiskOrder(
      makeRequest({ totalCapitalDeployed: d("96"), marketCapitalDeployed: d("21"), qty: d("999") }),
      makeLimits(),
    );
    expect(r.reason).toBe("max_total_capital");
  });

  it("market capital wins over order size", () => {
    // Notional 5.10 fits the total-capital projection (90 + 5.10 <= 100) and
    // breaches the market projection (21 + 5.10 > 25); qty 51 also breaches
    // maxOrderSize, but market capital is checked first.
    const r = evaluateRiskOrder(
      makeRequest({
        totalCapitalDeployed: d("90"),
        marketCapitalDeployed: d("21"),
        qty: d("51"),
        price: d("0.10"),
      }),
      makeLimits(),
    );
    expect(r.reason).toBe("max_market_capital");
  });
});

describe("evaluateRiskOrder — halted semantics", () => {
  it("environmental failures halt all new orders", () => {
    for (const req of [
      makeRequest({ marketExpired: true }),
      makeRequest({ reconciliation: undefined }),
      makeRequest({ apiHealth: "unhealthy" }),
      makeRequest({ marketDataAgeMs: 99_999 }),
      makeRequest({ dailyLossUsdc: d("20") }),
      makeRequest({ marketLossUsdc: d("10") }),
    ]) {
      const r = evaluateRiskOrder(req, makeLimits());
      expect(r.halted).toBe(true);
      expect(r.allowed).toBe(false);
    }
  });

  it("limit breaches do not halt the engine (single-order vetoes)", () => {
    for (const req of [
      makeRequest({ totalCapitalDeployed: d("96") }),
      makeRequest({ marketCapitalDeployed: d("21") }),
      makeRequest({ qty: d("51") }),
      makeRequest({ openOrderCount: 3 }),
      makeRequest({ directionalExposureAfter: d("41") }),
      makeRequest({ residualShares: d("11") }),
      makeRequest({ orphanInventoryUsdc: d("6") }),
    ]) {
      const r = evaluateRiskOrder(req, makeLimits());
      expect(r.allowed).toBe(false);
      expect(r.halted).toBe(false);
    }
  });
});

describe("evaluateRiskOrder — validation (fail closed on bad data)", () => {
  it("rejects non-positive qty and price", () => {
    expect(() => evaluateRiskOrder(makeRequest({ qty: d("0") }), makeLimits())).toThrow(
      ValidationError,
    );
    expect(() => evaluateRiskOrder(makeRequest({ price: d("-0.5") }), makeLimits())).toThrow(
      ValidationError,
    );
  });

  it("rejects negative observations", () => {
    expect(() =>
      evaluateRiskOrder(makeRequest({ totalCapitalDeployed: d("-1") }), makeLimits()),
    ).toThrow(ValidationError);
    expect(() => evaluateRiskOrder(makeRequest({ dailyLossUsdc: d("-1") }), makeLimits())).toThrow(
      ValidationError,
    );
    expect(() =>
      evaluateRiskOrder(makeRequest({ residualShares: d("-0.1") }), makeLimits()),
    ).toThrow(ValidationError);
    expect(() =>
      evaluateRiskOrder(makeRequest({ orphanInventoryUsdc: d("-1") }), makeLimits()),
    ).toThrow(ValidationError);
    expect(() => evaluateRiskOrder(makeRequest({ marketDataAgeMs: -1 }), makeLimits())).toThrow(
      ValidationError,
    );
    expect(() => evaluateRiskOrder(makeRequest({ openOrderCount: -1 }), makeLimits())).toThrow(
      ValidationError,
    );
  });

  it("rejects malformed identity and enums", () => {
    expect(() => evaluateRiskOrder(makeRequest({ marketId: "" }), makeLimits())).toThrow(
      ValidationError,
    );
    expect(() => evaluateRiskOrder(makeRequest({ tokenId: "  " }), makeLimits())).toThrow(
      ValidationError,
    );
    expect(() =>
      evaluateRiskOrder(makeRequest({ outcome: "sideways" as never }), makeLimits()),
    ).toThrow(ValidationError);
    expect(() => evaluateRiskOrder(makeRequest({ side: "hold" as never }), makeLimits())).toThrow(
      ValidationError,
    );
    expect(() =>
      evaluateRiskOrder(makeRequest({ reconciliation: "meh" as never }), makeLimits()),
    ).toThrow(ValidationError);
    expect(() =>
      evaluateRiskOrder(makeRequest({ apiHealth: "flaky" as never }), makeLimits()),
    ).toThrow(ValidationError);
  });

  it("validateRiskOrderRequest throws on the same cases directly", () => {
    expect(() => validateRiskOrderRequest(makeRequest({ qty: d("0") }))).toThrow(ValidationError);
    expect(() => validateRiskOrderRequest(makeRequest())).not.toThrow();
  });
});

describe("evaluateRiskOrder — determinism and purity", () => {
  it("is deterministic: identical inputs produce identical evaluations", () => {
    const req = makeRequest();
    const limits = makeLimits();
    expect(evaluateRiskOrder(req, limits)).toEqual(evaluateRiskOrder(req, limits));
  });

  it("does not mutate the request or limits", () => {
    const req = makeRequest();
    const limits = makeLimits();
    const reqSnapshot = { ...req };
    const limitsSnapshot = { ...limits };
    evaluateRiskOrder(req, limits);
    expect({ ...req }).toEqual(reqSnapshot);
    expect({ ...limits }).toEqual(limitsSnapshot);
  });

  it("produces a decision, not an order: no submission fields exist", () => {
    const r = evaluateRiskOrder(makeRequest(), makeLimits());
    expect(Object.keys(r).sort()).toEqual(
      ["allowed", "exposure", "halted", "limits", "reason"].sort(),
    );
  });
});
