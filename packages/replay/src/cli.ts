/**
 * `pnpm replay` CLI: run a deterministic historical replay and write reports.
 *
 * Usage:
 *   pnpm replay --dataset <path-to-json> [--outdir <dir>] [--speed <x>] [--tick <ms>]
 *
 * - Reads NO credentials and performs NO network calls: the dataset is a
 *   local JSON file (see fixtures/replay-sample.json for the schema).
 * - `--speed` paces ticks in real time (1 = historical-realtime, 0 = as fast
 *   as possible, default 0). It NEVER changes results.
 * - Writes `report.csv` and `report.json` into the outdir (default ./replay-out).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadBotConfig, createLogger } from "@bot/shared";

import { loadDatasetJson, parseDataset } from "./sources.js";
import { ReplayEngine, DEFAULT_REPLAY_CONFIG } from "./replay.js";
import { summaryLine, toCsv, toJson } from "./report.js";
import {
  ANALYSIS_CSV_HEADER,
  analysisToCsvRow,
  analyzePerformance,
  collectPerformanceInputs,
} from "./analytics.js";

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      args[key] = next !== undefined && !next.startsWith("--") ? next : "true";
    }
  }
  return args;
}

/**
 * Resolve a CLI path: relative paths are tried against the repo root first
 * (detected by the presence of pnpm-workspace.yaml, since pnpm runs the script
 * with the package dir as cwd), then against the current directory.
 */
function resolvePath(p: string): string {
  if (!p.startsWith(".") && !p.includes(":") && !p.startsWith("/") && !p.startsWith("\\")) {
    let dir = process.cwd();
    while (true) {
      if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
        const rooted = resolve(dir, p);
        if (existsSync(resolve(dir, p)) || !existsSync(p)) return rooted;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(process.cwd(), p);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = resolvePath(args["dataset"] ?? "fixtures/replay-sample.json");
  const outdir = resolvePath(args["outdir"] ?? "replay-out");
  const speed = args["speed"] !== undefined ? Number(args["speed"]) : DEFAULT_REPLAY_CONFIG.speed;
  const tickMs = args["tick"] !== undefined ? Number(args["tick"]) : DEFAULT_REPLAY_CONFIG.tickMs;

  const log = createLogger().child({ component: "replay" });

  // Paper-mode safety: refuse anything else. Live trading is not implemented.
  const { config } = loadBotConfig();
  if (config.trading.mode !== "paper" || config.trading.liveTradingEnabled) {
    log.error("replay supports paper mode only; refusing to run");
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(datasetPath, "utf8");
  } catch (err) {
    log.error("cannot read dataset file", {
      path: datasetPath,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }

  try {
    const dataset = loadDatasetJson(raw);
    const windows = parseDataset(dataset);
    const engine = new ReplayEngine(windows, { speed, tickMs });
    const report = engine.run(config);

    mkdirSync(outdir, { recursive: true });
    writeFileSync(resolve(outdir, "report.csv"), toCsv(report));
    writeFileSync(resolve(outdir, "report.json"), toJson(report));
    // Performance analysis (measurement & validation only — no ranking).
    const analysis = analyzePerformance(
      collectPerformanceInputs(report, config.risk.maxTotalCapital),
    );
    writeFileSync(
      resolve(outdir, "analysis.csv"),
      `${ANALYSIS_CSV_HEADER}\n${analysisToCsvRow(analysis)}\n`,
    );

    log.info(`replay complete: ${summaryLine(report)}`);
    log.info(
      `reports written to ${outdir}/report.csv, ${outdir}/report.json, ${outdir}/analysis.csv`,
    );
  } catch (err) {
    log.error("replay failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}

main();
