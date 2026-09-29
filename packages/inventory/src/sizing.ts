/**
 * Edge-based target-residual sizing (T1).
 *
 * Replaces (optionally — the legacy model stays selectable) the
 * `direction × confidence × maxResidual × phaseMultiplier` target with:
 *
 *   edge_up   = p_up − (ask_up + takerFee(ask_up))       (net of fees)
 *   edge_down = (1 − p_up) − (ask_down + takerFee(ask_down))
 *   side      = argmax(edge)
 *   edge      = max(edge_up, edge_down)
 *   size      = 0                                       if edge <= minEdge
 *   f_full    = (p_win·b − (1 − p_win)) / b             (full Kelly, binary)
 *                 where b = (1 − c)/c, c = ask + fee
 *   shares    = kellyFraction × f_full × maxResidual    (fractional Kelly)
 *                 clamped to [0, min(maxResidual, maxDirectionalShares)]
 *
 * `maxResidual` here is the *share budget* the Kelly fraction is applied to —
 * the same cap the legacy model scales. Budget (USDC) clamping remains the
 * planner's job, as for every action.
 *
 * All arithmetic is BigInt `Decimal` (8 dp); no floats anywhere. Pure and
 * deterministic. Fee math comes from @bot/domain (verified schedule — see
 * docs/RESOLUTION_AND_FEES.md).
 */

import {
  ValidationError,
  decAdd,
  decCompare,
  decDivRound,
  decFromString,
  decMax,
  decMin,
  decMulRound,
  decNeg,
  decSub,
  decToString,
  decZero,
  edgeNetOfTakerFee,
  takerFeePerShare,
  type Decimal,
} from "@bot/domain";

const ZERO = decZero();
const ONE = decFromString("1");

export interface EdgeSizingInput {
  /** Model probability that Up wins, in [0, 1]. */
  readonly pUp: Decimal;
  /** Executable ask for one Up share, in (0, 1). */
  readonly askUp: Decimal;
  /** Executable ask for one Down share, in (0, 1). */
  readonly askDown: Decimal;
  /** Taker fee rate (verified crypto default 0.07; config `FEE_TAKER_RATE`). */
  readonly takerFeeRate: Decimal;
  /** Kelly fraction in (0, 1] (config `STRATEGY_KELLY_FRACTION`). */
  readonly kellyFraction: Decimal;
  /** Minimum net edge to trade at all (config `STRATEGY_MIN_EDGE`). */
  readonly minEdge: Decimal;
  /** Share budget the Kelly fraction is applied to and clamped by. */
  readonly maxResidual: Decimal;
  /** Risk cap on directional shares per side. */
  readonly maxDirectionalShares: Decimal;
}

export interface EdgeSizingResult {
  /** Signed target residual (positive = Up side, negative = Down side). */
  readonly target: Decimal;
  /** Chosen side ("none" when there is no trade). */
  readonly side: "up" | "down" | "none";
  /** Net-of-fee edges per side (probability units). */
  readonly edgeUp: Decimal;
  readonly edgeDown: Decimal;
  /** The edge actually used (max of the two; informational). */
  readonly edge: Decimal;
}

/**
 * Compute the edge-based target residual. Throws on invalid inputs (fail
 * closed): pUp outside [0,1], asks outside (0,1), negative caps, or a Kelly
 * fraction outside (0,1].
 */
export function edgeTargetResidual(input: EdgeSizingInput): EdgeSizingResult {
  assertInclusive(input.pUp, ZERO, ONE, "pUp");
  assertExclusive(input.askUp, ZERO, ONE, "askUp");
  assertExclusive(input.askDown, ZERO, ONE, "askDown");
  if (decCompare(input.takerFeeRate, ZERO) < 0) {
    throw new ValidationError("takerFeeRate must be non-negative");
  }
  if (decCompare(input.kellyFraction, ZERO) <= 0 || decCompare(input.kellyFraction, ONE) > 0) {
    throw new ValidationError("kellyFraction must be in (0, 1]");
  }
  if (decCompare(input.minEdge, ZERO) < 0) {
    throw new ValidationError("minEdge must be non-negative");
  }
  if (decCompare(input.maxResidual, ZERO) < 0) {
    throw new ValidationError("maxResidual must be non-negative");
  }
  if (decCompare(input.maxDirectionalShares, ZERO) < 0) {
    throw new ValidationError("maxDirectionalShares must be non-negative");
  }

  const pDown = decSub(ONE, input.pUp);
  const edgeUp = edgeNetOfTakerFee(input.pUp, input.askUp, input.takerFeeRate);
  const edgeDown = edgeNetOfTakerFee(pDown, input.askDown, input.takerFeeRate);

  // Deterministic tie-break: Up wins a tie.
  const upWins = decCompare(edgeUp, edgeDown) >= 0;
  const side = upWins ? "up" : "down";
  const edge = upWins ? edgeUp : edgeDown;
  const ask = upWins ? input.askUp : input.askDown;
  const pWin = upWins ? input.pUp : pDown;

  // No position when the edge does not clear the minimum (strictly).
  if (decCompare(edge, input.minEdge) <= 0) {
    return { target: ZERO, side: "none", edgeUp, edgeDown, edge };
  }

  // Full-Kelly fraction for a binary contract paying 1:
  //   b = (1 - c)/c, f* = (p_win*b - (1 - p_win))/b,  c = ask + fee
  const cost = decAdd(ask, takerFeePerShare(ask, input.takerFeeRate));
  const b = decDivRound(decSub(ONE, cost), cost);
  if (decCompare(b, ZERO) <= 0) {
    // Degenerate pricing (cost >= 1): never trade.
    return { target: ZERO, side: "none", edgeUp, edgeDown, edge };
  }
  const fFull = decDivRound(decSub(decMulRound(pWin, b), decSub(ONE, pWin)), b);
  const fClamped = decMin(decMax(fFull, ZERO), ONE);

  const shares = decMulRound(input.kellyFraction, decMulRound(fClamped, input.maxResidual));
  const cap = decMin(input.maxResidual, input.maxDirectionalShares);
  const sized = decMin(shares, cap);

  const target = side === "up" ? sized : decNeg(sized);
  return { target, side, edgeUp, edgeDown, edge };
}

function assertInclusive(v: Decimal, lo: Decimal, hi: Decimal, name: string): void {
  if (decCompare(v, lo) < 0 || decCompare(v, hi) > 0) {
    throw new ValidationError(`${name} must be in [${decToString(lo)}, ${decToString(hi)}]`);
  }
}

function assertExclusive(v: Decimal, lo: Decimal, hi: Decimal, name: string): void {
  if (decCompare(v, lo) <= 0 || decCompare(v, hi) >= 0) {
    throw new ValidationError(`${name} must be in (${decToString(lo)}, ${decToString(hi)})`);
  }
}
