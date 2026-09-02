# Demo assets

Drop two files here when you record the demo:

- **`screenshot.png`** — a still of the running dashboard with at least one
  session on it. The top-level `README.md` picks it up automatically.
- **`demo.gif`** (or an `.mp4` link) — ~15 seconds for the launch post:
  1. Dashboard with 1–2 live sessions, burn-rate ticking.
  2. A session goes quiet → the **IDLE** badge appears.
  3. Reaper log shows `would-kill`, then (in live mode) `killed` and the tile
     disappears.

## How to capture it

```bash
cp .env.example .env          # add your SOLARI_API_KEY
REAP_IDLE_MINUTES=1 REAP_MODE=live npm start
```

Start a sandbox from any other Solari script (or the cookbook
`sandbox-quickstart` example), leave it doing nothing, and record the tab for a
minute. Use any screen recorder; convert to GIF with `ffmpeg` or gifski.
