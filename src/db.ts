/**
 * SQLite — the one persistent store.
 *
 * Three tables: `users` (accounts), `sessions` (login tokens), `runs` (every
 * fan-out run, as a JSON blob keyed by id and owner). Plus a `kv` table for the
 * account-wide fleet state (cumulative spend, burn history) that isn't tied to
 * a user.
 *
 * better-sqlite3 is synchronous — no connection pool, no await. It ships
 * prebuilt binaries, so it installs and deploys without a compiler.
 */
import Database from "better-sqlite3"
import { config } from "./config.js"

export const db = new Database(config.dbFile)
db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    json       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_by_user ON runs(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)
