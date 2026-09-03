/**
 * Dead-simple disk persistence — one JSON file, no database.
 *
 * Scope keeps run history, the cumulative spend, and the burn-rate history in
 * memory. Without this a restart (a deploy, a crash) loses all of it. Fleet and
 * Runner read the loaded state on startup and call `markDirty()` when their
 * slice changes; writes are debounced so a busy poll loop doesn't thrash the
 * disk.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { config } from "./config.js"
import type { PersistedState } from "./types.js"

const EMPTY: PersistedState = { retiredCostUsd: 0, burnHistory: [], runs: [] }

function read(): PersistedState {
  try {
    const raw = JSON.parse(readFileSync(config.stateFile, "utf8"))
    return {
      retiredCostUsd: Number(raw.retiredCostUsd) || 0,
      burnHistory: Array.isArray(raw.burnHistory) ? raw.burnHistory.slice(-240) : [],
      runs: Array.isArray(raw.runs) ? raw.runs.slice(0, 25) : [],
    }
  } catch {
    return { ...EMPTY }
  }
}

export const state: PersistedState = read()

let timer: NodeJS.Timeout | null = null
export function markDirty(): void {
  if (timer) return
  timer = setTimeout(flush, 1500)
}

/** Write now (used on graceful shutdown). */
export function flush(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  try {
    const tmp = config.stateFile + ".tmp"
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, config.stateFile)
  } catch (e) {
    console.error("persist: could not write state:", String(e))
  }
}
