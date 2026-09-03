# Demo assets

Drop two files here when you record the demo:

- **`screenshot.png`** — the fan-out runner after a real job: the worker table
  and the "combined results" block with actual data. The top-level `README.md`
  picks it up automatically.
- **`demo.gif`** (or an `.mp4` link) — ~20 seconds for the launch post:
  1. Type a real batch job — e.g. *"fetch the 15 top Hacker News stories and
     return each one's title, score and author"* — pick 3 workers, hit Run.
  2. Nemotron's script appears; three sandboxes light up in the fleet, each
     returns 5 results.
  3. Expand **combined results** — 15 rows of real scraped data.
  4. Optional tail: turn the reaper on, let a VM go idle, watch it get reaped.

## How to capture it

```bash
cp .env.example .env          # add SOLARI_API_KEY and NEMOTRON_API_KEY
REAP_IDLE_MINUTES=1 REAP_MODE=live npm start
```

Record the tab with any screen recorder; convert to GIF with `ffmpeg` or gifski.
