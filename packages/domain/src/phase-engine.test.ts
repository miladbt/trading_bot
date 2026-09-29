import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHASE_BOUNDARIES as B,
  clampClockSkew,
  cycleTimeline,
  msRemaining,
  cyclePhaseAt,
  cyclePositionOf,
  phaseSchedule,
  validateBoundaries,
  validateTimeline,
  type PhaseBoundaries,
} from "./phase-engine.js";
import { millis } from "./time.js";

// Fixed 5-minute cycle: 12:00:00.000 -> 12:05:00.000 UTC (pure numbers).
const START = 1_800_000_000_000;
const END = START + 300_000;

/** Expected absolute boundaries with the default 50/75/90 split. */
const MID = START + 150_000; // 2:30
const LATE = START + 225_000; // 3:45
const FINAL = START + 270_000; // 4:30

describe("validateTimeline", () => {
  it("accepts a well-formed cycle", () => {
    const r = validateTimeline({ startMs: millis(START), endMs: millis(END) });
    expect(r.ok).toBe(true);
  });

  it("rejects missing start/end", () => {
    const noStart = validateTimeline({ endMs: millis(END) });
    expect(noStart.ok).toBe(false);
    if (!noStart.ok) expect(noStart.error.reason).toBe("missing_start");

    const noEnd = validateTimeline({ startMs: millis(START) });
    expect(noEnd.ok).toBe(false);
    if (!noEnd.ok) expect(noEnd.error.reason).toBe("missing_end");
  });

  it("rejects end <= start", () => {
    const r = validateTimeline({ startMs: millis(END), endMs: millis(START) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("invalid_range");
  });
});

describe("validateBoundaries", () => {
  it("rejects out-of-range or non-monotonic boundaries", () => {
    expect(validateBoundaries({ mid: 0, late: 0.75, final: 0.9 }).ok).toBe(false);
    expect(validateBoundaries({ mid: 0.5, late: 1, final: 0.9 }).ok).toBe(false);
    expect(validateBoundaries({ mid: 0.8, late: 0.75, final: 0.9 }).ok).toBe(false);
    expect(validateBoundaries({ mid: 0.5, late: 0.75, final: Number.NaN }).ok).toBe(false);
  });
});

describe("phaseAt — boundary conditions (default 50/75/90)", () => {
  it.each([
    ["exactly at start", START, "EARLY"],
    ["1ms before mid", MID - 1, "EARLY"],
    ["exactly at mid (belongs to the later phase)", MID, "MID"],
    ["1ms before late", LATE - 1, "MID"],
    ["exactly at late", LATE, "LATE"],
    ["1ms before final", FINAL - 1, "LATE"],
    ["exactly at final", FINAL, "FINAL"],
    ["1ms before end", END - 1, "FINAL"],
    ["exactly at end", END, "FINAL"],
  ])("%s", (_label, at, expected) => {
    const r = cyclePhaseAt({ startMs: millis(START), endMs: millis(END) }, B, millis(at));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(expected);
  });

  it("rejects timestamps outside the cycle", () => {
    const tl = { startMs: millis(START), endMs: millis(END) };
    const before = cyclePhaseAt(tl, B, millis(START - 1));
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error.reason).toBe("invalid_range");

    const after = cyclePhaseAt(tl, B, millis(END + 1));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.reason).toBe("invalid_range");
  });

  it("rejects invalid boundary configs", () => {
    const tl = { startMs: millis(START), endMs: millis(END) };
    const bad: PhaseBoundaries = { mid: 0.9, late: 0.5, final: 0.4 };
    const r = cyclePhaseAt(tl, bad, millis(START + 1000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("invalid_boundaries");
  });
});

describe("phaseAt — duration independence", () => {
  it("produces identical relative phases for a 60s compressed cycle", () => {
    const short = { startMs: millis(START), endMs: millis(START + 60_000) };
    // 50% boundary of the 60s cycle
    const r = cyclePhaseAt(short, B, millis(START + 30_000));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("MID");
  });
});

describe("phaseOfMoment", () => {
  const tl = { startMs: millis(START), endMs: millis(END) };

  it("models before/after explicitly", () => {
    const before = cyclePositionOf(tl, B, millis(START - 1));
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.value).toBe("before");

    const after = cyclePositionOf(tl, B, millis(END + 1));
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toBe("after");
  });

  it("agrees with phaseAt inside the cycle", () => {
    const r = cyclePositionOf(tl, B, millis(MID + 1));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("MID");
  });
});

describe("phaseSchedule", () => {
  it("materializes absolute boundary timestamps", () => {
    const s = phaseSchedule({ startMs: millis(START), endMs: millis(END) }, B);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.value.startMs).toBe(START);
      expect(s.value.midMs).toBe(MID);
      expect(s.value.lateMs).toBe(LATE);
      expect(s.value.finalMs).toBe(FINAL);
      expect(s.value.endMs).toBe(END);
    }
  });
});

describe("msRemaining", () => {
  it("counts down inside the cycle and clamps outside", () => {
    const tl = { startMs: millis(START), endMs: millis(END) };
    const rem = (at: number): number => {
      const r = msRemaining(tl, millis(at));
      if (!r.ok) throw new Error(r.error.detail);
      return r.value;
    };
    expect(rem(START)).toBe(300_000);
    expect(rem(MID)).toBe(150_000);
    expect(rem(END - 1)).toBe(1);
    expect(rem(END)).toBe(0);
    expect(rem(START - 5_000)).toBe(300_000); // before: full
    expect(rem(END + 5_000)).toBe(0); // after: zero
  });
});

describe("cycleTimeline", () => {
  it("wraps validation and rejects missing values", () => {
    expect(cycleTimeline(START, END).ok).toBe(true);
    const missing = cycleTimeline(undefined, END);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.reason).toBe("missing_start");
  });
});

describe("clampClockSkew", () => {
  const NOW = millis(START);
  it("passes through timestamps within the skew window", () => {
    expect(clampClockSkew(START - 2_000, NOW, 5_000)).toBe(START - 2_000);
    expect(clampClockSkew(START + 2_000, NOW, 5_000)).toBe(START + 2_000);
  });

  it("clamps timestamps beyond the skew window to the edges", () => {
    expect(clampClockSkew(START - 60_000, NOW, 5_000)).toBe(START - 5_000);
    expect(clampClockSkew(START + 60_000, NOW, 5_000)).toBe(START + 5_000);
  });

  it("is exact at the window edges", () => {
    expect(clampClockSkew(START - 5_000, NOW, 5_000)).toBe(START - 5_000);
    expect(clampClockSkew(START + 5_000, NOW, 5_000)).toBe(START + 5_000);
  });
});
