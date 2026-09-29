/**
 * Probability calibration (T2).
 *
 * Maps a raw model score (the signal engine's `probabilityUp`, itself the
 * symmetric transform of the aggregate direction — see
 * `packages/strategy/src/engine/engine.ts`) to a *calibrated* probability
 * that the 5-minute window closes Up, fitted ONLY on labelled training data
 * (outcome 1 = window closed Up, 0 = closed Down).
 *
 * Two pure, deterministic fitters are provided:
 * - `fitBinnedCalibration` — equal-width bins over the raw score, each bin
 *   mapped to its empirical Up-frequency (Laplace-smoothed, empty bins
 *   bridged, and a monotonicity repair pass so the mapping is
 *   non-decreasing in the score).
 * - `fitIsotonicCalibration` — pool-adjacent-violators (PAVA) isotonic
 *   regression on the labelled samples (tied raw scores pooled first so the
 *   fit is a proper function of the raw value), minimizing squared error
 *   subject to a non-decreasing mapping.
 *
 * The fitted mapping is serialized as **versioned JSON** (`schema: 1`) and
 * loaded at runtime by the orchestrator when `CALIBRATION_FILE` points at a
 * file; without one the engine's raw prior is used unchanged.
 *
 * Evaluation utilities: Brier score, log loss (clipped), and the reliability
 * table (which doubles as the calibration-plot data: bin center, mean
 * predicted, observed frequency, count).
 *
 * Honesty rules: fitting and scoring are pure and deterministic; nothing here
 * reads a clock, a file, or the network. Fit statistics use floats — allowed
 * for statistics (AGENTS.md) — but the mapping's OUTPUT crosses back into the
 * money path only through the existing Decimal boundary
 * (`decFromString(p.toFixed(8))` in the orchestrator), which is where sizing
 * math stays exact.
 */

import type { Millis } from "@bot/domain";

// ---------------------------------------------------------------------------
// Versioned serialization schema
// ---------------------------------------------------------------------------

/** Current serialized-model schema version. Bump on any breaking shape change. */
export const CALIBRATION_SCHEMA_VERSION = 1;

/** One reliability-table row (also the calibration plot data). */
export interface ReliabilityBin {
  /** Bin index (0-based, ordered by increasing score). */
  readonly index: number;
  /** Half-open score range of the bin: [lower, upper). */
  readonly lower: number;
  readonly upper: number;
  /** Midpoint of the bin's score range (plot x-coordinate). */
  readonly center: number;
  /** Mean raw score of the samples that fell in this bin (bin center when unknown). */
  readonly meanRaw: number;
  /** Mean predicted probability of the samples in this bin. */
  readonly meanPredicted: number;
  /** Observed Up frequency of the samples in this bin. */
  readonly observed: number;
  /** Sample count (0 for an empty bin). */
  readonly count: number;
}

/** One step of the mapping: scores in [lower, upper) map to `value`. */
export interface CalibrationStep {
  readonly lower: number;
  readonly upper: number;
  readonly value: number;
}

/**
 * The fitted calibration model — plain immutable data, JSON-serializable.
 * `evaluateCalibration(model, raw)` is the piecewise-constant function defined
 * by the `bins` bands (non-decreasing in `raw` by construction).
 */
export interface CalibrationModel {
  /** Serialization schema version (currently 1). */
  readonly schema: number;
  /** Semantic version of the model artifact (fit pipeline version). */
  readonly version: string;
  /** Which fitter produced this mapping. */
  readonly method: "binned" | "isotonic";
  /** Free-form label, e.g. "BTC" or "btc-5m-v1". */
  readonly asset: string;
  /** Raw-score domain the model was fitted on. */
  readonly scoreRange: { readonly min: number; readonly max: number };
  /** Non-decreasing bands: calibrated value per raw-score interval. */
  readonly bins: readonly CalibrationStep[];
  /** Fitted-on metadata (walk-forward discipline evidence). */
  readonly fit: {
    readonly sampleCount: number;
    /** First/last sample time (UTC ms) used for the fit, when known. */
    readonly firstAt: number | undefined;
    readonly lastAt: number | undefined;
    readonly brier: number;
    readonly logLoss: number;
    readonly reliability: readonly ReliabilityBin[];
  };
}

