/** All env-driven configuration in one place, parsed and defaulted once. */

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("SOLARI_API_KEY is not set. Copy .env.example to .env and add your key.")
  process.exit(1)
}

export const config = {
  apiKey,
  port: num("PORT", 3000),
  token: process.env.SCOPE_TOKEN?.trim() || null,
  pollSeconds: Math.max(2, num("POLL_SECONDS", 4)),

  reaper: {
    idleMinutes: Math.max(0, num("REAP_IDLE_MINUTES", 0)),
    mode: (process.env.REAP_MODE?.trim() === "live" ? "live" : "dry-run") as
      | "live"
      | "dry-run",
    /** CPU% at or below this counts as "not doing anything". */
    cpuIdlePct: num("REAP_CPU_IDLE_PCT", 3),
    /** How often to sample a session's live metrics, seconds. */
    metricsEverySeconds: Math.max(10, num("METRICS_EVERY_SECONDS", 20)),
    /** Cap metric samples per tick so a big fleet can't stall a poll. */
    maxSamplesPerTick: Math.max(1, num("METRICS_MAX_PER_TICK", 25)),
  },

  rates: {
    sandbox: num("RATE_SANDBOX_PER_HOUR", 0.12),
    desktop: num("RATE_DESKTOP_PER_HOUR", 0.28),
  },

  // Vera — the planner that writes worker scripts. Runs on an NVIDIA Nemotron
  // model; VERA_* is preferred, NEMOTRON_* still works.
  vera: {
    apiKey:
      process.env.VERA_API_KEY?.trim() || process.env.NEMOTRON_API_KEY?.trim() || null,
    baseUrl:
      process.env.VERA_BASE_URL?.trim() ||
      process.env.NEMOTRON_BASE_URL?.trim() ||
      "https://integrate.api.nvidia.com/v1",
    model:
      process.env.VERA_MODEL?.trim() ||
      process.env.NEMOTRON_MODEL?.trim() ||
      "nvidia/nemotron-3-super-120b-a12b",
    maxTokens: Math.max(1000, num("VERA_MAX_TOKENS", 4096)),
  },

  fanout: {
    /** Max workers a single run may request. */
    maxWorkers: Math.max(1, num("FANOUT_MAX_WORKERS", 20)),
    /** How many sandboxes to create at once (Solari's plan caps this too). */
    concurrency: Math.max(1, num("FANOUT_CONCURRENCY", 3)),
    /** Hard cap on each worker's script run, ms (pip installs need headroom). */
    workerTimeoutMs: Math.max(5_000, num("FANOUT_WORKER_TIMEOUT_MS", 120_000)),
    /** Retry attempts when Solari returns a concurrency-limit 429. */
    concurrencyRetries: Math.max(0, num("FANOUT_CONCURRENCY_RETRIES", 8)),
  },
}

export type Config = typeof config
