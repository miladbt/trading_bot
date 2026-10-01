/**
 * Backtest dataset fetcher CLI (T10):
 *
 *   pnpm --filter @bot/backtest fetch -- --assets BTC,ETH --hours 30 --out data/backtest/dataset.json
 *
 * Reads ONLY official public APIs (Gamma + CLOB prices-history; see
 * fetch-dataset.ts for the verified endpoint shapes). Writes a versioned
 * JSON dataset. No credentials; no live trading.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { fetchDataset } from "../src/fetch-dataset.js";

interface Args {
  readonly assets: ("BTC" | "ETH")[];
  readonly hours: number;
  readonly out: string;
  readonly delayMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      args[a.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "true";
    }
  }
  const assets = (args["assets"] ?? "BTC,ETH")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is "BTC" | "ETH" => s === "BTC" || s === "ETH");
  return {
    assets: assets.length > 0 ? assets : ["BTC"],
    hours: Number(args["hours"] ?? "30"),
    out: args["out"] ?? "data/backtest/dataset.json",
    delayMs: Number(args["delay"] ?? "120"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  // The 24h hold-out is the LAST 24h; the walk-forward training data is the
  // earlier part of the fetched span (see T10 discipline in docs).
  const windowEndMs = Math.floor(now / 300_000) * 300_000 - 300_000; // last fully settled window
  const windowStartMs = windowEndMs - args.hours * 3_600_000;

  console.log(
    `fetching ${args.assets.join("+")} ${args.hours}h window ` +
      `${new Date(windowStartMs).toISOString()} -> ${new Date(windowEndMs).toISOString()} ` +
      `(~${(args.hours * 12 * args.assets.length).toFixed(0)} markets, delay ${args.delayMs}ms)`,
  );

  const dataset = await fetchDataset(
    { assets: args.assets, windowStartMs, windowEndMs, delayMs: args.delayMs },
    (msg) => console.log("  ", msg),
  );

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(dataset));
  console.log(
    `dataset written: ${outPath} (${dataset.markets.length} markets, ` +
      `${Object.keys(dataset.tokenHistories).length} token histories, ` +
      `${dataset.provenance.skipped.length} skipped)`,
  );
}

void main();
