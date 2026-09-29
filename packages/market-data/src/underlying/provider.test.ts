import { describe, expect, it, vi } from "vitest";

import { millis } from "@bot/domain";

import { MockSocketFactory, WS_CLOSED } from "./mock-ws.js";
import { BinanceUnderlyingProvider } from "./provider.js";
import type { UnderlyingMarketSnapshot } from "./types.js";

const T0 = 1_800_000_000_000;

/** Fixed clock: advances by `step` on each read (mimics real time passing). */
function steppedClock(start: number, step: number) {
  let value = start;
  return () => {
    const v = millis(value);
    value += step;
    return v;
  };
}

function tickerOver(overrides: Record<string, unknown> = {}): unknown {
  return {
    stream: "btcusdt@ticker",
    data: {
      s: "BTCUSDT",
      c: "65000.10",
      b: "64999.90",
      a: "65000.30",
      v: "123.456",
      q: "8024000.55",
      E: T0 + 1000,
      ...overrides,
    },
  };
}

interface Harness {
  factory: MockSocketFactory;
  provider: BinanceUnderlyingProvider;
  events: Array<{ symbol: string; snapshot: UnderlyingMarketSnapshot }>;
  statuses: Array<{ status: string; detail: string | undefined }>;
}

function makeHarness(clockStepMs = 0): Harness {
  const factory = new MockSocketFactory();
  const events: Harness["events"] = [];
  const statuses: Harness["statuses"] = [];
  const provider = new BinanceUnderlyingProvider({
    symbols: ["BTCUSDT", "ETHUSDT"],
    wsFactory: factory.factory,
    clock: steppedClock(T0, clockStepMs),
    reconnectBaseDelayMs: 10,
    maxReconnectDelayMs: 40,
    heartbeatIntervalMs: 50,
    maxDataAgeMs: 5_000,
  });
  provider.onEvent((symbol, snapshot) => events.push({ symbol, snapshot }));
  provider.onStatusChange((status, detail) => statuses.push({ status, detail }));
  return { factory, provider, events, statuses };
}

