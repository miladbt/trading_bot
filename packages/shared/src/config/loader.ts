/**
 * Configuration loader: parse -> validate -> reject or return.
 *
 * Guarantees:
 * - All groups validate at startup; invalid config throws `ConfigError` with
 *   every violation listed (fail fast, no partial starts).
 * - Cross-group invariants are enforced (net edge <= gross edge, capital
 *   hierarchy, 5-minute cycle sanity).
 * - The live-trading guard: live mode requires LIVE_TRADING_ENABLED=true AND
 *   complete credentials AND explicit mode; anything else stays paper.
 *   LIVE_TRADING_ENABLED=true without mode=live is rejected outright.
 * - Secrets never enter the parsed result; only a presence flag does.
 * - `toLogSafeConfig` strips the database URL before anything is logged.
 */

import { decFromString, decCompare, type Decimal } from "@bot/domain";
import type { z } from "zod";

import {
  credentialsSchema,
  executionSchema,
  assetsSchema,
  hedgeSchema,
  marketSchema,
  riskSchema,
  runtimeSchema,
  servicesSchema,
  strategySchema,
  tradingSchema,
  type EnvInput,
} from "./schema.js";
import type {
  AppConfig,
  AssetsConfig,
  CredentialsStatus,
  ExecutionConfig,
  HedgeConfig,
  MarketConfig,
  RiskConfig,
  StrategyConfig,
  TradingConfig,
} from "./types.js";
import {
  DEFAULT_ASSETS,
  DEFAULT_EXECUTION,
  DEFAULT_HEDGE,
  DEFAULT_MARKET,
  DEFAULT_RISK,
  DEFAULT_STRATEGY,
  DEFAULT_TRADING,
  toLogSafeConfig,
  type LogSafeConfig,
  type RuntimeConfig,
  type ServicesConfig,
} from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse one group; collect all failures instead of failing on the first. */
function parseGroup<S extends z.ZodTypeAny>(
  name: string,
  schema: S,
  env: EnvInput,
  failures: string[],
): z.infer<S> | undefined {
  const result = schema.safeParse(env);
  if (!result.success) {
    for (const issue of result.error.issues) {
      failures.push(`${name}.${issue.path.join(".")}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

function parseDecimal(
  group: string,
  field: string,
  raw: string | undefined,
  failures: string[],
): Decimal | undefined {
  if (raw === undefined) {
    failures.push(`${group}.${field}: missing`);
    return undefined;
  }
  try {
    return decFromString(raw);
  } catch (e: unknown) {
    failures.push(`${group}.${field}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export interface LoadedConfig {
  readonly config: AppConfig;
  readonly credentials: CredentialsStatus;
}

/**
 * Load and validate configuration from an environment-like record.
 * Throws `ConfigError` listing ALL violations; never returns partial config.
 */
export function loadBotConfig(source: EnvInput = process.env): LoadedConfig {
  const env: EnvInput = source;
  const failures: string[] = [];

  const trading = parseGroup("trading", tradingSchema, env, failures);
  const assets = parseGroup("assets", assetsSchema, env, failures);
  const market = parseGroup("market", marketSchema, env, failures);
  const strategy = parseGroup("strategy", strategySchema, env, failures);
  const risk = parseGroup("risk", riskSchema, env, failures);
  const execution = parseGroup("execution", executionSchema, env, failures);
  const hedge = parseGroup("hedge", hedgeSchema, env, failures);
  const runtime = parseGroup("runtime", runtimeSchema, env, failures);
  const services = parseGroup("services", servicesSchema, env, failures);
  const credentials = parseGroup("credentials", credentialsSchema, env, failures);

  if (
    trading === undefined ||
    assets === undefined ||
    market === undefined ||
    strategy === undefined ||
    risk === undefined ||
    execution === undefined ||
    hedge === undefined ||
    runtime === undefined ||
    services === undefined ||
    credentials === undefined
  ) {
    throw new ConfigError(
      failures.length > 0
        ? `invalid configuration: ${failures.join("; ")}`
        : "invalid configuration",
    );
  }

  // Decimal fields (strategy + risk), parsed with full domain precision.
  const minCsGrossEdge = parseDecimal(
    "strategy",
    "minCompleteSetGrossEdge",
    strategy.STRATEGY_MIN_CS_GROSS_EDGE,
    failures,
  );
  const minCsNetEdge = parseDecimal(
    "strategy",
    "minCompleteSetNetEdge",
    strategy.STRATEGY_MIN_CS_NET_EDGE,
    failures,
  );
  const maxResidual = parseDecimal(
    "strategy",
    "maxResidual",
    strategy.STRATEGY_MAX_RESIDUAL,
    failures,
  );
  const quoteSize = parseDecimal("strategy", "quoteSize", strategy.STRATEGY_QUOTE_SIZE, failures);
  const maxOrderSize = parseDecimal(
    "strategy",
    "maxOrderSize",
    strategy.STRATEGY_MAX_ORDER_SIZE,
    failures,
  );
  const maxTotalCapital = parseDecimal(
    "risk",
    "maxTotalCapital",
    risk.RISK_MAX_TOTAL_CAPITAL,
    failures,
  );
  const maxMarketCapital = parseDecimal(
    "risk",
    "maxMarketCapital",
    risk.RISK_MAX_MARKET_CAPITAL,
    failures,
  );
  const maxDirectionalExposure = parseDecimal(
    "risk",
    "maxDirectionalExposure",
    risk.RISK_MAX_DIRECTIONAL_EXPOSURE,
    failures,
  );
  const maxOrphanInventory = parseDecimal(
    "risk",
    "maxOrphanInventory",
    risk.RISK_MAX_ORPHAN_INVENTORY,
    failures,
  );
  const maxDailyLoss = parseDecimal("risk", "maxDailyLoss", risk.RISK_MAX_DAILY_LOSS, failures);

  if (failures.length > 0) {
    throw new ConfigError(`invalid configuration: ${failures.join("; ")}`);
  }

  // All Decimals are defined past this point; alias for non-null access.
  const money = {
    minCsGrossEdge: minCsGrossEdge as Decimal,
    minCsNetEdge: minCsNetEdge as Decimal,
    maxResidual: maxResidual as Decimal,
    quoteSize: quoteSize as Decimal,
    maxOrderSize: maxOrderSize as Decimal,
    maxTotalCapital: maxTotalCapital as Decimal,
    maxMarketCapital: maxMarketCapital as Decimal,
    maxDirectionalExposure: maxDirectionalExposure as Decimal,
    maxOrphanInventory: maxOrphanInventory as Decimal,
    maxDailyLoss: maxDailyLoss as Decimal,
  };

  // ---------------------------------------------------------------------
  // Cross-group invariants
  // ---------------------------------------------------------------------

  if (decCompare(money.minCsNetEdge, money.minCsGrossEdge) > 0) {
    failures.push("strategy: minCompleteSetNetEdge must be <= minCompleteSetGrossEdge");
  }
  if (decCompare(money.quoteSize, money.maxOrderSize) > 0) {
    failures.push("strategy: quoteSize must be <= maxOrderSize");
  }
  if (decCompare(money.maxMarketCapital, money.maxTotalCapital) > 0) {
    failures.push("risk: maxMarketCapital must be <= maxTotalCapital");
  }
  if (decCompare(money.maxOrphanInventory, money.maxMarketCapital) > 0) {
    failures.push("risk: maxOrphanInventory must be <= maxMarketCapital");
  }
  if (decCompare(money.maxDailyLoss, money.maxTotalCapital) > 0) {
    failures.push("risk: maxDailyLoss must be <= maxTotalCapital");
  }
  if (market.MARKET_SETTLE_OFFSET_MS < market.MARKET_LIVE_OFFSET_MS) {
    failures.push("market: MARKET_SETTLE_OFFSET_MS must be >= MARKET_LIVE_OFFSET_MS");
  }
  const {
    MARKET_PHASE_MID: phMid,
    MARKET_PHASE_LATE: phLate,
    MARKET_PHASE_FINAL: phFinal,
  } = market;
  if (!(phMid < phLate && phLate < phFinal)) {
    failures.push("market: MARKET_PHASE_MID < MARKET_PHASE_LATE < MARKET_PHASE_FINAL must hold");
  }

  // ---------------------------------------------------------------------
  // Live-trading guard
  // ---------------------------------------------------------------------

  const polymarketComplete =
    credentials.POLYMARKET_API_KEY &&
    credentials.POLYMARKET_API_SECRET &&
    credentials.POLYMARKET_API_PASSPHRASE &&
    credentials.POLYMARKET_WALLET_PRIVATE_KEY;

  if (trading.LIVE_TRADING_ENABLED && trading.TRADING_MODE !== "live") {
    throw new ConfigError(
      "LIVE_TRADING_ENABLED=true requires TRADING_MODE=live; refusing to start",
    );
  }
  if (trading.TRADING_MODE === "live" && !trading.LIVE_TRADING_ENABLED) {
    throw new ConfigError(
      "TRADING_MODE=live requires LIVE_TRADING_ENABLED=true; refusing to start",
    );
  }
  if (trading.TRADING_MODE === "live" && !polymarketComplete) {
    throw new ConfigError(
      "TRADING_MODE=live requires complete Polymarket credentials; refusing to start",
    );
  }
  if (hedge.ENABLE_EXTERNAL_HEDGE) {
    // No hedge implementation exists yet; enabling it is always a mistake.
    throw new ConfigError("ENABLE_EXTERNAL_HEDGE=true is not supported yet; refusing to start");
  }

  if (failures.length > 0) {
    throw new ConfigError(`invalid configuration: ${failures.join("; ")}`);
  }

  const tradingConfig: TradingConfig = {
    mode: trading.TRADING_MODE,
    liveTradingEnabled: trading.LIVE_TRADING_ENABLED,
  };
  const assetsConfig: AssetsConfig = { enabled: assets.ASSETS };
  const marketConfig: MarketConfig = {
    cycleMs: market.MARKET_CYCLE_MS,
    phases: {
      liveOffsetMs: market.MARKET_LIVE_OFFSET_MS,
      settleOffsetMs: market.MARKET_SETTLE_OFFSET_MS,
      settleGraceMs: market.MARKET_SETTLE_GRACE_MS,
    },
    phaseFractions: {
      mid: market.MARKET_PHASE_MID,
      late: market.MARKET_PHASE_LATE,
      final: market.MARKET_PHASE_FINAL,
    },
    pollIntervalMs: market.MARKET_DATA_POLL_INTERVAL_MS,
  };
  const strategyConfig: StrategyConfig = {
    minCompleteSetGrossEdge: money.minCsGrossEdge,
    minCompleteSetNetEdge: money.minCsNetEdge,
    maxResidual: money.maxResidual,
    quoteSize: money.quoteSize,
    maxOrderSize: money.maxOrderSize,
    minQuoteLifetimeMs: strategy.STRATEGY_MIN_QUOTE_LIFETIME_MS,
    minRepriceIntervalMs: strategy.STRATEGY_MIN_REPRICE_INTERVAL_MS,
  };
  const riskConfig: RiskConfig = {
    maxTotalCapital: money.maxTotalCapital,
    maxMarketCapital: money.maxMarketCapital,
    maxDirectionalExposure: money.maxDirectionalExposure,
    maxOrphanInventory: money.maxOrphanInventory,
    maxDailyLoss: money.maxDailyLoss,
    maxOpenOrders: risk.RISK_MAX_OPEN_ORDERS,
    maxDataAgeMs: risk.RISK_MAX_DATA_AGE_MS,
  };
  const executionConfig: ExecutionConfig = {
    postOnly: execution.EXECUTION_POST_ONLY,
    maxRetries: execution.EXECUTION_MAX_RETRIES,
    maxReconnects: execution.EXECUTION_MAX_RECONNECTS,
  };
  const hedgeConfig: HedgeConfig = { externalHedgeEnabled: hedge.ENABLE_EXTERNAL_HEDGE };
  const runtimeConfig: RuntimeConfig = {
    env: runtime.NODE_ENV,
    logLevel: runtime.LOG_LEVEL,
  };
  const servicesConfig: ServicesConfig = {
    apiPort: services.API_PORT,
    databaseUrl: services.DATABASE_URL,
  };

  return {
    config: {
      runtime: runtimeConfig,
      trading: tradingConfig,
      assets: assetsConfig,
      market: marketConfig,
      strategy: strategyConfig,
      risk: riskConfig,
      execution: executionConfig,
      hedge: hedgeConfig,
      services: servicesConfig,
    },
    credentials: { polymarketComplete },
  };
}

/** Convenience: validate and return just the typed config. */
export function loadConfig(source: EnvInput = process.env): AppConfig {
  return loadBotConfig(source).config;
}

export { toLogSafeConfig };
export type { LogSafeConfig };

// Re-export defaults so consumers can reference the documented baseline.
export {
  DEFAULT_ASSETS,
  DEFAULT_EXECUTION,
  DEFAULT_HEDGE,
  DEFAULT_MARKET,
  DEFAULT_RISK,
  DEFAULT_STRATEGY,
  DEFAULT_TRADING,
};
