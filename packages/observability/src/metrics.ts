/**
 * MetricsRegistry: a small, dependency-free metrics registry.
 *
 * Design constraints:
 * - Deterministic rendering: samples are emitted in registration order, then
 *   label order (stable sort by the canonical label string), so identical
 *   state always produces byte-identical output (proven by tests).
 * - Values are numbers here. This module is for *measurement* only — count
 *   totals, ages, latencies, utilization percentages — never money. Money and
 *   share quantities must be computed in the domain (BigInt `Decimal`) and
 *   only reduced, log-safe values cross into metrics. The typed collectors in
 *   `collectors.ts` take Decimal inputs and convert once, at the boundary.
 * - No I/O, no clocks, no environment reads: the registry is a pure data
 *   structure that the caller drives.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricKind = "counter" | "gauge";

/** Immutable label set attached to one time series. */
export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
}

export interface MetricSample {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

// ---------------------------------------------------------------------------
// Secret hygiene at the label boundary
// ---------------------------------------------------------------------------

/**
 * Patterns whose values must never become metric labels. Mirrors the shared
 * logger's `SECRET_PATTERN` so the two layers stay consistent.
 */
export const METRIC_SECRET_PATTERN =
  /passphrase|secret|private[_-]?key|api[_-]?key|password|token|credential|authorization|cookie|wallet/i;

/** Label keys that are always refused regardless of pattern. */
const FORBIDDEN_LABEL_KEYS = new Set([
  "secret",
  "password",
  "passphrase",
  "privatekey",
  "apikey",
  "apisecret",
  "apipassphrase",
  "authorization",
  "cookie",
  "walletprivatekey",
]);

/** Keys whitelisted for market token identifiers (benign, short, non-secret). */
const BENIGN_TOKEN_KEYS = new Set(["token", "tokenid", "tokenup", "tokendown"]);

function isForbiddenLabelKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (BENIGN_TOKEN_KEYS.has(normalized)) {
    return false;
  }
  if (FORBIDDEN_LABEL_KEYS.has(normalized)) {
    return true;
  }
  return METRIC_SECRET_PATTERN.test(normalized);
}

/**
 * Thrown when a metric would carry secret-shaped data (label key or value).
 * Fail closed: the registration or write is aborted rather than redacted, so
 * a programming error is loud instead of silently leaking.
 */
export class SecretLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretLabelError";
  }
}

