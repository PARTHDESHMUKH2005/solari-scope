"use strict"

const $ = (id) => document.getElementById(id)

/* ── session ────────────────────────────────────────────────────── */
let TOKEN = localStorage.getItem("scopeSession") || ""
let ME = null
const q = () => (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "")
const authHeaders = () => (TOKEN ? { authorization: "Bearer " + TOKEN } : {})

function forceLogin() {
  TOKEN = ""
  localStorage.removeItem("scopeSession")
  location.reload()
}

/* ── boot ───────────────────────────────────────────────────────── */
let HEALTH = {}
async function boot() {
  try {
    HEALTH = await (await fetch("/api/health")).json()
  } catch {
    HEALTH = {}
  }
  if (TOKEN) {
    try {
      const r = await fetch("/api/me", { headers: authHeaders() })
      if (r.ok) {
        ME = (await r.json()).user
        return startApp()
      }
    } catch {}
  }
  showLogin()
}

function showLogin() {
  $("login").hidden = false
  $("app").hidden = true
  let mode = "register" // or "login" — new visitors land on account creation

  const apply = () => {
    const reg = mode === "register"
    $("login-sub").textContent = reg
      ? "Create an account. Your jobs and history stay private to you."
      : "Welcome back. Sign in with your username and password."
    $("login-submit").textContent = reg ? "Create account" : "Sign in"
    $("login-toggle").textContent = reg
      ? "I already have an account"
      : "Create an account instead"
    $("login-pass").setAttribute("autocomplete", reg ? "new-password" : "current-password")
    $("login-pass2").hidden = !reg
    $("login-code").hidden = !(reg && HEALTH.signupCode)
    $("login-err").textContent = ""
  }
  $("login-toggle").onclick = () => {
    mode = mode === "login" ? "register" : "login"
    apply()
  }
  apply()

  $("login-form").onsubmit = async (e) => {
    e.preventDefault()
    $("login-err").textContent = ""
    const username = $("login-user").value.trim()
    const password = $("login-pass").value
    if (mode === "register" && password !== $("login-pass2").value) {
      $("login-err").textContent = "passwords do not match"
      return
    }
    const body = { username, password }
    if (mode === "register" && HEALTH.signupCode) body.code = $("login-code").value.trim()
    $("login-submit").disabled = true
    try {
      const res = await fetch(`/api/${mode === "register" ? "register" : "login"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "failed")
      TOKEN = data.token
      ME = data.user
      localStorage.setItem("scopeSession", TOKEN)
      $("login").hidden = true
      startApp()
    } catch (err) {
      $("login-err").textContent = err.message
      $("login-submit").disabled = false
    }
  }
}

function startApp() {
  $("app").hidden = false
  $("whoami").textContent = ME ? "@" + ME.username : ""
  $("logout").onclick = async () => {
    await fetch("/api/logout", { method: "POST", headers: authHeaders() }).catch(() => {})
    forceLogin()
  }
  if (!HEALTH.vera) {
    $("runner").style.opacity = "0.6"
    $("fo-run").disabled = true
    $("fo-task").placeholder = "Set VERA_API_KEY to enable the fan-out runner"
  }
  wireRunner()
  wireBudget()
  loadHistory({ autoOpen: true })
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

function download(name, text, type) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/* union of keys across an array of objects, first-seen order */
function keyUnion(rows) {
  const keys = []
  for (const r of rows) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
    }
  }
  return keys
}
function cell(v) {
  if (v == null) return ""
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}
function toCsv(rows) {
  const keys = keyUnion(rows)
  const qt = (v) => {
    const s = cell(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = keys.length ? keys : ["value"]
  const lines = [head.join(",")]
  for (const r of rows) {
    lines.push(keys.length ? keys.map((k) => qt(r?.[k])).join(",") : qt(r))
  }
  return lines.join("\n")
}

/* ── fan-out runner ─────────────────────────────────────────────── */
const SAMPLES = [
  "fetch the 15 top Hacker News stories and return each one's title, score and author",
  "for the numbers 1 to 60, return whether each is prime and its prime factorisation",
  "check these sites for HTTP status and page title: example.com github.com wikipedia.org rust-lang.org python.org npmjs.com",
  "estimate pi with a Monte Carlo simulation of 2 million points",
]
let runSource = null
let currentRun = null
let lastSnap = null
let resultView = "table"
let sortKey = null
let sortDir = 1

function wireRunner() {
  $("fo-sample").onclick = () => {
    $("fo-task").value = SAMPLES[Math.floor(Math.random() * SAMPLES.length)]
  }
  $("fo-run").onclick = () => startRun()
  $("run-cancel").onclick = async () => {
    if (!currentRun) return
    $("run-cancel").disabled = true
    $("run-cancel").textContent = "stopping…"
    await fetch(`/api/run/${currentRun.id}/cancel${q()}`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => {})
  }
  $("view-table").onclick = () => setView("table")
  $("view-raw").onclick = () => setView("raw")
  $("dl-csv").onclick = () =>
    currentRun && download(`${currentRun.id}.csv`, toCsv(currentRun.results), "text/csv")
  $("dl-json").onclick = () =>
    currentRun &&
    download(
      `${currentRun.id}.json`,
      JSON.stringify(currentRun.results, null, 2),
      "application/json",
    )
}

function setView(v) {
  resultView = v
  $("view-table").classList.toggle("on", v === "table")
  $("view-raw").classList.toggle("on", v === "raw")
  $("results-table-wrap").hidden = v !== "table"
  $("results-list").hidden = v !== "raw"
  if (currentRun) renderResults(currentRun.results)
}

async function startRun() {
  const task = $("fo-task").value.trim()
  const count = Number($("fo-count").value)
  if (task.length < 4) return
  $("fo-run").disabled = true
  $("fo-run").textContent = "starting…"
  sortKey = null
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

function streamRun(id) {
  if (runSource) runSource.close()
  $("run-view").hidden = false
  runSource = new EventSource(`/api/run/${id}/stream${q()}`)
  runSource.onmessage = (ev) => renderRun(JSON.parse(ev.data))
  runSource.addEventListener("gone", () => runSource.close())
  runSource.onerror = () => {
    runSource.close()
    fetch(`/api/run/${id}${q()}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((r) => r && r.id && renderRun(r))
      .catch(() => {})
    loadHistory()
  }
}

/** Open a finished run (from history) in the run view — stays until replaced. */
async function openRun(id) {
  try {
    const r = await (
      await fetch(`/api/run/${id}${q()}`, { headers: authHeaders() })
    ).json()
    if (r && r.id) {
      if (runSource) runSource.close()
      $("run-view").hidden = false
      sortKey = null
      renderRun(r)
    }
  } catch {}
}

async function loadHistory({ autoOpen = false } = {}) {
  let runs = []
  try {
    runs = (await (await fetch(`/api/runs${q()}`, { headers: authHeaders() })).json()).runs || []
  } catch {
    return
  }
  $("run-history").hidden = runs.length === 0
  $("rh-list").innerHTML = runs
    .map((r) => {
      const n = r.resultCount
      return `<button class="rh-item ${r.state}" data-id="${r.id}" title="${esc(r.task)}">
        <span class="dot">●</span> ${esc(r.task.slice(0, 38))}${r.task.length > 38 ? "…" : ""}
        <span class="rh-meta">${n ? n + " res" : r.state}</span>
      </button>`
    })
    .join("")
  $("rh-list")
    .querySelectorAll(".rh-item")
    .forEach((b) => (b.onclick = () => openRun(b.dataset.id)))

  // On first load, drop the most recent run straight into the view so a
  // finished run is never "gone" — you land back on it.
  if (autoOpen && runs.length && !currentRun) {
    const latest = runs[0]
    const active = latest.state === "running" || latest.state === "generating"
    if (active) streamRun(latest.id)
    else openRun(latest.id)
  }
}

function renderRun(run) {
  currentRun = run
  const finished =
    run.state === "done" || run.state === "error" || run.state === "canceled"
  if (finished) {
    $("fo-run").disabled = false
    $("fo-run").textContent = "Run job"
    loadHistory()
  }
  $("run-cancel").hidden = finished
  $("run-cancel").disabled = false
  $("run-cancel").textContent = "Stop"

  $("run-stage").className =
    "run-stage" +
    (run.state === "done" ? " done" : run.state === "error" || run.state === "canceled" ? " error" : "")
  $("run-stage-text").textContent = run.error || run.stage || run.state
  const elapsed = (Date.now() - Date.parse(run.createdAt)) / 1000
  $("run-mini").textContent = run.liveSandboxes
    ? `${run.liveSandboxes} sandbox${run.liveSandboxes === 1 ? "" : "es"} live`
    : run.state === "generating"
      ? `thinking · ${dur(elapsed)}`
      : finished && run.finishedAt
        ? `${run.state} in ${dur((Date.parse(run.finishedAt) - Date.parse(run.createdAt)) / 1000)}`
        : ""

  $("run-script").textContent = run.script || "…"

  $("worker-grid").innerHTML = (run.workers || [])
    .map((w) => {
      const cls =
        w.status === "running" || w.status === "creating"
          ? "running"
          : w.status === "done"
            ? "done"
            : w.status === "error" || w.status === "canceled"
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

  renderResults(run.results || [])
}

function renderResults(results) {
  $("results-wrap").hidden = results.length === 0
  setBump($("results-count"), String(results.length))

  if (resultView === "raw") {
    const shown = results.slice(0, 200)
    $("results-list").innerHTML =
      shown.map((r) => `<div class="row">${esc(JSON.stringify(r))}</div>`).join("") +
      (results.length > shown.length
        ? `<div class="row more">+ ${results.length - shown.length} more</div>`
        : "")
    return
  }

  const keys = keyUnion(results)
  let rows = results.slice()
  if (sortKey != null) {
    rows.sort((a, b) => {
      const av = cell(a?.[sortKey]),
        bv = cell(b?.[sortKey])
      const an = parseFloat(av),
        bn = parseFloat(bv)
      const cmp =
        !isNaN(an) && !isNaN(bn) ? an - bn : av < bv ? -1 : av > bv ? 1 : 0
      return cmp * sortDir
    })
  }
  const shown = rows.slice(0, 200)
  const head = keys.length
    ? keys
        .map(
          (k) =>
            `<th data-k="${esc(k)}">${esc(k)}${sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`,
        )
        .join("")
    : "<th>value</th>"
  const body = shown
    .map((r) => {
      if (!keys.length) return `<tr><td>${esc(cell(r))}</td></tr>`
      return (
        "<tr>" +
        keys
          .map((k) => {
            const v = r?.[k]
            const isErr = k === "error" || (k === "ok" && v === false)
            return `<td class="${isErr ? "err" : ""}">${esc(cell(v))}</td>`
          })
          .join("") +
        "</tr>"
      )
    })
    .join("")
  $("results-table-wrap").innerHTML =
    `<table class="results-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    (rows.length > shown.length
      ? `<div class="row more" style="padding:6px 10px;color:var(--dim)">+ ${rows.length - shown.length} more</div>`
      : "")
  $("results-table-wrap")
    .querySelectorAll("th[data-k]")
    .forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.k
        if (sortKey === k) sortDir = -sortDir
        else {
          sortKey = k
          sortDir = 1
        }
        renderResults(results)
      }
    })
}

/* ── budget ─────────────────────────────────────────────────────── */
let budgetDismissedAt = -1 // spend level at which the banner was dismissed

function wireBudget() {
  const saved = localStorage.getItem("scopeBudget")
  if (saved) $("budget-input").value = saved
  $("budget-input").oninput = () => {
    const v = $("budget-input").value.trim()
    if (v) localStorage.setItem("scopeBudget", v)
    else localStorage.removeItem("scopeBudget")
    budgetDismissedAt = -1
    applyBudget() // react immediately, don't wait for the next fleet tick
  }
  $("ab-dismiss").onclick = () => {
    budgetDismissedAt = lastSnap ? lastSnap.totals.costUsd : 0
    $("budget-banner").hidden = true
  }
}

function budgetLimit() {
  const local = parseFloat(localStorage.getItem("scopeBudget") || "")
  if (!isNaN(local) && local > 0) return local
  return lastSnap?.budget?.limit || 0
}

function applyBudget() {
  if (!lastSnap) return
  const limit = budgetLimit()
  const spend = lastSnap.totals.costUsd
  const over = limit > 0 && spend > limit
  $("kpi-spend").classList.toggle("over-budget", over)

  // re-show the banner if spend has climbed further since it was dismissed
  const show = over && spend > budgetDismissedAt
  $("budget-banner").hidden = !show
  if (show) {
    const pct = Math.round((spend / limit - 1) * 100)
    $("ab-text").innerHTML =
      `Budget exceeded — observed spend <b>${usd(spend)}</b> is <b>${pct}%</b> over your <b>${usd(
        limit,
      )}</b> limit.`
  }
}

/* ── fleet ──────────────────────────────────────────────────────── */
function connectFleet() {
  const es = new EventSource(`/api/stream${q()}`)
  es.onopen = () => (($("conn").textContent = "live"), ($("conn").className = "conn live"))
  es.onmessage = (ev) => renderFleet(JSON.parse(ev.data))
  es.onerror = async () => {
    $("conn").textContent = "reconnecting…"
    $("conn").className = "conn down"
    es.close()
    // if the session died, bounce to the login screen instead of looping
    try {
      const r = await fetch("/api/me", { headers: authHeaders() })
      if (r.status === 401) return forceLogin()
    } catch {}
    setTimeout(connectFleet, 2000)
  }
}

function drawSpark(history) {
  const svg = $("burn-spark")
  if (!history || history.length < 2) {
    svg.innerHTML = ""
    return
  }
  const rates = history.map((h) => h.rate)
  const max = Math.max(...rates, 0.0001)
  const n = rates.length
  const pts = rates
    .map((r, i) => `${(i / (n - 1)) * 100},${24 - (r / max) * 22 - 1}`)
    .join(" ")
  svg.innerHTML = `<polyline points="${pts}" />`
}

function renderFleet(snap) {
  setBump($("k-count"), String(snap.totals.count))
  setBump($("k-running"), String(snap.totals.running))
  setBump($("k-rate"), usd(snap.totals.ratePerHour))
  setBump($("k-cost"), usd(snap.totals.costUsd))
  $("stamp").textContent = "updated " + new Date(snap.at).toLocaleTimeString()

  // projected cost
  const p = snap.projected || { daily: 0, monthly: 0 }
  $("k-projected").textContent =
    snap.totals.ratePerHour > 0
      ? `/hr  ·  ~${usd(p.daily)}/day  ·  ~${usd(p.monthly)}/mo`
      : "/ hour"

  drawSpark(snap.burnHistory)

  lastSnap = snap
  applyBudget()

  // oldest running session
  const o = snap.oldest
  $("oldest").hidden = !o || o.ageSeconds < 300
  if (o && o.ageSeconds >= 300) {
    $("oldest").innerHTML = `⏳ oldest session — <b>${o.kind}</b> <span class="sid">${o.id.slice(
      0,
      14,
    )}…</span> up ${dur(o.ageSeconds)} <button data-id="${o.id}">kill</button>`
    $("oldest").querySelector("button").onclick = async (e) => {
      e.target.disabled = true
      await fetch(`/api/kill/${o.id}${q()}`, { method: "POST", headers: authHeaders() }).catch(
        () => {},
      )
    }
  }

  const rp = snap.reaper
  $("reaper").hidden = !rp.enabled
  if (rp.enabled) {
    $("reaper-desc").textContent = `${rp.mode} · kills after ${rp.idleMinutes}m idle`
    $("reaper-log").innerHTML =
      rp.actions
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
  const fo = snap.fanout || { sandboxes: 0 }
  $("empty").hidden = snap.sessions.length > 0 || fo.sandboxes > 0 || Boolean(snap.error)

  const foCard =
    fo.sandboxes > 0
      ? `<div class="card fanout">
          <div class="card-top"><span class="kind">fan-out · live</span><span class="badge running">running</span></div>
          <div class="sid">${fo.sandboxes} sandbox${fo.sandboxes === 1 ? "" : "es"} running a job right now</div>
          <div class="rows">
            <span>rate</span><span>${usd(fo.ratePerHour)}/h</span>
            <span>spent this run</span><span>${usd(fo.costUsd)}</span>
          </div>
        </div>`
      : ""

  $("grid").innerHTML =
    foCard +
    snap.sessions
      .map((s) => {
        const running = s.state === "running" || s.state === "starting"
        return `<div class="card ${s.idle ? "idle" : ""}">
        <div class="card-top">
          <span class="kind">${s.kind}</span>
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
