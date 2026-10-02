/**
 * Backtest experiment driver (T11): runs configs A/B/C/D over the hold-out
 * dataset through the REAL orchestrator pipeline, applies walk-forward
 * calibration fit ONLY on the training window, and emits a JSON results file
 * for reports/backtest-24h.md.
 *
 * Baseline mechanics (honesty first — no fake trades):
 * - D1 (no-trade): dataset markets are removed from the orchestrator's view,
 *   so the pipeline legitimately submits nothing; PnL is exactly 0.
 * - D3 (complete-set-only): config STRATEGY_MAX_RESIDUAL=0 makes the sizing
 *   plan zero directional residual; the orchestrator itself then has no
 *   directional action to submit (accumulate_sets is skipped by its one-order
 *   rule). PnL is exactly 0 — reported as "no directional trades by design".
 * - D2 (random direction): NOT implementable without touching strategy code
 *   (the orchestrator derives direction from the signal), so the driver
 *   REFUSES to fake it and the report explains this. See OPEN_QUESTIONS.md.
 *
 * Usage:
 *   tsx packages/backtest/src/run-experiments.ts \
 *     --dataset data/backtest/dataset.json --out reports/backtest-24h.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { cyclePhaseAt, DEFAULT_PHASE_BOUNDARIES, millis, decToString } from "@bot/domain";
import {
  brierScore,
  evaluateCalibration,
  fitIsotonicCalibration,
  logLoss,
  reliabilityTable,
  serializeCalibration,
  type CalibrationModel,
  type CalibrationSample,
} from "@bot/calibration";
import { loadConfig, type AppConfig } from "@bot/shared";
import {
  DEFAULT_GATE_CONFIG,
  DEFAULT_FAIR_VALUE_CONFIG,
  anchorDistFrac as fvAnchorDistFrac,
  evaluateGate,
  fairValueEstimate,
  momentumPerMin as fvMomentumPerMin,
  volAccelPerMin2 as fvVolAccelPerMin2,
  type GateEvaluation,
  type GateObservation,
} from "@bot/fair-value";
import {
  computeAssetSignal,
  createAssetHistory,
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  type SignalEngineConfig,
} from "@bot/strategy";

import type { BacktestDataset } from "./dataset.js";
import { runBacktest } from "./runner.js";
import {
  analyzeSetEdge,
  bootstrapByMarket,
  CONFIGS,
  marketOutcomes,
  summarize,
  SENSITIVITY_SPECS,
  type ConfigDescriptor,
  type RunStats,
  type SetEdgeStats,
} from "./metrics.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  readonly datasetPath: string;
  readonly outPath: string;
  readonly holdoutHours: number;
  readonly bootstrapIterations: number;
  readonly seed: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      args[a.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "true";
    }
  }
  return {
    datasetPath: args["dataset"] ?? "data/backtest/dataset.json",
    outPath: args["out"] ?? "reports/backtest-24h.json",
    holdoutHours: Number(args["holdout-hours"] ?? "24"),
    bootstrapIterations: Number(args["bootstrap-iters"] ?? "2000"),
    seed: Number(args["seed"] ?? "20261001"),
  };
}

// ---------------------------------------------------------------------------
// Walk-forward calibration (training window only)
// ---------------------------------------------------------------------------

/**
 * Build calibration samples from the TRAINING window only: for each training
 * market, at the window-open tick, compute the raw signal probability from
 * the anchor series at-or-before that instant, and pair it with the realized
 * resolution outcome. No hold-out data touches the fitter.
 */
