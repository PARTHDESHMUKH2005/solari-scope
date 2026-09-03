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

export type WorkerStatus = "queued" | "creating" | "running" | "done" | "error"

export interface Worker {
  n: number
  status: WorkerStatus
  /** Short human-readable note on what this worker is doing right now. */
  stage: string
  sandboxId?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
  ms?: number
  /** Parsed JSON-Lines the worker has printed so far (updates live). */
  items: unknown[]
}

export type RunState = "generating" | "running" | "done" | "error"

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
}

const isConcurrencyLimit = (e: any): boolean =>
  e?.code === "ConcurrencyLimitExceeded" || e?.status === 429

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    void this.execute(run)
    return run
  }

  private recount(run: Run): void {
    run.results = run.workers.flatMap((w) => w.items)
    run.resultCount = run.results.length
    run.liveSandboxes = run.workers.filter(
      (w) => w.status === "creating" || w.status === "running",
    ).length
  }

  private async execute(run: Run): Promise<void> {
    try {
      const { script, model } = await writeWorker(run.task)
      run.script = script
      run.model = model
      run.state = "running"
      run.stage = `running ${run.count} worker${run.count === 1 ? "" : "s"}`
    } catch (e) {
      run.state = "error"
      run.error = String(e instanceof Error ? e.message : e)
      run.stage = "Vera could not write a worker"
      run.finishedAt = new Date().toISOString()
      return
    }

    const queue = [...run.workers]
    const pool = Array.from({ length: config.fanout.concurrency }, () =>
      this.drain(run, queue),
    )
    await Promise.all(pool)

    this.recount(run)
    run.state = run.workers.every((w) => w.status === "error") ? "error" : "done"
    run.stage =
      run.state === "error"
        ? "all workers failed"
        : `${run.resultCount} result${run.resultCount === 1 ? "" : "s"} from ${run.count} worker${run.count === 1 ? "" : "s"}`
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
    const parser = new LineParser()
    try {
      w.status = "creating"
      w.stage = "starting a sandbox"
      sandbox = await this.createWithRetry(w)
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
      w.status = "error"
      w.error = String(e instanceof Error ? e.message : e).slice(0, 300)
      w.stage = "failed"
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
      this.recount(run)
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
        w.stage = `waiting for a free slot (try ${attempt})`
        await sleep(Math.min(2000 * attempt, 10_000))
        w.status = "creating"
      }
    }
  }
}
