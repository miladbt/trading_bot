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
  /**
   * Target-residual sizing model (T1):
   * - "directional": legacy `direction x confidence x maxResidual x phase`
   *   (kept selectable for A/B comparison in the backtest).
   * - "edge": fractional-Kelly sizing from the model probability vs the
   *   executable ask net of fees; no trade when edge <= STRATEGY_MIN_EDGE.
   */
  STRATEGY_SIZING_MODEL: z.enum(["directional", "edge"]).default("directional"),
  /** Fractional-Kelly fraction in (0, 1] for the "edge" model. */
  STRATEGY_KELLY_FRACTION: decimalString.default("0.25"),
  /** Minimum net edge (probability units) required to trade at all. */
  STRATEGY_MIN_EDGE: decimalString.default("0.01") /**
   * Optional path to a serialized calibration model (T2, versioned JSON from
   * @bot/calibration). Empty/unset disables calibration: the signal engine's
   * raw probability prior is used unchanged. The file is loaded by the
   * composition root (soak/backtest CLIs), never by the config loader.
   */,
  CALIBRATION_FILE: z.string().trim().default(""),
  /**
   * Phase multipliers on the directional target (T7): either a named preset
   * - "canonical" (1.0/0.75/0.5/0.25), "flat" (1/1/1/1), "reversed"
   * (0.25/0.5/0.75/1.0) - or four comma-separated values EARLY,MID,LATE,FINAL
   * in [0, 1]. Default: canonical (the historically-shipped curve).
   */
  STRATEGY_PHASE_MULTIPLIERS: z.string().trim().default("canonical"),
  /**
   * Strategy V2 (docs/STRATEGY_V2.md) probability source:
   * - "signal": the existing signal-engine prior (optionally calibrated).
   * - "fair-value-v2": the @bot/fair-value model with the fee/buffer-aware
   *   mispricing rule and the model-quality gate. Requires
   *   STRATEGY_SIZING_MODEL=edge (cross-validated in the loader). Without a
   *   gate artifact (STRATEGY_FV2_GATE_FILE) the gate is closed: no
   *   model-driven trades (fail closed); CSA and inventory rebalancing are
   *   unaffected.
   */
  STRATEGY_PROBABILITY_SOURCE: z.enum(["signal", "fair-value-v2"]).default("signal"),
  /** V2: minimum buffered, fee-aware mispricing (probability units) to trade. */
  STRATEGY_FV2_MIN_MISPRICING: decimalString.default("0.01"),
  /** V2 execution-cost buffers (probability units per share), all >= 0. */
  STRATEGY_FV2_SLIPPAGE_BUFFER: decimalString.default("0.003"),
  STRATEGY_FV2_ADVERSE_BUFFER: decimalString.default("0.003"),
  STRATEGY_FV2_UNCERTAINTY_BUFFER: decimalString.default("0.003"),
  /**
   * Optional path to the V2 model-quality gate artifact (versioned JSON
   * written by the backtest from @bot/fair-value `evaluateGate`). Empty = no
   * artifact = gate closed (fail closed). Loaded by the composition root,
   * never by the config loader.
   */
  STRATEGY_FV2_GATE_FILE: z.string().trim().default(""),
});

// ---------------------------------------------------------------------------
// Fees (verified schedule: docs.polymarket.com/trading/fees, retrieved
// 2026-09-29 — see docs/RESOLUTION_AND_FEES.md; per-market Gamma
// `feeSchedule` is authoritative at runtime when present)
// ---------------------------------------------------------------------------

export const feesSchema = z.object({
  /** Crypto taker fee rate in fee = C x rate x p x (1 - p). */
  FEE_TAKER_RATE: decimalString.default("0.07"),
  /** Docs: "Makers are never charged fees. Only takers pay fees." */
  FEE_TAKER_ONLY: strictBoolean.default(true),
  /** Informational maker-rebate share (docs: crypto 20%). */
  FEE_REBATE_RATE: decimalString.default("0.2"),
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
  /**
   * Fill simulation model for the paper adapter (T4). "optimistic" fills on
   * touch (legacy); "pessimistic" requires a price trade-through plus a
   * queue-position haircut, with adverse-selection relaxation. The backtest
   * and soak runners DEFAULT TO "pessimistic" regardless of this value's
   * default here (they select it explicitly per run); this flag exists so a
   * comparison run can flip back to optimistic without code changes.
   */
  EXECUTION_FILL_MODEL: z.enum(["optimistic", "pessimistic"]).default("optimistic"),
  /** Pessimistic model: required trade-through beyond the order price. */
  EXECUTION_TRADE_THROUGH: decimalString.default("0.001"),
  /** Pessimistic model: fraction of the level we get per fill event, (0, 1]. */
  EXECUTION_QUEUE_POSITION_FACTOR: decimalString.default("0.5"),
  /** Pessimistic model: adverse mid move (price units) that relaxes touch back to fill. */
  EXECUTION_ADVERSE_MOVE_THRESHOLD: decimalString.default("0.01"),
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
