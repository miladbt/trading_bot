/**
 * Complete-set accumulation engine.
 *
 * Concept: 1 Up + 1 Down = 1 complete set, and a set always settles to exactly
 * 1 USDC (the winning token pays 1, the losing token pays 0). The strategy
 * seeks inventory states where `up cost + down cost` is below the expected
 * settlement value after all applicable costs.
 *
 * This module is the lot-level complement of `@bot/domain`'s per-set parity
 * helpers (`setCost`/`mergeProfit`): instead of best-quote snapshots, it works
 * on *acquisition lots* — the actual fills the account is holding — and matches
 * them FIFO (earliest-acquired first) into complete sets.
 *
 * Guarantees:
 * - Pure and deterministic: no clock reads, no I/O, no randomness; the same
 *   inputs always produce the same result. Inputs are never mutated.
 * - Partial matching: a lot may be consumed across several sets; the leftover
 *   quantity stays in the residuals.
 * - Unmatched inventory is preserved: residual lots describe exactly what is
 *   still held, nothing is dropped.
 * - The engine never forces neutrality: when one side outnumbers the other,
 *   the surplus remains as directional (orphan) inventory.
 * - All financial math is BigInt-based `Decimal` (8 dp) — never floats.
 *
 * Fee/rebate amortization: each matched portion of a lot carries its pro-rata
 * share of the whole lot's fee/rebate (`fee * matchedQty / lotQty`), rounded
 * half-away-from-zero at 8 dp per lot. Totals are the exact sum of those
 * rounded shares, so the identity
 * `grossPairCost + fees - rebates == netPairCost` always holds exactly.
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decDivRound,
  decIsZero,
  decMin,
  decMulRound,
  decOne,
  decSub,
  decToString,
  decZero,
  type Decimal,
  type Outcome,
} from "@bot/domain";

import { createAcquisitionLot, type AcquisitionLot } from "./lot.js";

export type { AcquisitionLot, CreateAcquisitionLotInput } from "./lot.js";
export { createAcquisitionLot, lotGrossCost, lotNetCost } from "./lot.js";

/** A complete set always settles to exactly this value (1 USDC by default). */
export const DEFAULT_SETTLEMENT_VALUE: Decimal = decOne();

const ZERO = decZero();

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One lot's contribution to the matched sets, in FIFO match order. */
export interface MatchedLotPortion {
  readonly lotId: string;
  readonly outcome: Outcome;
  readonly marketId: string;
  readonly tokenId: string;
  /** Total quantity of this lot consumed by the matched sets. */
  readonly qty: Decimal;
}

/**
 * Per-portfolio cost breakdown of the matched sets, grouped by
 * (market, side, price per unit). Totals are exact:
 * `grossPairCost + fees - rebates == netPairCost`.
 */
export interface CompleteSetPortfolio {
  readonly name: string;
  readonly marketId: string;
  readonly side: Outcome;
  readonly pricePerUnit: Decimal;
  /** Matched quantity in shares of this portfolio (1 set needs 1 up + 1 down). */
  readonly qty: Decimal;
  /** Gross acquisition cost: sum of pricePerUnit * matched qty across lots. */
  readonly grossPairCost: Decimal;
  /** Fees attributable to the matched quantity (amortized, rounded at 8 dp). */
  readonly fees: Decimal;
  /** Rebates attributable to the matched quantity (amortized, rounded at 8 dp). */
  readonly rebates: Decimal;
  /** Net cost after costs: grossPairCost + fees - rebates (exact identity). */
  readonly netPairCost: Decimal;
  /** Lot-level contributions, in match order. */
  readonly lots: readonly MatchedLotPortion[];
}

