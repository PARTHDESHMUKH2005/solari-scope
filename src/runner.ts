/**
 * Fan-out runner.
 *
 * One plain-English job → Vera writes a Python worker → the worker runs on
 * `count` fresh Solari sandboxes in parallel, each handling its own shard.
 * Every worker's JSON-Lines output is parsed live (as it streams) and merged
 * into one result set. Every VM is torn down afterwards.
 *
 * Solari's plan caps how many sandboxes can exist at once, so `create` is
 * pooled and retries with backoff on a concurrency-limit 429 — on a 1-slot
 * plan the run just becomes sequential instead of failing.
 */
import { SolariClient } from "@solarisdk/sdk"
import { config } from "./config.js"
import { writeWorker } from "./vera.js"
import { state, markDirty } from "./persist.js"
import type { Run, Worker } from "./types.js"

const isConcurrencyLimit = (e: any): boolean =>
  e?.code === "ConcurrencyLimitExceeded" || e?.status === 429

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class CanceledError extends Error {
  constructor() {
    super("run canceled")
  }
}

/** Feed streamed stdout chunks; get back each complete JSON-Lines value. */
class LineParser {
  private buf = ""
  push(chunk: string): unknown[] {
    this.buf += chunk
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line && (line[0] === "{" || line[0] === "[")) {
        try {
          out.push(JSON.parse(line))
        } catch {
          /* not JSON — skip */
        }
      }
    }
    return out
  }
}

export class Runner {
  private readonly client = new SolariClient({ apiKey: config.apiKey })
  private readonly runs = new Map<string, Run>()
  private order: string[] = []
  private readonly canceled = new Set<string>()
  private sweeping: Promise<void>

  constructor() {
    // Rehydrate run history from disk. Anything that was mid-flight when the
    // server stopped is stale now — mark it interrupted.
    for (const run of state.runs) {
      if (run.state === "running" || run.state === "generating") {
        run.state = "error"
        run.stage = "interrupted by a restart"
        run.error = "the server restarted while this run was in progress"
        run.liveSandboxes = 0
      }
      this.runs.set(run.id, run)
      this.order.push(run.id)
      this.bank(run)
    }

    // A server killed mid-run leaves worker sandboxes behind; on a small plan
    // one orphan holds the only slot and every later run 429s forever. Sweep.
    this.sweeping = this.sweepOrphans()
  }

  private persist(): void {
    state.runs = this.list()
    markDirty()
  }