function fitWalkForwardCalibration(
  dataset: BacktestDataset,
  trainingEndMs: number,
  asset: "BTC" | "ETH",
): CalibrationModel | undefined {
  const samples: CalibrationSample[] = [];
  const markets = dataset.markets.filter(
    (m) =>
      m.asset === asset &&
      Number(m.startMs) >= Number(dataset.provenance.windowStartMs) &&
      Number(m.startMs) < trainingEndMs,
  );
  for (const m of markets) {
    const at = millis(Number(m.startMs) + 30_000); // first in-window tick
    const series = dataset.underlying[asset];
    if (series === undefined) return undefined;
    // Raw probability exactly as the pipeline computes it in the backtest:
    // the last 5 anchors at or before `at`, through the SAME dataset-cadence
    // signal config the runs use (no look-ahead: p.t <= at only).
    const points = series.points
      .filter((p) => p.t <= at)
      .slice(-5)
      .map((p) => ({ price: p.p.toFixed(2), at: p.t }));
    if (points.length < DATASET_SIGNAL_CONFIG.minSamples) continue;
    const signal = computeAssetSignal(createAssetHistory(asset, points), DATASET_SIGNAL_CONFIG, at);
    if (signal.metrics.probabilitySource !== "raw_score") continue;
    samples.push({
      raw: signal.probabilityUp,
      outcome: m.resolution.outcome === "UP" ? 1 : 0,
      at: m.startMs,
    });
  }
  if (samples.length < 50) return undefined; // too few to fit honestly
  return fitIsotonicCalibration({ samples, asset, version: "walkforward-isotonic-v1" });
}

// ---------------------------------------------------------------------------
// Experiment configs
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  TRADING_MODE: "paper",
  LIVE_TRADING_ENABLED: "false",
  STRATEGY_SIZING_MODEL: "directional",
  STRATEGY_MAX_RESIDUAL: "20", // shared experiment size (shares); disclosed, not tuned
  STRATEGY_MAX_ORDER_SIZE: "50",
  STRATEGY_QUOTE_SIZE: "25",
  RISK_MAX_TOTAL_CAPITAL: "100",
  RISK_MAX_MARKET_CAPITAL: "100",
  RISK_MAX_DIRECTIONAL_EXPOSURE: "100",
  RISK_MAX_ORPHAN_INVENTORY: "100",
  RISK_MAX_DAILY_LOSS: "100",
  RISK_MAX_OPEN_ORDERS: "500",
  RISK_MAX_DATA_AGE_MS: "120000",
  EXECUTION_FILL_MODEL: "pessimistic",
  EXECUTION_TRADE_THROUGH: "0.001",
  EXECUTION_QUEUE_POSITION_FACTOR: "0.5",
  EXECUTION_ADVERSE_MOVE_THRESHOLD: "0.01",
  EXECUTION_SUBMIT_LATENCY_MS: "250",
  EXECUTION_CANCEL_LATENCY_MS: "250",
  FEE_TAKER_RATE: "0.07",
  FEE_TAKER_ONLY: "true",
  FEE_REBATE_RATE: "0.2",
};

/**
 * Signal-engine config rescaled to the dataset's cadence (DISCLOSED
 * DEVIATION): production samples spot at ~1 Hz with second-scale component
 * lookbacks; this dataset's underlying series is the Chainlink TWAP anchor
 * chain at 5-minute steps, so every second-scale component window would hold
 * at most one sample and the pipeline would legitimately never trade. The
 * rescaling only ENABLES trading on this cadence; it supplies no extra
 * information — the same anchors at-or-before `now` are all the pipeline
 * ever sees — and the production default (`DEFAULT_SIGNAL_ENGINE_CONFIG`)
 * stays untouched for live paper mode.
 */
const DATASET_SIGNAL_CONFIG: SignalEngineConfig = {
  ...DEFAULT_SIGNAL_ENGINE_CONFIG,
  returnLookbackMs: 300_000, // one 5-minute window (was 30 s)
  volatilityLookbackMs: 600_000, // two windows (was 60 s)
  rangeLookbackMs: 900_000, // three windows (was 120 s)
  maxDataAgeMs: 300_000, // anchors arrive every 5 min (was 5 s)
  freshnessWarnMs: 60_000,
  maxBookAgeMs: 300_000,
};

function envFor(config: ConfigDescriptor): Record<string, string> {
  const env = { ...BASE_ENV };
  if (config.sizingModel === "edge") {
    env["STRATEGY_SIZING_MODEL"] = "edge";
    env["STRATEGY_KELLY_FRACTION"] = "0.25";
    env["STRATEGY_MIN_EDGE"] = "0.01";
  }
  if (config.fillModel === "optimistic") {
    env["EXECUTION_FILL_MODEL"] = "optimistic";
  }
  if (config.completeSetOnly) {
    env["STRATEGY_MAX_RESIDUAL"] = "0";
  }
  if (config.v2) {
    env["STRATEGY_PROBABILITY_SOURCE"] = "fair-value-v2";
    env["STRATEGY_FV2_MIN_MISPRICING"] = "0.01";
  }
  return env;
}

