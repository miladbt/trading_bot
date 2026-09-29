/**
 * Structured logging helpers.
 *
 * Emits JSON lines via the shared redacting logger (`@bot/shared`). Field
 * names are stable and machine-parseable: `area`, `event`, plus
 * area-specific fields. Money/share values are rendered with `decToString`
 * (exact 8-dp fixed-point strings) — never floats, never secret material.
 *
 * The logger from `@bot/shared` redacts secret-shaped keys (defense in
 * depth); this module additionally avoids passing secret-shaped data at all.
 */

import { decToString, type Decimal } from "@bot/domain";
import { createLogger, redactSecrets, type Logger } from "@bot/shared";

/** Event areas, used as the `area` log field. */
export type LogArea =
  "market" | "strategy" | "inventory" | "execution" | "risk" | "system" | "control";

/** JSON-safe log field values. */
export type LogFieldValue = string | number | boolean | undefined;

/** Decimal-or-string input rendered as an exact fixed-point string. */
export type LogNumeric = Decimal | number | string;

function numericString(value: LogNumeric): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("log numeric must be finite");
    }
    return value.toFixed(8);
  }
  return typeof value === "string" ? value : decToString(value);
}

/**
 * A structured event logger bound to one area.
 *
 * Every method appends the standard fields (`area`, `event`) plus caller
 * fields; Decimals are stringified exactly; undefined values are dropped.
 */
export class AreaLogger {
  private readonly logger: Logger;

  constructor(area: LogArea, logger?: Logger) {
    this.logger = (logger ?? createLogger()).child({ area });
  }

  debug(event: string, fields: Readonly<Record<string, LogFieldValue | LogNumeric>> = {}): void {
    this.logger.debug(event, renderFields(fields));
  }

  info(event: string, fields: Readonly<Record<string, LogFieldValue | LogNumeric>> = {}): void {
    this.logger.info(event, renderFields(fields));
  }

  warn(event: string, fields: Readonly<Record<string, LogFieldValue | LogNumeric>> = {}): void {
    this.logger.warn(event, renderFields(fields));
  }

  error(event: string, fields: Readonly<Record<string, LogFieldValue | LogNumeric>> = {}): void {
    this.logger.error(event, renderFields(fields));
  }
}

/**
 * Render caller fields: numeric strings exact, undefined dropped, and the
 * result passed through the shared `redactSecrets` so secret-shaped keys can
 * never reach the sink — even when the injected logger would not redact.
 */
function renderFields(
  fields: Readonly<Record<string, LogFieldValue | LogNumeric>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = numericString(value);
    }
  }
  return redactSecrets(out);
}

/** Convenience: an AreaLogger per concern area. */
export function createAreaLoggers(logger?: Logger): {
  market: AreaLogger;
  strategy: AreaLogger;
  inventory: AreaLogger;
  execution: AreaLogger;
  risk: AreaLogger;
  system: AreaLogger;
  control: AreaLogger;
} {
  return {
    market: new AreaLogger("market", logger),
    strategy: new AreaLogger("strategy", logger),
    inventory: new AreaLogger("inventory", logger),
    execution: new AreaLogger("execution", logger),
    risk: new AreaLogger("risk", logger),
    system: new AreaLogger("system", logger),
    control: new AreaLogger("control", logger),
  };
}