/** A labelled training sample: raw score -> realized window outcome. */
export interface CalibrationSample {
  /** Raw model score (the signal's uncalibrated `probabilityUp`). */
  readonly raw: number;
  /** 1 = the 5-minute window closed Up, 0 = closed Down. */
  readonly outcome: 0 | 1;
  /** Sample time (UTC ms); used for provenance metadata only. */
  readonly at?: Millis | undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireFinite(name: string, x: number): void {
  if (!Number.isFinite(x)) {
    throw new RangeError(`calibration: ${name} must be finite, got ${String(x)}`);
  }
}

function requireUnitInterval(name: string, x: number): void {
  requireFinite(name, x);
  if (x < 0 || x > 1) {
    throw new RangeError(`calibration: ${name} must be in [0, 1], got ${String(x)}`);
  }
}

function requireSamples(samples: readonly CalibrationSample[]): void {
  if (samples.length === 0) {
    throw new RangeError("calibration: at least one sample is required to fit");
  }
  for (const s of samples) {
    requireUnitInterval("raw score", s.raw);
    if (s.outcome !== 0 && s.outcome !== 1) {
      throw new RangeError("calibration: outcome must be 0 or 1");
    }
  }
}

// ---------------------------------------------------------------------------
// Binned reliability mapping
// ---------------------------------------------------------------------------

/**
 * Fit an equal-width binned reliability mapping. Each bin's value is the
 * Laplace-smoothed empirical Up frequency `(ups + 1) / (count + 2)`; empty
 * bins are forward-filled from their left neighbour (overall prior 0.5 when
 * the whole domain is empty), and a final pass enforces non-decreasing values
 * so the mapping is monotone even when a low bin empirically outperformed.
 *
 * Deterministic: identical inputs produce identical outputs.
 */
export function fitBinnedCalibration(input: {
  readonly samples: readonly CalibrationSample[];
  readonly bins: number;
  readonly asset: string;
  readonly version?: string;
  /** Fixed score domain; defaults to the observed sample min/max. */
  readonly scoreMin?: number;
  readonly scoreMax?: number;
}): CalibrationModel {
  const { samples, asset } = input;
  if (!Number.isInteger(input.bins) || input.bins < 2) {
    throw new RangeError("calibration: bins must be an integer >= 2");
  }
  requireSamples(samples);

  const scoreMin = input.scoreMin ?? Math.min(...samples.map((s) => s.raw));
  const scoreMax = input.scoreMax ?? Math.max(...samples.map((s) => s.raw));
  requireFinite("scoreMin", scoreMin);
  requireFinite("scoreMax", scoreMax);
  if (scoreMax <= scoreMin) {
    throw new RangeError("calibration: scoreMax must be > scoreMin");
  }

  const width = (scoreMax - scoreMin) / input.bins;
  const ups = new Array<number>(input.bins).fill(0);
  const totals = new Array<number>(input.bins).fill(0);

  for (const s of samples) {
    let b = Math.floor((s.raw - scoreMin) / width);
    if (b >= input.bins) b = input.bins - 1; // scoreMax sentinel goes to the last bin
    if (b < 0) b = 0;
    totals[b] = (totals[b] ?? 0) + 1;
    if (s.outcome === 1) ups[b] = (ups[b] ?? 0) + 1;
  }

  // Laplace-smoothed empirical frequency per bin, then repair.
  const smoothed = ups.map((u, i) => (u + 1) / ((totals[i] ?? 0) + 2));
  const values = smoothed.slice();
  let lastKnown = 0.5;
  for (let i = 0; i < input.bins; i++) {
    if ((totals[i] ?? 0) > 0) lastKnown = smoothed[i] ?? 0.5;
    values[i] = lastKnown;
  }
  for (let i = input.bins - 2; i >= 0; i--) {
    const v = values[i] ?? 0.5;
    if (v > (values[i + 1] ?? 0.5)) values[i] = values[i + 1] ?? 0.5;
  }

  const bins: CalibrationStep[] = values.map((value, i) => ({
    lower: scoreMin + i * width,
    upper: scoreMin + (i + 1) * width,
    value,
  }));

  const calibratedSamples = samples.map((s) => ({
    raw: s.raw,
    outcome: s.outcome,
    predicted: evaluateSteps(bins, scoreMin, scoreMax, s.raw),
    at: s.at,
  }));

  return finalizeModel({
    method: "binned",
    asset,
    version: input.version ?? "0.1.0",
    scoreRange: { min: scoreMin, max: scoreMax },
    bins,
    samples: calibratedSamples,
  });
}

// ---------------------------------------------------------------------------
// Isotonic regression (pool-adjacent-violators, weighted squared error)
// ---------------------------------------------------------------------------

/**
 * Fit a monotone non-decreasing mapping with PAVA. Tied raw scores are pooled
 * first (mean outcome per distinct raw), so the fit is a proper function of
 * the raw value; the result is the least-squares best non-decreasing step
 * function. Below the lowest and above the highest fitted score the mapping
 * is flat (clamped to the first/last band values).
 *
 * Deterministic: identical inputs produce identical outputs.
 */
export function fitIsotonicCalibration(input: {
  readonly samples: readonly CalibrationSample[];
  readonly asset: string;
  readonly version?: string;
}): CalibrationModel {
  const { samples, asset } = input;
  requireSamples(samples);

  // 1) Pool tied raw scores: distinct raw -> mean outcome, sample weight.
  const byRaw = new Map<number, { ySum: number; n: number }>();
  for (const s of samples) {
    const entry = byRaw.get(s.raw);
    if (entry === undefined) {
      byRaw.set(s.raw, { ySum: s.outcome, n: 1 });
    } else {
      entry.ySum += s.outcome;
      entry.n += 1;
    }
  }
  const distinct = [...byRaw.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([raw, agg]) => ({ raw, value: agg.ySum / agg.n, weight: agg.n }));

  // 2) PAVA over the distinct raws (weighted mean merge on violations).
  const blocks: { startIndex: number; value: number; weight: number }[] = [];
  for (let i = 0; i < distinct.length; i++) {
    const d = distinct[i];
    if (d === undefined) continue;
    let value = d.value;
    let weight = d.weight;
    let startIndex = i;
    while (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last === undefined || last.value <= value) break;
      blocks.pop();
      const totalWeight = last.weight + weight;
      value = (last.value * last.weight + value * weight) / totalWeight;
      weight = totalWeight;
      startIndex = last.startIndex;
    }
    blocks.push({ startIndex, value, weight });
  }

