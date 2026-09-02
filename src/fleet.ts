/**
 * The fleet poller. On an interval it asks Solari for every sandbox and
 * desktop on the account, folds that into Scope's own running state (age,
 * observed seconds, estimated cost, live CPU/memory, whether a session has
 * gone idle) and — when the reaper is on — kills sessions that have been idle
 * too long.
 *
 * Idle detection is CPU-based: Solari has no "last active" field and its
 * `expiresAt` gets nudged forward by keep-alive, so it can't be trusted for
 * this. Instead Scope samples `metrics()` every METRICS_EVERY_SECONDS; a
 * session whose CPU stays at/below REAP_CPU_IDLE_PCT for the whole idle window
 * is idle. Anything Scope can't measure is treated as active — the reaper
 * never kills on missing data.
 */
import { SolariClient } from "@solarisdk/sdk"
import { config } from "./config.js"
import type { FleetSession, FleetSnapshot, ReaperAction } from "./types.js"

interface Tracked {
  firstSeen: number
  lastPoll: number
  observedSeconds: number
  costUsd: number
  lastActiveAt: number
  lastMetricsAt: number
  cpuPct: number | null
  memBytes: number | null
  memTotalBytes: number | null
}

const RUNNING_STATES = new Set(["starting", "running"])

interface RawSession {
  sandboxId: string
  kind: "sandbox" | "desktop"
  state: string
  cpu: number
  memMb: number
  metadata: Record<string, string>
  expiresAt: string
}

export class Fleet {
  private readonly client = new SolariClient({ apiKey: config.apiKey })
  private readonly tracked = new Map<string, Tracked>()
  private actions: ReaperAction[] = []
  private snapshot: FleetSnapshot = emptySnapshot()
  private timer: NodeJS.Timeout | null = null
  private lastError: string | null = null
  private polling = false

