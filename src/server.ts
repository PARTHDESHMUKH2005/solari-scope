/**
 * Solari Scope — HTTP server.
 *
 * Serves the dashboard (static files in public/) and a small JSON + SSE API
 * over the Fleet poller. One process, one port, one env var to run.
 */
import express from "express"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { config } from "./config.js"
import { Fleet } from "./fleet.js"
import { Runner } from "./runner.js"
import { state, markDirty, flush } from "./persist.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const fleet = new Fleet()
fleet.start()
const runner = new Runner()

/** Gate the API behind SCOPE_TOKEN when one is configured. */
function auth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.token) return next()
  const given =
    req.get("x-scope-token") ||
    (typeof req.query.token === "string" ? req.query.token : undefined)
  if (given === config.token) return next()
  res.status(401).json({ error: "bad or missing token" })
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    tokenRequired: Boolean(config.token),
    vera: Boolean(config.vera.apiKey),
  })
})

/** Verify a token (used by the login screen). */
app.post("/api/login", (req, res) => {
  if (!config.token) {
    res.json({ ok: true })
    return
  }
  res.status(req.body?.token === config.token ? 200 : 401).json({
    ok: req.body?.token === config.token,
  })
})

// ── Fan-out runner ────────────────────────────────────────────────────
app.post("/api/run", auth, (req, res) => {
  const task = String(req.body?.task ?? "").trim()
  const count = Number(req.body?.count ?? 1)
  if (!config.vera.apiKey) {
    res.status(400).json({ error: "Vera is not configured (set VERA_API_KEY)" })
    return
  }
  if (task.length < 4) {
    res.status(400).json({ error: "describe the job in a sentence" })
    return
  }
  if (!Number.isFinite(count) || count < 1) {
    res.status(400).json({ error: "workers must be a positive number" })
    return
  }
  const run = runner.start(task, count)
  res.json({ runId: run.id })
})

app.get("/api/runs", auth, (_req, res) => {
  res.json({ runs: runner.list() })
})

app.get("/api/run/:id", auth, (req, res) => {
  const run = req.params.id ? runner.get(req.params.id) : undefined
  if (!run) {
    res.status(404).json({ error: "no such run" })
    return
  }
  res.json(run)
})

app.post("/api/run/:id/cancel", auth, async (req, res) => {
  const ok = req.params.id ? await runner.cancel(req.params.id) : false
  res.status(ok ? 200 : 409).json({ ok })
})

/** Live run state, pushed until the run finishes. */
app.get("/api/run/:id/stream", auth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.flushHeaders()
  const tick = () => {
    const run = req.params.id ? runner.get(req.params.id) : undefined
    if (!run) {
      res.write(`event: gone\ndata: {}\n\n`)
      return
    }
    res.write(`data: ${JSON.stringify(run)}\n\n`)
    if (run.state === "done" || run.state === "error") {
      clearInterval(iv)
      res.end()
    }
  }
  const iv = setInterval(tick, 700)
  tick()
  req.on("close", () => clearInterval(iv))
})

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

/** Fleet snapshot + the fan-out runner's live contribution + derived views. */
function fleetView() {
  const snap = fleet.current()
  const s = runner.summary()
  const ratePerHour = r4(snap.totals.ratePerHour + s.ratePerHour)
  const costUsd = r4(snap.totals.costUsd + s.costUsd)
  return {
    ...snap,
    totals: {
      count: snap.totals.count + s.sandboxes,
      running: snap.totals.running + s.sandboxes,
      ratePerHour,
      costUsd,
    },
    fanout: s,
    burnHistory: state.burnHistory,
    projected: { daily: r4(ratePerHour * 24), monthly: r4(ratePerHour * 730) },
    budget:
      config.budgetUsd > 0
        ? { limit: config.budgetUsd, over: costUsd > config.budgetUsd }
        : null,
  }
}

// Sample total burn every 15s for the sparkline (1h of history at ~240 points).
setInterval(() => {
  const rate = fleetView().totals.ratePerHour
  state.burnHistory.push({ t: Date.now(), rate })
  if (state.burnHistory.length > 240) state.burnHistory.shift()
  markDirty()
}, 15_000).unref()

app.get("/api/fleet", auth, (_req, res) => {
  res.json(fleetView())
})

app.post("/api/kill/:id", auth, async (req, res) => {
  const id = req.params.id
  if (!id) {
    res.status(400).json({ ok: false, error: "missing id" })
    return
  }
  try {
    await fleet.kill(id)
    res.json({ ok: true })
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e) })
  }
})

/** Server-sent events: push a fresh snapshot on every poll interval. */
app.get("/api/stream", auth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.flushHeaders()
  const send = () => res.write(`data: ${JSON.stringify(fleetView())}\n\n`)
  send()
  // Push faster than the Solari poll so fan-out activity shows up promptly.
  const iv = setInterval(send, 1500)
  req.on("close", () => clearInterval(iv))
})

app.use(express.static(path.join(__dirname, "..", "public")))

const server = app.listen(config.port, () => {
  console.log(`Solari Scope on http://localhost:${config.port}`)
  console.log(
    `  polling every ${config.pollSeconds}s` +
      (config.token ? ", token required" : ", NO token set (open dashboard)") +
      (config.reaper.idleMinutes > 0
        ? `, reaper ${config.reaper.mode} at ${config.reaper.idleMinutes}m idle`
        : ", reaper off"),
  )
})

// Graceful shutdown: cancel in-flight runs (which kills their sandboxes) and
// write state to disk before exiting, so a deploy doesn't leak VMs or history.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} — cleaning up…`)
  fleet.stop()
  server.close()
  const running = runner.list().filter((r) => r.state === "running" || r.state === "generating")
  await Promise.all(running.map((r) => runner.cancel(r.id).catch(() => {})))
  flush()
  console.log(`  cancelled ${running.length} run(s), state saved. bye.`)
  process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
