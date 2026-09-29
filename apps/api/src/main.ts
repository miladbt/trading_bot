import { createLogger, loadConfig, toLogSafeConfig } from "@bot/shared";

import { startApiServer, stopApiServer } from "./server.js";

/**
 * API entrypoint — production deployment surface.
 *
 * - Validates configuration at startup (refusing to start on any violation,
 *   including any attempt to enable live trading).
 * - Serves GET /health (liveness) and GET /ready (readiness, 503 until the
 *   process reports itself warm).
 * - Handles SIGTERM/SIGINT with graceful shutdown: stop accepting, drain
 *   in-flight requests within a bounded grace period, then exit 0.
 */
async function main(): Promise<void> {
  const log = createLogger().child({ component: "api" });

  const config = loadConfig();
  const port = config.services.apiPort;

  // Fail closed on any non-paper configuration; live trading does not exist.
  if (config.trading.mode !== "paper" || config.trading.liveTradingEnabled) {
    log.error("api refuses non-paper configuration", {
      mode: config.trading.mode,
      liveTradingEnabled: config.trading.liveTradingEnabled,
    });
    process.exitCode = 1;
    return;
  }

  let ready = false;
  const server = await startApiServer({
    port,
    tradingMode: config.trading.mode,
    liveTradingEnabled: config.trading.liveTradingEnabled,
    isReady: () => ready,
  });

  const signalHandler = (signal: string) => {
    ready = false; // /ready flips to 503 immediately
    log.info("shutdown signal received; draining", { signal });
    const graceMs = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? "10000");
    void stopApiServer(server, graceMs).then(() => {
      log.info("api stopped cleanly");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => signalHandler("SIGTERM"));
  process.on("SIGINT", () => signalHandler("SIGINT"));

  // Warm-up complete: the process is now accepting production traffic.
  ready = true;
  log.info("api listening", {
    port,
    routes: ["/health", "/ready"],
    tradingMode: config.trading.mode,
    runtime: toLogSafeConfig(config).runtime,
  });
}

main().catch((err: unknown) => {
  const log = createLogger("error").child({ component: "api" });
  log.error("api failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
