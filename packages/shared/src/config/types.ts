/**
 * Strongly typed application configuration.
 *
 * Groups mirror the bot's subsystems. Two flavors exist:
 * - `*Env` interfaces: raw environment-variable names/values (in schema.ts)
 * - `AppConfig` (this file): validated, typed, ready-to-use config
 *
 * Rules enforced here:
 * - Financial values are Decimals from @bot/domain (no floats in the pipeline).
 * - Credentials are never serialized: `LogSafeConfig` excludes them entirely.
 * - Live trading requires an explicit two-way opt-in (see loader.ts guard).
 */

import { decFromString, decToString, type Decimal } from "@bot/domain";

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/** Paper trading is the default and the only implemented mode. */
export type TradingMode = "paper" | "live";

export interface TradingConfig {
  readonly mode: TradingMode;
  /**
   * Live trading master switch. Must be the literal string "true" to enable,
   * and is further gated by mode === "live" and credentials presence (loader).
   */
  readonly liveTradingEnabled: boolean;
}

export const DEFAULT_TRADING: TradingConfig = {
  mode: "paper",
  liveTradingEnabled: false,
} as const;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Underlyings the bot is allowed to trade 5-minute markets on. */
export type AssetId = "BTC" | "ETH";

export const ASSET_IDS: readonly AssetId[] = ["BTC", "ETH"] as const;

export interface AssetsConfig {
  /** Enabled underlyings, e.g. ["BTC"] or ["BTC", "ETH"]. Never empty. */
  readonly enabled: readonly AssetId[];
}

export const DEFAULT_ASSETS: AssetsConfig = {
  enabled: ["BTC", "ETH"],
} as const;

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

/** Phase boundaries of the 5-minute cycle, in milliseconds. */
export interface MarketPhaseWindows {
  /** Trading open -> live transition offset from cycle open. */
  readonly liveOffsetMs: number;
  /** Cycle open -> settlement offset. The 5-minute length itself. */
  readonly settleOffsetMs: number;
  /** Grace period after settleAt before a market is considered overdue. */
  readonly settleGraceMs: number;
}

/**
 * Canonical EARLY/MID/LATE/FINAL phase boundaries as fractions of the cycle
 * (consumed by @bot/domain's phase engine). Must satisfy mid < late < final.
 */
export interface MarketPhaseFractions {
  readonly mid: number;
  readonly late: number;
  readonly final: number;
}

export interface MarketConfig {
  /** Cycle length; the bot only trades 5-minute (300_000 ms) markets. */
  readonly cycleMs: number;
  readonly phases: MarketPhaseWindows;
  /** Canonical EARLY/MID/LATE/FINAL boundaries as cycle fractions. */
  readonly phaseFractions: MarketPhaseFractions;
  /** How often to poll public market data, in ms. */
  readonly pollIntervalMs: number;
}

/** 5-minute cycle with sensible phase boundaries. */
export const DEFAULT_MARKET: MarketConfig = {
  cycleMs: 300_000,
  phases: {
    liveOffsetMs: 240_000, // last 60s is "live"
    settleOffsetMs: 300_000,
    settleGraceMs: 15_000,
  },
  phaseFractions: {
    mid: 0.5, // EARLY |  first half
    late: 0.75, // MID   |  third quarter
    final: 0.9, // LATE  |  last 10% is FINAL
  },
  pollIntervalMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  /** Minimum |1 - (up + down)| to treat a combined ask as off parity (gross). */
  readonly minCompleteSetGrossEdge: Decimal;
  /** Same, after the per-set fee allowance (net). Must be <= gross. */
  readonly minCompleteSetNetEdge: Decimal;
  /** Maximum acceptable residual when merging/minting complete sets. */
  readonly maxResidual: Decimal;
  /** Default quote size in shares. */
  readonly quoteSize: Decimal;
  /** Hard cap on any single order's size (shares). USDC caps live in risk. */
  readonly maxOrderSize: Decimal;
  /** Minimum time a resting quote must live before repricing, ms. */
  readonly minQuoteLifetimeMs: number;
  /** Minimum interval between repricing actions, ms. */
  readonly minRepriceIntervalMs: number;
  /**
   * Target-residual sizing model (T1): "directional" = legacy
   * `direction x confidence x maxResidual x phase`; "edge" = fractional-Kelly
   * on the net edge between the model probability and the executable ask.
   */
  readonly sizingModel: "directional" | "edge";
  /** Kelly fraction in (0, 1] for the "edge" model. */
  readonly kellyFraction: Decimal;
  /** Minimum net edge (probability units) required to trade at all. */
  readonly minEdge: Decimal;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  minCompleteSetGrossEdge: decFromString("0.01"),
  minCompleteSetNetEdge: decFromString("0.005"),
  maxResidual: decFromString("0.002"),
  quoteSize: decFromString("25"),
  maxOrderSize: decFromString("50"),
  minQuoteLifetimeMs: 2_000,
  minRepriceIntervalMs: 1_000,
  sizingModel: "directional",
  kellyFraction: decFromString("0.25"),
  minEdge: decFromString("0.01"),
} as const;

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export interface RiskConfig {
  /** Maximum total capital the bot may deploy (USDC). */
  readonly maxTotalCapital: Decimal;
  /** Maximum capital in any single market (USDC). */
  readonly maxMarketCapital: Decimal;
  /** Maximum signed directional exposure per asset (USDC). */
  readonly maxDirectionalExposure: Decimal;
  /** Maximum unhedged inventory held past the cycle (USDC). */
  readonly maxOrphanInventory: Decimal;
  /** Daily loss cutoff (USDC); trading stops when hit. */
  readonly maxDailyLoss: Decimal;
  /** Maximum concurrently open orders. */
  readonly maxOpenOrders: number;
  /** Maximum age of market data before trading pauses, ms. */
  readonly maxDataAgeMs: number;
}

