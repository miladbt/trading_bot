/**
 * Settlement (T10): applies the verified resolution outcome (T3: Chainlink
 * TWAP; ties resolve Up) to held lots at market expiry, in exact Decimal.
 * Winners pay 1 USDC per share; losers pay 0 (their cost is the loss).
 */

import {
  decAdd,
  decCompare,
  decFromString,
  decMulRound,
  decSub,
  decZero,
  type Decimal,
} from "@bot/domain";
import { matchCompleteSets, type AcquisitionLot } from "@bot/inventory";

import type { BacktestMarket } from "./dataset.js";
import type { BacktestAdapterState } from "./ports.js";

export interface SettlementResult {
  readonly slug: string;
  readonly asset: "BTC" | "ETH";
  readonly outcome: "UP" | "DOWN";
  /** Cash received at settlement (complete sets pay 1/set; winners 1/share). */
  readonly payout: Decimal;
  /** Exact USDC cost paid at fill time for every share in this market. */
  readonly costUsdc: Decimal;
  /** Exact USDC fees paid at fill time for this market. */
  readonly feesUsdc: Decimal;
  /** Realized PnL for the market: payout − cost (exact Decimal). */
  readonly realizedPnlUsdc: Decimal;
  /** Unmatched UP shares held at expiry (orphan/leg risk, shares). */
  readonly residualUpShares: Decimal;
  /** Unmatched DOWN shares held at expiry (orphan/leg risk, shares). */
  readonly residualDownShares: Decimal;
}

/** Per-lot USDC cost = qty × price + fee − rebate (exact Decimal). */
function lotCost(lot: {
  qty: Decimal;
  pricePerUnit: Decimal;
  fee: Decimal;
  rebate: Decimal;
}): Decimal {
  return decAdd(decMulRound(lot.qty, lot.pricePerUnit), decSub(lot.fee, lot.rebate));
}

/**
 * Settle one market: converts held lots into their settlement cash value
 * (winner pays 1/share, loser 0; complete sets pay 1/set regardless of the
 * outcome), removes them from the lot state, and returns the accounting
 * breakdown. A market with no lots still settles (zero payout) so every
 * market in the window is accounted for.
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

  let cost = decZero();
  let fees = decZero();
  for (const lot of held.up) {
    cost = decAdd(cost, lotCost(lot));
    fees = decAdd(fees, decSub(lot.fee, lot.rebate));
  }
  for (const lot of held.down) {
    cost = decAdd(cost, lotCost(lot));
    fees = decAdd(fees, decSub(lot.fee, lot.rebate));
  }

  const upShares = match.residualUp;
  const downShares = match.residualDown;
  const sets = match.matchedSets;

  // Complete sets pay exactly 1 USDC each regardless of outcome (capital-
  // neutral); residuals pay only if their side won.
  const winnerShares = market.resolution.outcome === "UP" ? upShares : downShares;
  const payout = decAdd(sets, winnerShares);

  // Remove settled lots from state (the market is gone after expiry).
  state.lots.set(market.slug, { up: [], down: [] });

  return {
    slug: market.slug,
    asset: market.asset,
    outcome: market.resolution.outcome,
    payout,
    costUsdc: cost,
    feesUsdc: fees,
    realizedPnlUsdc: decSub(payout, cost),
    residualUpShares: upShares,
    residualDownShares: downShares,
  };
}

/** True when the market held any directional (unmatched) inventory. */
export function hasResiduals(result: SettlementResult): boolean {
  return (
    decCompare(result.residualUpShares, decZero()) > 0 ||
    decCompare(result.residualDownShares, decZero()) > 0
  );
}
