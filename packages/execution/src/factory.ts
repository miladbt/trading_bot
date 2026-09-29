/**
 * Execution backend factory — the ONLY place that maps a trading mode to an
 * adapter implementation.
 *
 * Fail-closed guarantee: `TRADING_MODE=paper` (the default) can only ever
 * produce the `PaperExecutionAdapter`, which holds no venue client, no
 * credentials, and no network code — it is structurally incapable of reaching
 * Polymarket. `mode: "live"` is refused unconditionally: live execution does
 * not exist yet, so asking for it is a hard error, not a silent fallback.
 *
 * The `LiveExecutionAdapter` type exists so the future live adapter has a
 * named home in the type system, but there is deliberately no value of it.
 */

import type { AppConfig } from "@bot/shared";

import type { ExecutionAdapter } from "./adapter.js";
import { PaperExecutionAdapter, type PaperAdapterConfig } from "./paper-adapter.js";

/** Brand marking an adapter that may touch the real venue. None exists yet. */
export interface LiveExecutionAdapter extends ExecutionAdapter {
  readonly backend: "live";
}

/** Error thrown when a mode requests a backend that does not exist. */
export class LiveExecutionNotImplementedError extends Error {
  constructor(mode: string) {
    super(
      `live execution is not implemented; TRADING_MODE=${mode} cannot be served by any real venue adapter`,
    );
    this.name = "LiveExecutionNotImplementedError";
  }
}

export type ExecutionBackend = PaperExecutionAdapter; // union grows when live exists

/**
 * Resolve the execution backend for a trading mode. Fail closed:
 * - "paper" → PaperExecutionAdapter (simulated books only; no venue reach).
 * - "live"  → throws LiveExecutionNotImplementedError (no such adapter).
 * - anything else → throws (unknown state means no execution).
 */
export function createExecutionAdapter(
  mode: AppConfig["trading"]["mode"],
  paperConfig: PaperAdapterConfig,
): ExecutionBackend {
  switch (mode) {
    case "paper":
      return new PaperExecutionAdapter(paperConfig);
    case "live":
      throw new LiveExecutionNotImplementedError(mode);
    default: {
      const exhaustive: never = mode;
      throw new LiveExecutionNotImplementedError(String(exhaustive));
    }
  }
}

/**
 * Runtime guard for tests and callers: only the paper adapter can pass.
 * Anything claiming a live backend is unreachable through supported paths;
 * encountering one is a hard error.
 */
export function assertPaperBackend(adapter: ExecutionAdapter): PaperExecutionAdapter {
  if (!(adapter instanceof PaperExecutionAdapter)) {
    throw new LiveExecutionNotImplementedError(adapter.backend);
  }
  return adapter;
}
