/**
 * Canonical 5-minute market phase engine.
 *
 * The single source of truth for the EARLY/MID/LATE/FINAL progression within a
 * market's cycle. Strategy, inventory, and risk must all derive their view of
 * "where are we in the cycle" from here — never from their own arithmetic
 * (requirement 2: never duplicate phase logic elsewhere).
 *
 * Model: a cycle is [startMs, endMs). Phase boundaries are *fractions* of the
 * cycle, so the engine is duration-agnostic (a 5-minute market and a 1-minute
 * replay behave identically). Boundary semantics: a boundary timestamp belongs
 * to the LATER phase — [start, mid) EARLY, [mid, late) MID, [late, final)
 * LATE, [final, end] FINAL.
 *
 * Clock skew (requirement 3): comparisons are made against an explicit
 * `nowMs` parameter supplied by the caller, never a clock read. The caller may
 * pass a skew-corrected value; `clampClockSkew` helps bound a peer-provided
 * timestamp to a trusted window.
 *
 * Missing timestamps (requirement 4): unknown start/end are a typed
 * `PhaseEngineError` (Result), not an exception and never a guessed phase.
 */

import { ok, err, type Result } from "./result.js";
import type { Millis } from "./brand.js";

/** The four canonical phases of a 5-minute cycle. */
export type CyclePhase = "EARLY" | "MID" | "LATE" | "FINAL";

export const CYCLE_PHASES: readonly CyclePhase[] = ["EARLY", "MID", "LATE", "FINAL"] as const;

/**
 * Phase boundaries as fractions of the cycle duration, in (0, 1).
 * Defaults: EARLY = first half, MID = next quarter, LATE = next eighth of the
 * remaining time... concretely: mid at 50%, late at 75%, final at 90%.
 */
export interface PhaseBoundaries {
  /** EARLY -> MID transition, fraction of cycle (0 < mid < 1). */
  readonly mid: number;
  /** MID -> LATE transition, fraction of cycle (mid < late < 1). */
  readonly late: number;
  /** LATE -> FINAL transition, fraction of cycle (late < final < 1). */
  readonly final: number;
}

/**
 * Inert, documented defaults: 50% / 75% / 90%. Configurable per deployment
 * (see @bot/shared MARKET_* phase settings) but fixed per engine instance.
 */
export const DEFAULT_PHASE_BOUNDARIES: PhaseBoundaries = {
  mid: 0.5,
  late: 0.75,
  final: 0.9,
} as const;

/** Typed failure reasons for phase computation. */
export type PhaseErrorReason =
  "missing_start" | "missing_end" | "invalid_range" | "invalid_boundaries";

export interface PhaseError {
  readonly reason: PhaseErrorReason;
  readonly detail: string;
}

function phaseError(reason: PhaseErrorReason, detail: string): Result<never, PhaseError> {
  return err({ reason, detail });
}

/** A market's cycle timeline: start and end in UTC epoch ms. */
export interface CycleTimeline {
  /** Cycle open (trading window start). */
  readonly startMs: Millis;
  /** Cycle end (settlement). */
  readonly endMs: Millis;
}

/** Validate a timeline: both timestamps present, end strictly after start. */
export function validateTimeline(
  timeline: Partial<CycleTimeline>,
): Result<CycleTimeline, PhaseError> {
  if (timeline.startMs === undefined) {
    return phaseError("missing_start", "cycle start timestamp is missing");
  }
  if (timeline.endMs === undefined) {
    return phaseError("missing_end", "cycle end timestamp is missing");
  }
  if (!(timeline.startMs < timeline.endMs)) {
    return phaseError(
      "invalid_range",
      `cycle end (${timeline.endMs}) must be after start (${timeline.startMs})`,
    );
  }
  return ok({ startMs: timeline.startMs, endMs: timeline.endMs });
}

/** Validate boundaries: strictly increasing fractions in (0, 1). */
export function validateBoundaries(
  boundaries: PhaseBoundaries,
): Result<PhaseBoundaries, PhaseError> {
  const { mid, late, final } = boundaries;
  const inRange = (x: number) => Number.isFinite(x) && x > 0 && x < 1;
  if (!inRange(mid) || !inRange(late) || !inRange(final)) {
    return phaseError("invalid_boundaries", "boundaries must be fractions in (0, 1)");
  }
  if (!(mid < late && late < final)) {
    return phaseError(
      "invalid_boundaries",
      `boundaries must satisfy mid < late < final (${mid} < ${late} < ${final})`,
    );
  }
  return ok(boundaries);
}

/**
 * Classify a timestamp against a validated timeline. Pure; `atMs` is an
 * explicit parameter (clock-skew safe by construction — no clock reads).
 * Semantics: boundary instants belong to the later phase; endMs is FINAL.
 */
