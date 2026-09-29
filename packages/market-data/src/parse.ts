/**
 * Market parser: raw venue record -> validated `DiscoveredMarket`.
 *
 * Every failure mode is a typed `ParseFailure` inside a `Result` — malformed
 * markets never throw, never reach the strategy, and never crash discovery.
 * Metadata validation (requirement 6) lives here: the market is only produced
 * when ids, both token ids, and a sane 5-minute time window are present.
 *
 * The settlement oracle is never assumed: whatever the venue reports in
 * resolution-source fields is recorded verbatim or left undefined.
 */

import {
  millis,
  createMarket,
  ok,
  err,
  type Market,
  type MarketId,
  type Millis,
  type Result,
} from "@bot/domain";

import {
  dtoConditionId,
  dtoId,
  dtoQuestion,
  dtoResolution,
  dtoSlug,
  dtoTiming,
  dtoTokenIds,
} from "./dto.js";
import {
  DEFAULT_DISCOVERY_POLICY,
  type DiscoveredMarket,
  type DiscoveryPolicy,
  type MarketStatus,
  type ParseFailure,
  type RawMarketRecord,
  type ResolutionMetadata,
} from "./types.js";

function fail(reason: ParseFailure["reason"], detail: string): Result<never, ParseFailure> {
  return err({ reason, detail });
}

/** Derive the asset from slug/question text; unknown or ambiguous are rejected. */
function deriveAsset(slug: string, question: string | undefined): "BTC" | "ETH" | undefined {
  const hay = `${slug} ${question ?? ""}`.toLowerCase();
  const btc = hay.includes("btc") || hay.includes("bitcoin");
  const eth = hay.includes("eth") || hay.includes("ethereum");
  if (btc && !eth) return "BTC";
  if (eth && !btc) return "ETH";
  return undefined; // ambiguous or unrelated
}

function withinTolerance(actualMs: number, targetMs: number, tolerancePct: number): boolean {
  if (targetMs <= 0) return false;
  const ratio = Math.abs(actualMs - targetMs) / targetMs;
  return ratio <= tolerancePct;
}

/**
 * Choose the cycle start: gameStartTime (event-style cycles) when present,
 * otherwise startDate.
 */
function cycleStart(t: {
  startDate: Date | undefined;
  gameStartTime: Date | undefined;
}): Date | undefined {
  return t.gameStartTime ?? t.startDate;
}

export interface ParsedMarketParts {
  readonly meta: {
    readonly marketId: MarketId;
    readonly conditionId: string | undefined;
    readonly upTokenId: string;
    readonly downTokenId: string;
    readonly slug: string;
    readonly asset: "BTC" | "ETH";
    readonly openAt: Millis;
    readonly liveAt: Millis;
    readonly settleAt: Millis;
  };
  readonly status: MarketStatus;
  readonly resolution: ResolutionMetadata;
}

/**
 * Normalize one raw record. Returns the parsed parts (domain construction is
 * the caller's final step) or a typed failure.
 */
export function parseRawMarket(
  record: RawMarketRecord,
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
  now: Millis = millis(Date.now()),
): Result<ParsedMarketParts, ParseFailure> {
  const dto = record.payload;
  if (typeof dto !== "object" || dto === null || Array.isArray(dto)) {
    return fail("not_an_object", "market payload is not an object");
  }
  const obj = dto as Record<string, unknown>;

  const id = dtoId(obj);
  if (id === undefined) {
    return fail("missing_id", "market payload has no usable id");
  }

  const slug = dtoSlug(obj) ?? `market-${id}`;
  const question = dtoQuestion(obj);

  const tokens = dtoTokenIds(obj);
  if (tokens.up === undefined || tokens.down === undefined) {
    return fail("missing_tokens", `market ${id} lacks a complete up/down token pair`);
  }
  if (tokens.up === tokens.down) {
    return fail("invalid_tokens", `market ${id} has identical up and down token ids`);
  }

  const asset = deriveAsset(slug, question);
  if (asset === undefined) {
    return fail("invalid_shape", `market ${id} is not a BTC or ETH 5-minute market`);
  }

  const timing = dtoTiming(obj);
  const start = cycleStart(timing);
  const end = timing.endDate;
  if (start === undefined || end === undefined) {
    return fail("invalid_timing", `market ${id} lacks start/end times`);
  }
  const openAtMs = start.getTime();
  const settleAtMs = end.getTime();
  if (!(openAtMs < settleAtMs)) {
    return fail("invalid_timing", `market ${id} has end before start`);
  }
  if (!withinTolerance(settleAtMs - openAtMs, policy.cycleMs, policy.durationTolerancePct)) {
    return fail(
      "invalid_timing",
      `market ${id} duration ${settleAtMs - openAtMs}ms is not a ~${policy.cycleMs}ms cycle`,
    );
  }

  // Expired filter: anything that ended before now - maxAge is skipped.
  if (settleAtMs + policy.maxAgeMs < now) {
    return fail("invalid_timing", `market ${id} expired too long ago to be useful`);
  }

  const resolution = dtoResolution(obj);
  const closed = resolution.closed ?? false;
  const active = resolution.active ?? true;
  const status: MarketStatus = closed ? "closed" : active ? "active" : "expired";

  const liveOffset = Math.min(policy.liveOffsetMs, settleAtMs - openAtMs - 1);

  return ok({
    meta: {
      marketId: id as MarketId,
      conditionId: dtoConditionId(obj),
      upTokenId: tokens.up,
      downTokenId: tokens.down,
      slug,
      asset,
      openAt: millis(openAtMs),
      liveAt: millis(openAtMs + liveOffset),
      settleAt: millis(settleAtMs),
    },
    status,
    resolution: {
      winningOutcome:
        resolution.winningOutcome === "up" ||
        resolution.winningOutcome === "down" ||
        resolution.winningOutcome === "voided"
          ? resolution.winningOutcome
          : undefined,
      oracleSource: resolution.oracleSource,
      resolvedAt: closed ? record.fetchedAt : undefined,
    },
  });
}

/**
 * Build the domain `Market` from parsed parts. Wraps domain validation errors
 * into the same Result shape (belt and braces: timing was pre-validated).
 */
export function toDiscoveredMarket(
  parts: ParsedMarketParts,
  discoveredAt: Millis,
): Result<DiscoveredMarket, ParseFailure> {
  try {
    const market: Market = createMarket({
      id: parts.meta.marketId,
      slug: parts.meta.slug,
      asset: parts.meta.asset,
      openAt: parts.meta.openAt,
      liveAt: parts.meta.liveAt,
      settleAt: parts.meta.settleAt,
      upTokenId: parts.meta.upTokenId,
      downTokenId: parts.meta.downTokenId,
      phase: "announced",
    });
    return ok({
      market,
      conditionId: parts.meta.conditionId,
      status: parts.status,
      resolution: parts.resolution,
      discoveredAt,
    });
  } catch (e: unknown) {
    return fail("invalid_shape", e instanceof Error ? e.message : String(e));
  }
}

/**
 * One-shot convenience: parse and build. Used by the discovery client; kept
 * separate from `parseRawMarket` so tests can inspect intermediate parts.
 */
export function normalizeMarket(
  record: RawMarketRecord,
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
  now: Millis = millis(Date.now()),
): Result<DiscoveredMarket, ParseFailure> {
  const parts = parseRawMarket(record, policy, now);
  if (!parts.ok) return parts;
  return toDiscoveredMarket(parts.value, record.fetchedAt);
}
