# Recording the demo

You need two things for the launch post: a **screenshot** and a **~25s screen
recording** (posted as an MP4 or converted to GIF).

Drop the files here — `docs/screenshot.png` is picked up by the top-level
README automatically.

---

## 1. Set up

```bash
cp .env.example .env
#   SOLARI_API_KEY = your slr_live_ key
#   VERA_API_KEY   = your LLM provider API key
npm install
REAP_IDLE_MINUTES=2 REAP_MODE=dry-run npm start
```

Open <http://localhost:3000>, create an account, full-screen the browser, zoom
to ~110%.

## 2. The shot list (~25 seconds)

| # | On screen | Say (voiceover or caption) |
|---|---|---|
| 1 | The hero + the 4 step chips | "Solari Scope runs a batch job across a fleet of cloud sandboxes." |
| 2 | Type a job, e.g. *check these six sites for HTTP status and page title: example.com, github.com, wikipedia.org, rust-lang.org, npmjs.com, python.org* — set **3 sandboxes** — hit **Run job** | "You describe it. Vera writes the worker." |
| 3 | "Vera is writing the worker…" with the timer | *(let it sit ~2s, then cut)* |
| 4 | Three worker cards go **creating → running → done**, result counts tick up, the merged-results list fills row by row | "Solari runs it on three isolated VMs in parallel. Scope shards the work and streams the results back." |
| 5 | Scroll to the **Fleet** section mid-run so the sandboxes show up with the *fan-out* badge and the **burn rate** is non-zero | "And it's watching the whole fleet — including what it's costing you right now." |
| 6 | *(optional tail)* leave a sandbox idle, switch `REAP_MODE=live`, show the reaper log flip to `killed` | "Idle VMs get reaped automatically." |

## 3. Record

- **macOS:** Cmd-Shift-5 → record the browser window. Or QuickTime → New Screen Recording.
- Trim the dead air while Vera thinks (or speed that clip 4×).
- To GIF: `ffmpeg -i demo.mp4 -vf "fps=15,scale=1000:-1" demo.gif` — or use [gifski](https://gif.ski).
- Keep it under ~8 MB so it plays inline on X / LinkedIn.

## 4. Screenshot

Take it right after a run finishes — the worker cards showing **DONE** with
result counts, the **merged results** list visible, and the fleet KPIs below.
Save as `docs/screenshot.png`.
