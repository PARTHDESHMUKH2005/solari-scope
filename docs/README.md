# Demo assets

Drop two files here when you record the demo:

- **`screenshot.png`** — a still of the running dashboard with at least one
  session on it. The top-level `README.md` picks it up automatically.
- **`demo.gif`** (or an `.mp4` link) — ~20 seconds for the launch post:
  1. Type a task into the fan-out runner, pick 3 workers, hit Run.
  2. Nemotron's script appears; three sandboxes light up and return answers.
  3. Cut to the fleet: a session goes quiet → **IDLE** badge → reaper log shows
     `would-kill`, then `killed` and the tile disappears.

## How to capture it

```bash
cp .env.example .env          # add your SOLARI_API_KEY
REAP_IDLE_MINUTES=1 REAP_MODE=live npm start
```

Start a sandbox from any other Solari script (or the cookbook
`sandbox-quickstart` example), leave it doing nothing, and record the tab for a
minute. Use any screen recorder; convert to GIF with `ffmpeg` or gifski.