  // 3) Blocks -> contiguous half-open bands [startRaw, nextStartRaw).
  const rawMin = distinct[0]?.raw ?? 0;
  const rawMax = distinct[distinct.length - 1]?.raw ?? 1;
  const bins: CalibrationStep[] = blocks.map((block, i) => {
    const start = distinct[block.startIndex]?.raw ?? rawMin;
    const next = blocks[i + 1];
    const upper = next === undefined ? rawMax : (distinct[next.startIndex]?.raw ?? rawMax);
    return { lower: start, upper, value: block.value };
  });

  const calibratedSamples = samples.map((s) => ({
    raw: s.raw,
    outcome: s.outcome,
    predicted: evaluateSteps(bins, rawMin, rawMax, s.raw),
    at: s.at,
  }));

  return finalizeModel({
    method: "isotonic",
    asset,
    version: input.version ?? "0.1.0",
    scoreRange: { min: rawMin, max: rawMax },
    bins,
    samples: calibratedSamples,
  });
}

// ---------------------------------------------------------------------------
// Runtime lookup
// ---------------------------------------------------------------------------

/**
 * Evaluate the mapping for one raw score: the value of the band containing it
 * (`lower <= raw < upper`, scanned from the top). Scores at/below
 * `scoreRange.min` clamp to the first band's value; scores at/above
 * `scoreRange.max` clamp to the last's. The result is clamped into [0, 1].
 */
export function evaluateCalibration(model: CalibrationModel, raw: number): number {
  requireFinite("raw score", raw);
  return evaluateSteps(model.bins, model.scoreRange.min, model.scoreRange.max, raw);
}

