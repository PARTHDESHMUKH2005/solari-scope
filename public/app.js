"use strict"

const $ = (id) => document.getElementById(id)

/* ── token handling ─────────────────────────────────────────────── */
const url = new URL(location.href)
if (url.searchParams.get("token")) {
  localStorage.setItem("scopeToken", url.searchParams.get("token"))
  url.searchParams.delete("token")
  history.replaceState({}, "", url)
}
let TOKEN = localStorage.getItem("scopeToken") || ""
const q = () => (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "")
const authHeaders = () => (TOKEN ? { "x-scope-token": TOKEN } : {})

/* ── boot ───────────────────────────────────────────────────────── */
let HEALTH = {}
async function boot() {
  try {
    HEALTH = await (await fetch("/api/health")).json()
  } catch {
    HEALTH = {}
  }
  if (HEALTH.tokenRequired) {
    const ok = TOKEN && (await verify(TOKEN))
    if (!ok) return showLogin()
  }
  startApp()
}

async function verify(token) {
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
    return r.ok
  } catch {
    return false
  }
}

function showLogin() {
  $("login").hidden = false
  $("app").hidden = true
  $("login-form").onsubmit = async (e) => {
    e.preventDefault()
    const t = $("login-token").value.trim()
    $("login-err").textContent = ""
    if (await verify(t)) {
      TOKEN = t
      localStorage.setItem("scopeToken", t)
      $("login").hidden = true
      startApp()
    } else {
      $("login-err").textContent = "wrong key"
    }
  }
}

function startApp() {
  $("app").hidden = false
  if (HEALTH.tokenRequired) {
    $("logout").hidden = false
    $("logout").onclick = () => {
      localStorage.removeItem("scopeToken")
      location.reload()
    }
  }
  if (!HEALTH.vera) {
    $("runner").style.opacity = "0.6"
    $("fo-run").disabled = true
    $("fo-task").placeholder = "Set VERA_API_KEY to enable the fan-out runner"
  }
  wireRunner()
  connectFleet()
}

/* ── helpers ────────────────────────────────────────────────────── */
const usd = (n) => "$" + (n < 1 ? n.toFixed(n < 0.1 ? 4 : 3) : n.toFixed(2))
const dur = (s) => {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`
}
const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])

function setBump(el, value) {
  if (el.textContent !== value) {
    el.textContent = value
    el.classList.remove("bump")
    void el.offsetWidth
    el.classList.add("bump")
  }
}

/* ── fan-out runner ─────────────────────────────────────────────── */
const SAMPLES = [
  "fetch the 15 top Hacker News stories and return each one's title, score and author",
  "for the numbers 1 to 60, return whether each is prime and its prime factorisation",
  "estimate pi with a Monte Carlo simulation of 2 million points",
  "check these URLs for HTTP status and page title: example.com, github.com, wikipedia.org, npmjs.com, rust-lang.org",
]
let runSource = null

function wireRunner() {
  $("fo-sample").onclick = () => {
    $("fo-task").value = SAMPLES[Math.floor(Math.random() * SAMPLES.length)]
  }
  $("fo-run").onclick = async () => {
    const task = $("fo-task").value.trim()
    const count = Number($("fo-count").value)
    if (task.length < 4) return
    $("fo-run").disabled = true
    $("fo-run").textContent = "starting…"
    try {
      const res = await fetch(`/api/run${q()}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ task, count }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || res.statusText)
      streamRun(body.runId)
    } catch (e) {
      $("fo-run").disabled = false
      $("fo-run").textContent = "Run job"
      $("run-view").hidden = false
      $("run-stage").className = "run-stage error"
      $("run-stage-text").textContent = e.message
    }
  }
  $("results-copy").onclick = () => {
    navigator.clipboard?.writeText($("results-list").dataset.json || "")
    $("results-copy").textContent = "copied"
    setTimeout(() => ($("results-copy").textContent = "copy JSON"), 1200)
  }
}

