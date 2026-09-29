/**
 * Observability tests: deterministic, no network, no real clocks.
 */

import { describe, expect, it } from "vitest";

import { decFromString } from "@bot/domain";

import {
  AreaLogger,
  MetricsRegistry,
  SecretLabelError,
  WS_STATUS_VALUE,
  createAreaLoggers,
  nodeSystemSampler,
  recordApiError,
  recordCompleteSetOpportunity,
  recordExecutionEvent,
  recordExecutionLatency,
  recordInventoryMetrics,
  recordMarketMetrics,
  recordRiskMetrics,
  recordStrategyPhase,
  recordStrategySignal,
  recordStrategyTargetInventory,
  recordSystemSample,
  registerAllMetrics,
  type SystemSampler,
} from "./index.js";

function valueOf(
  registry: MetricsRegistry,
  name: string,
  labelMatch: Record<string, string>,
): number | undefined {
  return registry
    .snapshot()
    .find((s) => s.name === name && Object.entries(labelMatch).every(([k, v]) => s.labels[k] === v))
    ?.value;
}

function freshRegistry(): MetricsRegistry {
  const r = new MetricsRegistry();
  registerAllMetrics(r);
  return r;
}

describe("MetricsRegistry", () => {
  it("snapshots in deterministic order (registration, then sorted labels)", () => {
    const a = new MetricsRegistry();
    a.register("m", "gauge", "m gauge");
    a.set("m", { b: "2" }, 2);
    a.set("m", { a: "1" }, 1);
    const snap = a.snapshot();
    expect(snap.map((s) => s.labels.a ?? s.labels.b)).toEqual(["1", "2"]);
  });

  it("re-registration with the same definition is idempotent; conflict throws", () => {
    const r = new MetricsRegistry();
    r.register("m", "gauge", "help");
    expect(() => r.register("m", "gauge", "help")).not.toThrow();
    expect(() => r.register("m", "counter", "help")).toThrow(/conflict/);
  });

  it("counters are monotone and start at zero; gauges overwrite", () => {
    const r = new MetricsRegistry();
    r.register("c", "counter", "c");
    r.increment("c", { k: "v" });
    r.increment("c", { k: "v" }, 2);
    expect(valueOf(r, "c", { k: "v" })).toBe(3);
    expect(() => r.increment("c", { k: "v" }, -1)).toThrow(/monotone|non-negative/);
    r.register("g", "gauge", "g");
    r.set("g", { k: "v" }, 1);
    r.set("g", { k: "v" }, 5);
    expect(valueOf(r, "g", { k: "v" })).toBe(5);
  });

  it("renders valid Prometheus text with HELP/TYPE and sorted samples", () => {
    const r = new MetricsRegistry();
    r.register("obs_test_counter", "counter", "Counts things");
    r.increment("obs_test_counter", { asset: "BTC" }, 3);
    r.set("obs_test_gauge", { asset: "ETH" }, 0.5);
    const text = r.renderPrometheus();
    expect(text).toContain("# HELP obs_test_counter Counts things");
    expect(text).toContain("# TYPE obs_test_counter counter");
    expect(text).toContain('obs_test_counter{asset="BTC"} 3');
    expect(text).toContain('obs_test_gauge{asset="ETH"} 0.5');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("renders JSON with grouped samples", () => {
    const r = new MetricsRegistry();
    r.register("obs_test_gauge", "gauge", "g");
    r.set("obs_test_gauge", { a: "1" }, 4);
    const json = r.renderJson();
    expect(json.metrics.length).toBe(1);
    expect(json.metrics[0]?.samples).toEqual([{ labels: { a: "1" }, value: 4 }]);
  });

  it("escapes label values in Prometheus rendering", () => {
    const r = new MetricsRegistry();
    r.register("m", "gauge", "m");
    r.set("m", { side: 'buy"x\\y' }, 1);
    expect(r.renderPrometheus()).toContain('m{side="buy\\"x\\\\y"} 1');
  });
});

describe("collectors: market", () => {
  it("records BTC/ETH data ages, book age, WS status, reconnects", () => {
    const r = freshRegistry();
    recordMarketMetrics(r, {
      underlyingDataAgeMs: { BTC: 120, ETH: 340 },
      bookAgeMs: { "703257": 55 },
      wsStatus: { "binance-btc": "healthy", polymarket: "degraded" },
      wsReconnects: { "binance-btc": 2, polymarket: 1 },
    });
    expect(valueOf(r, "market_underlying_data_age_ms", { asset: "BTC" })).toBe(120);
    expect(valueOf(r, "market_underlying_data_age_ms", { asset: "ETH" })).toBe(340);
    expect(valueOf(r, "market_book_age_ms", { market_id: "703257" })).toBe(55);
    expect(valueOf(r, "market_ws_status", { feed: "binance-btc" })).toBe(WS_STATUS_VALUE.healthy);
    expect(valueOf(r, "market_ws_status", { feed: "polymarket" })).toBe(WS_STATUS_VALUE.degraded);
    expect(valueOf(r, "market_ws_reconnects_total", { feed: "binance-btc" })).toBe(2);
  });

  it("overwrites gauges on re-record (latest wins)", () => {
    const r = freshRegistry();
    const input = {
      underlyingDataAgeMs: { BTC: 10 },
      bookAgeMs: {},
      wsStatus: {},
      wsReconnects: {},
    } as const;
    recordMarketMetrics(r, input);
    recordMarketMetrics(r, { ...input, underlyingDataAgeMs: { BTC: 20 } });
    expect(valueOf(r, "market_underlying_data_age_ms", { asset: "BTC" })).toBe(20);
  });
});

describe("collectors: strategy", () => {
  it("records signal direction/confidence and regime flags", () => {
    const r = freshRegistry();
    recordStrategySignal(r, {
      asset: "BTC",
      direction: decFromString("0.5"),
      confidence: decFromString("0.8"),
      regime: "normal",
    });
    expect(valueOf(r, "strategy_signal_direction", { asset: "BTC" })).toBeCloseTo(0.5, 6);
    expect(valueOf(r, "strategy_signal_confidence", { asset: "BTC" })).toBeCloseTo(0.8, 6);
    expect(valueOf(r, "strategy_signal_regime", { asset: "BTC", regime: "normal" })).toBe(1);
    expect(valueOf(r, "strategy_signal_regime", { asset: "BTC", regime: "volatile" })).toBe(0);
  });

  it("records market phase flags", () => {
    const r = freshRegistry();
    recordStrategyPhase(r, "703257", "mid");
    expect(valueOf(r, "strategy_market_phase", { market_id: "703257", phase: "mid" })).toBe(1);
    expect(valueOf(r, "strategy_market_phase", { market_id: "703257", phase: "final" })).toBe(0);
  });

  it("records target inventory and complete-set opportunities", () => {
    const r = freshRegistry();
    recordStrategyTargetInventory(r, { marketId: "703257", upShares: 50, downShares: 0 });
    recordCompleteSetOpportunity(r, {
      marketId: "703257",
      grossEdge: decFromString("0.01234567"),
      netEdge: decFromString("0.00600000"),
    });
    expect(
      valueOf(r, "strategy_target_inventory_shares", { market_id: "703257", outcome: "up" }),
    ).toBe(50);
    expect(
      valueOf(r, "strategy_target_inventory_shares", { market_id: "703257", outcome: "down" }),
    ).toBe(0);
    expect(valueOf(r, "strategy_complete_set_gross_edge", { market_id: "703257" })).toBeCloseTo(
      0.01234567,
      6,
    );
    expect(valueOf(r, "strategy_complete_set_net_edge", { market_id: "703257" })).toBeCloseTo(
      0.006,
      6,
    );
    expect(valueOf(r, "strategy_complete_set_opportunities_total", {})).toBe(1);
  });
});

describe("collectors: inventory", () => {
  it("records up/down, matched sets, residuals, orphan value", () => {
    const r = freshRegistry();
    recordInventoryMetrics(r, {
      marketId: "703257",
      upShares: decFromString("200"),
      downShares: decFromString("150"),
      matchedSets: decFromString("150"),
      residualUp: decFromString("50"),
      residualDown: decFromString("0"),
      orphanUsdc: decFromString("25"),
    });
    expect(valueOf(r, "inventory_up_shares", { market_id: "703257" })).toBe(200);
    expect(valueOf(r, "inventory_down_shares", { market_id: "703257" })).toBe(150);
    expect(valueOf(r, "inventory_matched_sets", { market_id: "703257" })).toBe(150);
    expect(valueOf(r, "inventory_residual_up_shares", { market_id: "703257" })).toBe(50);
    expect(valueOf(r, "inventory_residual_down_shares", { market_id: "703257" })).toBe(0);
    expect(valueOf(r, "inventory_orphan_usdc", { market_id: "703257" })).toBe(25);
  });
});

describe("collectors: execution", () => {
  it("counts orders, fills, partial fills, cancels, rejections", () => {
    const r = freshRegistry();
    recordExecutionEvent(r, { outcome: "up", side: "buy", event: "submitted" });
    recordExecutionEvent(r, { outcome: "up", side: "buy", event: "partial_fill" });
    recordExecutionEvent(r, { outcome: "up", side: "buy", event: "filled" });
    recordExecutionEvent(r, {
      outcome: "down",
      side: "buy",
      event: "rejected",
      reason: "post_only_would_cross",
    });
    recordExecutionEvent(r, { outcome: "up", side: "buy", event: "cancelled" });
    expect(valueOf(r, "execution_orders_total", { outcome: "up", side: "buy" })).toBe(1);
    expect(valueOf(r, "execution_fills_total", { outcome: "up", side: "buy" })).toBe(2);
    expect(valueOf(r, "execution_partial_fills_total", { outcome: "up", side: "buy" })).toBe(1);
    expect(valueOf(r, "execution_cancellations_total", { outcome: "up", side: "buy" })).toBe(1);
    expect(
      valueOf(r, "execution_rejections_total", {
        outcome: "down",
        side: "buy",
        reason: "post_only_would_cross",
      }),
    ).toBe(1);
  });

  it("records latency last-value and sample count", () => {
    const r = freshRegistry();
    recordExecutionLatency(r, "submit", 12);
    recordExecutionLatency(r, "submit", 30);
    expect(valueOf(r, "execution_latency_ms", { operation: "submit" })).toBe(30);
    expect(valueOf(r, "execution_latency_samples_total", { operation: "submit" })).toBe(2);
  });
});

describe("collectors: risk", () => {
  it("records capital, utilization, exposure, losses, state, kill switch", () => {
    const r = freshRegistry();
    recordRiskMetrics(r, {
      capitalDeployedUsdc: decFromString("60"),
      capitalLimitUsdc: decFromString("100"),
      directionalExposureUsdc: { BTC: decFromString("-12.5") },
      dailyLossUsdc: decFromString("5"),
      marketLossUsdc: { "703257": decFromString("2") },
      state: "halted",
      killSwitch: false,
    });
    expect(valueOf(r, "risk_capital_deployed_usdc", {})).toBe(60);
    expect(valueOf(r, "risk_capital_limit_usdc", {})).toBe(100);
    expect(valueOf(r, "risk_capital_utilization_ratio", {})).toBeCloseTo(0.6, 6);
    expect(valueOf(r, "risk_directional_exposure_usdc", { asset: "BTC" })).toBe(-12.5);
    expect(valueOf(r, "risk_daily_loss_usdc", {})).toBe(5);
    expect(valueOf(r, "risk_market_loss_usdc", { market_id: "703257" })).toBe(2);
    expect(valueOf(r, "risk_state", { state: "halted" })).toBe(1);
    expect(valueOf(r, "risk_state", { state: "allowed" })).toBe(0);
    expect(valueOf(r, "risk_kill_switch", {})).toBe(0);
  });

  it("guards zero-limit utilization and kill-switch flag", () => {
    const r = freshRegistry();
    recordRiskMetrics(r, {
      capitalDeployedUsdc: 10,
      capitalLimitUsdc: 0,
      directionalExposureUsdc: {},
      dailyLossUsdc: 0,
      state: "allowed",
      killSwitch: true,
    });
    expect(valueOf(r, "risk_capital_utilization_ratio", {})).toBe(0);
    expect(valueOf(r, "risk_kill_switch", {})).toBe(1);
  });
});

describe("collectors: system + api errors", () => {
  it("records CPU, memory, uptime from a fake sampler deterministically", () => {
    const r = freshRegistry();
    const sampler: SystemSampler = {
      sample: () => ({
        cpuPercent: 12.5,
        memoryUsedBytes: 8 * 1024 ** 3,
        memoryRssBytes: 120 * 1024 ** 2,
        heapUsedBytes: 40 * 1024 ** 2,
        heapLimitBytes: 2 * 1024 ** 3,
        uptimeSeconds: 90,
      }),
    };
    const sample = recordSystemSample(sampler, r);
    expect(sample.cpuPercent).toBe(12.5);
    expect(valueOf(r, "system_cpu_percent", {})).toBe(12.5);
    expect(valueOf(r, "system_memory_used_bytes", {})).toBe(8 * 1024 ** 3);
    expect(valueOf(r, "system_uptime_seconds", {})).toBe(90);
  });

  it("nodeSystemSampler returns real finite numbers", () => {
    const sample = nodeSystemSampler().sample();
    expect(Number.isFinite(sample.cpuPercent)).toBe(true);
    expect(sample.memoryRssBytes).toBeGreaterThan(0);
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
    expect(sample.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("counts API errors per area", () => {
    const r = freshRegistry();
    recordApiError(r, "market-data");
    recordApiError(r, "market-data");
    recordApiError(r, "execution");
    expect(valueOf(r, "system_api_errors_total", { area: "market-data" })).toBe(2);
    expect(valueOf(r, "system_api_errors_total", { area: "execution" })).toBe(1);
  });
});

describe("secret hygiene", () => {
  it("refuses secret-shaped label keys (fail closed)", () => {
    const r = new MetricsRegistry();
    r.register("obs_test_gauge", "gauge", "g");
    expect(() => r.set("obs_test_gauge", { apiKey: "x" }, 1)).toThrow(SecretLabelError);
    expect(() => r.set("obs_test_gauge", { private_key: "x" }, 1)).toThrow(SecretLabelError);
    expect(() => r.set("obs_test_gauge", { credential: "x" }, 1)).toThrow(SecretLabelError);
    expect(() => r.set("obs_test_gauge", { password: "x" }, 1)).toThrow(SecretLabelError);
    expect(() => r.set("obs_test_gauge", { authorization: "Bearer x" }, 1)).toThrow(
      SecretLabelError,
    );
  });

  it("refuses credential-shaped label values; short ids are fine", () => {
    const r = new MetricsRegistry();
    r.register("obs_test_gauge", "gauge", "g");
    expect(() => r.set("obs_test_gauge", { token_id: "a".repeat(48) }, 1)).toThrow(
      SecretLabelError,
    );
    expect(() => r.set("obs_test_gauge", { token_id: "703257" }, 1)).not.toThrow();
    expect(() => r.set("obs_test_gauge", { token_id: "1111111111" }, 1)).not.toThrow();
  });

  it("structured logs redact secret-shaped keys and render Decimals exactly", () => {
    const captured: { msg: string; ctx: Record<string, unknown> }[] = [];
    const fakeLogger = {
      debug: () => undefined,
      info: (msg: string, ctx: Record<string, unknown>) => captured.push({ msg, ctx }),
      warn: () => undefined,
      error: () => undefined,
      child: () => fakeLogger,
    };
    const log = createAreaLoggers(fakeLogger);
    log.execution.info("order_submitted", {
      clientOrderId: "ord-1",
      apiKey: "SHOULD_NOT_APPEAR",
      price: decFromString("0.45"),
    });
    expect(captured.length).toBe(1);
    const ctx = captured[0]?.ctx as Record<string, unknown>;
    expect(ctx.apiKey).toBe("[REDACTED]");
    expect(ctx.price).toBe("0.45000000");
    expect(ctx.clientOrderId).toBe("ord-1");
  });

  it("AreaLogger drops undefined fields", () => {
    const captured: { msg: string; ctx: Record<string, unknown> }[] = [];
    const fakeLogger = {
      debug: () => undefined,
      info: (msg: string, ctx: Record<string, unknown>) => captured.push({ msg, ctx }),
      warn: () => undefined,
      error: () => undefined,
      child: () => fakeLogger,
    };
    const log = new AreaLogger("risk", fakeLogger);
    log.info("risk_state", { state: "halted", detail: undefined });
    expect(captured[0]?.ctx).toEqual({ state: "halted" });
  });
});

describe("determinism", () => {
  it("identical collector calls yield byte-identical Prometheus text", () => {
    const build = () => {
      const r = freshRegistry();
      recordMarketMetrics(r, {
        underlyingDataAgeMs: { BTC: 5, ETH: 7 },
        bookAgeMs: { m1: 1 },
        wsStatus: { polymarket: "healthy" },
        wsReconnects: { polymarket: 0 },
      });
      recordInventoryMetrics(r, {
        marketId: "m1",
        upShares: 2,
        downShares: 2,
        matchedSets: 2,
        residualUp: 0,
        residualDown: 0,
        orphanUsdc: 0,
      });
      recordExecutionEvent(r, { outcome: "up", side: "buy", event: "submitted" });
      return r.renderPrometheus();
    };
    expect(build()).toBe(build());
  });
});