  start(): void {
    if (this.timer) return
    const tick = () => {
      if (this.polling) return
      this.polling = true
      this.poll()
        .catch((e) => (this.lastError = String(e)))
        .finally(() => (this.polling = false))
    }
    tick()
    this.timer = setInterval(tick, config.pollSeconds * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  current(): FleetSnapshot & { error: string | null } {
    return { ...this.snapshot, error: this.lastError }
  }

  async kill(id: string): Promise<void> {
    await this.client.sandboxes.kill(id)
    this.tracked.delete(id)
  }

  private rateFor(kind: string): number {
    return kind === "desktop" ? config.rates.desktop : config.rates.sandbox
  }

  private async listAll(): Promise<RawSession[]> {
    const out: RawSession[] = []
    for (const kind of ["sandbox", "desktop"] as const) {
      for await (const s of this.client.sandboxes.listAll({ kind })) {
        out.push(s as unknown as RawSession)
      }
    }
    return out
  }

  /** Sample metrics for a few sessions that are due, and fold CPU into idle state. */
  private async sampleMetrics(live: RawSession[], now: number): Promise<void> {
    const due = live
      .filter((s) => RUNNING_STATES.has(s.state))
      .filter((s) => {
        const t = this.tracked.get(s.sandboxId)
        return !t || now - t.lastMetricsAt >= config.reaper.metricsEverySeconds * 1000
      })
      .slice(0, config.reaper.maxSamplesPerTick)

    await Promise.all(
      due.map(async (s) => {
        const t = this.tracked.get(s.sandboxId)
        if (!t) return
        try {
          const h = await this.client.sandboxes.connect(s.sandboxId)
          const m = await h.metrics()
          h.close()
          t.cpuPct = m.cpuPct
          t.memBytes = m.memBytes
          t.memTotalBytes = m.memTotalBytes
          t.lastMetricsAt = now
          if (m.cpuPct > config.reaper.cpuIdlePct) t.lastActiveAt = now
        } catch {
          // Can't measure it → treat as active so the reaper leaves it alone.
          t.lastActiveAt = now
          t.lastMetricsAt = now
        }
      }),
    )
  }

  private async poll(): Promise<void> {
    const now = Date.now()
    const live = await this.listAll()
    this.lastError = null

    const liveIds = new Set(live.map((s) => s.sandboxId))
    for (const id of [...this.tracked.keys()]) {
      if (!liveIds.has(id)) this.tracked.delete(id)
    }

    for (const s of live) {
      if (this.tracked.has(s.sandboxId)) continue
      this.tracked.set(s.sandboxId, {
        firstSeen: now,
        lastPoll: now,
        observedSeconds: 0,
        costUsd: 0,
        lastActiveAt: now,
        lastMetricsAt: 0,
        cpuPct: null,
        memBytes: null,
        memTotalBytes: null,
      })
    }

    await this.sampleMetrics(live, now)

    const idleWindowMs = config.reaper.idleMinutes * 60_000
    const sessions: FleetSession[] = []
    const toReap: FleetSession[] = []

    for (const s of live) {
      const t = this.tracked.get(s.sandboxId)!
      const running = RUNNING_STATES.has(s.state)
      const dtSec = Math.max(0, (now - t.lastPoll) / 1000)
      if (running) {
        t.observedSeconds += dtSec
        t.costUsd += (this.rateFor(s.kind) / 3600) * dtSec
      }
      t.lastPoll = now

      const idleSeconds = Math.floor((now - t.lastActiveAt) / 1000)
      const idle = idleWindowMs > 0 && running && now - t.lastActiveAt >= idleWindowMs

      const fs: FleetSession = {
        id: s.sandboxId,
        kind: s.kind,
        state: s.state,
        cpu: s.cpu,
        memMb: s.memMb,
        metadata: s.metadata ?? {},
        expiresAt: s.expiresAt,
        firstSeen: new Date(t.firstSeen).toISOString(),
        observedSeconds: Math.floor(t.observedSeconds),
        costUsd: round4(t.costUsd),
        ratePerHour: running ? this.rateFor(s.kind) : 0,
        cpuPct: t.cpuPct,
        memBytes: t.memBytes,
        memTotalBytes: t.memTotalBytes,
        idle,
        idleSeconds,
      }
      sessions.push(fs)
      if (idle) toReap.push(fs)
    }

    if (config.reaper.idleMinutes > 0) await this.runReaper(toReap)

    sessions.sort(
      (a, b) => b.ratePerHour - a.ratePerHour || a.firstSeen.localeCompare(b.firstSeen),
    )

    const running = sessions.filter((s) => RUNNING_STATES.has(s.state))
    this.snapshot = {
      at: new Date(now).toISOString(),
      sessions,
      totals: {
        count: sessions.length,
        running: running.length,
        ratePerHour: round4(running.reduce((n, s) => n + s.ratePerHour, 0)),
        costUsd: round4(sessions.reduce((n, s) => n + s.costUsd, 0)),
      },
      reaper: {
        enabled: config.reaper.idleMinutes > 0,
        mode: config.reaper.mode,
        idleMinutes: config.reaper.idleMinutes,
        actions: this.actions.slice(-50).reverse(),
      },
    }
  }

  private async runReaper(candidates: FleetSession[]): Promise<void> {
    for (const c of candidates) {
      if (this.actions.some((a) => a.id === c.id && a.result !== "error")) continue
      if (config.reaper.mode === "dry-run") {
        this.actions.push(action(c, "would-kill"))
        continue
      }
      try {
        await this.client.sandboxes.kill(c.id)
        this.tracked.delete(c.id)
        this.actions.push(action(c, "killed"))
      } catch (e) {
        this.actions.push(action(c, "error", String(e)))
      }
    }
  }
}

function action(c: FleetSession, result: ReaperAction["result"], detail?: string): ReaperAction {
  return { at: new Date().toISOString(), id: c.id, kind: c.kind, idleSeconds: c.idleSeconds, result, detail }
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

function emptySnapshot(): FleetSnapshot {
  return {
    at: new Date().toISOString(),
    sessions: [],
    totals: { count: 0, running: 0, ratePerHour: 0, costUsd: 0 },
    reaper: {
      enabled: config.reaper.idleMinutes > 0,
      mode: config.reaper.mode,
      idleMinutes: config.reaper.idleMinutes,
      actions: [],
    },
  }
}
