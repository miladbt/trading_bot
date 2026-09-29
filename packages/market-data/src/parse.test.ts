import { describe, expect, it } from "vitest";

import { millis } from "@bot/domain";

import { FIXTURE_TIMES, DOWN_TOKEN, UP_TOKEN, gammaBtcMarket, gammaEthMarket } from "./fixtures.js";
import { normalizeMarket } from "./parse.js";
import { DEFAULT_DISCOVERY_POLICY } from "./types.js";

const { OPEN, SETTLE } = FIXTURE_TIMES;
const NOW = millis(OPEN + 10_000); // inside the open phase
const POLICY = DEFAULT_DISCOVERY_POLICY;

describe("normalizeMarket (valid metadata)", () => {
  it("normalizes a well-formed BTC market", () => {
    const r = normalizeMarket({ payload: gammaBtcMarket(), fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.market.id).toBe("703257");
    expect(r.value.market.asset).toBe("BTC");
    expect(r.value.market.upToken.tokenId).toBe(UP_TOKEN);
    expect(r.value.market.downToken.tokenId).toBe(DOWN_TOKEN);
    expect(r.value.market.openAt).toBe(OPEN);
    expect(r.value.market.settleAt).toBe(SETTLE);
    expect(r.value.conditionId).toMatch(/^0x/);
    expect(r.value.status).toBe("active");
  });

  it("maps outcomes by label, not just position", () => {
    const swapped = gammaBtcMarket({
      clobTokenIds: `["${DOWN_TOKEN}","${UP_TOKEN}"]`,
      outcomes: '["Down","Up"]',
    });
    const r = normalizeMarket({ payload: swapped, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.market.upToken.tokenId).toBe(UP_TOKEN);
    expect(r.value.market.downToken.tokenId).toBe(DOWN_TOKEN);
  });

  it("derives ETH from ethereum markets", () => {
    const r = normalizeMarket({ payload: gammaEthMarket(), fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.market.asset).toBe("ETH");
  });

  it("records resolution metadata verbatim without assuming an oracle", () => {
    const dto = gammaBtcMarket({ resolutionSource: "chainlink", closed: true });
    const r = normalizeMarket({ payload: dto, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.resolution.oracleSource).toBe("chainlink");
      expect(r.value.status).toBe("closed");
    }
  });

  it("leaves oracleSource undefined when the venue does not report one", () => {
    const dto = gammaBtcMarket();
    delete dto["resolutionSource"];
    const r = normalizeMarket({ payload: dto, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.resolution.oracleSource).toBeUndefined();
  });
});

describe("normalizeMarket (rejections)", () => {
  it("rejects non-object payloads", () => {
    const r = normalizeMarket({ payload: "nope", fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("not_an_object");
  });

  it("rejects markets without ids", () => {
    const dto = gammaBtcMarket();
    delete dto["id"];
    const r = normalizeMarket({ payload: dto, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("missing_id");
  });

  it("rejects markets with missing tokens", () => {
    const r = normalizeMarket(
      { payload: gammaBtcMarket({ clobTokenIds: null }), fetchedAt: NOW },
      POLICY,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("missing_tokens");
  });

  it("rejects markets with only one token or identical tokens", () => {
    const one = normalizeMarket(
      { payload: gammaBtcMarket({ clobTokenIds: `["${UP_TOKEN}"]` }), fetchedAt: NOW },
      POLICY,
      NOW,
    );
    expect(one.ok).toBe(false);
    const same = normalizeMarket(
      {
        payload: gammaBtcMarket({ clobTokenIds: `["${UP_TOKEN}","${UP_TOKEN}"]` }),
        fetchedAt: NOW,
      },
      POLICY,
      NOW,
    );
    expect(same.ok).toBe(false);
  });

  it("rejects non-BTC/ETH markets (ambiguous or unrelated assets)", () => {
    const sol = gammaBtcMarket({ slug: "solana-up-or-down-x", question: "Solana up?" });
    const r = normalizeMarket({ payload: sol, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("invalid_shape");
  });

  it("rejects markets with missing or invalid timing", () => {
    const noTimes = gammaBtcMarket();
    delete noTimes["endDate"];
    const r1 = normalizeMarket({ payload: noTimes, fetchedAt: NOW }, POLICY, NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.reason).toBe("invalid_timing");

    const backwards = gammaBtcMarket({
      startDate: new Date(SETTLE).toISOString(),
      endDate: new Date(OPEN).toISOString(),
    });
    const r2 = normalizeMarket({ payload: backwards, fetchedAt: NOW }, POLICY, NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe("invalid_timing");
  });

  it("rejects markets whose duration is not a ~5-minute cycle", () => {
    const hourly = gammaBtcMarket({
      endDate: new Date(OPEN + 3_600_000).toISOString(),
    });
    const r = normalizeMarket({ payload: hourly, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("invalid_timing");
  });

  it("skips long-expired markets", () => {
    const old = gammaBtcMarket({
      startDate: new Date(OPEN - 7_200_000).toISOString(),
      endDate: new Date(SETTLE - 7_200_000).toISOString(),
    });
    const r = normalizeMarket({ payload: old, fetchedAt: NOW }, POLICY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("invalid_timing");
  });

  it("treats closed markets as closed, not active, but still parses them", () => {
    const r = normalizeMarket(
      { payload: gammaBtcMarket({ closed: true, active: false }), fetchedAt: NOW },
      POLICY,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe("closed");
  });
});
