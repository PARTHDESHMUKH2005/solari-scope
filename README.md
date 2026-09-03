# 🛰️ Solari Scope

**Run a real batch job across a fleet of [Solari](https://getsolari.com)
sandboxes — and watch what it costs.**

Type a job in plain English. An NVIDIA Nemotron model writes the worker script.
Solari runs it on *N* fresh microVMs in parallel — each one an isolated Linux
box with real internet and `pip` — and Scope shards the work across them and
collects every worker's output into one result set.

The same screen is a live cost dashboard for the fleet: what's running, how long
it's been up, **how much money it's burning right now**, and an optional reaper
that kills idle VMs so an agent crash doesn't leave zombies on the meter.

Built on Solari's own SDK. One process, one port, one required env var.

> **Demo:** run it (below) or drop a screenshot / GIF at `docs/screenshot.png`.

---

## What it does

**Fan-out runner** — the core.

- You describe a batch job: *"fetch the 15 top Hacker News stories and return
  each one's title, score and author."*
- Nemotron writes one Python worker. It's told the runtime has internet and
  `pip`, and that it's worker `WORKER_INDEX` of `WORKER_COUNT` — so it processes
  only its shard of the list.
- Scope spins up the sandboxes (pooled, and it retries Solari's concurrency
  limit so a small plan just runs sequentially instead of erroring), runs the
  script on each, tears every VM down, and merges the JSON-Lines output.
- You get per-worker status and the combined result set on screen.

**Fleet dashboard** — the control surface around it.

- Every sandbox and desktop on the account, live, with age, CPU/memory, and an
  estimated $/hour burn.
- A reaper that flags VMs whose CPU has been idle too long and (optionally)
  kills them — dry-run first so you can watch it decide.
- One-click kill for anything.

Why both: the thing that quietly runs up a Solari bill is a VM nobody released.
A batch-job runner that forgets to clean up *is* that problem — so the runner
and the thing that watches for leaked VMs ship together.

---

## Run it locally

Needs Node 22+.

```bash
cd THE_PROJECT
npm install
cp .env.example .env    # paste your slr_live_ key, and an nvapi- key for the runner
npm start
```

Open <http://localhost:3000>. No database, no build step for dev. The fan-out
runner needs `NEMOTRON_API_KEY`; without it the dashboard still works and the
runner panel stays hidden.

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
| `NEMOTRON_API_KEY` | _(none)_ | `nvapi-...` from build.nvidia.com — turns on the fan-out runner |
| `NEMOTRON_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Any chat model on the NVIDIA endpoint |
| `FANOUT_CONCURRENCY` | `3` | Sandboxes to create at once (your Solari plan caps this too) |
| `FANOUT_MAX_WORKERS` | `20` | Upper bound on workers per run |
| `FANOUT_WORKER_TIMEOUT_MS` | `120000` | Hard cap on each worker's script (pip installs need headroom) |

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
| **3. Fan-out runner** | Plain-English job → Nemotron worker script → N sandboxes in parallel; shards a list by `WORKER_INDEX`/`WORKER_COUNT`; JSON-Lines output merged into one result set; concurrency-pooled with 429 retry; every VM torn down after | ✅ done |
| **4. Inspect a session** | Click a tile → CPU/mem history; embedded VNC via `streamUrl` for desktops | 🔜 planned |
| **5. Job library** | Save a job + its generated script, re-run it, diff results across runs | 🔜 planned |
| **6. Hardening** | Per-user tokens, audit-log export, Slack/webhook alert when burn-rate crosses a threshold | 🔜 planned |

Phase 3 is the product; 1–2 are the safety rail it rides on. 4–6 are where it grows.

---

## Project layout

```
THE_PROJECT/
├── src/
│   ├── server.ts     Express: static UI + JSON API + SSE stream
│   ├── fleet.ts       the poller — Solari → Scope state, cost, idle, reaper
│   ├── runner.ts      fan-out runner: task → script → N sandboxes
│   ├── nemotron.ts    the NVIDIA Nemotron call
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
| `GET /api/run/:id` | one run's live state (workers, output) |
| `GET /api/runs` | recent runs |
| `GET /api/health` | liveness + whether a token / the fan-out runner is available |

## Limitations

- **In-memory state.** Restarting Scope resets observed-cost counters and the
  reaper log. Run one instance.
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
