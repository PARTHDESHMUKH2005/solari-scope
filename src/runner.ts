/**
 * Fan-out runner.
 *
 * Take one plain-English task, have Nemotron write a Python script for it, then
 * run that script on `count` fresh Solari sandboxes in parallel. Each worker
 * gets its own microVM, runs the script to completion, hands back stdout/exit,
 * and is killed. Progress is kept in memory and polled by the dashboard.
 *
 * Solari's plan caps how many sandboxes can exist at once, so `create` is
 * pooled and retries with backoff on a concurrency-limit 429 — on a 1-slot
 * plan the run just becomes sequential instead of failing.
 */
import { SolariClient } from "@solarisdk/sdk"
import { config } from "./config.js"
import { taskToScript } from "./nemotron.js"

export type WorkerStatus = "queued" | "creating" | "running" | "done" | "error"

export interface Worker {
  n: number
  status: WorkerStatus
  sandboxId?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
  ms?: number
  /** Parsed JSON-Lines the worker printed to stdout. */
  items: unknown[]
}

export type RunState = "generating" | "running" | "done" | "error"

export interface Run {
  id: string
  task: string
  count: number
  state: RunState
  model?: string
  script?: string
  error?: string
  createdAt: string
  finishedAt?: string
  workers: Worker[]
  /** Every worker's JSON-Lines output, concatenated. */
  results: unknown[]
  resultCount: number
}

const isConcurrencyLimit = (e: any): boolean =>
  e?.code === "ConcurrencyLimitExceeded" || e?.status === 429

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Parse every stdout line that is a JSON value; ignore the rest. */
function parseJsonLines(stdout: string): unknown[] {
  const out: unknown[] = []
  for (const line of stdout.split("\n")) {
    const s = line.trim()
    if (!s || (s[0] !== "{" && s[0] !== "[")) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* not JSON — skip */
    }
  }
  return out
}

export class Runner {
  private readonly client = new SolariClient({ apiKey: config.apiKey })
  private readonly runs = new Map<string, Run>()
  private order: string[] = []

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  list(): Run[] {
    return this.order.map((id) => this.runs.get(id)!).filter(Boolean)
  }

  start(task: string, count: number): Run {
    const n = Math.min(Math.max(1, Math.floor(count)), config.fanout.maxWorkers)
    const run: Run = {
      id: "run_" + Math.random().toString(36).slice(2, 10),
      task: task.trim(),
      count: n,
      state: "generating",
      createdAt: new Date().toISOString(),
      workers: Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        status: "queued" as const,
        items: [],
      })),
      results: [],
      resultCount: 0,
    }
    this.runs.set(run.id, run)
    this.order.unshift(run.id)
    this.order = this.order.slice(0, 25)
    void this.execute(run)
    return run
  }

  private async execute(run: Run): Promise<void> {
    try {
      const { script, model } = await taskToScript(run.task)
      run.script = script
      run.model = model
      run.state = "running"
    } catch (e) {
      run.state = "error"
      run.error = String(e instanceof Error ? e.message : e)
      run.finishedAt = new Date().toISOString()
      return
    }

    const queue = [...run.workers]
    const pool = Array.from({ length: config.fanout.concurrency }, () =>
      this.drain(run, queue),
    )
    await Promise.all(pool)

    run.results = run.workers.flatMap((w) => w.items)
    run.resultCount = run.results.length
    const anyOk = run.workers.some((w) => w.status === "done")
    run.state = run.workers.some((w) => w.status === "error") && !anyOk ? "error" : "done"
    run.finishedAt = new Date().toISOString()
  }

  private async drain(run: Run, queue: Worker[]): Promise<void> {
    for (;;) {
      const w = queue.shift()
      if (!w) return
      await this.runWorker(run, w)
    }
  }

  private async runWorker(run: Run, w: Worker): Promise<void> {
    const started = Date.now()
    let sandbox: Awaited<ReturnType<Runner["createWithRetry"]>> | undefined
    try {
      w.status = "creating"
      sandbox = await this.createWithRetry(w)
      w.sandboxId = sandbox.sandboxId

      await sandbox.connect()
      await sandbox.files.write("/tmp/task.py", run.script!)

      w.status = "running"
      const out = await sandbox.commands.run("python3", {
        args: ["/tmp/task.py"],
        env: { WORKER_INDEX: String(w.n - 1), WORKER_COUNT: String(run.count) },
        timeoutMs: config.fanout.workerTimeoutMs,
      })
      w.exitCode = out.exitCode
      w.stdout = out.stdout.slice(0, 8000)
      w.stderr = out.stderr.slice(0, 3000)
      w.items = parseJsonLines(out.stdout)
      w.status = out.exitCode === 0 ? "done" : "error"
      if (out.exitCode !== 0 && !w.error) w.error = `exit ${out.exitCode}`
    } catch (e) {
      w.status = "error"
      w.error = String(e instanceof Error ? e.message : e)
    } finally {
      w.ms = Date.now() - started
      if (sandbox) {
        // handle.kill() deletes the VM AND closes the control websocket that
        // connect() opened; the client-level kill only does the former.
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
    }
  }

  private async createWithRetry(w: Worker) {
    let attempt = 0
    for (;;) {
      try {
        return await this.client.sandboxes.create({
          template: "base",
          timeoutMs: config.fanout.workerTimeoutMs + 30_000,
          metadata: { scope: "fanout" },
        })
      } catch (e) {
        if (!isConcurrencyLimit(e) || attempt >= config.fanout.concurrencyRetries) throw e
        attempt++
        w.status = "queued"
        await sleep(Math.min(2000 * attempt, 10_000))
        w.status = "creating"
      }
    }
  }
}
