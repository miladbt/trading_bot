/**
 * Soak CLI: `pnpm soak --data <dir> [--interval <ms>] [--cycles <n>] [--start <ms>]`
 *
 * Long-running paper-trading soak loop with a deterministic synthetic feed
 * (the market-data adapters exist but need live sockets; the soak uses a
 * seeded generator so runs are reproducible). Real-time pacing via
 * `setInterval`-style loop with a configurable interval; SIGTERM/SIGINT
 * trigger a graceful stop (the current cycle finishes, state persists).
 *
 * Safety: validates paper mode from the environment before doing anything;
 * live trading is never enabled.
 */

import { createLogger, loadBotConfig } from "@bot/shared";
import { decFromString, millis } from "@bot/domain";
import { createExecutionAdapter, createSimulatedBook } from "@bot/execution";
import { StrategyOrchestrator } from "@bot/orchestrator";
import { DEFAULT_SIGNAL_ENGINE_CONFIG } from "@bot/strategy";
import { deserializeCalibration } from "@bot/calibration";
import { readFileSync } from "node:fs";

import { SoakRunner, DEFAULT_SOAK_CONFIG } from "./runner.js";

interface CliArgs {
  readonly data: string;
  readonly intervalMs: number;
  readonly cycles: number; // 0 = run until stopped
  readonly startMs: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      args[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "true";
    }
  }
  return {
    data: args["data"] ?? "soak-data",
    intervalMs: Number(args["interval"] ?? "5000"),
    cycles: Number(args["cycles"] ?? "0"),
    startMs: Number(args["start"] ?? String(Date.now())),
  };
}

/**
 * Deterministic synthetic universe: one BTC and one ETH 5-minute market on a
 * repeating cycle, seeded price paths (mild uptrend/downtrend oscillation),
 * healthy data with realistic ages. Deterministic for a given (startMs, tick).
 */