function assertLabelsSafe(labels: MetricLabels): void {
  for (const [key, value] of Object.entries(labels)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (isForbiddenLabelKey(key) && !BENIGN_TOKEN_KEYS.has(normalized)) {
      throw new SecretLabelError(`metric label key refused: "${key}"`);
    }
    // Values: refuse anything that looks like a long credential-shaped secret
    // (hex/base64 runs of 40+ chars). Market/token ids and statuses are short
    // identifiers and are fine.
    if (typeof value === "string" && /^[A-Za-z0-9_\-+/=]{40,}$/.test(value)) {
      throw new SecretLabelError(`metric label value refused for key "${key}"`);
    }
    if (value.length > 128) {
      throw new SecretLabelError(`metric label value too long for key "${key}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface SeriesEntry {
  readonly kind: MetricKind;
  readonly help: string;
  /** Canonical label string → value. Insertion-ordered per registration. */
  readonly series: Map<string, { labels: MetricLabels; value: number }>;
}

export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly series = new Map<string, SeriesEntry>();

  /**
   * Register a metric. Idempotent per (name, kind, help): re-registering the
   * same definition is a no-op; a conflicting re-registration throws.
   */
  register(name: string, kind: MetricKind, help: string): void {
    const existing = this.definitions.get(name);
    if (existing !== undefined) {
      if (existing.kind !== kind || existing.help !== help) {
        throw new Error(`metric re-registration conflict: ${name}`);
      }
      return;
    }
    this.definitions.set(name, { name, kind, help });
    this.series.set(name, { kind, help, series: new Map() });
  }

  /**
   * Set a sample for a metric. Auto-registers as a gauge when the metric was
   * not registered explicitly (convenience), but a counter MUST be registered
   * first (counters are monotone and need their definition up front).
   */
  set(name: string, labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`metric value must be finite: ${name} = ${value}`);
    }
    assertLabelsSafe(labels);
    const entry = this.series.get(name);
    if (entry === undefined) {
      if (this.definitions.has(name)) {
        // Registered but series map missing — impossible; defensive.
        throw new Error(`metric state corrupted: ${name}`);
      }
      this.register(name, "gauge", `${name} gauge`);
      this.set(name, labels, value);
      return;
    }
    if (entry.kind === "counter" && value < 0) {
      throw new Error(`counter values must be monotone: ${name}`);
    }
    const key = canonicalLabels(labels);
    entry.series.set(key, { labels: { ...labels }, value });
  }

  /**
   * Add to a counter. The metric must already be registered as a counter.
   * Creates the labeled series on first use.
   */
  increment(name: string, labels: MetricLabels, delta = 1): void {
    const entry = this.series.get(name);
    if (entry === undefined || entry.kind !== "counter") {
      throw new Error(`counter not registered: ${name}`);
    }
    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error(`counter delta must be non-negative and finite: ${name}`);
    }
    assertLabelsSafe(labels);
    const key = canonicalLabels(labels);
    const current = entry.series.get(key);
    const next = (current?.value ?? 0) + delta;
    entry.series.set(key, { labels: { ...labels }, value: next });
  }

  /** Whether a metric name is registered. */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Snapshot of all samples, in deterministic order. */
  snapshot(): readonly MetricSample[] {
    const out: MetricSample[] = [];
    for (const def of [...this.definitions.values()]) {
      const entry = this.series.get(def.name);
      if (entry === undefined) {
        continue;
      }
      const keys = [...entry.series.keys()].sort();
      for (const key of keys) {
        const sample = entry.series.get(key);
        if (sample !== undefined) {
          out.push({ name: def.name, labels: sample.labels, value: sample.value });
        }
      }
    }
    return out;
  }

  /**
   * Prometheus text exposition format. Deterministic: metrics in registration
   * order, samples sorted by canonical labels, `# HELP`/`# TYPE` lines first.
   */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const def of [...this.definitions.values()]) {
      const entry = this.series.get(def.name);
      if (entry === undefined) {
        continue;
      }
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.kind}`);
      const keys = [...entry.series.keys()].sort();
      for (const key of keys) {
        const sample = entry.series.get(key);
        if (sample === undefined) {
          continue;
        }
        lines.push(`${def.name}${formatLabels(sample.labels)} ${renderNumber(sample.value)}`);
      }
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  /** JSON rendering (JSON-safe, deterministic order). */
  renderJson(): {
    readonly metrics: readonly {
      readonly name: string;
      readonly kind: MetricKind;
      readonly help: string;
      readonly samples: readonly { readonly labels: MetricLabels; readonly value: number }[];
    }[];
  } {
    return {
      metrics: this.snapshot().reduce<
        {
          name: string;
          kind: MetricKind;
          help: string;
          samples: { labels: MetricLabels; value: number }[];
        }[]
      >((acc, sample) => {
        let bucket = acc.find((m) => m.name === sample.name);
        if (bucket === undefined) {
          const def = this.definitions.get(sample.name);
          bucket = {
            name: sample.name,
            kind: def?.kind ?? "gauge",
            help: def?.help ?? "",
            samples: [],
          };
          acc.push(bucket);
        }
        bucket.samples.push({ labels: sample.labels, value: sample.value });
        return acc;
      }, []),
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Canonical, order-independent label string used as the series map key. */
function canonicalLabels(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`)
    .join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const canonical = canonicalLabels(labels);
  return `{${canonical}}`;
}

/** Fixed-point rendering: enough precision for metrics, never scientific. */
function renderNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  // up to 6 decimal places, trailing zeros trimmed; avoids exponent notation.
  const fixed = value.toFixed(6);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed;
}