function streamRun(id) {
  if (runSource) runSource.close()
  $("run-view").hidden = false
  runSource = new EventSource(`/api/run/${id}/stream${q()}`)
  runSource.onmessage = (ev) => renderRun(JSON.parse(ev.data))
  runSource.addEventListener("gone", () => runSource.close())
  runSource.onerror = () => {
    runSource.close()
    // run finished (server ends the stream) — fetch the final state once
    fetch(`/api/run/${id}${q()}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((r) => r && r.id && renderRun(r))
      .catch(() => {})
  }
}

function renderRun(run) {
  const finished = run.state === "done" || run.state === "error"
  if (finished) {
    $("fo-run").disabled = false
    $("fo-run").textContent = "Run job"
  }

  $("run-stage").className =
    "run-stage" + (run.state === "done" ? " done" : run.state === "error" ? " error" : "")
  $("run-stage-text").textContent = run.error || run.stage || run.state
  const elapsed = (Date.now() - Date.parse(run.createdAt)) / 1000
  $("run-mini").textContent = run.liveSandboxes
    ? `${run.liveSandboxes} sandbox${run.liveSandboxes === 1 ? "" : "es"} live`
    : run.state === "generating"
      ? `thinking · ${dur(elapsed)}`
      : finished && run.finishedAt
        ? `done in ${dur((Date.parse(run.finishedAt) - Date.parse(run.createdAt)) / 1000)}`
        : ""

  $("run-model").textContent = run.model ? "· " + run.model : ""
  $("run-script").textContent = run.script || "…"

  $("worker-grid").innerHTML = (run.workers || [])
    .map((w) => {
      const cls =
        w.status === "running" || w.status === "creating"
          ? "running"
          : w.status === "done"
            ? "done"
            : w.status === "error"
              ? "error"
              : ""
      return `<div class="worker ${cls}">
        <div class="worker-top">
          <span class="worker-n">sandbox ${w.n}</span>
          <span class="pill ${w.status}">${w.status}</span>
        </div>
        <div class="worker-stage">${esc(w.stage || "")}</div>
        <div class="worker-meta">${w.ms ? (w.ms / 1000).toFixed(1) + "s" : "…"}${
          w.items && w.items.length ? " · " + w.items.length + " items" : ""
        }${w.error ? " · " + esc(w.error) : ""}</div>
        <div class="worker-bar"><i></i></div>
      </div>`
    })
    .join("")

  const results = run.results || []
  $("results-wrap").hidden = results.length === 0
  setBump($("results-count"), String(run.resultCount ?? results.length))
  const shown = results.slice(0, 60)
  $("results-list").dataset.json = JSON.stringify(results, null, 2)
  $("results-list").innerHTML =
    shown.map((r) => `<div class="row">${esc(JSON.stringify(r))}</div>`).join("") +
    (results.length > shown.length
      ? `<div class="row more">+ ${results.length - shown.length} more</div>`
      : "")
}

/* ── fleet ──────────────────────────────────────────────────────── */
function connectFleet() {
  const es = new EventSource(`/api/stream${q()}`)
  es.onopen = () => (($("conn").textContent = "live"), ($("conn").className = "conn live"))
  es.onmessage = (ev) => renderFleet(JSON.parse(ev.data))
  es.onerror = () => {
    $("conn").textContent = "reconnecting…"
    $("conn").className = "conn down"
    es.close()
    setTimeout(connectFleet, 2000)
  }
}

function renderFleet(snap) {
  setBump($("k-count"), String(snap.totals.count))
  setBump($("k-running"), String(snap.totals.running))
  setBump($("k-rate"), usd(snap.totals.ratePerHour))
  setBump($("k-cost"), usd(snap.totals.costUsd))
  $("stamp").textContent = "updated " + new Date(snap.at).toLocaleTimeString()

  const r = snap.reaper
  $("reaper").hidden = !r.enabled
  if (r.enabled) {
    $("reaper-desc").textContent = `${r.mode} · kills after ${r.idleMinutes}m idle`
    $("reaper-log").innerHTML =
      r.actions
        .map(
          (a) =>
            `<li class="${a.result === "killed" ? "killed" : ""}">${new Date(
              a.at,
            ).toLocaleTimeString()} — <b>${a.result}</b> ${a.kind} <span class="sid">${a.id.slice(
              0,
              12,
            )}…</span> (idle ${dur(a.idleSeconds)})</li>`,
        )
        .join("") || "<li>nothing reaped yet</li>"
  }

  $("err").hidden = !snap.error
  if (snap.error) $("err").textContent = "Solari API error: " + snap.error
  $("empty").hidden = snap.sessions.length > 0 || Boolean(snap.error)

  $("grid").innerHTML = snap.sessions
    .map((s) => {
      const running = s.state === "running" || s.state === "starting"
      const fanout = s.metadata && s.metadata.scope === "fanout"
      return `<div class="card ${s.idle ? "idle" : ""} ${fanout ? "fanout" : ""}">
        <div class="card-top">
          <span class="kind">${s.kind}${fanout ? " · fan-out" : ""}</span>
          <span class="badge ${s.idle ? "idlem" : running ? "running" : ""}">${
            s.idle ? "IDLE " + dur(s.idleSeconds) : s.state
          }</span>
        </div>
        <div class="sid">${s.id.slice(0, 38)}${s.id.length > 38 ? "…" : ""}</div>
        <div class="rows">
          <span>seen for</span><span>${dur((Date.now() - Date.parse(s.firstSeen)) / 1000)}</span>
          <span>CPU</span><span>${s.cpuPct == null ? "—" : s.cpuPct.toFixed(0) + "%"}</span>
          <span>memory</span><span>${
            s.memBytes == null
              ? s.cpu + " vCPU"
              : (s.memBytes / 2 ** 30).toFixed(1) + " / " + (s.memTotalBytes / 2 ** 30).toFixed(1) + " GiB"
          }</span>
          <span>rate</span><span>${usd(s.ratePerHour)}/h</span>
          <span>cost so far</span><span>${usd(s.costUsd)}</span>
        </div>
        <div class="card-actions"><button class="kill" data-id="${s.id}">Kill</button></div>
      </div>`
    })
    .join("")

  $("grid")
    .querySelectorAll("button.kill")
    .forEach((b) => {
      b.onclick = async () => {
        b.disabled = true
        b.textContent = "killing…"
        try {
          const res = await fetch(`/api/kill/${b.dataset.id}${q()}`, {
            method: "POST",
            headers: authHeaders(),
          })
          if (!res.ok) throw new Error((await res.json()).error || res.statusText)
        } catch (e) {
          b.textContent = "failed"
          b.disabled = false
        }
      }
    })
}

boot()
