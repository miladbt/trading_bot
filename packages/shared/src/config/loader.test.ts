import { describe, expect, it } from "vitest";

import { decCompare, decEquals, decFromString, decToString } from "@bot/domain";

import { ConfigError, loadBotConfig, loadConfig, toLogSafeConfig } from "./loader.js";
import {
  DEFAULT_ASSETS,
  DEFAULT_EXECUTION,
  DEFAULT_HEDGE,
  DEFAULT_MARKET,
  DEFAULT_RISK,
  DEFAULT_STRATEGY,
  DEFAULT_TRADING,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full valid environment; tests mutate from this baseline. */
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    TRADING_MODE: "paper",
    LIVE_TRADING_ENABLED: "false",
    ASSETS: "BTC,ETH",
    MARKET_CYCLE_MS: "300000",
    MARKET_LIVE_OFFSET_MS: "240000",
    MARKET_SETTLE_OFFSET_MS: "300000",
    MARKET_SETTLE_GRACE_MS: "15000",
    MARKET_PHASE_MID: "0.5",
    MARKET_PHASE_LATE: "0.75",
    MARKET_PHASE_FINAL: "0.9",
    MARKET_DATA_POLL_INTERVAL_MS: "1000",
    STRATEGY_MIN_CS_GROSS_EDGE: "0.01",
    STRATEGY_MIN_CS_NET_EDGE: "0.005",
    STRATEGY_MAX_RESIDUAL: "0.002",
    STRATEGY_QUOTE_SIZE: "25",
    STRATEGY_MAX_ORDER_SIZE: "50",
    STRATEGY_MIN_QUOTE_LIFETIME_MS: "2000",
    STRATEGY_MIN_REPRICE_INTERVAL_MS: "1000",
    RISK_MAX_TOTAL_CAPITAL: "100",
    RISK_MAX_MARKET_CAPITAL: "25",
    RISK_MAX_DIRECTIONAL_EXPOSURE: "50",
    RISK_MAX_ORPHAN_INVENTORY: "10",
    RISK_MAX_DAILY_LOSS: "50",
    RISK_MAX_OPEN_ORDERS: "8",
    RISK_MAX_DATA_AGE_MS: "5000",
    EXECUTION_POST_ONLY: "true",
    EXECUTION_MAX_RETRIES: "3",
    EXECUTION_MAX_RECONNECTS: "5",
    EXECUTION_FILL_MODEL: "optimistic",
    EXECUTION_TRADE_THROUGH: "0.001",
    EXECUTION_QUEUE_POSITION_FACTOR: "0.5",
    EXECUTION_ADVERSE_MOVE_THRESHOLD: "0.01",
    ENABLE_EXTERNAL_HEDGE: "false",
    API_PORT: "3001",
    DATABASE_URL: "postgres://localhost:5432/polymarket_bot",
  };
}

describe("safe defaults", () => {
  it("produces a fully valid config from an empty environment", () => {
    const cfg = loadConfig({});
    expect(cfg.trading).toEqual(DEFAULT_TRADING);
    expect(cfg.assets).toEqual(DEFAULT_ASSETS);
    expect(cfg.market).toEqual(DEFAULT_MARKET);
    expect(cfg.strategy).toEqual(DEFAULT_STRATEGY);
    expect(cfg.risk).toEqual(DEFAULT_RISK);
    expect(cfg.execution).toEqual(DEFAULT_EXECUTION);
    expect(cfg.hedge).toEqual(DEFAULT_HEDGE);
    expect(cfg.runtime).toEqual({ env: "development", logLevel: "info" });
    expect(cfg.services.apiPort).toBe(3001);
  });

  it("defaults are safe: paper mode, live disabled, hedge disabled", () => {
    const cfg = loadConfig({});
    expect(cfg.trading.mode).toBe("paper");
    expect(cfg.trading.liveTradingEnabled).toBe(false);
    expect(cfg.hedge.externalHedgeEnabled).toBe(false);
  });

  it("defaults keep Decimal values exact", () => {
    const cfg = loadConfig({});
    expect(decEquals(cfg.strategy.minCompleteSetGrossEdge, decFromString("0.01"))).toBe(true);
    expect(decEquals(cfg.strategy.quoteSize, decFromString("25"))).toBe(true);
    expect(decEquals(cfg.risk.maxTotalCapital, decFromString("100"))).toBe(true);
    // hierarchy holds on defaults
    expect(decCompare(cfg.risk.maxMarketCapital, cfg.risk.maxTotalCapital)).toBeLessThanOrEqual(0);
  });

  it("defaults are internally consistent with a full valid env", () => {
    // explicit env with every value equal to the documented defaults loads fine
    expect(() => loadConfig(validEnv())).not.toThrow();
  });
});