/** The outcome of matching up lots against down lots into complete sets. */
export interface CompleteSetMatchResult {
  /** Matched-set quantity: the size of the smaller side (1 set = 1 up + 1 down). */
  readonly matchedSets: Decimal;
  /** Cost of the up shares consumed by the matched sets (price only). */
  readonly upCost: Decimal;
  /** Cost of the down shares consumed by the matched sets (price only). */
  readonly downCost: Decimal;
  /** upCost + downCost. */
  readonly grossPairCost: Decimal;
  /** Fees attributable to the matched quantity. */
  readonly fees: Decimal;
  /** Rebates attributable to the matched quantity. */
  readonly rebates: Decimal;
  /** grossPairCost + fees - rebates. */
  readonly netPairCost: Decimal;
  /** Aggregate expected settlement value: settlementValue * matchedSets. */
  readonly expectedSettlementValue: Decimal;
  /** expectedSettlementValue - grossPairCost (positive = gross arbitrage). */
  readonly grossEdge: Decimal;
  /** expectedSettlementValue - netPairCost (positive = net arbitrage). */
  readonly netEdge: Decimal;
  /** Leftover up inventory — preserved, never force-neutralized. */
  readonly residualUp: Decimal;
  /** Leftover down inventory — preserved, never force-neutralized. */
  readonly residualDown: Decimal;
  /** Residual lots (unconsumed remainders of the input lots), FIFO order. */
  readonly residualUpLots: readonly AcquisitionLot[];
  readonly residualDownLots: readonly AcquisitionLot[];
  /** One portfolio per matched (market, side, price) grouping. */
  readonly perPortfolio: readonly CompleteSetPortfolio[];
  /** Matched portions per lot, FIFO match order. */
  readonly matchedUpLots: readonly MatchedLotPortion[];
  readonly matchedDownLots: readonly MatchedLotPortion[];
  /** Expected settlement value per set (1 USDC by default). */
  readonly settlementValue: Decimal;
}