function evaluateSteps(
  bins: readonly CalibrationStep[],
  min: number,
  max: number,
  raw: number,
): number {
  if (bins.length === 0) return clamp01(raw);
  if (raw <= min) return clamp01(bins[0]?.value ?? raw);
  if (raw >= max) return clamp01(bins[bins.length - 1]?.value ?? raw);
  // Containing band (bands are contiguous for both fitters; scan guards
  // against gaps anyway).
  for (let i = bins.length - 1; i >= 0; i--) {
    const step = bins[i];
    if (step !== undefined && raw >= step.lower && raw < step.upper) {
      return clamp01(step.value);
    }
  }
  // Gap fallback: highest band whose upper bound exceeds the score.
  for (let i = bins.length - 1; i >= 0; i--) {
    const step = bins[i];
    if (step !== undefined && raw < step.upper) return clamp01(step.value);
  }
  return clamp01(bins[bins.length - 1]?.value ?? raw);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}

// ---------------------------------------------------------------------------
// Metrics: Brier, log loss, reliability table
// ---------------------------------------------------------------------------

/** Mean squared error between prediction and outcome, in [0, 1]. */
export function brierScore(pairs: readonly { predicted: number; outcome: 0 | 1 }[]): number {
  if (pairs.length === 0) throw new RangeError("calibration: no samples to score");
  let sum = 0;
  for (const p of pairs) {
    requireUnitInterval("predicted", p.predicted);
    sum += (p.predicted - p.outcome) ** 2;
  }
  return sum / pairs.length;
}

/** Mean log loss with predictions clipped to [eps, 1-eps] (never infinite). */
export function logLoss(pairs: readonly { predicted: number; outcome: 0 | 1 }[]): number {
  const eps = 1e-12;
  if (pairs.length === 0) throw new RangeError("calibration: no samples to score");
  let sum = 0;
  for (const p of pairs) {
    requireUnitInterval("predicted", p.predicted);
    const clamped = Math.min(1 - eps, Math.max(eps, p.predicted));
    sum += -(p.outcome * Math.log(clamped) + (1 - p.outcome) * Math.log(1 - clamped));
  }
  return sum / pairs.length;
}

/**
 * Reliability table over equal-width bins of the *predicted* probability:
 * per bin, mean prediction vs observed frequency vs count. This doubles as
 * the calibration-plot data (x = meanPredicted, y = observed, size = count).
 */
export function reliabilityTable(
  pairs: readonly { predicted: number; outcome: 0 | 1 }[],
  binCount: number,
): readonly ReliabilityBin[] {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError("calibration: binCount must be an integer >= 1");
  }
  const width = 1 / binCount;
  const rows: {
    index: number;
    lower: number;
    upper: number;
    predictedSum: number;
    outcomeSum: number;
    count: number;
  }[] = [];
  for (let i = 0; i < binCount; i++) {
    rows.push({
      index: i,
      lower: i * width,
      upper: (i + 1) * width,
      predictedSum: 0,
      outcomeSum: 0,
      count: 0,
    });
  }
  for (const p of pairs) {
    let b = Math.floor(p.predicted / width);
    if (b >= binCount) b = binCount - 1; // predicted == 1 sentinel
    if (b < 0) b = 0;
    const row = rows[b];
    if (row === undefined) continue;
    row.predictedSum += p.predicted;
    row.outcomeSum += p.outcome;
    row.count += 1;
  }
  return rows.map((r) => ({
    index: r.index,
    lower: r.lower,
    upper: r.upper,
    center: r.lower + width / 2,
    meanRaw: r.lower + width / 2,
    meanPredicted: r.count > 0 ? r.predictedSum / r.count : 0,
    observed: r.count > 0 ? r.outcomeSum / r.count : 0,
    count: r.count,
  }));
}

// ---------------------------------------------------------------------------
// Model finalization + (de)serialization
// ---------------------------------------------------------------------------

function finalizeModel(input: {
  method: "binned" | "isotonic";
  asset: string;
  version: string;
  scoreRange: { min: number; max: number };
  bins: readonly CalibrationStep[];
  samples: readonly { raw: number; outcome: 0 | 1; predicted: number; at?: Millis | undefined }[];
}): CalibrationModel {
  const pairs = input.samples.map((s) => ({ predicted: s.predicted, outcome: s.outcome }));
  const times = input.samples.map((s) => s.at).filter((t): t is Millis => t !== undefined);
  const reliability = reliabilityTable(pairs, Math.min(10, Math.max(1, input.samples.length)));
  return {
    schema: CALIBRATION_SCHEMA_VERSION,
    version: input.version,
    method: input.method,
    asset: input.asset,
    scoreRange: input.scoreRange,
    bins: input.bins,
    fit: {
      sampleCount: input.samples.length,
      firstAt: times.length > 0 ? Math.min(...times.map(Number)) : undefined,
      lastAt: times.length > 0 ? Math.max(...times.map(Number)) : undefined,
      brier: brierScore(pairs),
      logLoss: logLoss(pairs),
      reliability,
    },
  };
}

