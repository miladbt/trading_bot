import { createLogger, loadBotConfig, toLogSafeConfig } from "@bot/shared";

/**
 * Trader entrypoint — scaffold phase.
 *
 * Validates configuration at startup (refusing to start on any violation,
 * including any attempt to enable live trading) and reports readiness. The
 * strategy loop, Polymarket connectivity, and all trading logic are
 * intentionally absent.
 */
function main(): void {
  const log = createLogger().child({ component: "trader" });

  let loaded;
  try {
    loaded = loadBotConfig();
  } catch (err) {
    log.error("configuration invalid; refusing to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }

  const { config, credentials } = loaded;
  log.info("trader scaffold initialized (no trading logic)", {
    config: toLogSafeConfig(config),
    credentialsComplete: credentials.polymarketComplete,
  });

  if (config.trading.mode === "live" || config.trading.liveTradingEnabled) {
    // Defensive: the loader rejects this combination unless credentials are
    // complete, and live trading itself is not implemented anywhere.
    log.warn("live trading switch present, but live trading is not implemented");
    process.exitCode = 1;
    return;
  }
}

main();