export interface MatchCompleteSetsInput {
  readonly upLots: readonly AcquisitionLot[];
  readonly downLots: readonly AcquisitionLot[];
  /**
   * Expected value of one complete set at settlement, in USDC. A set always
   * pays exactly 1 USDC, so the default is 1; injectable for exactness tests
   * or venue-specific payout quirks.
   */
  readonly settlementValue?: Decimal | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sort lots FIFO: by acquisition instant, then by original position for ties,
 * so ordering is fully deterministic even when lots share a timestamp.
 */
function fifoSort(lots: readonly AcquisitionLot[]): readonly AcquisitionLot[] {
  return lots
    .map((lot, index) => ({ lot, index }))
    .sort((a, b) => {
      if (a.lot.acquiredAt !== b.lot.acquiredAt) return a.lot.acquiredAt - b.lot.acquiredAt;
      return a.index - b.index;
    })
    .map((entry) => entry.lot);
}

function assertSameMarket(side: Outcome, lots: readonly AcquisitionLot[]): void {
  const first = lots[0];
  if (first === undefined) return;
  for (const lot of lots) {
    if (lot.marketId !== first.marketId) {
      throw new ValidationError(
        `all ${side} lots must belong to the same market: found ${String(lot.marketId)} and ${String(first.marketId)}`,
      );
    }
    if (lot.outcome !== side) {
      throw new ValidationError(
        `expected every ${side} lot to have outcome "${side}", but lot "${lot.lotId}" has outcome "${lot.outcome}"`,
      );
    }
  }
}

/** A lot plus the quantity the matcher has not consumed from it yet. */
interface LotCursor {
  readonly lot: AcquisitionLot;
  remaining: Decimal;
}

function recordMatchedPortion(
  portions: Map<string, MatchedLotPortion>,
  lot: AcquisitionLot,
  qty: Decimal,
): void {
  const existing = portions.get(lot.lotId);
  if (existing !== undefined) {
    portions.set(lot.lotId, { ...existing, qty: decAdd(existing.qty, qty) });
    return;
  }
  portions.set(lot.lotId, {
    lotId: lot.lotId,
    outcome: lot.outcome,
    marketId: String(lot.marketId),
    tokenId: String(lot.tokenId),
    qty,
  });
}

/**
 * Cost accumulator for one (market, side, price) grouping. Fee/rebate shares
 * are amortized per matched portion (rounded) and summed, keeping the exact
 * gross + fees - rebates == net identity.
 */
interface ConsumedPortfolio {
  readonly marketId: string;
  readonly side: Outcome;
  readonly price: Decimal;
  qty: Decimal;
  gross: Decimal;
  fees: Decimal;
  rebates: Decimal;
  readonly lots: Map<string, MatchedLotPortion>;
}

function accumulatePortfolio(
  portfolios: Map<string, ConsumedPortfolio>,
  lot: AcquisitionLot,
  qty: Decimal,
  isUp: boolean,
): void {
  const key = `${String(lot.marketId)}|${isUp ? "up" : "down"}|${decToString(lot.pricePerUnit)}`;
  let portfolio = portfolios.get(key);
  if (portfolio === undefined) {
    portfolio = {
      marketId: String(lot.marketId),
      side: isUp ? "up" : "down",
      price: lot.pricePerUnit,
      qty: ZERO,
      gross: ZERO,
      fees: ZERO,
      rebates: ZERO,
      lots: new Map<string, MatchedLotPortion>(),
    };
    portfolios.set(key, portfolio);
  }
  portfolio.qty = decAdd(portfolio.qty, qty);
  portfolio.gross = decAdd(portfolio.gross, decMulRound(lot.pricePerUnit, qty));
  // Pro-rata fee/rebate for this portion: fee * qty / lotQty, rounded at 8 dp.
  portfolio.fees = decAdd(portfolio.fees, decDivRound(decMulRound(lot.fee, qty), lot.qty));
  portfolio.rebates = decAdd(portfolio.rebates, decDivRound(decMulRound(lot.rebate, qty), lot.qty));
  recordMatchedPortion(portfolio.lots, lot, qty);
}

/** The all-zero result used when either side has no lots to match. */
function zeroResult(
  upLots: readonly AcquisitionLot[],
  downLots: readonly AcquisitionLot[],
  settlementValue: Decimal,
): CompleteSetMatchResult {
  let residualUp = ZERO;
  for (const lot of upLots) residualUp = decAdd(residualUp, lot.qty);
  let residualDown = ZERO;
  for (const lot of downLots) residualDown = decAdd(residualDown, lot.qty);
  return {
    matchedSets: ZERO,
    upCost: ZERO,
    downCost: ZERO,
    grossPairCost: ZERO,
    fees: ZERO,
    rebates: ZERO,
    netPairCost: ZERO,
    expectedSettlementValue: ZERO,
    grossEdge: ZERO,
    netEdge: ZERO,
    residualUp,
    residualDown,
    residualUpLots: upLots,
    residualDownLots: downLots,
    perPortfolio: [],
    matchedUpLots: [],
    matchedDownLots: [],
    settlementValue,
  };
}

function assembleResult(args: {
  matchedSets: Decimal;
  upCost: Decimal;
  downCost: Decimal;
  portfolios: Map<string, ConsumedPortfolio>;
  matchedUp: Map<string, MatchedLotPortion>;
  matchedDown: Map<string, MatchedLotPortion>;
  residualUpLots: readonly AcquisitionLot[];
  residualDownLots: readonly AcquisitionLot[];
  settlementValue: Decimal;
}): CompleteSetMatchResult {
  const {
    matchedSets,
    upCost,
    downCost,
    portfolios,
    matchedUp,
    matchedDown,
    residualUpLots,
    residualDownLots,
    settlementValue,
  } = args;

  const grossPairCost = decAdd(upCost, downCost);
  let fees = ZERO;
  let rebates = ZERO;
  const perPortfolio: CompleteSetPortfolio[] = [];

  // Deterministic portfolio order regardless of match insertion order.
  const ordered = [...portfolios.values()].sort((a, b) => {
    if (a.marketId !== b.marketId) return a.marketId < b.marketId ? -1 : 1;
    if (a.side !== b.side) return a.side === "up" ? -1 : 1;
    if (a.price !== b.price) return a.price < b.price ? -1 : 1;
    return 0;
  });
  for (const p of ordered) {
    fees = decAdd(fees, p.fees);
    rebates = decAdd(rebates, p.rebates);
    const net = decSub(decAdd(p.gross, p.fees), p.rebates);
    perPortfolio.push({
      name: `${p.marketId} ${p.side} @ ${decToString(p.price)}`,
      marketId: p.marketId,
      side: p.side,
      pricePerUnit: p.price,
      qty: p.qty,
      grossPairCost: p.gross,
      fees: p.fees,
      rebates: p.rebates,
      netPairCost: net,
      lots: [...p.lots.values()],
    });
  }

  const netPairCost = decSub(decAdd(grossPairCost, fees), rebates);
  const expectedSettlementValue = decMulRound(settlementValue, matchedSets);

  let residualUp = ZERO;
  for (const lot of residualUpLots) residualUp = decAdd(residualUp, lot.qty);
  let residualDown = ZERO;
  for (const lot of residualDownLots) residualDown = decAdd(residualDown, lot.qty);

  return {
    matchedSets,
    upCost,
    downCost,
    grossPairCost,
    fees,
    rebates,
    netPairCost,
    expectedSettlementValue,
    grossEdge: decSub(expectedSettlementValue, grossPairCost),
    netEdge: decSub(expectedSettlementValue, netPairCost),
    residualUp,
    residualDown,
    residualUpLots,
    residualDownLots,
    perPortfolio,
    matchedUpLots: [...matchedUp.values()],
    matchedDownLots: [...matchedDown.values()],
    settlementValue,
  };
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Match up lots against down lots into complete sets, FIFO by acquisition
 * time, consuming lots partially as needed. Returns the matched-set quantity,
 * the cost breakdown (gross, fees, rebates, net) with both edges against the
 * expected settlement value, and the preserved residual inventory.
 *
 * The engine does NOT force neutrality: surplus inventory on either side stays
 * in the residuals untouched. Inputs are never mutated.
 */
export function matchCompleteSets(input: MatchCompleteSetsInput): CompleteSetMatchResult {
  const { upLots, downLots } = input;
  const settlementValue = input.settlementValue ?? DEFAULT_SETTLEMENT_VALUE;
  if (decCompare(settlementValue, ZERO) <= 0) {
    throw new ValidationError("settlement value must be positive");
  }

  // Validate (and clone) all inputs up front so the engine is safe even if a
  // lot was hand-constructed instead of built via the smart constructor.
  const upSorted = fifoSort(upLots.map((lot) => createAcquisitionLot({ ...lot })));
  const downSorted = fifoSort(downLots.map((lot) => createAcquisitionLot({ ...lot })));

  assertSameMarket("up", upSorted);
  assertSameMarket("down", downSorted);
  const firstUp = upSorted[0];
  const firstDown = downSorted[0];
  if (firstUp !== undefined && firstDown !== undefined && firstUp.marketId !== firstDown.marketId) {
    throw new ValidationError(
      `up and down lots must belong to the same market: ${String(firstUp.marketId)} vs ${String(firstDown.marketId)}`,
    );
  }

  // Either side empty: nothing can match; inventory is fully preserved.
  if (upSorted.length === 0 || downSorted.length === 0) {
    return zeroResult(upSorted, downSorted, settlementValue);
  }

  const upCur: LotCursor[] = upSorted.map((lot) => ({ lot, remaining: lot.qty }));
  const downCur: LotCursor[] = downSorted.map((lot) => ({ lot, remaining: lot.qty }));

  let upIdx = 0;
  let downIdx = 0;
  let upEntry: LotCursor | undefined = upCur[0];
  let downEntry: LotCursor | undefined = downCur[0];
  let upRemaining: Decimal = upEntry === undefined ? ZERO : upEntry.remaining;
  let downRemaining: Decimal = downEntry === undefined ? ZERO : downEntry.remaining;

  const matchedUp = new Map<string, MatchedLotPortion>();
  const matchedDown = new Map<string, MatchedLotPortion>();
  const portfolios = new Map<string, ConsumedPortfolio>();
  let matchedSets = ZERO;
  let upCost = ZERO;
  let downCost = ZERO;

  while (upEntry !== undefined && downEntry !== undefined) {
    const pairQty = decMin(upRemaining, downRemaining);
    if (decIsZero(pairQty)) break;

    const upLot = upEntry.lot;
    const downLot = downEntry.lot;
    matchedSets = decAdd(matchedSets, pairQty);
    upCost = decAdd(upCost, decMulRound(upLot.pricePerUnit, pairQty));
    downCost = decAdd(downCost, decMulRound(downLot.pricePerUnit, pairQty));
    recordMatchedPortion(matchedUp, upLot, pairQty);
    recordMatchedPortion(matchedDown, downLot, pairQty);
    accumulatePortfolio(portfolios, upLot, pairQty, true);
    accumulatePortfolio(portfolios, downLot, pairQty, false);

    upRemaining = decSub(upRemaining, pairQty);
    downRemaining = decSub(downRemaining, pairQty);
    // Write the leftovers back so the residual builder sees post-match state.
    if (upEntry !== undefined) upEntry.remaining = upRemaining;
    if (downEntry !== undefined) downEntry.remaining = downRemaining;

    if (decIsZero(upRemaining)) {
      upIdx += 1;
      const next = upCur[upIdx];
      upEntry = next;
      upRemaining = next === undefined ? ZERO : next.remaining;
    }
    if (decIsZero(downRemaining)) {
      downIdx += 1;
      const next = downCur[downIdx];
      downEntry = next;
      downRemaining = next === undefined ? ZERO : next.remaining;
    }
  }

  // Residuals: whatever the matcher did not consume, exactly as held.
  const residualUpLots: AcquisitionLot[] = [];
  for (const entry of upCur) {
    if (!decIsZero(entry.remaining)) residualUpLots.push({ ...entry.lot, qty: entry.remaining });
  }
  const residualDownLots: AcquisitionLot[] = [];
  for (const entry of downCur) {
    if (!decIsZero(entry.remaining)) residualDownLots.push({ ...entry.lot, qty: entry.remaining });
  }

  return assembleResult({
    matchedSets,
    upCost,
    downCost,
    portfolios,
    matchedUp,
    matchedDown,
    residualUpLots,
    residualDownLots,
    settlementValue,
  });
}
