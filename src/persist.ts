/**
 * Account-wide state that isn't tied to a user: cumulative spend and the
 * burn-rate history behind the sparkline. Stored as one JSON row in SQLite's
 * `kv` table. Writes are debounced so a busy poll loop doesn't thrash.
 *
 * (Per-user run history lives in the `runs` table — see db.ts / runner.ts.)
 */
import { db } from "./db.js"

interface GlobalState {
  retiredCostUsd: number
  burnHistory: Array<{ t: number; rate: number }>
}

function read(): GlobalState {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'global'").get() as
      | { value: string }
      | undefined
    if (row) {
      const raw = JSON.parse(row.value)
      return {
        retiredCostUsd: Number(raw.retiredCostUsd) || 0,
        burnHistory: Array.isArray(raw.burnHistory) ? raw.burnHistory.slice(-240) : [],
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { retiredCostUsd: 0, burnHistory: [] }
}

export const state: GlobalState = read()

const write = db.prepare(
  "INSERT INTO kv (key, value) VALUES ('global', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
)

let timer: NodeJS.Timeout | null = null
export function markDirty(): void {
  if (timer) return
  timer = setTimeout(flush, 1500)
}

export function flush(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  try {
    write.run(JSON.stringify(state))
  } catch (e) {
    console.error("persist: could not write global state:", String(e))
  }
}
