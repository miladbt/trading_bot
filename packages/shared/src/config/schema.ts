/**
 * Zod schemas for environment-variable parsing, one per config group.
 *
 * Conventions:
 * - Every variable has a safe default unless it is genuinely required.
 * - Booleans are strict: only "true"/"false" (any case) are accepted; the
 *   loader rejects anything else rather than coercing (a typo like "ture"
 *   must not silently flip a safety switch).
 * - Decimal-valued variables are parsed as strings here and converted to
 *   domain Decimals in the loader (so zod stays a runtime validator, not the
 *   money layer).
 * - Secrets are read but never persisted into the parsed result: the schema
 *   maps them to a boolean "present" flag only.
 */

import { z } from "zod";

import { ASSET_IDS, type AssetId } from "./types.js";

const ASSET_ID_SET: ReadonlySet<string> = new Set<string>(ASSET_IDS);

/** Strict boolean: accepts "true"/"false" in any casing, nothing else. */
export const strictBoolean = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s): s is "true" | "false" => s === "true" || s === "false", {
    message: 'must be "true" or "false"',
  })
  .transform((s) => s === "true");

/** Positive integer string -> number. */
export const positiveInt = z.coerce.number().int().positive();

/** Non-negative integer string -> number (allows 0). */
export const nonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * Decimal money/size string. Kept as a string with a light regex here; the
 * full parse (and rejection of >12 fractional digits) happens via
 * decFromString in the loader, which produces precise errors.
 */
export const decimalString = z
  .string()
  .trim()
  .regex(/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/, "must be a decimal number");

/**
 * A credential variable: reduces to "was it set to a non-empty value?".
 * The default (empty string) is applied BEFORE the transform so the output
 * type is boolean and unset variables simply read as false.
 */
export const secretPresence = z
  .string()
  .default("")
  .transform((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export const tradingSchema = z.object({
  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  LIVE_TRADING_ENABLED: strictBoolean.default(false),
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const assetsSchema = z.object({
  ASSETS: z
    .string()
    .default("BTC,ETH")
    .transform((s) =>
      s
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter((part) => part.length > 0),
    )
    .refine((list) => list.length > 0, {
      message: "at least one asset is required",
    })
    .refine((list) => list.every((a) => ASSET_ID_SET.has(a)), {
      message: `assets must be one of ${ASSET_IDS.join(", ")}`,
    })
    .refine((list) => new Set(list).size === list.length, {
      message: "assets must not contain duplicates",
    })
    .transform((list) => list as AssetId[]),
});

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

/** Fraction of the cycle in (0, 1). */
const cycleFraction = z.coerce.number().finite().gt(0).lt(1);

export const marketSchema = z.object({
  MARKET_CYCLE_MS: positiveInt.default(300_000),
  MARKET_LIVE_OFFSET_MS: nonNegativeInt.default(240_000),
  MARKET_SETTLE_OFFSET_MS: positiveInt.default(300_000),
  MARKET_SETTLE_GRACE_MS: nonNegativeInt.default(15_000),
  MARKET_PHASE_MID: cycleFraction.default(0.5),
  MARKET_PHASE_LATE: cycleFraction.default(0.75),
  MARKET_PHASE_FINAL: cycleFraction.default(0.9),
  MARKET_DATA_POLL_INTERVAL_MS: positiveInt.default(1_000),
});

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const strategySchema = z.object({
  STRATEGY_MIN_CS_GROSS_EDGE: decimalString.default("0.01"),
  STRATEGY_MIN_CS_NET_EDGE: decimalString.default("0.005"),
  STRATEGY_MAX_RESIDUAL: decimalString.default("0.002"),
  STRATEGY_QUOTE_SIZE: decimalString.default("25"),
  STRATEGY_MAX_ORDER_SIZE: decimalString.default("50"),
  STRATEGY_MIN_QUOTE_LIFETIME_MS: positiveInt.default(2_000),
  STRATEGY_MIN_REPRICE_INTERVAL_MS: positiveInt.default(1_000),
});

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export const riskSchema = z.object({
  RISK_MAX_TOTAL_CAPITAL: decimalString.default("100"),
  RISK_MAX_MARKET_CAPITAL: decimalString.default("25"),
  RISK_MAX_DIRECTIONAL_EXPOSURE: decimalString.default("50"),
  RISK_MAX_ORPHAN_INVENTORY: decimalString.default("10"),
  RISK_MAX_DAILY_LOSS: decimalString.default("50"),
  RISK_MAX_OPEN_ORDERS: positiveInt.default(8),
  RISK_MAX_DATA_AGE_MS: positiveInt.default(5_000),
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const executionSchema = z.object({
  EXECUTION_POST_ONLY: strictBoolean.default(true),
  EXECUTION_MAX_RETRIES: nonNegativeInt.default(3),
  EXECUTION_MAX_RECONNECTS: nonNegativeInt.default(5),
});

// ---------------------------------------------------------------------------
// Hedge
// ---------------------------------------------------------------------------

export const hedgeSchema = z.object({
  ENABLE_EXTERNAL_HEDGE: strictBoolean.default(false),
});

// ---------------------------------------------------------------------------
// Runtime / services
// ---------------------------------------------------------------------------

export const runtimeSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const servicesSchema = z.object({
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  DATABASE_URL: z.string().trim().min(1).default("postgres://localhost:5432/polymarket_bot"),
});

/**
 * Credentials: read to measure presence, reduced to booleans. The actual
 * values are intentionally NOT part of any parsed output.
 */
export const credentialsSchema = z.object({
  POLYMARKET_API_KEY: secretPresence,
  POLYMARKET_API_SECRET: secretPresence,
  POLYMARKET_API_PASSPHRASE: secretPresence,
  POLYMARKET_WALLET_PRIVATE_KEY: secretPresence,
});

/** Union of every environment variable the config system may read. */
export type EnvInput = Partial<Record<string, string | undefined>>;
