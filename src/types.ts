/** A single Solari session (sandbox or desktop) as Scope tracks it. */
export interface FleetSession {
  id: string
  kind: "sandbox" | "desktop"
  state: string
  cpu: number
  memMb: number
  metadata: Record<string, string>
  /** ISO deadline reported by Solari (moves forward on every use). */
  expiresAt: string
  /** When Scope first saw this session, ISO. Not the true creation time. */
  firstSeen: string
  /** Seconds Scope has observed it in a running state. */
  observedSeconds: number
  /** Estimated cost so far, USD, from the configured hourly rate. */
  costUsd: number
  /** Current hourly burn rate, USD/hour. 0 when not running. */
  ratePerHour: number
  /** Live CPU %, from the last metrics sample. null if never sampled. */
  cpuPct: number | null
  /** Live memory used / total in bytes, from the last metrics sample. */
  memBytes: number | null
  memTotalBytes: number | null
  /** True when CPU has stayed below the idle threshold for the idle window. */
  idle: boolean
  /** Seconds since the session last showed activity (or since first seen). */
  idleSeconds: number
}

export interface FleetSnapshot {
  at: string
  sessions: FleetSession[]
  totals: {
    count: number
    running: number
    ratePerHour: number
    costUsd: number
  }
  /** The running session that has been up longest, if any. */
  oldest: { id: string; kind: string; ageSeconds: number } | null
  reaper: {
    enabled: boolean
    mode: "dry-run" | "live"
    idleMinutes: number
    actions: ReaperAction[]
  }
}

export interface ReaperAction {
  at: string
  id: string
  kind: string
  idleSeconds: number
  result: "would-kill" | "killed" | "error"
  detail?: string
}

// ── Fan-out runner ──────────────────────────────────────────────────────

export type WorkerStatus =
  | "queued"
  | "creating"
  | "running"
  | "done"
  | "error"
  | "canceled"

export interface Worker {
  n: number
  status: WorkerStatus
  /** Short human-readable note on what this worker is doing right now. */
  stage: string
  startedAt?: number
  sandboxId?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
  ms?: number
  /** Parsed JSON-Lines the worker has printed so far (updates live). */
  items: unknown[]
}

export type RunState = "generating" | "running" | "done" | "error" | "canceled"

export interface Run {
  id: string
  task: string
  count: number
  state: RunState
  /** Headline note: "Vera is writing the worker", "running 3 workers", … */
  stage: string
  model?: string
  script?: string
  error?: string
  createdAt: string
  finishedAt?: string
  workers: Worker[]
  /** Every worker's JSON-Lines output so far, concatenated. */
  results: unknown[]
  resultCount: number
  /** Sandboxes this run has live right now. */
  liveSandboxes: number
  /** Its compute cost has been added to the cumulative spend total. */
  banked?: boolean
}

/** What Scope writes to disk so a restart doesn't lose everything. */
export interface PersistedState {
  retiredCostUsd: number
  burnHistory: Array<{ t: number; rate: number }>
  runs: Run[]
}
