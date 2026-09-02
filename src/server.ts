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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const fleet = new Fleet()
fleet.start()

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
  res.json({ ok: true, tokenRequired: Boolean(config.token) })
})

app.get("/api/fleet", auth, (_req, res) => {
  res.json(fleet.current())
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
  const send = () => res.write(`data: ${JSON.stringify(fleet.current())}\n\n`)
  send()
  const iv = setInterval(send, config.pollSeconds * 1000)
  req.on("close", () => clearInterval(iv))
})

app.use(express.static(path.join(__dirname, "..", "public")))

app.listen(config.port, () => {
  console.log(`Solari Scope on http://localhost:${config.port}`)
  console.log(
    `  polling every ${config.pollSeconds}s` +
      (config.token ? ", token required" : ", NO token set (open dashboard)") +
      (config.reaper.idleMinutes > 0
        ? `, reaper ${config.reaper.mode} at ${config.reaper.idleMinutes}m idle`
        : ", reaper off"),
  )
})
