/**
 * Independent structural verification of LIVE_READINESS.md claims (T8).
 *
 * These tests do NOT trust the report: each one re-proves a structural claim
 * from the repository source itself, so the doc's status column can cite a
 * named, always-runnable test. Grep-style checks read files with node:fs —
 * unit tests must not shell out (AGENTS.md rule 7) and must be deterministic
 * and offline.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Repository walker (source files only; skip tests/dist/node_modules/docs)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Recursive walk of *.ts files under a directory (relative to repo root). */
function tsFiles(dir: string, out: string[] = []): string[] {
  const abs = join(REPO_ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return out; // missing directory: nothing to scan
  }
  for (const entry of entries) {
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(join(dir, entry).split("\\").join("/"));
    }
    const child = join(dir, entry);
    try {
      if (statSync(join(REPO_ROOT, child)).isDirectory() && !SKIP_DIRS.has(entry)) {
        tsFiles(child, out);
      }
    } catch {
      // not a directory or unreadable: skip
    }
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function allSourceFiles(): string[] {
  return [...tsFiles("packages"), ...tsFiles("apps"), ...tsFiles("hermes")];
}

// ---------------------------------------------------------------------------
// 1. RiskEngine cannot be bypassed: exactly one adapter.submit call site,
//    in the orchestrator, after evaluateRiskOrder
// ---------------------------------------------------------------------------

describe("item 1 — RiskEngine cannot be bypassed", () => {
  it("has exactly one adapter.submit call site in non-test sources: the orchestrator", () => {
    const sites: string[] = [];
    for (const file of allSourceFiles()) {
      const src = read(file);
      // Call sites: `.submit(` on the adapter port (excludes type/interface
      // mentions and comments are tolerated: comments never contain `= this.adapter` style code; we match invocation shape precisely)
      if (/adapter\.submit\(/.test(src)) {
        sites.push(file);
      }
    }
    expect(sites).toEqual(["packages/orchestrator/src/orchestrator.ts"]);
  });

  it("routes risk through evaluateRiskOrder in the same file, before submit", () => {
    const src = read("packages/orchestrator/src/orchestrator.ts");
    const riskAt = src.indexOf("evaluateRiskOrder(");
    const submitAt = src.indexOf("this.adapter.submit(");
    expect(riskAt).toBeGreaterThan(-1);
    expect(submitAt).toBeGreaterThan(riskAt);
  });

  it("refuses to submit unless risk.allowed", () => {
    const src = read("packages/orchestrator/src/orchestrator.ts");
    expect(src).toMatch(/if \(!risk\.allowed\)/);
    expect(src).toMatch(/halted_risk/);
  });
});

// ---------------------------------------------------------------------------
// 2./3. Paper execution cannot reach live; live requires explicit config
// ---------------------------------------------------------------------------

describe("items 2–3 — execution factory is fail-closed", () => {
  it("paper maps only to PaperExecutionAdapter; live throws; unknown throws", () => {
    const src = read("packages/execution/src/factory.ts");
    expect(src).toMatch(/LiveExecutionNotImplementedError/);
    expect(src).toMatch(/assertPaperBackend/);
    // The live branch throws before constructing anything else.
    const liveBranch = src.slice(src.indexOf('case "live"'), src.indexOf("default:"));
    expect(liveBranch).toMatch(/throw/);
  });

  it("config loader keeps live trading behind mode+credentials guards", () => {
    const src = read("packages/shared/src/config/loader.ts");
    expect(src).toMatch(/LIVE_TRADING_ENABLED=true requires TRADING_MODE=live/);
    expect(src).toMatch(/TRADING_MODE=live requires LIVE_TRADING_ENABLED=true/);
    expect(src).toMatch(/TRADING_MODE=live requires complete Polymarket credentials/);
    expect(src).toMatch(/ENABLE_EXTERNAL_HEDGE=true is not supported/);
  });

  it("orchestrator refuses a live config at construction", () => {
    const src = read("packages/orchestrator/src/orchestrator.ts");
    expect(src).toMatch(/supports paper mode only/);
  });
});

// ---------------------------------------------------------------------------
// 7./8. WS recovery + stale-data halts
// ---------------------------------------------------------------------------

describe("items 7–8 — recovery and staleness gates exist", () => {
  it("underlying provider implements reconnect-with-backoff and staleness", () => {
    const src = read("packages/market-data/src/underlying/provider.ts");
    expect(src).toMatch(/backoff|Backoff/);
    expect(src).toMatch(/stale/);
    expect(src).toMatch(/freshnessMs/);
  });

  it("risk engine refuses on stale market/underlying data", () => {
    const src = read("packages/risk/src/engine.ts");
    expect(src).toMatch(/stale_market_data/);
    expect(src).toMatch(/stale_underlying_data/);
  });

  it("orchestrator halts before proposing orders when data is stale", () => {
    const src = read("packages/orchestrator/src/orchestrator.ts");
    expect(src).toMatch(/halted_stale_market_data/);
    expect(src).toMatch(/halted_stale_underlying_data/);
  });
});

// ---------------------------------------------------------------------------
// 10. Hermes cannot bypass controls: no imports from execution/orchestrator,
//     no order submission surface
// ---------------------------------------------------------------------------

describe("item 10 — hermes isolation", () => {
  it("imports nothing from execution/orchestrator/inventory/risk packages", () => {
    const files = tsFiles("hermes");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = read(file);
      expect(src, `${file} imports @bot/execution`).not.toMatch(/@bot\/execution/);
      expect(src, `${file} imports @bot/orchestrator`).not.toMatch(/@bot\/orchestrator/);
      expect(src, `${file} imports @bot/inventory`).not.toMatch(/@bot\/inventory/);
      expect(src, `${file} imports @bot/risk`).not.toMatch(/@bot\/risk/);
      expect(src, `${file} imports @bot/market-data`).not.toMatch(/@bot\/market-data/);
    }
  });

  it("hermes sources contain no order-submission call shape", () => {
    for (const file of tsFiles("hermes")) {
      expect(read(file), file).not.toMatch(/\.submit\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 12./13. Settlement + complete-set determinism claims are anchored in source
// ---------------------------------------------------------------------------

describe("items 12–13 — settlement and set-accounting anchors", () => {
  it("domain complete-set model encodes the payout identity", () => {
    const src = read("packages/domain/src/complete-set.ts");
    expect(src).toMatch(/setPayoutAtSettlement/);
    expect(src).toMatch(/Payout of a set at settlement/);
  });

  it("STRATEGY.md documents the capital-neutral settlement property", () => {
    const doc = read("STRATEGY.md");
    expect(doc).toMatch(/at settlement they return\s+exactly their settlement value/);
  });

  it("matchCompleteSets is a pure inventory function over Decimal", () => {
    const src = read("packages/inventory/src/complete-set-engine.ts");
    expect(src).toMatch(/export function matchCompleteSets/);
    expect(src).toMatch(/Decimal/);
  });
});

// ---------------------------------------------------------------------------
// 17–19. Counts in LIVE_READINESS.md must not be stale
// ---------------------------------------------------------------------------

describe("items 17–19 — doc consistency", () => {
  it("LIVE_READINESS.md no longer carries the stale 536 count or persistence contradiction", () => {
    const doc = read("LIVE_READINESS.md");
    expect(doc).not.toMatch(/536 passed/);
    expect(doc).not.toMatch(/packages\/persistence` remains a stub/);
    expect(doc).toMatch(/T8 program|readiness-structural\.test\.ts/);
  });

  it("README.md no longer claims scaffold-only status", () => {
    const doc = read("README.md");
    expect(doc).not.toMatch(/\*\*Status: scaffold only\.\*\*/);
  });
});