describe("BinanceUnderlyingProvider (mock websocket, deterministic)", () => {
  it("connects, normalizes ticks, and maintains the snapshot", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    expect(ws?.url).toContain("btcusdt@ticker");
    expect(ws?.url).toContain("ethusdt@ticker");

    ws?.serverAccept();
    expect(h.provider.status()).toBe("connected");

    ws?.serverMessage(tickerOver());
    const snap = h.provider.snapshot("BTCUSDT");
    expect(snap?.lastPrice).toBe("65000.10");
    expect(snap?.bid).toBe("64999.90");
    expect(snap?.ask).toBe("65000.30");
    expect(snap?.spread).toBe("0.4");
    expect(snap?.baseVolume).toBe("123.456");
    expect(snap?.quoteVolume).toBe("8024000.55");
    expect(snap?.stale).toBe(false);
  });

  it("tracks ETHUSDT independently", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();
    ws?.serverMessage({
      stream: "ethusdt@ticker",
      data: {
        s: "ETHUSDT",
        c: "3100.5",
        b: "3100.4",
        a: "3100.6",
        v: "900",
        q: "2790000",
        E: T0 + 1000,
      },
    });
    expect(h.provider.snapshot("ETHUSDT")?.lastPrice).toBe("3100.5");
    expect(h.provider.snapshot("BTCUSDT")).toBeUndefined();
  });

  it("rejects out-of-order events and keeps the newest state", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();

    ws?.serverMessage(tickerOver({ E: T0 + 2000, c: "65100" }));
    ws?.serverMessage(tickerOver({ E: T0 + 1000, c: "64000" })); // older: dropped

    expect(h.provider.snapshot("BTCUSDT")?.lastPrice).toBe("65100");
    expect(h.provider.counters("BTCUSDT").outOfOrderDropped).toBe(1);
  });

  it("accepts equal-timestamp refreshes (idempotent) but not regressions", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();
    ws?.serverMessage(tickerOver({ E: T0 + 1000, c: "65001" }));
    ws?.serverMessage(tickerOver({ E: T0 + 1000, c: "65001" }));
    expect(h.provider.counters("BTCUSDT").outOfOrderDropped).toBe(0);
    expect(h.provider.snapshot("BTCUSDT")?.lastPrice).toBe("65001");
  });

  it("counts malformed payloads without crashing", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();
    ws?.serverMessage("not json at all");
    ws?.serverMessage({ nope: 1 });
    ws?.serverMessage({ stream: "dogeusdt@ticker", data: { s: "DOGEUSDT" } });
    expect(h.provider.snapshot("BTCUSDT")).toBeUndefined();
    // two bare malformed payloads are unattributable; the doge stream is
    // parsed but its symbol is untracked, so it is also unattributable.
    expect(h.provider.unattributableMalformedCount()).toBe(3);
    expect(h.provider.counters("BTCUSDT").malformedDropped).toBe(0);
  });

  it("counts malformed payloads against the stream's symbol when tracked", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();
    ws?.serverMessage({ stream: "btcusdt@ticker", data: { s: "BTCUSDT" } }); // no price
    expect(h.provider.counters("BTCUSDT").malformedDropped).toBe(1);
  });

  it("reports staleness from the injected clock", () => {
    let value = T0;
    const clock = () => millis(value);
    const factory = new MockSocketFactory();
    const provider = new BinanceUnderlyingProvider({
      symbols: ["BTCUSDT"],
      wsFactory: factory.factory,
      clock,
      maxDataAgeMs: 5_000,
      heartbeatIntervalMs: 60_000,
    });
    provider.start();
    const ws = factory.last;
    ws?.serverAccept();
    ws?.serverMessage(tickerOver({ E: T0 + 1000 }));

    value = T0 + 2_000; // fresh
    expect(provider.snapshot("BTCUSDT")?.stale).toBe(false);
    expect(provider.freshnessMs("BTCUSDT", millis(value))).toBeLessThan(5_000);

    value = T0 + 9_000; // 8s after receive
    const snap = provider.snapshot("BTCUSDT");
    expect(snap?.stale).toBe(true);
    expect(snap?.ageMs).toBeGreaterThanOrEqual(5_000);
  });

  it("emits events to listeners with the normalized snapshot", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();
    ws?.serverMessage(tickerOver());
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.symbol).toBe("BTCUSDT");
    expect(h.events[0]?.snapshot.lastPrice).toBe("65000.10");
  });

  it("reconnects with exponential backoff after abnormal close", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.provider.start();
      h.factory.last?.serverAccept();
      expect(h.provider.status()).toBe("connected");

      h.factory.last?.serverClose(1006, "abnormal");
      expect(h.provider.status()).toBe("reconnecting");

      // base 10ms -> first retry at 10ms
      vi.advanceTimersByTime(10);
      expect(h.factory.sockets).toHaveLength(2);

      // fail again -> backoff doubles to 20ms
      h.factory.last?.serverClose(1006);
      vi.advanceTimersByTime(20);
      expect(h.factory.sockets).toHaveLength(3);

      // again -> 40ms (capped)
      h.factory.last?.serverClose(1006);
      vi.advanceTimersByTime(40);
      expect(h.factory.sockets).toHaveLength(4);

      // Delays are announced when each reconnect is SCHEDULED (entries whose
      // detail carries the computed backoff).
      const scheduled = h.statuses.filter((s) => s.detail?.includes("retry"));
      expect(scheduled.length).toBe(3);
      expect(scheduled[0]?.detail).toContain("in 10ms");
      expect(scheduled[1]?.detail).toContain("in 20ms");
      expect(scheduled[2]?.detail).toContain("in 40ms");
      // The close reason is preserved in the announced detail.
      expect(scheduled[0]?.detail).toContain("closed (code=1006)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops cleanly and never reconnects after stop", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.provider.start();
      h.factory.last?.serverAccept();
      h.provider.stop();
      expect(h.provider.status()).toBe("closed");
      expect(h.factory.last?.closedWith?.code).toBe(1000);

      const count = h.factory.sockets.length;
      h.factory.last?.serverClose(1006);
      vi.advanceTimersByTime(5_000);
      expect(h.factory.sockets).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-reconnects when the socket goes silent past the heartbeat", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.provider.start();
      h.factory.last?.serverAccept();
      const before = h.factory.sockets.length;

      vi.advanceTimersByTime(50); // heartbeat fires here
      expect(h.statuses.some((s) => s.detail?.includes("heartbeat timeout"))).toBe(true);

      // The heartbeat tears down the hung socket and schedules a reconnect
      // (base delay 10ms); advance past it and a new socket is created.
      vi.advanceTimersByTime(10);
      expect(h.factory.sockets.length).toBe(before + 1);
      expect(h.provider.status()).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset-free heartbeats: traffic keeps the connection alive", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.provider.start();
      const ws = h.factory.last;
      ws?.serverAccept();
      const before = h.factory.sockets.length;

      for (let t = 0; t < 5; t += 1) {
        vi.advanceTimersByTime(40);
        ws?.serverMessage(tickerOver({ E: T0 + 1000 + t * 1000 }));
      }
      expect(h.factory.sockets.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("socket factory failure schedules a reconnect instead of throwing", () => {
    vi.useFakeTimers();
    try {
      const factory: () => never = () => {
        throw new Error("no network");
      };
      const provider = new BinanceUnderlyingProvider({
        symbols: ["BTCUSDT"],
        wsFactory: factory,
        reconnectBaseDelayMs: 10,
      });
      expect(() => provider.start()).not.toThrow();
      vi.advanceTimersByTime(10);
      expect(provider.status()).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closed sockets report readyState CLOSED after server close", () => {
    const h = makeHarness();
    h.provider.start();
    const ws = h.factory.last;
    ws?.serverAccept();
    ws?.serverClose(1001, "going away");
    expect(h.factory.last?.readyState).toBe(WS_CLOSED);
  });
});
