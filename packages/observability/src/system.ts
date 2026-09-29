/**
 * System probe: CPU / memory / uptime sampling, isolated from metrics logic.
 *
 * The probe is injectable: production uses `nodeSystemSampler()` (os +
 * process); tests inject a deterministic fake. The probe never reads clocks
 * itself — the caller drives sampling — and never writes anything secret.
 */

import os from "node:os";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";

import { recordSystemMetrics, type SystemSample } from "./collectors.js";
import type { MetricsRegistry } from "./metrics.js";

export interface SystemSampler {
  /** Take one CPU/memory/uptime sample. */
  sample(): SystemSample;
}

/**
 * Production sampler using `os` and `process`.
 *
 * CPU percent is computed from `process.cpuUsage()` deltas between samples
 * (percent of one core, wall-clock based), so the first call returns the
 * baseline (0) and subsequent calls return the usage since the previous call.
 */
export function nodeSystemSampler(): SystemSampler {
  let lastCpu = process.cpuUsage();
  let lastWall = performance.now();

  return {
    sample(): SystemSample {
      const cpu = process.cpuUsage();
      const wall = performance.now();
      const cpuDelta = cpu.user + cpu.system - (lastCpu.user + lastCpu.system);
      const wallDelta = Math.max(wall - lastWall, 1);
      lastCpu = cpu;
      lastWall = wall;
      const cpuPercent = Math.min(100, Math.max(0, (cpuDelta / 1000 / wallDelta) * 100));
      const memory = process.memoryUsage();

      return {
        cpuPercent,
        memoryUsedBytes: os.totalmem() - os.freemem(),
        memoryRssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
        uptimeSeconds: process.uptime(),
      };
    },
  };
}

/** Sample once and write the system metrics into the registry. */
export function recordSystemSample(
  sampler: SystemSampler,
  registry: MetricsRegistry,
): SystemSample {
  const sample = sampler.sample();
  recordSystemMetrics(registry, sample);
  return sample;
}
