/**
 * Evidence builders: turn raw observation series into the fair-value engine's
 * Dormant/available evidence inputs.
 *
 * Pure and deterministic. Statistics are floats (AGENTS.md allows this for
 * analysis inside packages that do not touch the money path directly); the
 * orchestrator converts the OUTPUT back into the Decimal world through the
 * standard `decFromString(p.toFixed(8))` boundary.
 *
 * Cadence honesty: the committed dataset carries one underlying anchor per
 * 5-minute window (the Chainlink settlement chain), so intra-window momentum
 * and volatility acceleration are UNOBSERVABLE on it — the builders mark
 * those components dormant rather than fabricating sub-window values. A
 * denser series (recorded spot feed) automatically activates them.
 */

/** One (time, price) observation, epoch ms + positive price. */
export interface Obs {
  readonly t: number;
  readonly price: number;
}

/** Time-ordered (ascending `t`) observations covering the model's lookback. */
export type Series = readonly Obs[];

/** Windowed per-minute realized drift (slope) of the series, or dormant. */
export function momentumPerMin(series: Series, now: number, lookbackMs: number): DormantInput {
  const win = series.filter((o) => o.t <= now && o.t > now - lookbackMs);
  if (win.length < 2) return DORMANT;
  const first = win[0]!;
  const last = win[win.length - 1]!;
  const dtMin = (last.t - first.t) / 60_000;
  if (dtMin <= 0 || first.price <= 0) return DORMANT;
  return { available: true, value: (last.price - first.price) / first.price / dtMin };
}

/** Relative distance of spot from the strike (priceToBeat): (spot − strike)/strike. */
export function anchorDistFrac(spot: number, priceToBeat: number): DormantInput {
  if (!Number.isFinite(spot) || !Number.isFinite(priceToBeat) || priceToBeat <= 0) return DORMANT;
  return { available: true, value: (spot - priceToBeat) / priceToBeat };
}

/**
 * Volatility acceleration: change in per-minute realized stdev between the
 * most recent half of the window and the half before it. Dormant unless the
 * window holds enough independent observations (>= 4) — on the 5-minute
 * anchor cadence it stays dormant, by design.
 */
export function volAccelPerMin2(series: Series, now: number, lookbackMs: number): DormantInput {
  const win = series.filter((o) => o.t <= now && o.t > now - lookbackMs);
  if (win.length < 4) return DORMANT;
  const mid = win[Math.floor(win.length / 2)]!.t;
  const recent = win.filter((o) => o.t >= mid);
  const earlier = win.filter((o) => o.t < mid);
  const r = stdevPerMin(recent, lookbackMs / 2);
  const e = stdevPerMin(earlier, lookbackMs / 2);
  if (r === undefined || e === undefined) return DORMANT;
  return { available: true, value: r - e };
}

function stdevPerMin(win: Series, windowMs: number): number | undefined {
  if (win.length < 2) return undefined;
  const rets: number[] = [];
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1]!;
    const cur = win[i]!;
    if (prev.price <= 0) continue;
    rets.push((cur.price - prev.price) / prev.price);
  }
  if (rets.length < 1) return undefined;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const minutes = Math.max(windowMs / 60_000, 1 / 60);
  // Per-minute stdev scale (random-walk scaling), de-annualized to the window.
  return Math.sqrt(variance) / Math.sqrt(minutes);
}

// Local shape mirror (avoids exporting the engine's internals twice).
interface DormantInput {
  readonly available: boolean;
  readonly value: number;
}

const DORMANT: DormantInput = { available: false, value: 0 };
