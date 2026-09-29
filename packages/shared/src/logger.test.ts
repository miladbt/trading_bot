import { describe, expect, it } from "vitest";

import { createLogger, isValidLogLevel, redactSecrets, SECRET_PATTERN } from "./logger.js";

describe("isValidLogLevel", () => {
  it("accepts known levels", () => {
    expect(isValidLogLevel("debug")).toBe(true);
    expect(isValidLogLevel("info")).toBe(true);
    expect(isValidLogLevel("warn")).toBe(true);
    expect(isValidLogLevel("error")).toBe(true);
  });

  it("rejects unknown levels", () => {
    expect(isValidLogLevel("verbose")).toBe(false);
    expect(isValidLogLevel("")).toBe(false);
  });
});

describe("createLogger", () => {
  it("falls back to info for an invalid level", () => {
    const log = createLogger("not-a-level");
    expect(() => log.info("hello")).not.toThrow();
  });

  it("supports child loggers with bindings", () => {
    const base = createLogger("error");
    const child = base.child({ module: "test" });
    expect(() => child.warn("hello", { key: "value" })).not.toThrow();
  });

  it("redacts secret-shaped keys in log context", () => {
    const log = createLogger("error");
    expect(() =>
      log.info("attempting start", {
        apiKey: "sk-live-123",
        walletPrivateKey: "0xabc",
        nested: { apiPassphrase: "hunter2" },
      }),
    ).not.toThrow();
  });
});

describe("redactSecrets", () => {
  it("redacts secret-looking keys at the top level", () => {
    const out = redactSecrets({
      apiKey: "sk-123",
      apiSecret: "s3cret",
      passphrase: "p",
      walletPrivateKey: "0xk",
      password: "hunter2",
      token: "tok",
      credentials: { anything: true },
    });
    expect(out).toEqual({
      apiKey: "[REDACTED]",
      apiSecret: "[REDACTED]",
      passphrase: "[REDACTED]",
      walletPrivateKey: "[REDACTED]",
      password: "[REDACTED]",
      token: "[REDACTED]",
      credentials: "[REDACTED]",
    });
  });

  it("redacts nested secrets and keeps safe values", () => {
    const out = redactSecrets({
      market: "btc-5m",
      depth: 3,
      nested: { databaseUrl: "postgres://u:p@h/d", keep: "yes" },
      list: [{ apiKey: "k" }, { ok: 1 }],
    });
    expect(out).toEqual({
      market: "btc-5m",
      depth: 3,
      nested: { databaseUrl: "[REDACTED]", keep: "yes" },
      list: [{ apiKey: "[REDACTED]" }, { ok: 1 }],
    });
  });

  it("does not mutate the input object", () => {
    const input = { apiKey: "sk-123", nested: { secret: "x" } };
    const snapshot = structuredClone(input);
    redactSecrets(input);
    expect(input).toEqual(snapshot);
  });

  it("flags credential-shaped keys via pattern", () => {
    expect(SECRET_PATTERN.test("POLYMARKET_API_KEY")).toBe(true);
    expect(SECRET_PATTERN.test("walletPrivateKey")).toBe(true);
    expect(SECRET_PATTERN.test("marketData")).toBe(false);
  });
});
