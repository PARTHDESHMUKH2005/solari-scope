# 🛰️ Solari Scope

**Run a real batch job across a fleet of [Solari](https://getsolari.com)
sandboxes — and watch what it costs.**

Type a job in plain English. **Vera** — the planner — writes one Python worker.
Solari runs it on *N* fresh microVMs in parallel, each an isolated Linux box
with real internet and `pip`. Scope shards the work across them, streams every
worker's output back live, and merges it into one result set.

The same screen is a live cost dashboard for the fleet: what's running, how long
it's been up, **how much money it's burning right now**, and an optional reaper
that kills idle VMs so an agent crash doesn't leave zombies on the meter.

Built on Solari's own SDK. Vera runs on an NVIDIA Nemotron model. One process,
one port, one required env var.

> **Demo:** run it (below) or drop a screenshot / GIF at `docs/screenshot.png` —
> see [`docs/`](docs/) for how to record one.

---

## What it does

**Fan-out runner** — the core.

- You describe a batch job: *"check these six sites for HTTP status and page
  title"* or *"fetch the top 15 Hacker News stories and return title, score,
  author."*
- Vera writes one Python worker. It's told the runtime has internet and `pip`,
  and that it's worker `WORKER_INDEX` of `WORKER_COUNT` — so it processes only
  its shard, and prints one JSON line per item **including failures**, so
  nothing disappears silently.
- Scope spins up the sandboxes (pooled, and it retries Solari's concurrency
  limit so a small plan just runs sequentially instead of erroring), runs the
  worker on each, tears every VM down, and merges the JSON-Lines output.
- Per-worker status, live result count, and the merged set all stream to the
  screen over SSE while it runs. **Stop** a run at any point — its sandboxes
  are killed immediately.
- Results show as a **sortable table** or raw JSON, and download as **CSV** or
  **JSON**. Every run is kept in history and re-openable.

**Fleet dashboard** — the control surface around it.

- Every sandbox and desktop on the account, live, with age, CPU/memory, and an
  estimated $/hour burn — plus **projected daily / monthly** cost and a
  **burn-rate sparkline**.
- A **budget** you set: cross it and the KPIs turn red with a banner.
- The **oldest running session** is called out — that's usually the forgotten
  one — with a kill button.
- A reaper that flags VMs whose CPU has been idle too long and (optionally)
  kills them — dry-run first so you can watch it decide.
- One-click kill for anything.

**It survives restarts.** Run history, cumulative spend, and burn history are
written to a small JSON file (no database). On `SIGINT` / `SIGTERM` Scope
cancels in-flight runs — killing their VMs — and flushes state before exiting,
so a deploy never leaks a sandbox.

Why both: the thing that quietly runs up a Solari bill is a VM nobody released.
A batch-job runner that forgets to clean up *is* that problem — so the runner
and the thing that watches for leaked VMs ship together.

---

## Run it locally

Needs Node 22+.

```bash
git clone git@github.com:PARTHDESHMUKH2005/solari-demo.git
cd solari-demo
npm install
cp .env.example .env    # SOLARI_API_KEY (required) + VERA_API_KEY for the runner
npm start
```

Open <http://localhost:3000>. No database, no build step for dev. The fan-out
runner needs `VERA_API_KEY` (an `nvapi-...` key from build.nvidia.com); without
it the dashboard still works and the runner is disabled. Set `SCOPE_TOKEN` and
the app shows a login screen.

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
| `SCOPE_STATE_FILE` | `.scope-state.json` | Where run history + spend are persisted |
| `BUDGET_USD` | `0` | Warn once observed spend crosses this (`0` = off; the UI can also set one per-browser) |
| `POLL_SECONDS` | `4` | How often Scope re-reads the fleet from Solari |
| `REAP_IDLE_MINUTES` | `0` | Kill sessions idle this long. `0` = reaper off |
| `REAP_MODE` | `dry-run` | `dry-run` logs decisions; `live` actually kills |
| `RATE_SANDBOX_PER_HOUR` | `0.12` | $/hour used for the cost estimate |
| `RATE_DESKTOP_PER_HOUR` | `0.28` | $/hour used for the cost estimate |
| `VERA_API_KEY` | _(none)_ | `nvapi-...` from build.nvidia.com — turns on the fan-out runner (`NEMOTRON_API_KEY` also accepted) |
| `VERA_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Any chat model on the NVIDIA endpoint |
| `VERA_MAX_TOKENS` | `4096` | Raise if Vera's worker is cut off on a complex job |
| `FANOUT_CONCURRENCY` | `3` | Sandboxes to create at once (your Solari plan caps this too) |
| `FANOUT_MAX_WORKERS` | `20` | Upper bound on workers per run |
| `FANOUT_WORKER_TIMEOUT_MS` | `120000` | Hard cap on each worker (pip installs + fetches need headroom) |

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
| **0. Setup** | One-command local run, `.env`, deploy files (Docker / Render / Procfile) | ✅ done |
| **1. Fleet view** | Live list of every sandbox + desktop; age, state, vCPU/RAM, auto-release time; manual kill; SSE live updates | ✅ done |
| **2. Cost meter + reaper** | Burn-rate KPI, per-session cost, live CPU/memory sampling, CPU-based idle flagging, dry-run/live auto-reaper with an action log | ✅ done |
| **3. Fan-out runner** | Plain-English job → Vera writes a worker → N sandboxes in parallel; shards a list by `WORKER_INDEX`/`WORKER_COUNT`; per-item JSON incl. failures, merged into one set; live SSE progress; concurrency-pooled with 429 retry; every VM torn down after | ✅ done |
| **4. Operability** | Disk persistence (history + spend survive restarts), graceful shutdown, cancel a run, CSV/JSON export, sortable result table, run history, projected cost, burn sparkline, budget alert, oldest-session callout | ✅ done |
| **5. Inspect a session** | Click a tile → CPU/mem history; embedded VNC via `streamUrl` for desktops | 🔜 planned |
| **6. Diff runs** | Re-run a saved job, highlight what changed since last time (a status flipped, a number moved) | 🔜 planned |

Phase 3 is the product; 1–2 are the safety rail; 4 is what makes it usable day to day.

---

## Project layout

```
solari-demo/
├── src/
│   ├── server.ts     Express: static UI + JSON API + SSE stream
│   ├── fleet.ts       the poller — Solari → Scope state, cost, idle, reaper
│   ├── runner.ts      fan-out runner: job → worker → N sandboxes, live
│   ├── vera.ts        the planner — writes worker scripts (NVIDIA Nemotron)
│   ├── persist.ts     one-JSON-file store for history + spend
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
| `POST /api/run` | `{ task, count }` → start a fan-out run, returns `{ runId }` |
| `GET /api/run/:id` | one run's full state (workers, merged results) |
| `GET /api/run/:id/stream` | that run pushed as SSE until it finishes |
| `POST /api/run/:id/cancel` | stop a run, kill its sandboxes |
| `GET /api/runs` | recent runs (persisted across restarts) |
| `POST /api/login` | `{ token }` → 200/401, for the login screen |
| `GET /api/health` | liveness + whether a token / Vera are configured |

## The frontend

`public/` is plain HTML + CSS + one JS file — no build step, no framework. It
talks to the API over two SSE streams (the fleet, and the active run) and
animates with CSS keyframes and transitions. Adding React + Framer Motion was
considered and skipped: a full rewrite of a working app under a deadline is the
wrong risk, and CSS covers the motion here (worker cards slide in, results
stream row-by-row, KPI numbers pulse on change). `prefers-reduced-motion` is
respected.

## Limitations

- **Single instance.** State is one JSON file on local disk — it survives a
  restart, but two instances would each keep their own. Run one (or point
  `SCOPE_STATE_FILE` at shared storage).
- **Vera is a reasoning model**, so writing a worker takes ~20–40s — a one-time
  cost per run, shown with a live "thinking" timer. `VERA_MODEL` overrides it.
- **Estimated cost**, not billing data (see above).
- **Fleet view is sandboxes + desktops.** The browser SDK has no "list live
  sessions" call, so cloud-browser sessions aren't in the dashboard. The
  fan-out runner uses sandboxes.
- **Idle detection needs `metrics()`.** If a session's metrics can't be read
  (some desktop states don't expose them), Scope treats it as active and the
  reaper won't touch it — safe, but it means the reaper is effectively
  sandbox-only for now.

## License

MIT — see [LICENSE](LICENSE).