describe("missing variables", () => {
  it("empty env is fine — everything has a default", () => {
    expect(() => loadConfig({})).not.toThrow();
  });

  it("an explicitly empty required-style string is rejected (assets)", () => {
    expect(() => loadConfig({ ASSETS: "  " })).toThrow(ConfigError);
    expect(() => loadConfig({ ASSETS: "," })).toThrow(ConfigError);
  });

  it("partial Decimal failure still reports the exact field", () => {
    expect(() => loadConfig({ STRATEGY_QUOTE_SIZE: "" })).toThrow(/strategy\.STRATEGY_QUOTE_SIZE/);
  });
});

describe("invalid values", () => {
  it("rejects non-numeric values in numeric fields", () => {
    expect(() => loadConfig({ MARKET_CYCLE_MS: "five" })).toThrow(ConfigError);
    expect(() => loadConfig({ RISK_MAX_OPEN_ORDERS: "2.5" })).toThrow(ConfigError);
    expect(() => loadConfig({ API_PORT: "99999" })).toThrow(ConfigError);
  });

  it("rejects zero/negative values in positive fields", () => {
    expect(() => loadConfig({ MARKET_CYCLE_MS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ RISK_MAX_DATA_AGE_MS: "-1" })).toThrow(ConfigError);
  });

  it("rejects malformed Decimal strings", () => {
    expect(() => loadConfig({ STRATEGY_QUOTE_SIZE: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ RISK_MAX_TOTAL_CAPITAL: "1.2.3" })).toThrow(ConfigError);
    expect(() => loadConfig({ STRATEGY_MAX_ORDER_SIZE: "1e" })).toThrow(ConfigError);
  });

  it("rejects unknown enum values", () => {
    expect(() => loadConfig({ TRADING_MODE: "aggressive" })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: "loud" })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  it("rejects malformed booleans instead of coercing", () => {
    expect(() => loadConfig({ LIVE_TRADING_ENABLED: "ture" })).toThrow(ConfigError);
    expect(() => loadConfig({ LIVE_TRADING_ENABLED: "1" })).toThrow(ConfigError);
    expect(() => loadConfig({ EXECUTION_POST_ONLY: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ ENABLE_EXTERNAL_HEDGE: "0" })).toThrow(ConfigError);
  });

  it("rejects unknown assets and duplicates", () => {
    expect(() => loadConfig({ ASSETS: "SOL" })).toThrow(ConfigError);
    expect(() => loadConfig({ ASSETS: "BTC,BTC" })).toThrow(ConfigError);
  });

  it("collects multiple violations into one error", () => {
    try {
      loadConfig({ MARKET_CYCLE_MS: "0", RISK_MAX_OPEN_ORDERS: "-2" });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain("MARKET_CYCLE_MS");
      expect(msg).toContain("RISK_MAX_OPEN_ORDERS");
    }
  });

  it("rejects non-monotonic or out-of-range phase fractions", () => {
    expect(() => loadConfig({ MARKET_PHASE_MID: "0.8", MARKET_PHASE_LATE: "0.75" })).toThrow(
      /MARKET_PHASE_MID < MARKET_PHASE_LATE/,
    );
    expect(() => loadConfig({ MARKET_PHASE_FINAL: "1.5" })).toThrow(ConfigError);
    expect(() => loadConfig({ MARKET_PHASE_MID: "0" })).toThrow(ConfigError);
  });

  it("enforces cross-group invariants", () => {
    expect(() =>
      loadConfig({ STRATEGY_MIN_CS_NET_EDGE: "0.02", STRATEGY_MIN_CS_GROSS_EDGE: "0.01" }),
    ).toThrow(/minCompleteSetNetEdge/);
    expect(() => loadConfig({ STRATEGY_QUOTE_SIZE: "10", STRATEGY_MAX_ORDER_SIZE: "5" })).toThrow(
      /quoteSize/,
    );
    expect(() => loadConfig({ RISK_MAX_MARKET_CAPITAL: "200" })).toThrow(/maxMarketCapital/);
    expect(() => loadConfig({ RISK_MAX_DAILY_LOSS: "500" })).toThrow(/maxDailyLoss/);
    expect(() => loadConfig({ MARKET_LIVE_OFFSET_MS: "310000" })).toThrow(
      /MARKET_SETTLE_OFFSET_MS/,
    );
  });
});

describe("live-trading guard", () => {
  it("paper mode with live disabled is the only no-credential combination that starts", () => {
    const { config, credentials } = loadBotConfig(validEnv());
    expect(config.trading.mode).toBe("paper");
    expect(config.trading.liveTradingEnabled).toBe(false);
    expect(credentials.polymarketComplete).toBe(false);
  });

  it("rejects LIVE_TRADING_ENABLED=true without TRADING_MODE=live", () => {
    expect(() => loadConfig({ LIVE_TRADING_ENABLED: "true", TRADING_MODE: "paper" })).toThrow(
      /LIVE_TRADING_ENABLED=true requires TRADING_MODE=live/,
    );
  });

  it("rejects TRADING_MODE=live without LIVE_TRADING_ENABLED=true", () => {
    expect(() => loadConfig({ TRADING_MODE: "live", LIVE_TRADING_ENABLED: "false" })).toThrow(
      /TRADING_MODE=live requires LIVE_TRADING_ENABLED=true/,
    );
  });

  it("rejects live mode without complete credentials", () => {
    expect(() =>
      loadConfig({
        TRADING_MODE: "live",
        LIVE_TRADING_ENABLED: "true",
        POLYMARKET_API_KEY: "k",
        POLYMARKET_API_SECRET: "s",
        // missing passphrase + wallet key
      }),
    ).toThrow(/complete Polymarket credentials/);
  });

  it("rejects live mode with only some credentials present", () => {
    expect(() =>
      loadConfig({
        TRADING_MODE: "live",
        LIVE_TRADING_ENABLED: "true",
        POLYMARKET_API_KEY: "k",
        POLYMARKET_API_SECRET: "s",
        POLYMARKET_API_PASSPHRASE: "p",
        // wallet key missing
      }),
    ).toThrow(ConfigError);
  });

  it("never enables live trading by default", () => {
    const cfg = loadConfig({});
    expect(cfg.trading.liveTradingEnabled).toBe(false);
    expect(cfg.trading.mode).toBe("paper");
  });

  it("reports credential presence without exposing values", () => {
    const { credentials } = loadBotConfig({
      POLYMARKET_API_KEY: "super-secret-key",
      POLYMARKET_API_SECRET: "super-secret-secret",
      POLYMARKET_API_PASSPHRASE: "super-secret-pass",
      POLYMARKET_WALLET_PRIVATE_KEY: "0xdeadbeef",
    });
    expect(credentials.polymarketComplete).toBe(true);
    // The credentials object carries only the boolean.
    expect(Object.keys(credentials)).toEqual(["polymarketComplete"]);
  });
});

describe("sizing + fees config (T1/T3)", () => {
  it("defaults to the legacy directional model and the verified fee schedule", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.strategy.sizingModel).toBe("directional");
    expect(decToString(cfg.strategy.kellyFraction)).toBe("0.25000000");
    expect(decToString(cfg.strategy.minEdge)).toBe("0.01000000");
    expect(decToString(cfg.fees.takerRate)).toBe("0.07000000");
    expect(cfg.fees.takerOnly).toBe(true);
    expect(decToString(cfg.fees.rebateRate)).toBe("0.20000000");
    // T2: no calibration file by default -> raw prior stays in effect.
    expect(cfg.strategy.calibrationFile).toBe("");
  });

  it("accepts a calibration file path and trims surrounding whitespace", () => {
    const cfg = loadConfig({
      ...validEnv(),
      CALIBRATION_FILE: " calibration/btc-5m-v1.json ",
    });
    expect(cfg.strategy.calibrationFile).toBe("calibration/btc-5m-v1.json");
  });

  it("accepts the edge model with an explicit fraction and min edge", () => {
    const cfg = loadConfig({
      ...validEnv(),
      STRATEGY_SIZING_MODEL: "edge",
      STRATEGY_KELLY_FRACTION: "0.4",
      STRATEGY_MIN_EDGE: "0.02",
    });
    expect(cfg.strategy.sizingModel).toBe("edge");
    expect(decToString(cfg.strategy.kellyFraction)).toBe("0.40000000");
    expect(decToString(cfg.strategy.minEdge)).toBe("0.02000000");
  });

  it("accepts the pessimistic fill model with explicit T4 parameters", () => {
    const cfg = loadConfig({
      ...validEnv(),
      EXECUTION_FILL_MODEL: "pessimistic",
      EXECUTION_TRADE_THROUGH: "0.002",
      EXECUTION_QUEUE_POSITION_FACTOR: "0.3",
      EXECUTION_ADVERSE_MOVE_THRESHOLD: "0.02",
    });
    expect(cfg.execution.fillModel).toBe("pessimistic");
    expect(decToString(cfg.execution.tradeThrough)).toBe("0.00200000");
    expect(decToString(cfg.execution.queuePositionFactor)).toBe("0.30000000");
    expect(decToString(cfg.execution.adverseMoveThreshold)).toBe("0.02000000");
  });

  it("rejects out-of-range T4 fill parameters", () => {
    expect(() => loadConfig({ ...validEnv(), EXECUTION_QUEUE_POSITION_FACTOR: "0" })).toThrow(
      /queuePositionFactor/,
    );
    expect(() => loadConfig({ ...validEnv(), EXECUTION_QUEUE_POSITION_FACTOR: "1.5" })).toThrow(
      /queuePositionFactor/,
    );
    expect(() => loadConfig({ ...validEnv(), EXECUTION_TRADE_THROUGH: "1" })).toThrow(
      /tradeThrough/,
    );
    expect(() => loadConfig({ ...validEnv(), EXECUTION_ADVERSE_MOVE_THRESHOLD: "-0.01" })).toThrow(
      /adverseMoveThreshold/,
    );
  });

  it("resolves phase-multiplier presets (T7)", () => {
    const canonical = loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "canonical" });
    expect(decToString(canonical.strategy.phaseMultipliers.early)).toBe("1.00000000");
    expect(decToString(canonical.strategy.phaseMultipliers.mid)).toBe("0.75000000");
    expect(decToString(canonical.strategy.phaseMultipliers.late)).toBe("0.50000000");
    expect(decToString(canonical.strategy.phaseMultipliers.final)).toBe("0.25000000");

    const flat = loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "flat" });
    expect(decToString(flat.strategy.phaseMultipliers.final)).toBe("1.00000000");

    const reversed = loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "reversed" });
    expect(decToString(reversed.strategy.phaseMultipliers.early)).toBe("0.25000000");
    expect(decToString(reversed.strategy.phaseMultipliers.final)).toBe("1.00000000");

    const explicit = loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "1,0.9,0.6,0.3" });
    expect(decToString(explicit.strategy.phaseMultipliers.mid)).toBe("0.90000000");
    expect(decToString(explicit.strategy.phaseMultipliers.final)).toBe("0.30000000");
  });

  it("rejects bad phase-multiplier specs", () => {
    expect(() => loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "1,0.5,0.25" })).toThrow(
      /PHASE_MULTIPLIERS/,
    );
    expect(() =>
      loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "1,0.5,1.5,0.25" }),
    ).toThrow(/must be in \[0, 1\]/);
    expect(() => loadConfig({ ...validEnv(), STRATEGY_PHASE_MULTIPLIERS: "1,0.5,x,0.25" })).toThrow(
      /phase multiplier/,
    );
  });

  it("rejects out-of-range kelly fraction, min edge, and fee rate", () => {
    expect(() => loadConfig({ ...validEnv(), STRATEGY_KELLY_FRACTION: "0" })).toThrow(
      /kellyFraction/,
    );
    expect(() => loadConfig({ ...validEnv(), STRATEGY_KELLY_FRACTION: "1.5" })).toThrow(
      /kellyFraction/,
    );
    expect(() => loadConfig({ ...validEnv(), STRATEGY_MIN_EDGE: "-0.01" })).toThrow(/minEdge/);
    expect(() => loadConfig({ ...validEnv(), FEE_TAKER_RATE: "1" })).toThrow(/takerRate/);
    expect(() => loadConfig({ ...validEnv(), FEE_TAKER_RATE: "-0.1" })).toThrow(/takerRate/);
    expect(() => loadConfig({ ...validEnv(), FEE_REBATE_RATE: "1.2" })).toThrow(/rebateRate/);
  });

  it("exposes the fee schedule through the log-safe projection (no secrets)", () => {
    const serialized = JSON.stringify(toLogSafeConfig(loadConfig(validEnv())));
    expect(serialized).toContain("takerRate");
  });
});

