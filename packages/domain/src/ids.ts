/**
 * Smart constructors for branded identifiers. At runtime they are plain
 * strings; the brand exists to make cross-field mistakes (e.g. a tokenId used
 * where a marketId is expected) unrepresentable at compile time.
 */

import type {
  AssetSymbol,
  FillId,
  MarketId,
  MarketSlug,
  OrderId,
  PositionId,
  Tagged,
  TokenId,
} from "./brand.js";
import { ValidationError } from "./errors.js";

function tag<B extends string>(kind: B, value: string, minLen: number): Tagged<B> {
  const trimmed = value.trim();
  if (trimmed.length < minLen) {
    throw new ValidationError(`${kind} must be at least ${minLen} chars, got "${value}"`);
  }
  return trimmed as Tagged<B>;
}

export function assetSymbol(value: string): AssetSymbol {
  const v = value.trim().toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(v)) {
    throw new ValidationError(`asset symbol must be 2-10 uppercase letters: "${value}"`);
  }
  return v as AssetSymbol;
}

/**
 * Polymarket market ids are short numeric strings (e.g. "703257"), so the
 * floor is deliberately low; the brand still prevents cross-id mixups.
 */
export function marketId(value: string): MarketId {
  return tag("MarketId", value, 4);
}

export function marketSlug(value: string): MarketSlug {
  const v = value.trim();
  if (!/^[a-z0-9-]{3,120}$/.test(v)) {
    throw new ValidationError(`market slug must be lowercase kebab-case: "${value}"`);
  }
  return v as MarketSlug;
}

export function tokenId(value: string): TokenId {
  return tag("TokenId", value, 8);
}

export function orderId(value: string): OrderId {
  return tag("OrderId", value, 6);
}

export function fillId(value: string): FillId {
  return tag("FillId", value, 6);
}

export function positionId(value: string): PositionId {
  return tag("PositionId", value, 6);
}
