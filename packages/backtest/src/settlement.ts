/**
 * Settlement (T10): applies the verified resolution outcome (T3: Chainlink
 * TWAP; ties resolve Up) to held lots at market expiry, in exact Decimal.
 * Winners pay 1 USDC per share; losers pay 0 (their cost is the loss).
 */

import { decAdd, decFromString, type Decimal } from "@bot/domain";
import { matchCompleteSets, type AcquisitionLot } from "@bot/inventory";

import type { BacktestMarket } from "./dataset.js";
import type { BacktestAdapterState } from "./ports.js";

export interface SettlementResult {
  readonly slug: string;
  readonly outcome: "UP" | "DOWN";
  readonly payout: Decimal;
}

/**
 * Settle one market: converts held lots into their settlement cash value
 * (winner pays 1/share, loser 0), removes them from the lot state, and
 * returns the payout (negative when a loser's cost was already spent — the
 * payout itself is 0; cost accounting happens at fill time).
 */
export function settleMarket(
  market: BacktestMarket,
  state: BacktestAdapterState,
): SettlementResult {
  const held = state.lots.get(market.slug) ?? { up: [], down: [] };
  const match = matchCompleteSets({
    upLots: held.up as readonly AcquisitionLot[],
    downLots: held.down as readonly AcquisitionLot[],
    settlementValue: decFromString("1"),
  });

  const upShares = match.residualUp;
  const downShares = match.residualDown;
  const sets = match.matchedSets;

  // Complete sets pay exactly 1 USDC each regardless of outcome (capital-
  // neutral); residuals pay only if their side won.
  const winnerShares = market.resolution.outcome === "UP" ? upShares : downShares;
  const payout = decAdd(sets, winnerShares);

  // Remove settled lots from state (the market is gone after expiry).
  state.lots.set(market.slug, { up: [], down: [] });

  return { slug: market.slug, outcome: market.resolution.outcome, payout };
}