describe("hedge guard", () => {
  it("rejects ENABLE_EXTERNAL_HEDGE=true (not implemented)", () => {
    expect(() => loadConfig({ ENABLE_EXTERNAL_HEDGE: "true" })).toThrow(
      /ENABLE_EXTERNAL_HEDGE=true is not supported/,
    );
  });
});

describe("secret hygiene", () => {
  it("log-safe projection excludes the database URL", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://user:pw@host/db" });
    const safe = toLogSafeConfig(cfg);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("pw@host");
    expect("services" in safe).toBe(false);
  });

  it("config never contains credential values even when they are set", () => {
    const env = {
      ...validEnv(),
      POLYMARKET_API_KEY: "k",
      POLYMARKET_API_SECRET: "s",
      POLYMARKET_API_PASSPHRASE: "p",
      POLYMARKET_WALLET_PRIVATE_KEY: "w",
      TRADING_MODE: "live",
      LIVE_TRADING_ENABLED: "true",
    };
    const { config, credentials } = loadBotConfig(env);
    expect(credentials.polymarketComplete).toBe(true);
    // The log-safe projection is what reaches log lines; it must serialize
    // cleanly and contain no credential-shaped keys.
    const serialized = JSON.stringify(toLogSafeConfig(config));
    expect(serialized).not.toContain("POLYMARKET");
    expect(serialized).not.toContain("credentials");
    const parsed: unknown = JSON.parse(serialized);
    expect(parsed).not.toHaveProperty("credentials");
  });
});
