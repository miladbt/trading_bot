import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Patterns whose values must never reach a log line. Matching keys are
 * redacted by `redactSecrets` before logging; pino's own redact path is
 * configured separately in createLogger.
 */
export const SECRET_PATTERN =
  /passphrase|secret|private[_-]?key|api[_-]?key|password|token|credential/i;

/** Keys that always redact regardless of pattern. */
const ALWAYS_REDACT = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "databaseurl",
  "walletprivatekey",
]);

function isSecretKey(key: string): boolean {
  return ALWAYS_REDACT.has(key.toLowerCase()) || SECRET_PATTERN.test(key);
}

/**
 * Deep-copy a context object with secret-looking values replaced by
 * "[REDACTED]". Pure; used by the logger for defense-in-depth so a stray
 * credential in a context object can never reach the log sink.
 */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 4) return value;
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    return arr.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Booleans/numbers cannot be secrets (e.g. a "credentialsComplete"
      // flag); only strings and nested objects get redacted for secret keys.
      const secretValue =
        isSecretKey(k) && (typeof v === "string" || (v !== null && typeof v === "object"));
      out[k] = secretValue ? "[REDACTED]" : redactSecrets(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

export function isValidLogLevel(value: string): value is LogLevel {
  return value in levelRank;
}

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  const normalized = isValidLogLevel(level) ? level : "info";
  const pinoLogger = pino({
    level: normalized,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "apiKey",
        "apiSecret",
        "apiPassphrase",
        "passphrase",
        "privateKey",
        "walletPrivateKey",
        "password",
        "token",
        "secret",
        "credentials",
        "authorization",
        "cookie",
        "databaseUrl",
        "*.apiKey",
        "*.apiSecret",
        "*.apiPassphrase",
        "*.passphrase",
        "*.privateKey",
        "*.walletPrivateKey",
        "*.password",
        "*.token",
        "*.secret",
        "*.credentials",
        "*.authorization",
        "*.cookie",
        "*.databaseUrl",
      ],
      censor: "[REDACTED]",
    },
  });

  const wrap = (p: pino.Logger): Logger => ({
    debug: (msg, ctx) => p.debug(redactSecrets(ctx ?? {}), msg),
    info: (msg, ctx) => p.info(redactSecrets(ctx ?? {}), msg),
    warn: (msg, ctx) => p.warn(redactSecrets(ctx ?? {}), msg),
    error: (msg, ctx) => p.error(redactSecrets(ctx ?? {}), msg),
    child: (bindings) => wrap(p.child(redactSecrets(bindings))),
  });

  return wrap(pinoLogger);
}
