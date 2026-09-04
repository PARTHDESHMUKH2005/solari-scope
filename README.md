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

Built on Solari's own SDK. Vera runs on a hosted LLM (any OpenAI-compatible
chat endpoint — set `VERA_MODEL` / `VERA_BASE_URL`). One process, one port, one
required env var.

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

**Accounts.** Sign up with a username + password. Every job you run is stored
under your account, and the run endpoints check ownership — so on a shared
deployment two people never see each other's jobs, scripts, or results. The
*fleet* view is account-wide (it's one Solari API key), and clearly labelled as
such.

**It survives restarts.** Accounts, sessions, per-user run history, cumulative
spend, and burn history all live in a single SQLite file. On `SIGINT` /
`SIGTERM` Scope cancels in-flight runs — killing their VMs — and closes the DB
cleanly, so a deploy never leaks a sandbox or loses history.

Why both halves: the thing that quietly runs up a Solari bill is a VM nobody
released. A batch-job runner that forgets to clean up *is* that problem — so the
runner and the thing that watches for leaked VMs ship together.

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

Open <http://localhost:3000> and create an account (open sign-up by default —
set `SIGNUP_CODE` to gate it). No build step for dev; the SQLite file is created
on first run. The fan-out runner needs `VERA_API_KEY` (an API key for an
OpenAI-compatible LLM endpoint); without it the dashboard still works and the
runner is disabled.

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
| `SIGNUP_CODE` | _(none)_ | If set, new accounts must supply this code. Empty = open sign-up |
| `SCOPE_DB_FILE` | `.scope.db` | SQLite file — accounts, sessions, per-user history, fleet state |
| `BUDGET_USD` | `0` | Warn once observed spend crosses this (`0` = off; the UI can also set one per-browser) |
| `POLL_SECONDS` | `4` | How often Scope re-reads the fleet from Solari |
| `REAP_IDLE_MINUTES` | `0` | Kill sessions idle this long. `0` = reaper off |
| `REAP_MODE` | `dry-run` | `dry-run` logs decisions; `live` actually kills |
| `RATE_SANDBOX_PER_HOUR` | `0.12` | $/hour used for the cost estimate |
| `RATE_DESKTOP_PER_HOUR` | `0.28` | $/hour used for the cost estimate |
| `VERA_API_KEY` | _(none)_ | API key for Vera's LLM endpoint — turns on the fan-out runner |
| `VERA_BASE_URL` | _(an OpenAI-compatible endpoint)_ | Override to point Vera at a different provider |
| `VERA_MODEL` | _(a sensible default)_ | The chat model Vera uses |
| `VERA_MAX_TOKENS` | `4096` | Raise if Vera's worker is cut off on a complex job |
| `FANOUT_CONCURRENCY` | `1` | Sandboxes to create at once — set to your Solari plan's limit |
| `FANOUT_MAX_WORKERS` | `20` | Upper bound on workers per run |
| `FANOUT_WORKER_TIMEOUT_MS` | `120000` | Hard cap on each worker (pip installs + fetches need headroom) |

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
| **4. Operability** | Graceful shutdown, cancel a run, CSV/JSON export, sortable result table, run history, projected cost, burn sparkline, budget alert, oldest-session callout | ✅ done |
| **5. Accounts** | Username/password sign-up, session tokens, per-user run history in SQLite, ownership checks on every run route — two users on one deployment can't see each other's work | ✅ done |
| **6. Inspect a session** | Click a tile → CPU/mem history; embedded VNC via `streamUrl` for desktops | 🔜 planned |

Phase 3 is the product; 1–2 are the safety rail; 4–5 make it a real multi-user tool.

---

## Project layout

```
solari-demo/
├── src/
│   ├── server.ts     Express: static UI + JSON API + SSE + auth middleware
│   ├── db.ts          SQLite — users, sessions, runs, fleet kv
│   ├── auth.ts        register / login / sessions (scrypt, no deps)
│   ├── fleet.ts       the poller — Solari → Scope state, cost, idle, reaper
│   ├── runner.ts      fan-out runner: job → worker → N sandboxes, per user
│   ├── vera.ts        the planner — writes worker scripts (LLM call)
│   ├── persist.ts     account-wide fleet state (spend, burn history)
│   ├── config.ts      env parsing, one place
│   └── types.ts       shared shapes
├── public/            the dashboard (vanilla HTML/CSS/JS, no build)
├── Dockerfile · render.yaml · Procfile   deploy
└── .env.example
```

## API

All routes below need `Authorization: Bearer <token>` (SSE routes take
`?token=`) except register / login / health.

| Route | Purpose |
| --- | --- |
| `POST /api/register` | `{ username, password, code? }` → `{ token, user }` |
| `POST /api/login` | `{ username, password }` → `{ token, user }` |
| `POST /api/logout` · `GET /api/me` | end / check the session |
| `POST /api/run` | `{ task, count }` → start a fan-out run under your account |
| `GET /api/runs` | **your** recent runs |
| `GET /api/run/:id` · `/stream` | one of **your** runs (404 otherwise) — full state / SSE |
| `POST /api/run/:id/cancel` | stop one of your runs, kill its sandboxes |
| `GET /api/fleet` · `/api/stream` | account-wide fleet snapshot / SSE |
| `POST /api/kill/:id` | destroy one fleet session |
| `GET /api/health` | liveness + whether Vera and a signup code are configured |

## The frontend

`public/` is plain HTML + CSS + one JS file — no build step, no framework. It
talks to the API over two SSE streams (the fleet, and the active run) and
animates with CSS keyframes and transitions. Adding React + Framer Motion was
considered and skipped: a full rewrite of a working app under a deadline is the
wrong risk, and CSS covers the motion here (worker cards slide in, results
stream row-by-row, KPI numbers pulse on change). `prefers-reduced-motion` is
respected.

## Limitations

- **Single instance.** Everything is in one SQLite file — it survives restarts,
  but two instances would each open their own. Run one (or put the DB on a
  shared volume and add a proper client if you need to scale out).
- **The fleet is one Solari account.** Accounts isolate run history, not the
  underlying infrastructure — every signed-in user sees the same live fleet,
  burn rate, and reaper, because there's one API key.
- **Vera takes ~20–40s to write a worker** — a one-time cost per run, shown
  with a live "thinking" timer. Point `VERA_MODEL` at a faster model to cut it.
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