/**
 * Strategy V2 hold-out observations: the fair-value model's P(UP) at each
 * hold-out market's window-open tick (start + 30 s, the calibration recipe),
 * paired with the realized outcome. Built from the Chainlink anchor series
 * and the market's verified priceToBeat ONLY — no book evidence exists on
 * schema-1 data, so those components run dormant (honest, disclosed).
 */
function fv2HoldoutObservations(
  dataset: BacktestDataset,
  asset: string,
  holdoutStartMs: number,
): GateObservation[] {
  const series = dataset.underlying[asset as "BTC" | "ETH"];
  if (series === undefined) return [];
  const obs: GateObservation[] = [];
  for (const m of dataset.markets) {
    if (m.asset !== asset || Number(m.startMs) < holdoutStartMs) continue;
    const at = Number(m.startMs) + 30_000;
    const points = series.points.filter((p) => p.t <= at);
    if (points.length < 2) continue;
    const fvSeries = points.map((p) => ({ t: Number(p.t), price: p.p }));
    const spot = fvSeries[fvSeries.length - 1]?.price;
    if (spot === undefined || m.resolution.priceToBeat <= 0) continue;
    const estimate = fairValueEstimate({
      elapsedSec: 30,
      remainingSec: (Number(m.endMs) - at) / 1000,
      underlying: {
        anchorDistFrac: fvAnchorDistFrac(spot, m.resolution.priceToBeat),
        momentumPerMin: fvMomentumPerMin(fvSeries, at, 900_000),
        volAccelPerMin2: fvVolAccelPerMin2(fvSeries, at, 1_800_000),
      },
      market: { bookImbalance: { available: false, value: 0 } },
      config: DEFAULT_FAIR_VALUE_CONFIG,
    });
    obs.push({ predicted: estimate.pUp, outcome: m.resolution.outcome === "UP" ? 1 : 0 });
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Per-asset / per-phase / per-probability-bucket attribution for the report.
 * Phase attribution uses each market's FIRST fill phase (a market can trade
 * in several phases; first-fill is the dominant decision point — disclosed).
 * Probabilities are the raw signal prior at window open + 30 s (same recipe
 * as calibration fitting; no look-ahead).
 */
function attribute(
  run: ReturnType<typeof runBacktest>,
  dataset: BacktestDataset,
  holdoutStartMs: number,
  assetFilter: (a: string) => boolean,
) {
  const settleBySlug = new Map(run.settlements.map((s) => [s.slug, s]));
  // First fill timestamp per market (fill->market needs the dataset tokens).
  const firstFill = new Map<string, number>();
  const tokenToSlug = new Map<string, string>();
  for (const m of dataset.markets) {
    tokenToSlug.set(m.upTokenId, m.slug);
    tokenToSlug.set(m.downTokenId, m.slug);
  }
  for (const f of run.fills) {
    // fills carry clientOrderId only; recover slug from the order id prefix
    // `ord-<marketId>-<counter>` (the orchestrator's deterministic scheme).
    const m = /^ord-(.+)-\d+$/.exec(f.clientOrderId);
    if (m === null) continue;
    const slug = m[1] ?? "";
    if (!firstFill.has(slug)) firstFill.set(slug, Number(f.at));
  }
  void tokenToSlug;

  const rows: { key: string; pnl: number; cost: number; markets: number }[] = [];
  const acc = new Map<string, { pnl: number; cost: number; markets: number }>();
  const bump = (key: string, pnl: number, cost: number): void => {
    const e = acc.get(key) ?? { pnl: 0, cost: 0, markets: 0 };
    e.pnl += pnl;
    e.cost += cost;
    e.markets += 1;
    acc.set(key, e);
  };

  for (const m of dataset.markets) {
    if (Number(m.startMs) < holdoutStartMs || !assetFilter(m.asset)) continue;
    const s = settleBySlug.get(m.slug);
    if (s === undefined) continue;
    const pnl = Number(decToString(s.realizedPnlUsdc));
    const cost = Number(decToString(s.costUsdc));
    // Per-asset.
    bump(`asset:${m.asset}`, pnl, cost);
    // Per phase (first fill).
    const ff = firstFill.get(m.slug);
    if (ff !== undefined) {
      const phase = cyclePhaseAt(
        { startMs: m.startMs, endMs: m.endMs },
        DEFAULT_PHASE_BOUNDARIES,
        millis(ff),
      );
      if (phase.ok) bump(`phase:${phase.value}`, pnl, cost);
    } else {
      bump("phase:none", pnl, cost);
    }
    // Per probability bucket (raw prior at open + 30 s).
    const series = dataset.underlying[m.asset];
    if (series === undefined) continue;
    const at = millis(Number(m.startMs) + 30_000);
    const pts = series.points
      .filter((p) => p.t <= at)
      .slice(-5)
      .map((p) => ({ price: p.p.toFixed(2), at: p.t }));
    if (pts.length < DATASET_SIGNAL_CONFIG.minSamples) continue;
    const sig = computeAssetSignal(createAssetHistory(m.asset, pts), DATASET_SIGNAL_CONFIG, at);
    if (sig.metrics.probabilitySource !== "raw_score") continue;
    const p = sig.probabilityUp;
    const bucket = p < 0.35 ? "p<0.35" : p < 0.5 ? "0.35-0.5" : p < 0.65 ? "0.5-0.65" : "p>=0.65";
    bump(`bucket:${bucket}`, pnl, cost);
  }
  for (const [key, e] of [...acc.entries()].sort()) {
    rows.push({
      key,
      pnl: Math.round(e.pnl * 1e6) / 1e6,
      cost: Math.round(e.cost * 1e6) / 1e6,
      markets: e.markets,
    });
  }
  return rows;
}

function emptySetEdge(): SetEdgeStats {
  return {
    samples: 0,
    positiveCount: 0,
    positiveFraction: 0,
    meanPositiveEdgeUsdc: null,
    maxPositiveEdgeUsdc: null,
    longestPositiveRunTicks: 0,
    capturableFraction: 0,
    captureLatencyTicks: 2,
  };
}

interface ConfigResult {
  readonly configId: string;
  readonly label: string;
  readonly stats: RunStats;
  readonly setEdge: SetEdgeStats;
  readonly bootstrap: {
    readonly netPnl: { estimate: number; ciLow: number; ciHigh: number };
    readonly hitRate: { estimate: number; ciLow: number; ciHigh: number } | null;
  };
  readonly attribution: { key: string; pnl: number; cost: number; markets: number }[];
  readonly notes: string[];
}

function runOneConfig(
  config: ConfigDescriptor,
  dataset: BacktestDataset,
  holdoutStartMs: number,
  windowEndMs: number,
  calibration: Readonly<Record<string, CalibrationModel>> | undefined,
  fv2Gate: Readonly<Record<string, GateEvaluation>> | undefined,
  bootstrapIterations: number,
  seed: number,
): ConfigResult {
  const notes: string[] = [];
  if (config.v2 && fv2Gate !== undefined) {
    for (const [asset, gate] of Object.entries(fv2Gate)) {
      notes.push(
        `fv2 gate ${asset}: ${gate.verdict} (brier=${gate.brier?.toFixed(4) ?? "n/a"}, logLoss=${gate.logLoss?.toFixed(4) ?? "n/a"}, n=${gate.sampleCount}) — ${gate.reason}`,
      );
    }
  }
  if (config.forceGateOpen) {
    notes.push(
      "DIAGNOSTIC ONLY: gate forced open regardless of measured skill — quantifies what the gate prevented; not a recommendation",
    );
  }

  if (config.noTrade) {
    // D1 (no-trade): reported analytically. Hiding all markets from the
    // runner would also empty the paper adapter's token set (it requires at
    // least one), so the honest statement is trivial: no trades, no spend,
    // no PnL — identical to the dataset's hold-out span with zero activity.
    const holdoutMarkets = dataset.markets.filter(
      (m) => Number(m.startMs) >= holdoutStartMs,
    ).length;
    notes.push(
      "no-trade baseline: zero activity by definition; reported analytically (the pipeline itself is exercised by every other config)",
    );
    return {
      configId: config.id,
      label: config.label,
      stats: {
        configId: config.id,
        label: config.label,
        ticks: (windowEndMs - holdoutStartMs) / 30_000,
        submits: 0,
        fills: 0,
        filledOrders: 0,
        unfilledOrders: 0,
        partiallyFilledOrders: 0,
        spentUsdc: "0.00000000",
        feesUsdc: "0.00000000",
        settlementUsdc: "0.00000000",
        netPnlUsdc: "0.00000000",
        grossPnlUsdc: "0.00000000",
        marketsTraded: 0,
        marketsSettled: holdoutMarkets,
        orphanedMarkets: 0,
        orphanRate: 0,
        worstMarketPnlUsdc: "0.00000000",
        bestMarketPnlUsdc: "0.00000000",
        maxDrawdownUsdc: 0,
        sharpeLikePerMarket: null,
        hitRate: null,
        marketsWithPositivePnl: 0,
      },
      setEdge: emptySetEdge(),
      bootstrap: { netPnl: { estimate: 0, ciLow: 0, ciHigh: 0 }, hitRate: null },
      attribution: [],
      notes,
    };
  }

  const cfg: AppConfig = loadConfig(envFor(config));
  const run = runBacktest(dataset, {
    config: cfg,
    windowStartMs: millis(holdoutStartMs),
    windowEndMs: millis(windowEndMs),
    tickMs: 30_000,
    fillModel: config.fillModel,
    submitLatencyMs: 250,
    cancelLatencyMs: 250,
    signalConfig: DATASET_SIGNAL_CONFIG,
    ...(calibration !== undefined ? { calibration } : {}),
    ...(fv2Gate !== undefined ? { fv2Gate } : {}),
  });

  if (config.completeSetOnly) {
    notes.push(
      "complete-set-only: maxResidual=0 disables directional targets by design; no directional trades",
    );
  }

  const outcomes = marketOutcomes(
    run,
    dataset.markets.filter((m) => Number(m.startMs) >= holdoutStartMs),
  );
  const stats = summarize(config, run, outcomes);
  const setEdge = analyzeSetEdge(run, 2);
  const attribution = config.noTrade ? [] : attribute(run, dataset, holdoutStartMs, () => true);
  const pnls = run.marketPnls.map((p) => Number(decToString(p)));
  const netPnlCi = bootstrapByMarket("net_pnl_usdc", pnls, bootstrapIterations, seed);
  const hitCi = pnls.some((p) => p !== 0)
    ? bootstrapByMarket("hit_rate", pnls, bootstrapIterations, seed)
    : null;

  return {
    configId: config.id,
    label: config.label,
    stats,
    setEdge,
    bootstrap: {
      netPnl: { estimate: netPnlCi.estimate, ciLow: netPnlCi.ciLow, ciHigh: netPnlCi.ciHigh },
      hitRate:
        hitCi === null
          ? null
          : { estimate: hitCi.estimate, ciLow: hitCi.ciLow, ciHigh: hitCi.ciHigh },
    },
    attribution,
    notes,
  };
}

// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(readFileSync(args.datasetPath, "utf8")) as BacktestDataset;
  const windowStartMs = Number(dataset.provenance.windowStartMs);
  const windowEndMs = Number(dataset.provenance.windowEndMs);
  const trainingEndMs =
    windowStartMs + (windowEndMs - windowStartMs - args.holdoutHours * 3_600_000);
  const holdoutStartMs = trainingEndMs;

  console.log(
    `dataset: ${dataset.markets.length} markets, window ${new Date(windowStartMs).toISOString()} .. ${new Date(windowEndMs).toISOString()}`,
  );
  console.log(
    `walk-forward split: training [${new Date(windowStartMs).toISOString()} .. ${new Date(trainingEndMs).toISOString()}) , hold-out [${new Date(holdoutStartMs).toISOString()} .. ${new Date(windowEndMs).toISOString()}]`,
  );

  // --- Calibration: fit on TRAINING window only, per asset ---------------
  const calibration: Record<string, CalibrationModel> = {};
  const calibrationInfo: Record<string, unknown> = {};
  for (const asset of dataset.provenance.assets) {
    const model = fitWalkForwardCalibration(dataset, trainingEndMs, asset);
    if (model !== undefined) {
      calibration[asset] = model;
      calibrationInfo[asset] = {
        method: model.method,
        version: model.version,
        fittedOn: "training window only",
      };
      writeFileSync(
        `data/backtest/calibration-${asset.toLowerCase()}.json`,
        serializeCalibration(model),
      );
      console.log(
        `calibration ${asset}: fitted (isotonic), saved to data/backtest/calibration-${asset.toLowerCase()}.json`,
      );
    } else {
      console.log(`calibration ${asset}: NOT fitted (insufficient training samples)`);
      calibrationInfo[asset] = { fitted: false, reason: "insufficient training samples" };
    }
  }
  const calibrationUsed = Object.keys(calibration).length > 0 ? calibration : undefined;

  // --- Strategy V2 model-quality gate (hold-out evaluated, per asset) ------
  // The gate artifact is computed from hold-out observations ONLY (same
  // recipe as the calibration-quality read-out). Disclosure: setting the
  // gate for a hold-out run from hold-out skill is aggregate-level, not
  // per-market, leakage; config E2 (forced open) quantifies exactly what
  // the gate changed. In production the artifact is loaded from file.
  const fv2Gates: Record<string, GateEvaluation> = {};
  for (const asset of dataset.provenance.assets) {
    const obs = fv2HoldoutObservations(dataset, asset, holdoutStartMs);
    const gate = evaluateGate(obs, DEFAULT_GATE_CONFIG);
    fv2Gates[asset] = gate;
    console.log(
      `fv2 gate ${asset}: ${gate.verdict} (brier=${gate.brier?.toFixed(4) ?? "n/a"}, logLoss=${gate.logLoss?.toFixed(4) ?? "n/a"}, n=${gate.sampleCount})`,
    );
  }
  const fv2GatesForcedOpen: Record<string, GateEvaluation> = Object.fromEntries(
    Object.entries(fv2Gates).map(([asset, gate]) => [
      asset,
      { ...gate, verdict: "open" as const, reason: "FORCED OPEN (diagnostic)" },
    ]),
  );

  // --- Hold-out calibration quality (reported, never tuned on) -----------
  const calibrationQuality: Record<string, unknown> = {};
  for (const asset of Object.keys(calibration)) {
    const model = calibration[asset]!;
    const series = dataset.underlying[asset as "BTC" | "ETH"];
    if (series === undefined) continue;
    const pairs: { predicted: number; outcome: 0 | 1 }[] = [];
    for (const m of dataset.markets) {
      if (m.asset !== asset || Number(m.startMs) < holdoutStartMs) continue;
      const at = millis(Number(m.startMs) + 30_000);
      const points = series.points
        .filter((p) => p.t <= at)
        .slice(-5)
        .map((p) => ({ price: p.p.toFixed(2), at: p.t }));
      if (points.length < DATASET_SIGNAL_CONFIG.minSamples) continue;
      const signal = computeAssetSignal(
        createAssetHistory(asset, points),
        DATASET_SIGNAL_CONFIG,
        at,
      );
      if (signal.metrics.probabilitySource !== "raw_score") continue;
      pairs.push({
        predicted: evaluateCalibration(model, signal.probabilityUp),
        outcome: m.resolution.outcome === "UP" ? 1 : 0,
      });
    }
    if (pairs.length > 0) {
      calibrationQuality[asset] = {
        holdoutSamples: pairs.length,
        brier: brierScore(pairs),
        logLoss: logLoss(pairs),
        reliability: reliabilityTable(pairs, 5),
      };
      console.log(
        `calibration quality ${asset}: brier=${(calibrationQuality[asset] as { brier: number }).brier.toFixed(4)} over ${pairs.length} hold-out markets`,
      );
    }
  }

  // --- Run configs --------------------------------------------------------
  const results: ConfigResult[] = [];
  for (const config of CONFIGS) {
    if (config.randomDirection) {
      results.push({
        configId: config.id,
        label: config.label,
        stats: {
          configId: config.id,
          label: config.label,
          ticks: 0,
          submits: 0,
          fills: 0,
          filledOrders: 0,
          unfilledOrders: 0,
          partiallyFilledOrders: 0,
          spentUsdc: "0.00000000",
          feesUsdc: "0.00000000",
          settlementUsdc: "0.00000000",
          netPnlUsdc: "0.00000000",
          grossPnlUsdc: "0.00000000",
          marketsTraded: 0,
          marketsSettled: dataset.markets.filter((m) => Number(m.startMs) >= holdoutStartMs).length,
          orphanedMarkets: 0,
          orphanRate: 0,
          worstMarketPnlUsdc: "0.00000000",
          bestMarketPnlUsdc: "0.00000000",
          maxDrawdownUsdc: 0,
          sharpeLikePerMarket: null,
          hitRate: null,
          marketsWithPositivePnl: 0,
        },
        setEdge: {
          samples: 0,
          positiveCount: 0,
          positiveFraction: 0,
          meanPositiveEdgeUsdc: null,
          maxPositiveEdgeUsdc: null,
          longestPositiveRunTicks: 0,
          capturableFraction: 0,
          captureLatencyTicks: 2,
        },
        bootstrap: { netPnl: { estimate: 0, ciLow: 0, ciHigh: 0 }, hitRate: null },
        attribution: [],
        notes: [
          "NOT RUN: a random-direction baseline requires modifying strategy/orchestrator code (direction is signal-derived by design). Recorded as an open question instead of being faked.",
        ],
      });
      continue;
    }
    console.log(`running config ${config.id}: ${config.label} ...`);
    const fv2Gate = config.v2 ? (config.forceGateOpen ? fv2GatesForcedOpen : fv2Gates) : undefined;
    const result = runOneConfig(
      config,
      dataset,
      holdoutStartMs,
      windowEndMs,
      calibrationUsed,
      fv2Gate,
      args.bootstrapIterations,
      args.seed,
    );
    console.log(
      `  ${config.id}: submits=${result.stats.submits} fills=${result.stats.fills} netPnL=${result.stats.netPnlUsdc} spent=${result.stats.spentUsdc} orphans=${result.stats.orphanedMarkets}`,
    );
    results.push(result);
  }

  // --- T7 phase-multiplier comparison --------------------------------------
  // Phase multipliers scale the DIRECTIONAL target only (edge/Kelly sizing is
  // deliberately multiplier-free — see packages/inventory/src/rebalancing.ts),
  // so the comparison runs under config B (directional sizing + pessimistic
  // fills) where the curve is actually in effect. Config C's curves are
  // identical by construction and are not re-run.
  const phaseComparison: { curve: string; netPnlUsdc: string; fills: number; submits: number }[] =
    [];
  for (const curve of ["canonical", "flat", "reversed"] as const) {
    const env = { ...envFor(CONFIGS[1]!), STRATEGY_PHASE_MULTIPLIERS: curve };
    const cfg = loadConfig(env);
    const run = runBacktest(dataset, {
      config: cfg,
      windowStartMs: millis(holdoutStartMs),
      windowEndMs: millis(windowEndMs),
      tickMs: 30_000,
      fillModel: "pessimistic",
      submitLatencyMs: 250,
      cancelLatencyMs: 250,
      signalConfig: DATASET_SIGNAL_CONFIG,
    });
    phaseComparison.push({
      curve,
      netPnlUsdc: decToString(run.netPnlUsdc),
      fills: run.fills.length,
      submits: run.decisions.filter((d) => d.action === "submit_order").length,
    });
    console.log(
      `  phase curve ${curve}: netPnL=${decToString(run.netPnlUsdc)} fills=${run.fills.length}`,
    );
  }

  // --- Sensitivity (config C, one factor at a time) ------------------------
  const sensitivity: { name: string; netPnlUsdc: string; fills: number; submits: number }[] = [];
  for (const spec of SENSITIVITY_SPECS) {
    const env = { ...envFor(CONFIGS[2]!) };
    if (spec.takerRateOverride !== undefined) env["FEE_TAKER_RATE"] = spec.takerRateOverride;
    if (spec.tradeThroughOverride !== undefined)
      env["EXECUTION_TRADE_THROUGH"] = spec.tradeThroughOverride;
    if (spec.queuePositionFactorOverride !== undefined)
      env["EXECUTION_QUEUE_POSITION_FACTOR"] = spec.queuePositionFactorOverride;
    if (spec.adverseMoveThresholdOverride !== undefined)
      env["EXECUTION_ADVERSE_MOVE_THRESHOLD"] = spec.adverseMoveThresholdOverride;
    const cfg = loadConfig(env);
    const run = runBacktest(dataset, {
      config: cfg,
      windowStartMs: millis(holdoutStartMs),
      windowEndMs: millis(windowEndMs),
      tickMs: 30_000,
      fillModel: "pessimistic",
      submitLatencyMs: spec.submitLatencyMs,
      cancelLatencyMs: spec.submitLatencyMs,
      signalConfig: DATASET_SIGNAL_CONFIG,
      ...(calibrationUsed !== undefined ? { calibration: calibrationUsed } : {}),
    });
    sensitivity.push({
      name: spec.name,
      netPnlUsdc: decToString(run.netPnlUsdc),
      fills: run.fills.length,
      submits: run.decisions.filter((d) => d.action === "submit_order").length,
    });
    console.log(
      `  sensitivity ${spec.name}: netPnL=${decToString(run.netPnlUsdc)} fills=${run.fills.length}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    datasetPath: args.datasetPath,
    dataset: {
      schema: dataset.schema,
      provenance: dataset.provenance,
      holdoutMarkets: dataset.markets.filter((m) => Number(m.startMs) >= holdoutStartMs).length,
      trainingMarkets: dataset.markets.filter((m) => Number(m.startMs) < trainingEndMs).length,
      marketsPerAsset: Object.fromEntries(
        dataset.provenance.assets.map((a) => [
          a,
          dataset.markets.filter((m) => m.asset === a && Number(m.startMs) >= holdoutStartMs)
            .length,
        ]),
      ),
    },
    holdout: { startMs: holdoutStartMs, endMs: windowEndMs },
    training: { startMs: windowStartMs, endMs: trainingEndMs },
    calibrationInfo,
    calibrationQuality,
    fv2Gates: fv2Gates,
    configs: results,
    phaseComparison,
    sensitivity,
    sensitivityNotes: {
      latency:
        "fill events in this harness are all-or-nothing per tick at a fixed tick grid; 100 ms vs 500 ms submit latency never changes which tick an order fills on, so the factor is INERT here — a tick-level replay with real depth is needed to measure latency sensitivity",
      adverseSelection:
        "adverse-moveThreshold relaxes the trade-through requirement when mid drifts against a resting order; the runner refreshes books BEFORE the orchestrator submits and orders rest at most one tick, so the adverse-relaxation path never triggers in this replay — the factor is INERT here and real adverse selection is UNDER-modeled",
    },
    settings: {
      sizingShared: {
        maxResidualShares: 20,
        maxOrderSizeShares: 50,
        maxTotalCapitalUsdc: 100,
        kellyFraction: 0.25,
        minEdge: 0.01,
      },
      fills: {
        model: "pessimistic (A optimistic)",
        tradeThrough: 0.001,
        queuePositionFactor: 0.5,
        adverseMoveThreshold: 0.01,
        submitLatencyMs: 250,
        cancelLatencyMs: 250,
      },
      fees: {
        takerRate: 0.07,
        takerOnly: true,
        source: "docs/RESOLUTION_AND_FEES.md (verified 2026-09-29)",
      },
      fv2: {
        probabilityModel: "transparent bounded additive (docs/STRATEGY_V2.md §3)",
        gateThresholds: {
          maxBrier: DEFAULT_GATE_CONFIG.maxBrier,
          maxLogLoss: DEFAULT_GATE_CONFIG.maxLogLoss,
        },
        minMispricing: 0.01,
        buffers: { slippage: 0.003, adverse: 0.003, uncertainty: 0.003 },
        bookEvidence: "dormant — schema-1 dataset carries no order-book depth (honest degradation)",
        gateDisclosure:
          "gate set from hold-out aggregate skill (see fv2Gates note above); E2 is the forced-open counterfactual",
      },
      tickMs: 30_000,
      signalEngine:
        "dataset-cadence rescale (returnLookbackMs 300000, volatilityLookbackMs 600000, rangeLookbackMs 900000, maxDataAgeMs 300000) — disclosed deviation; production default untouched",
    },
    gitCommit: process.env["BACKTEST_GIT_COMMIT"] ?? "unknown",
  };

  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(report, null, 2));
  console.log(`report written: ${args.outPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
