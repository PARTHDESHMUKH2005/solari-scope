"use strict"

// SCOPE_TOKEN support: ?token=... in the URL is remembered in localStorage.
const url = new URL(location.href)
if (url.searchParams.get("token")) {
  localStorage.setItem("scopeToken", url.searchParams.get("token"))
  url.searchParams.delete("token")
  history.replaceState({}, "", url)
}
const TOKEN = localStorage.getItem("scopeToken") || ""
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""

const $ = (id) => document.getElementById(id)
const conn = $("conn")

const usd = (n) =>
  "$" + (n < 1 ? n.toFixed(n < 0.1 ? 4 : 3) : n.toFixed(2))
const dur = (s) => {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`
}

function render(snap) {
  $("k-count").textContent = snap.totals.count
  $("k-running").textContent = snap.totals.running
  $("k-rate").textContent = usd(snap.totals.ratePerHour)
  $("k-cost").textContent = usd(snap.totals.costUsd)
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
            )}…</span> (idle ${dur(a.idleSeconds)})${a.detail ? " — " + a.detail : ""}</li>`,
        )
        .join("") || "<li>nothing reaped yet</li>"
  }

  $("err").hidden = !snap.error
  if (snap.error) $("err").textContent = "Solari API error: " + snap.error

  const grid = $("grid")
  $("empty").hidden = snap.sessions.length > 0 || Boolean(snap.error)

  grid.innerHTML = snap.sessions
    .map((s) => {
      const running = s.state === "running" || s.state === "starting"
      return `<div class="card ${s.idle ? "idle" : ""}">
        <div class="card-top">
          <span class="kind">${s.kind}</span>
          <span class="badge ${s.idle ? "idlem" : running ? "running" : ""}">${
        s.idle ? "IDLE " + dur(s.idleSeconds) : s.state
      }</span>
        </div>
        <div class="sid">${s.id.slice(0, 40)}${s.id.length > 40 ? "…" : ""}</div>
        <div class="rows">
          <span>seen for</span><span>${dur(
            (Date.now() - Date.parse(s.firstSeen)) / 1000,
          )}</span>
          <span>running</span><span>${dur(s.observedSeconds)}</span>
          <span>CPU</span><span>${s.cpuPct == null ? "—" : s.cpuPct.toFixed(0) + "%"}</span>
          <span>memory</span><span>${
            s.memBytes == null
              ? s.cpu + " vCPU"
              : (s.memBytes / 2 ** 30).toFixed(1) +
                " / " +
                (s.memTotalBytes / 2 ** 30).toFixed(1) +
                " GiB"
          }</span>
          <span>rate</span><span>${usd(s.ratePerHour)}/h</span>
          <span>cost so far</span><span>${usd(s.costUsd)}</span>
          <span>auto-release</span><span>${new Date(s.expiresAt).toLocaleTimeString()}</span>
        </div>
        <div class="card-actions">
          <button class="kill" data-id="${s.id}">Kill</button>
        </div>
      </div>`
    })
    .join("")

  grid.querySelectorAll("button.kill").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true
      b.textContent = "killing…"
      try {
        const res = await fetch(`/api/kill/${b.dataset.id}${q}`, { method: "POST" })
        if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      } catch (e) {
        b.textContent = "failed"
        alert("Kill failed: " + e.message)
        b.disabled = false
      }
    }
  })
}

function connect() {
  const es = new EventSource(`/api/stream${q}`)
  es.onopen = () => {
    conn.textContent = "live"
    conn.className = "conn live"
  }
  es.onmessage = (ev) => render(JSON.parse(ev.data))
  es.onerror = () => {
    conn.textContent = "reconnecting…"
    conn.className = "conn down"
    es.close()
    setTimeout(connect, 2000)
  }
}
connect()