export const DEFAULT_RISK: RiskConfig = {
  maxTotalCapital: decFromString("100"),
  maxMarketCapital: decFromString("25"),
  maxDirectionalExposure: decFromString("50"),
  maxOrphanInventory: decFromString("10"),
  maxDailyLoss: decFromString("50"),
  maxOpenOrders: 8,
  maxDataAgeMs: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecutionConfig {
  /** Prefer post-only orders (maker) when the venue supports them. */
  readonly postOnly: boolean;
  /** Per-order submit/amend retry attempts before giving up. */
  readonly maxRetries: number;
  /** WebSocket/data reconnect attempts before backing off hard. */
  readonly maxReconnects: number;
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  postOnly: true,
  maxRetries: 3,
  maxReconnects: 5,
} as const;

// ---------------------------------------------------------------------------
// Hedge
// ---------------------------------------------------------------------------

export interface HedgeConfig {
  /**
   * Enable an external hedge venue. Scaffolding only: nothing implements
   * hedging, so this must stay false until that exists (loader guards it).
   */
  readonly externalHedgeEnabled: boolean;
}

export const DEFAULT_HEDGE: HedgeConfig = {
  externalHedgeEnabled: false,
} as const;

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/**
 * Verified Polymarket crypto fee schedule (see docs/RESOLUTION_AND_FEES.md
 * for citations): fee = C x takerRate x p x (1 - p), takers only, fees
 * rounded to 5 dp. Per-market Gamma `feeSchedule` overrides at runtime.
 */
export interface FeesConfig {
  readonly takerRate: Decimal;
  /** Docs: makers are never charged. */
  readonly takerOnly: boolean;
  /** Informational maker-rebate share. */
  readonly rebateRate: Decimal;
}

export const DEFAULT_FEES: FeesConfig = {
  takerRate: decFromString("0.07"),
  takerOnly: true,
  rebateRate: decFromString("0.2"),
} as const;

// ---------------------------------------------------------------------------
// Runtime / services (pre-existing groups, kept for compatibility)
// ---------------------------------------------------------------------------

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface RuntimeConfig {
  readonly env: "development" | "test" | "production";
  readonly logLevel: LogLevelName;
}

export interface ServicesConfig {
  readonly apiPort: number;
  readonly databaseUrl: string;
}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export interface AppConfig {
  readonly runtime: RuntimeConfig;
  readonly trading: TradingConfig;
  readonly assets: AssetsConfig;
  readonly market: MarketConfig;
  readonly strategy: StrategyConfig;
  readonly risk: RiskConfig;
  readonly execution: ExecutionConfig;
  readonly hedge: HedgeConfig;
  readonly fees: FeesConfig;
  readonly services: ServicesConfig;
}

/**
 * Credential presence flag — the ONLY thing config exposes about secrets.
 * The values themselves never enter AppConfig, so they cannot be logged.
 */
export interface CredentialsStatus {
  /** All four Polymarket credential variables are set and non-empty. */
  readonly polymarketComplete: boolean;
}

/**
 * JSON-safe projection: Decimals render as their exact 8-dp strings so the
 * result can always be JSON.stringify'd (bigint cannot). Everything else
 * passes through structurally unchanged.
 */
export type JsonSafe<T> = T extends Decimal
  ? string
  : T extends bigint
    ? string
    : T extends readonly (infer U)[]
      ? JsonSafe<U>[]
      : T extends object
        ? { readonly [K in keyof T]: JsonSafe<T[K]> }
        : T;

/**
 * Log-safe projection of the configuration. Excluded on purpose: the services
 * group (database URL may embed a password) and any credential material.
 * Decimal values become exact strings; the result is JSON-serializable.
 */
export type LogSafeConfig = JsonSafe<Omit<AppConfig, "services">>;

function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof value === "bigint") {
    return decToString(value as Decimal);
  }
  if (Array.isArray(value)) {
    return value.map((v) => jsonSafe(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = jsonSafe(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function toLogSafeConfig(config: AppConfig): LogSafeConfig {
  const { services: _services, ...rest } = config;
  return jsonSafe(rest) as LogSafeConfig;
}