export function cyclePhaseAt(
  timeline: CycleTimeline,
  boundaries: PhaseBoundaries,
  atMs: Millis,
): Result<CyclePhase, PhaseError> {
  const valid = validateBoundaries(boundaries);
  if (!valid.ok) return valid;

  const start = timeline.startMs as unknown as number;
  const end = timeline.endMs as unknown as number;
  const at = atMs as unknown as number;
  const duration = end - start;

  // Before the cycle opens and after settlement: no phase exists. Callers use
  // `phaseOfMoment` when they need the pre/post states modeled explicitly.
  if (at < start) {
    return phaseError("invalid_range", `timestamp ${at} is before cycle start ${start}`);
  }
  if (at > end) {
    return phaseError("invalid_range", `timestamp ${at} is after cycle end ${end}`);
  }

  const midMs = start + boundaries.mid * duration;
  const lateMs = start + boundaries.late * duration;
  const finalMs = start + boundaries.final * duration;

  if (at < midMs) return ok("EARLY");
  if (at < lateMs) return ok("MID");
  if (at < finalMs) return ok("LATE");
  return ok("FINAL");
}

/** Full position model including before/after the cycle. */
export type CyclePosition = "before" | CyclePhase | "after";

/** Position of a moment relative to the cycle, including before/after. */
export function cyclePositionOf(
  timeline: CycleTimeline,
  boundaries: PhaseBoundaries,
  atMs: Millis,
): Result<CyclePosition, PhaseError> {
  const valid = validateBoundaries(boundaries);
  if (!valid.ok) return valid;
  const at = atMs as unknown as number;
  const start = timeline.startMs as unknown as number;
  const end = timeline.endMs as unknown as number;
  if (at < start) return ok("before");
  if (at > end) return ok("after");
  const p = cyclePhaseAt(timeline, boundaries, atMs);
  return p.ok ? ok(p.value) : p;
}

/**
 * Compute the timeline from explicit start/end.
 * Convenience wrapper that runs validation once.
 */
export function cycleTimeline(
  startMs: number | Millis | undefined,
  endMs: number | Millis | undefined,
): Result<CycleTimeline, PhaseError> {
  if (startMs === undefined) {
    return phaseError("missing_start", "cycle start timestamp is missing");
  }
  if (endMs === undefined) {
    return phaseError("missing_end", "cycle end timestamp is missing");
  }
  return validateTimeline({ startMs: startMs as Millis, endMs: endMs as Millis });
}

/** Absolute boundary timestamps of a timeline (for logging/monitoring). */
export interface PhaseSchedule {
  readonly startMs: Millis;
  readonly midMs: Millis;
  readonly lateMs: Millis;
  readonly finalMs: Millis;
  readonly endMs: Millis;
}

/** Materialize the phase schedule (rounded down to the ms). Pure. */
export function phaseSchedule(
  timeline: CycleTimeline,
  boundaries: PhaseBoundaries,
): Result<PhaseSchedule, PhaseError> {
  const valid = validateBoundaries(boundaries);
  if (!valid.ok) return valid;
  const start = timeline.startMs as unknown as number;
  const end = timeline.endMs as unknown as number;
  const duration = end - start;
  const round = (x: number): Millis => Math.floor(x) as Millis;
  return ok({
    startMs: timeline.startMs,
    midMs: round(start + boundaries.mid * duration),
    lateMs: round(start + boundaries.late * duration),
    finalMs: round(start + boundaries.final * duration),
    endMs: timeline.endMs,
  });
}

/** Milliseconds remaining until settlement (never negative inside the cycle). */
export function msRemaining(timeline: CycleTimeline, atMs: Millis): Result<number, PhaseError> {
  const at = atMs as unknown as number;
  const end = timeline.endMs as unknown as number;
  const start = timeline.startMs as unknown as number;
  if (at < start) return ok(end - start);
  if (at > end) return ok(0);
  return ok(end - at);
}

/**
 * Clamp a peer-reported timestamp into a trusted window around local now:
 * timestamps further than `maxSkewMs` from `nowMs` are pulled to the nearest
 * edge. Returns the clamped value. Pure; helps when consuming venue event
 * times that may drift from the local clock.
 */
export function clampClockSkew(peerMs: number, nowMs: Millis, maxSkewMs: number): Millis {
  const now = nowMs as unknown as number;
  if (peerMs < now - maxSkewMs) return (now - maxSkewMs) as Millis;
  if (peerMs > now + maxSkewMs) return (now + maxSkewMs) as Millis;
  return peerMs as Millis;
}