/**
 * Serialize the model to the versioned JSON string. Deterministic ordering;
 * floats are stored with full double precision (JSON numbers).
 */
export function serializeCalibration(model: CalibrationModel): string {
  return JSON.stringify(model, null, 2);
}

/** Parse and validate a serialized model; throws on any shape violation. */
export function deserializeCalibration(json: string): CalibrationModel {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CalibrationFormatError("calibration JSON must be an object");
  }
  const m = parsed as Record<string, unknown>;
  if (m["schema"] !== CALIBRATION_SCHEMA_VERSION) {
    throw new CalibrationFormatError(
      `calibration: unsupported schema ${String(m["schema"])} (expected ${CALIBRATION_SCHEMA_VERSION})`,
    );
  }
  if (typeof m["version"] !== "string" || m["version"].length === 0) {
    throw new CalibrationFormatError("calibration: version must be a non-empty string");
  }
  if (m["method"] !== "binned" && m["method"] !== "isotonic") {
    throw new CalibrationFormatError('calibration: method must be "binned" or "isotonic"');
  }
  if (typeof m["asset"] !== "string") {
    throw new CalibrationFormatError("calibration: asset must be a string");
  }
  const range = m["scoreRange"] as Record<string, unknown> | undefined;
  if (
    range === undefined ||
    typeof range !== "object" ||
    range === null ||
    Array.isArray(range) ||
    typeof range["min"] !== "number" ||
    typeof range["max"] !== "number"
  ) {
    throw new CalibrationFormatError("calibration: scoreRange {min, max} is required");
  }
  if (!Array.isArray(m["bins"]) || m["bins"].length === 0) {
    throw new CalibrationFormatError("calibration: bins must be a non-empty array");
  }
  const bins: CalibrationStep[] = [];
  for (const rawStep of m["bins"]) {
    if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
      throw new CalibrationFormatError("calibration: each bin must be an object");
    }
    const step = rawStep as Record<string, unknown>;
    if (
      typeof step["lower"] !== "number" ||
      typeof step["upper"] !== "number" ||
      typeof step["value"] !== "number"
    ) {
      throw new CalibrationFormatError("calibration: each bin needs numeric lower/upper/value");
    }
    requireUnitInterval("bin value", step["value"]);
    bins.push({ lower: step["lower"], upper: step["upper"], value: step["value"] });
  }
  const fit = m["fit"] as Record<string, unknown> | undefined;
  if (fit === undefined || typeof fit !== "object" || Array.isArray(fit)) {
    throw new CalibrationFormatError("calibration: fit block is required");
  }
  if (typeof fit["sampleCount"] !== "number" || fit["sampleCount"] < 1) {
    throw new CalibrationFormatError("calibration: fit.sampleCount must be a positive number");
  }
  if (typeof fit["brier"] !== "number" || typeof fit["logLoss"] !== "number") {
    throw new CalibrationFormatError("calibration: fit.brier/logLoss must be numbers");
  }
  const model: CalibrationModel = {
    schema: CALIBRATION_SCHEMA_VERSION,
    version: m["version"],
    method: m["method"],
    asset: m["asset"],
    scoreRange: { min: range["min"], max: range["max"] },
    bins,
    fit: {
      sampleCount: fit["sampleCount"],
      firstAt: typeof fit["firstAt"] === "number" ? fit["firstAt"] : undefined,
      lastAt: typeof fit["lastAt"] === "number" ? fit["lastAt"] : undefined,
      brier: fit["brier"],
      logLoss: fit["logLoss"],
      reliability: Array.isArray(fit["reliability"])
        ? (fit["reliability"] as ReliabilityBin[])
        : [],
    },
  };
  // Sanity: the deserialized model must evaluate to valid probabilities.
  evaluateCalibration(model, model.scoreRange.min);
  evaluateCalibration(model, model.scoreRange.max);
  return model;
}

/** Error type for malformed serialized models (kept local; no domain dep). */
export class CalibrationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationFormatError";
  }
}
