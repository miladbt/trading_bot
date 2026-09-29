import { describe, expect, it } from "vitest";

import {
  binanceStreamUrl,
  isOutOfOrder,
  normalizeTicker,
  parseCombinedStream,
  streamSymbol,
} from "./binance.js";
import { isUnderlyingSymbol } from "./types.js";

describe("binanceStreamUrl", () => {
  it("builds a combined stream URL for both symbols", () => {
    const url = binanceStreamUrl(["BTCUSDT", "ETHUSDT"]);
    expect(url).toBe("wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker");
  });

  it("supports a custom host (testcontainers/proxy)", () => {
    expect(binanceStreamUrl(["BTCUSDT"], "ws://localhost:9999")).toBe(
      "ws://localhost:9999/stream?streams=btcusdt@ticker",
    );
  });
});

describe("parseCombinedStream", () => {
  it("parses { stream, data } envelopes", () => {
    const parsed = parseCombinedStream({ stream: "btcusdt@ticker", data: { s: "BTCUSDT" } });
    expect(parsed?.stream).toBe("btcusdt@ticker");
    expect(parsed?.data["s"]).toBe("BTCUSDT");
  });

  it("returns undefined for garbage", () => {
    expect(parseCombinedStream("hello")).toBeUndefined();
    expect(parseCombinedStream(42)).toBeUndefined();
    expect(parseCombinedStream({ stream: 1 })).toBeUndefined();
    expect(parseCombinedStream(null)).toBeUndefined();
  });
});

describe("streamSymbol", () => {
  it("maps supported streams", () => {
    expect(streamSymbol("btcusdt@ticker")).toBe("BTCUSDT");
    expect(streamSymbol("ethusdt@ticker")).toBe("ETHUSDT");
  });

  it("rejects unsupported symbols", () => {
    expect(streamSymbol("dogeusdt@ticker")).toBeUndefined();
    expect(streamSymbol("")).toBeUndefined();
  });
});

describe("normalizeTicker", () => {
  it("maps ticker fields", () => {
    const t = normalizeTicker({
      s: "BTCUSDT",
      c: "65000.1",
      b: "64999.9",
      a: "65000.3",
      v: "1.5",
      q: "97500.15",
      E: 123,
    });
    expect(t).toEqual({
      symbol: "BTCUSDT",
      lastPrice: "65000.1",
      bid: "64999.9",
      ask: "65000.3",
      baseVolume: "1.5",
      quoteVolume: "97500.15",
      eventTime: 123,
    });
  });

  it("returns undefined for unsupported or empty payloads", () => {
    expect(normalizeTicker({ s: "DOGEUSDT", c: "1" })).toBeUndefined();
    expect(normalizeTicker({ s: "BTCUSDT" })).toBeUndefined();
    expect(normalizeTicker({})).toBeUndefined();
  });
});

describe("isOutOfOrder", () => {
  it("rejects strictly older events only", () => {
    expect(isOutOfOrder(1000, 2000)).toBe(true);
    expect(isOutOfOrder(2000, 2000)).toBe(false);
    expect(isOutOfOrder(3000, 2000)).toBe(false);
  });

  it("accepts the first event and NaN times", () => {
    expect(isOutOfOrder(1000, undefined)).toBe(false);
    expect(isOutOfOrder(Number.NaN, 2000)).toBe(false);
  });
});

describe("symbol guard", () => {
  it("isUnderlyingSymbol accepts exactly the two supported symbols", () => {
    expect(isUnderlyingSymbol("BTCUSDT")).toBe(true);
    expect(isUnderlyingSymbol("ETHUSDT")).toBe(true);
    expect(isUnderlyingSymbol("SOLUSDT")).toBe(false);
    expect(isUnderlyingSymbol("btcusdt")).toBe(false);
  });
});
