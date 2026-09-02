# 🛰️ Solari Scope

**Live mission-control for AI agent fleets running on [Solari](https://getsolari.com).**

One screen shows every sandbox and desktop on your account: what's running, how
long it's been up, **how much money it's burning right now**, and which sessions
have gone idle. Turn on the reaper and idle sessions get killed automatically —
so you stop paying for the zombie VMs an agent crash leaves behind.

Built with Solari's own SDK. One process, one port, one required env var.

> **Demo:** run it (Phase 0 below) or drop a screenshot / GIF at
> `docs/screenshot.png` and it shows here.

---

## Why this exists

Solari bills by usage across browsers, sandboxes, and desktops. The thing that
quietly runs up a bill is a session nobody released: an agent throws halfway
through, its `finally` never runs, and a microVM sits there on the meter until
its idle timeout — times every crash, every run, every developer.

Scope is the operational layer for that problem:

- **See the burn** — a single burn-rate number and a per-session cost estimate,
  updated every few seconds.
- **Catch the zombies** — sessions whose activity has stopped are flagged idle.
- **Reap them** — optional auto-kill of idle sessions, with a dry-run mode so you
  can watch it decide before you let it act.
- **Kill anything by hand** — one button per session.

It's a tool a Solari customer would actually keep open.

---

## Phase 0 — Run it locally

Needs Node 22+.

```bash
cd THE_PROJECT
npm install
cp .env.example .env          # then paste your slr_live_ key into .env
npm start
```

Open <http://localhost:3000>. That's it — no database, no build step for dev.

---

## Deploy

Scope is a stateless Node web service. Anything that runs Node or a container
works.

### Render (one click)

1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → point it at the repo. [`render.yaml`](render.yaml)
   wires the build, a generated dashboard password, and the reaper defaults.
3. Add your `SOLARI_API_KEY` in the Render dashboard. Done.

### Docker

```bash
docker build -t solari-scope .
docker run -p 3000:3000 -e SOLARI_API_KEY=slr_live_... solari-scope
```

### Any Node host (Railway, Fly, Heroku, a VM)

```bash
npm ci && npm run build && npm run start:prod
```

`Procfile` and `Dockerfile` are both included. The only state is in memory, so
scale to one instance (a second instance just double-counts cost).

---

## Configuration

Everything is env vars. Copy [`.env.example`](.env.example) and edit.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOLARI_API_KEY` | — | **Required.** `slr_live_...` from console.getsolari.com |
| `PORT` | `3000` | HTTP port |
| `SCOPE_TOKEN` | _(none)_ | Shared password. Unset = open dashboard. **Set this before deploying anywhere public.** |
| `POLL_SECONDS` | `4` | How often Scope re-reads the fleet from Solari |
| `REAP_IDLE_MINUTES` | `0` | Kill sessions idle this long. `0` = reaper off |
| `REAP_MODE` | `dry-run` | `dry-run` logs decisions; `live` actually kills |
| `RATE_SANDBOX_PER_HOUR` | `0.12` | $/hour used for the cost estimate |
| `RATE_DESKTOP_PER_HOUR` | `0.28` | $/hour used for the cost estimate |
| `NEMOTRON_API_KEY` | _(none)_ | Only for the Phase 5 fan-out runner |

With `SCOPE_TOKEN` set, open the dashboard once as
`https://your-url/?token=THE_TOKEN` — it's saved to the browser and stripped
from the URL.

---

## How the numbers work

Solari doesn't publish a machine-readable price list, so **cost is an estimate**,
not a bill:

- Scope watches each session and counts the seconds it spends in a running
  state, then multiplies by the per-hour rate for its kind.
- `RATE_SANDBOX_PER_HOUR` / `RATE_DESKTOP_PER_HOUR` are placeholders — put your
  real plan numbers in `.env` and the meter matches your invoice.
- Counting starts when Scope first sees a session, so a session that was already
  running when you started Scope shows cost from that moment on, not from its
  true birth.

**Idle detection is CPU-based.** Solari has no "last active" field, and its
`expiresAt` gets nudged forward by keep-alive, so it can't be trusted for this.
Instead Scope samples each session's `metrics()` every `METRICS_EVERY_SECONDS`;
a session whose CPU stays at or below `REAP_CPU_IDLE_PCT` for the whole
`REAP_IDLE_MINUTES` window is idle. Anything Scope can't measure is treated as
active — **the reaper never kills on missing data.**

---

## Roadmap (phases)

| Phase | Scope | Status |
| --- | --- | --- |
| **0. Setup** | One-command local run, `.env`, deploy files | ✅ done |
| **1. Fleet view** | Live list of every sandbox + desktop; age, state, vCPU/RAM, auto-release time; manual kill; SSE live updates | ✅ done |
| **2. Cost meter + reaper** | Burn-rate KPI, per-session cost, live CPU/memory sampling, CPU-based idle flagging, dry-run/live auto-reaper with an action log | ✅ done |
| **3. Inspect a session** | Click a tile → CPU/mem sparkline history; embedded VNC via `streamUrl` for desktops | 🔜 planned |
| **4. Session replay** | List recorded browser sessions, pull the rrweb replay, render it inline with `rrweb-player` | 🔜 planned |
| **5. Fan-out runner** | Paste a task + N; Nemotron turns it into a script; launch N sandboxes in parallel; stream per-worker status; one-click teardown | 🔜 planned |
| **6. Hardening** | Per-user tokens, structured audit log export, Slack/webhook alert when burn-rate crosses a threshold | 🔜 planned |

Phases 1–2 are the product. 3–6 are where it grows.

---

## Project layout

```
THE_PROJECT/
├── src/
│   ├── server.ts     Express: static UI + JSON API + SSE stream
│   ├── fleet.ts       the poller — Solari → Scope state, cost, idle, reaper
│   ├── config.ts      env parsing, one place
│   └── types.ts       shared shapes
├── public/            the dashboard (vanilla HTML/CSS/JS, no build)
├── Dockerfile · render.yaml · Procfile   deploy
└── .env.example
```

## API

| Route | Purpose |
| --- | --- |
| `GET /api/fleet` | current snapshot (JSON) |
| `GET /api/stream` | same snapshot, pushed as SSE every `POLL_SECONDS` |
| `POST /api/kill/:id` | destroy one session |
| `GET /api/health` | liveness + whether a token is required |

## Limitations

- **In-memory state.** Restarting Scope resets observed-cost counters and the
  reaper log. Run one instance.
- **Estimated cost**, not billing data (see above).
- **Sandboxes and desktops only.** The browser SDK has no "list live sessions"
  call, so live cloud-browser sessions aren't shown; recorded ones land in
  Phase 4.

## License

MIT — see [LICENSE](LICENSE).