function buildSyntheticFeed(startMs: number, tickIndex: number) {
  const cycleMs = 300_000;
  const cycleStart = startMs - (startMs % cycleMs) + Math.floor(tickIndex / 60) * cycleMs;
  const t = millis(startMs + tickIndex * 5_000);
  const wave = Math.sin(tickIndex / 20) * 0.5 + 0.5; // 0..1 slow oscillation
  const upAsk = (0.44 + wave * 0.04).toFixed(8);
  const downAsk = (1.01 - Number(upAsk)).toFixed(8);

  const btc = {
    marketId: "soak-btc-1",
    tokenIdUp: "soak-btc-up",
    tokenIdDown: "soak-btc-down",
    asset: "BTC" as never,
    startMs: millis(cycleStart),
    endMs: millis(cycleStart + cycleMs),
  };
  const eth = {
    marketId: "soak-eth-1",
    tokenIdUp: "soak-eth-up",
    tokenIdDown: "soak-eth-down",
    asset: "ETH" as never,
    startMs: millis(cycleStart),
    endMs: millis(cycleStart + cycleMs),
  };

  const mkSamples = (base: number, drift: number) =>
    [4, 3, 2, 1, 0].map((back) => ({
      price: (base + drift * (5 - back) + wave * 2).toFixed(2),
      at: millis(Number(t) - back * 5_000),
    }));

  return {
    now: t,
    markets: [btc, eth],
    dataByMarket: new Map([
      [
        btc.marketId,
        {
          marketId: btc.marketId,
          upAsk: decFromString(upAsk),
          downAsk: decFromString(downAsk),
          ageMs: 250,
          underlyingAgeMs: 250,
          apiHealth: "healthy" as const,
          wsHealth: "healthy" as const,
        },
      ],
      [
        eth.marketId,
        {
          marketId: eth.marketId,
          upAsk: decFromString(upAsk),
          downAsk: decFromString(downAsk),
          ageMs: 250,
          underlyingAgeMs: 250,
          apiHealth: "healthy" as const,
          wsHealth: "healthy" as const,
        },
      ],
    ]),
    samplesByAsset: new Map<string, { price: string; at: ReturnType<typeof millis> }[]>([
      ["BTC", mkSamples(100_000, 12)],
      ["ETH", mkSamples(50_000, -6)],
    ]),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger().child({ component: "soak-cli" });

  // ---- Paper-mode gate (fail closed before anything else) ----
  const { config } = loadBotConfig();
  if (config.trading.mode !== "paper" || config.trading.liveTradingEnabled) {
    log.error("soak requires paper mode; refusing to run", {
      mode: config.trading.mode,
      liveTradingEnabled: config.trading.liveTradingEnabled,
    });
    process.exitCode = 1;
    return;
  }

  // The reconciliation gate observed by the orchestrator's risk checks:
  // updated from the runner after every cycle, so a blocking reconciliation
  // genuinely enforces NO_NEW_ORDERS in the next ticks (fail closed: unknown
  // until the first clean pass).
  const gate: { state: "reconciled" | "unreconciled" | "unknown" } = { state: "unknown" };

  // The orchestrator's port set, backed by the synthetic feed.
  let feed = buildSyntheticFeed(args.startMs, 0);
  const adapter = createExecutionAdapter("paper", {
    tokens: feed.markets.flatMap((m) => [
      {
        tokenId: m.tokenIdUp,
        book: createSimulatedBook([
          { price: decFromString("0.45"), qty: decFromString("50") },
          { price: decFromString("0.45"), qty: decFromString("5000") },
        ]),
      },
      {
        tokenId: m.tokenIdDown,
        book: createSimulatedBook([
          { price: decFromString("0.56"), qty: decFromString("50") },
          { price: decFromString("0.56"), qty: decFromString("5000") },
        ]),
      },
    ]),
    takerFeeRate: decFromString("0.002"),
  });

  // T2: optional calibration model per enabled asset, loaded from the
  // configured versioned-JSON file. Absence of CALIBRATION_FILE leaves the
  // raw prior in effect; a configured-but-bad file fails closed here.
  const calibration: Record<string, ReturnType<typeof deserializeCalibration>> = {};
  if (config.strategy.calibrationFile !== "") {
    const raw = readFileSync(config.strategy.calibrationFile, "utf8");
    const model = deserializeCalibration(raw);
    calibration[String(model.asset)] = model;
    log.info("calibration model loaded", {
      file: config.strategy.calibrationFile,
      asset: String(model.asset),
      version: model.version,
      method: model.method,
      fittedAt: model.fit.lastAt,
    });
  }

  const orchestrator = new StrategyOrchestrator({
    config,
    ports: {
      discoverMarkets: () => feed.markets,
      marketData: (m) => feed.dataByMarket.get(m.marketId),
      spotSamples: (asset) => feed.samplesByAsset.get(String(asset)) ?? [],
      account: () => ({
        openOrderCount: adapter.listOpenOrders().length,
        totalCapitalDeployed: decFromString("0"),
        marketCapitalByMarket: {},
        directionalExposureAfter: decFromString("0"),
        dailyLossUsdc: decFromString("0"),
        marketLossByMarket: {},
        // "unknown" is represented as undefined in the account snapshot —
        // the risk engine treats undefined reconciliation as refusal.
        reconciliation: gate.state === "unknown" ? undefined : gate.state,
      }),
      lots: () => ({ up: [], down: [] }),
    },
    adapter,
    signalConfig: DEFAULT_SIGNAL_ENGINE_CONFIG,
    ...(Object.keys(calibration).length > 0 ? { calibration } : {}),
  });

  const runner = new SoakRunner({
    config,
    orchestrator,
    adapter,
    dataDir: args.data,
    runnerConfig: DEFAULT_SOAK_CONFIG,
    log,
  });

  // ---- Graceful stop on SIGTERM/SIGINT ----
  let interrupted = false;
  const onSignal = (signal: string) => {
    interrupted = true;
    log.info("stop requested; finishing current cycle", { signal });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  // ---- The loop: real-time pacing, deterministic feed ----
  const syncGate = (): void => {
    gate.state = runner.reconciliationState;
  };
  syncGate();
  log.info("soak loop starting", {
    dataDir: args.data,
    intervalMs: args.intervalMs,
    cycles: args.cycles === 0 ? "unbounded" : args.cycles,
    tradingMode: "paper",
  });

  let tickIndex = 0;
  const runLoop = (): void => {
    // Pace by wall clock in real time; the feed itself is deterministic.
    feed = buildSyntheticFeed(args.startMs, tickIndex);
    const health = runner.runCycle(feed.now);
    tickIndex += 1;
    syncGate();
    log.info("cycle complete", {
      tickIndex,
      reconciliation: health.reconciliation,
      openOrders: health.openOrders,
      lots: health.lotCount,
    });
    if (interrupted || (args.cycles > 0 && tickIndex >= args.cycles)) {
      runner.stop();
      runner.finalize();
      log.info("soak loop finished", { cycles: tickIndex, dataDir: args.data });
      process.exit(0);
    }
    setTimeout(runLoop, Math.max(args.intervalMs, 100));
  };
  runLoop();
}

main();
