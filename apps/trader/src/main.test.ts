import { describe, expect, it } from "vitest";

import { createLogger, loadConfig, toLogSafeConfig } from "@bot/shared";

describe("trader scaffold", () => {
  it("loads config with defaults, creates a logger, and exposes a log-safe view", () => {
    const config = loadConfig({});
    const log = createLogger("error").child({ component: "trader" });
    expect(() => log.info("smoke")).not.toThrow();
    expect(config.trading.mode).toBe("paper");
    expect(config.trading.liveTradingEnabled).toBe(false);
    expect(config.assets.enabled).toEqual(["BTC", "ETH"]);
    expect(config.market.cycleMs).toBe(300_000);
    // log-safe projection drops the services group (database URL)
    expect("services" in toLogSafeConfig(config)).toBe(false);
  });
});