  private async sweepOrphans(): Promise<void> {
    try {
      let n = 0
      for await (const s of this.client.sandboxes.listAll({
        metadata: { scope: "fanout" },
      })) {
        await this.client.sandboxes.kill(s.sandboxId).catch(() => {})
        n++
      }
      if (n) console.log(`runner: swept ${n} orphaned fan-out sandbox(es)`)
    } catch (e) {
      console.log("runner: orphan sweep failed (non-fatal):", String(e))
    }
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  list(): Run[] {
    return this.order.map((id) => this.runs.get(id)!).filter(Boolean)
  }

  private workerSeconds(run: Run): number {
    let s = 0
    for (const w of run.workers) {
      s +=
        w.ms != null
          ? w.ms / 1000
          : w.startedAt
            ? (Date.now() - w.startedAt) / 1000
            : 0
    }
    return s
  }

  /** Move a finished run's compute cost into the cumulative spend total, once. */
  private bank(run: Run): void {
    if (run.banked) return
    run.banked = true
    state.retiredCostUsd += (config.rates.sandbox / 3600) * this.workerSeconds(run)
    markDirty()
  }

  /** What in-flight fan-out runs are contributing to the fleet right now. */
  summary(): { sandboxes: number; ratePerHour: number; costUsd: number } {
    const rate = config.rates.sandbox
    let sandboxes = 0
    let costUsd = 0
    for (const run of this.runs.values()) {
      if (run.state !== "running" && run.state !== "generating") continue
      costUsd += (rate / 3600) * this.workerSeconds(run)
      if (run.state === "running") sandboxes += run.liveSandboxes
    }
    return {
      sandboxes,
      ratePerHour: Math.round(sandboxes * rate * 1e4) / 1e4,
      costUsd: Math.round(costUsd * 1e4) / 1e4,
    }
  }

  start(task: string, count: number): Run {
    const n = Math.min(Math.max(1, Math.floor(count)), config.fanout.maxWorkers)
    const run: Run = {
      id: "run_" + Math.random().toString(36).slice(2, 10),
      task: task.trim(),
      count: n,
      state: "generating",
      stage: "Vera is writing the worker…",
      createdAt: new Date().toISOString(),
      workers: Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        status: "queued" as const,
        stage: "waiting for the worker script",
        items: [],
      })),
      results: [],
      resultCount: 0,
      liveSandboxes: 0,
    }
    this.runs.set(run.id, run)
    this.order.unshift(run.id)
    this.order = this.order.slice(0, 25)
    this.persist()
    void this.execute(run)
    return run
  }

  /** Stop a run: kill its sandboxes, mark it (and its workers) canceled. */
  async cancel(id: string): Promise<boolean> {
    const run = this.runs.get(id)
    if (!run || run.state === "done" || run.state === "error" || run.state === "canceled") {
      return false
    }
    this.canceled.add(id)
    run.state = "canceled"
    run.stage = "canceled"
    run.finishedAt = new Date().toISOString()
    for (const w of run.workers) {
      if (w.status === "queued" || w.status === "creating" || w.status === "running") {
        w.status = "canceled"
        w.stage = "canceled"
      }
      if (w.sandboxId) {
        await this.client.sandboxes.kill(w.sandboxId).catch(() => {})
      }
    }
    run.liveSandboxes = 0
    this.persist()
    return true
  }

  private recount(run: Run): void {
    run.results = run.workers.flatMap((w) => w.items)
    run.resultCount = run.results.length
    run.liveSandboxes = run.workers.filter(
      (w) => w.status === "creating" || w.status === "running",
    ).length
    this.persist()
  }

  private async execute(run: Run): Promise<void> {
    await this.sweeping // don't race the startup orphan sweep
    if (this.canceled.has(run.id)) return
    try {
      const { script, model } = await writeWorker(run.task)
      if (this.canceled.has(run.id)) return // cancelled while Vera was writing
      run.script = script
      run.model = model
      run.state = "running"
      run.stage = `running ${run.count} worker${run.count === 1 ? "" : "s"}`
    } catch (e) {
      if (this.canceled.has(run.id)) return
      run.state = "error"
      run.error = String(e instanceof Error ? e.message : e)
      run.stage = "Vera could not write a worker"
      run.finishedAt = new Date().toISOString()
      this.persist()
      return
    }
    if (this.canceled.has(run.id)) return

    const queue = [...run.workers]
    const pool = Array.from({ length: config.fanout.concurrency }, () =>
      this.drain(run, queue),
    )
    await Promise.all(pool)

    if (this.canceled.has(run.id)) {
      this.canceled.delete(run.id)
      this.recount(run)
      this.bank(run)
      this.persist()
      return
    }

    this.recount(run)
    run.state = run.workers.every((w) => w.status === "error") ? "error" : "done"
    run.stage =
      run.state === "error"
        ? "all workers failed"
        : `${run.resultCount} result${run.resultCount === 1 ? "" : "s"} from ${run.count} worker${run.count === 1 ? "" : "s"}`
    run.finishedAt = new Date().toISOString()
    this.bank(run)
    this.persist()
  }

  private async drain(run: Run, queue: Worker[]): Promise<void> {
    for (;;) {
      const w = queue.shift()
      if (!w) return
      if (this.canceled.has(run.id)) {
        w.status = "canceled"
        w.stage = "canceled"
        continue
      }
      await this.runWorker(run, w)
    }
  }

  private async runWorker(run: Run, w: Worker): Promise<void> {
    const started = Date.now()
    w.startedAt = started
    let sandbox: Awaited<ReturnType<Runner["createWithRetry"]>> | undefined
    const parser = new LineParser()
    try {
      w.status = "creating"
      w.stage = "starting a sandbox"
      sandbox = await this.createWithRetry(run, w)
      w.sandboxId = sandbox.sandboxId
      this.recount(run)

      await sandbox.connect()
      w.stage = "uploading the worker"
      await sandbox.files.write("/tmp/task.py", run.script!)

      w.status = "running"
      w.stage = "running"
      this.recount(run)
      const out = await sandbox.commands.run("python3", {
        args: ["/tmp/task.py"],
        env: { WORKER_INDEX: String(w.n - 1), WORKER_COUNT: String(run.count) },
        timeoutMs: config.fanout.workerTimeoutMs,
        onStdout: (chunk) => {
          for (const v of parser.push(chunk)) w.items.push(v)
          w.stage = `${w.items.length} result${w.items.length === 1 ? "" : "s"}`
          this.recount(run)
        },
      })
      w.exitCode = out.exitCode
      w.stdout = out.stdout.slice(0, 8000)
      w.stderr = out.stderr.slice(0, 3000)
      w.status = out.exitCode === 0 ? "done" : "error"
      w.stage =
        w.status === "done"
          ? `${w.items.length} result${w.items.length === 1 ? "" : "s"}`
          : `exited ${out.exitCode}`
      if (out.exitCode !== 0 && !w.error) {
        w.error = (out.stderr.trim().split("\n").pop() || `exit ${out.exitCode}`).slice(0, 300)
      }
    } catch (e) {
      if (e instanceof CanceledError || this.canceled.has(run.id)) {
        w.status = "canceled"
        w.stage = "canceled"
      } else {
        w.status = "error"
        w.error = String(e instanceof Error ? e.message : e).slice(0, 300)
        w.stage = "failed"
      }
    } finally {
      w.ms = Date.now() - started
      if (sandbox) {
        try {
          await sandbox.kill()
        } catch {
          try {
            await this.client.sandboxes.kill(sandbox.sandboxId)
          } catch {
            /* best effort — it will hit its idle timeout otherwise */
          }
        }
      }
      this.recount(run)
    }
  }

  private async createWithRetry(run: Run, w: Worker) {
    const deadline = Date.now() + config.fanout.slotWaitMs
    let attempt = 0
    for (;;) {
      if (this.canceled.has(run.id)) throw new CanceledError()
      try {
        return await this.client.sandboxes.create({
          template: "base",
          timeoutMs: config.fanout.workerTimeoutMs + 30_000,
          metadata: { scope: "fanout" },
        })
      } catch (e) {
        // A concurrency-limit 429 is expected on small plans — keep waiting for
        // a peer worker to free its slot, up to slotWaitMs. Any other error is
        // real; surface it.
        if (!isConcurrencyLimit(e) || Date.now() > deadline) throw e
        attempt++
        w.status = "queued"
        w.stage = `waiting for a free slot (${attempt})`
        await sleep(Math.min(1500 + 1000 * attempt, 8_000))
        w.status = "creating"
      }
    }
  }
}
