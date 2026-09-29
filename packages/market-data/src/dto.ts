/**
 * Defensive accessors for Gamma API market DTOs.
 *
 * The Gamma API returns loosely typed JSON: several fields are stringified
 * JSON arrays (`clobTokenIds`, `outcomes`, `outcomePrices`), ids are numeric
 * strings, and absent fields come back as null/undefined inconsistently. These
 * accessors never throw and never trust shape; the market parser turns their
 * findings into typed failures.
 *
 * Field-name reference (public docs, verified 2026-09): id, slug, question,
 * conditionId, clobTokenIds, outcomes, outcomePrices, closed, active,
 * startDate, endDate, gameStartTime, umaResolutionStatuses.
 */

export interface ParsedTokenIds {
  readonly up: string | undefined;
  readonly down: string | undefined;
}

export interface TimingFields {
  readonly startDate: Date | undefined;
  readonly endDate: Date | undefined;
  /** Event start (sports-style cycles); takes precedence when present. */
  readonly gameStartTime: Date | undefined;
}

export interface ResolutionFields {
  readonly closed: boolean | undefined;
  readonly active: boolean | undefined;
  readonly winningOutcome: string | undefined;
  readonly oracleSource: string | undefined;
}

/** Parse a stringified-JSON-array field into string[]. */
function parseStringifiedArray(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") {
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return undefined;
  }
}

export function dtoId(dto: Record<string, unknown>): string | undefined {
  const v = dto["id"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function dtoSlug(dto: Record<string, unknown>): string | undefined {
  const v = dto["slug"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function dtoQuestion(dto: Record<string, unknown>): string | undefined {
  const v = dto["question"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function dtoConditionId(dto: Record<string, unknown>): string | undefined {
  const v = dto["conditionId"];
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v;
}

/**
 * Extract the up/down CLOB token ids. `clobTokenIds` is positional (index 0 =
 * first outcome, index 1 = second) and pairs with the stringified `outcomes`
 * array ("Up"/"Down" — case-insensitive — per docs; "Yes"/"No" variants are
 * mapped by position only when the labels are unrecognizable).
 */
export function dtoTokenIds(dto: Record<string, unknown>): ParsedTokenIds {
  const tokens = parseStringifiedArray(dto["clobTokenIds"]);
  const labels = parseStringifiedArray(dto["outcomes"])?.map((s) => s.trim().toLowerCase());

  if (tokens === undefined || tokens.length < 2) {
    return { up: undefined, down: undefined };
  }
  if (labels !== undefined && labels.length >= 2) {
    const upIdx = labels.findIndex((l) => l === "up" || l === "yes" || l === "higher");
    const downIdx = labels.findIndex((l) => l === "down" || l === "no" || l === "lower");
    if (upIdx >= 0 && downIdx >= 0 && upIdx !== downIdx) {
      const up = tokens[upIdx];
      const down = tokens[downIdx];
      return { up, down };
    }
  }
  // Positional fallback: 0 = up, 1 = down.
  return { up: tokens[0], down: tokens[1] };
}

export function dtoTiming(dto: Record<string, unknown>): TimingFields {
  const toMillis = (key: string): Date | undefined => {
    const v = dto[key];
    if (typeof v !== "string" || v.length === 0) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return {
    startDate: toMillis("startDate"),
    endDate: toMillis("endDate"),
    gameStartTime: toMillis("gameStartTime"),
  };
}

export function dtoResolution(dto: Record<string, unknown>): ResolutionFields {
  const boolOf = (key: string): boolean | undefined =>
    typeof dto[key] === "boolean" ? dto[key] : undefined;
  const strOf = (key: string): string | undefined => {
    const v = dto[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  // Winner: prefer explicit outcome fields; fall back to outcomePrices when
  // exactly one side is 1 (fully resolved binary market).
  let winner = strOf("winningOutcome");
  if (winner === undefined) {
    const prices = parseStringifiedArray(dto["outcomePrices"]);
    if (prices !== undefined && prices.length === 2) {
      const one = prices.filter((p) => p === "1" || p === "1.0" || p === "1.00");
      if (one.length === 1) {
        winner = prices[0] === "1" || prices[0] === "1.0" || prices[0] === "1.00" ? "up" : "down";
      }
    }
  }
  const oracleSource =
    strOf("resolutionSource") ??
    strOf("umaResolutionStatus") ??
    (Array.isArray(dto["umaResolutionStatuses"])
      ? undefined
      : typeof dto["umaResolutionStatuses"] === "string"
        ? dto["umaResolutionStatuses"]
        : undefined);
  return {
    closed: boolOf("closed"),
    active: boolOf("active"),
    winningOutcome: winner,
    oracleSource,
  };
}
