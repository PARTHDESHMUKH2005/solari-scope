/**
 * Solari Scope — HTTP server.
 *
 * Serves the dashboard and a JSON + SSE API. Accounts and per-user run history
 * live in SQLite (see db.ts / auth.ts); the fleet view is account-wide because
 * it's one Solari API key. Every /api route except register/login/health
 * requires a valid session — and the run routes additionally check ownership.
 */
import express from "express"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { config } from "./config.js"
import { Fleet } from "./fleet.js"
import { Runner } from "./runner.js"
import { state, markDirty, flush } from "./persist.js"
import { db, compact } from "./db.js"
import {
  AuthError,
  login,
  logout,
  register,
  userCount,
  userForToken,
  type User,
} from "./auth.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const fleet = new Fleet()
fleet.start()
const runner = new Runner()

// ── auth ──────────────────────────────────────────────────────────────
declare global {
  // eslint-disable-next-line no-var
  namespace Express {
    interface Request {
      user?: User
    }
  }
}

function tokenOf(req: express.Request): string | undefined {
  const h = req.get("authorization")
  if (h?.startsWith("Bearer ")) return h.slice(7)
  return typeof req.query.token === "string" ? req.query.token : undefined
}

/** Require a valid session; attaches req.user. */
function requireUser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const user = userForToken(tokenOf(req))
  if (!user) {
    res.status(401).json({ error: "sign in" })
    return
  }
  req.user = user
  next()
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    vera: Boolean(config.vera.apiKey),
    // registration is open unless a signup code is required
    signupCode: Boolean(config.signupCode),
    hasUsers: userCount() > 0,
  })
})

app.post("/api/register", (req, res) => {
  try {
    const { token, user } = register(
      String(req.body?.username ?? ""),
      String(req.body?.password ?? ""),
      req.body?.code ? String(req.body.code) : undefined,
    )
    res.json({ token, user })
  } catch (e) {
    const err = e instanceof AuthError ? e : new AuthError("could not register")
    res.status(err.status).json({ error: err.message })
  }
})

app.post("/api/login", (req, res) => {
  try {
    const { token, user } = login(
      String(req.body?.username ?? ""),
      String(req.body?.password ?? ""),
    )
    res.json({ token, user })
  } catch (e) {
    const err = e instanceof AuthError ? e : new AuthError("could not sign in", 401)
    res.status(err.status).json({ error: err.message })
  }
})

app.post("/api/logout", requireUser, (req, res) => {
  logout(tokenOf(req))
  res.json({ ok: true })
})

app.get("/api/me", requireUser, (req, res) => {
  res.json({ user: req.user })
})

// ── Fan-out runner (per-user) ─────────────────────────────────────────
app.post("/api/run", requireUser, (req, res) => {
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
  const run = runner.start(task, count, req.user!.id)
  res.json({ runId: run.id })
})

app.get("/api/runs", requireUser, (req, res) => {
  res.json({ runs: runner.list(req.user!.id) })
})

app.get("/api/run/:id", requireUser, (req, res) => {
  const run = req.params.id ? runner.get(req.params.id, req.user!.id) : undefined
  if (!run) {
    res.status(404).json({ error: "no such run" })
    return
  }
  res.json(run)
})

app.post("/api/run/:id/cancel", requireUser, async (req, res) => {
  const ok = req.params.id ? await runner.cancel(req.params.id, req.user!.id) : false
  res.status(ok ? 200 : 409).json({ ok })
})

/** Live run state, pushed until the run finishes. Owner only. */
app.get("/api/run/:id/stream", requireUser, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.flushHeaders()
  const tick = () => {
    const run = req.params.id ? runner.get(req.params.id, req.user!.id) : undefined
    if (!run) {
      res.write(`event: gone\ndata: {}\n\n`)
      clearInterval(iv)
      res.end()
      return
    }
    res.write(`data: ${JSON.stringify(run)}\n\n`)
    if (run.state === "done" || run.state === "error" || run.state === "canceled") {
      clearInterval(iv)
      res.end()
    }
  }
  const iv = setInterval(tick, 700)
  tick()
  req.on("close", () => clearInterval(iv))
})

// ── Fleet (account-wide — one Solari key, shared by everyone signed in) ─
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

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

// Sample total burn every 15s for the sparkline (~1h of history at 240 points).
setInterval(() => {
  const rate = fleetView().totals.ratePerHour
  state.burnHistory.push({ t: Date.now(), rate })
  if (state.burnHistory.length > 240) state.burnHistory.shift()
  markDirty()
}, 15_000).unref()

app.get("/api/fleet", requireUser, (_req, res) => {
  res.json(fleetView())
})

app.post("/api/kill/:id", requireUser, async (req, res) => {
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

app.get("/api/stream", requireUser, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.flushHeaders()
  const send = () => res.write(`data: ${JSON.stringify(fleetView())}\n\n`)
  send()
  const iv = setInterval(send, 1500)
  req.on("close", () => clearInterval(iv))
})

app.use(express.static(path.join(__dirname, "..", "public")))

const server = app.listen(config.port, () => {
  console.log(`Solari Scope on http://localhost:${config.port}`)
  console.log(
    `  ${userCount()} account(s)` +
      (config.signupCode ? ", signup code required" : ", open signup") +
      (config.reaper.idleMinutes > 0
        ? `, reaper ${config.reaper.mode} at ${config.reaper.idleMinutes}m idle`
        : ", reaper off"),
  )
})

// Graceful shutdown: cancel in-flight runs (killing their sandboxes) and flush
// state before exiting, so a deploy never leaks a VM or loses history.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} — cleaning up…`)
  fleet.stop()
  server.close()
  const n = await runner.cancelAll()
  flush()
  try {
    compact()
    db.close()
  } catch {
    /* already closed */
  }
  console.log(`  cancelled ${n} run(s), state saved. bye.`)
  process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
