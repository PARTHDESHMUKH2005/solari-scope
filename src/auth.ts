/**
 * Accounts and login sessions.
 *
 * Register with a username + password; you get a session token. Every fan-out
 * run you start is stored under your user id, and the run endpoints check
 * ownership — so two people using the same deployment never see each other's
 * jobs, scripts, or results.
 *
 * Passwords are scrypt-hashed with a per-user salt (node:crypto, no external
 * dependency). Session tokens are 32 random bytes, looked up in SQLite.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { db } from "./db.js"
import { config } from "./config.js"

export interface User {
  id: string
  username: string
}

interface UserRow {
  id: string
  username: string
  pw_hash: string
  pw_salt: string
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/

function hash(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), 64).toString("hex")
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export function register(username: string, password: string, code?: string): {
  token: string
  user: User
} {
  if (config.signupCode && code !== config.signupCode) {
    throw new AuthError("invalid signup code", 403)
  }
  if (!USERNAME_RE.test(username)) {
    throw new AuthError("username must be 3-32 chars: letters, digits, _ . -")
  }
  if (password.length < 8) {
    throw new AuthError("password must be at least 8 characters")
  }
  const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)
  if (exists) throw new AuthError("that username is taken", 409)

  const id = "u_" + randomBytes(9).toString("hex")
  const salt = randomBytes(16).toString("hex")
  db.prepare(
    "INSERT INTO users (id, username, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, username, hash(password, salt), salt, new Date().toISOString())

  return { token: openSession(id), user: { id, username } }
}

export function login(username: string, password: string): { token: string; user: User } {
  const row = db
    .prepare("SELECT id, username, pw_hash, pw_salt FROM users WHERE username = ?")
    .get(username) as UserRow | undefined
  if (!row) throw new AuthError("wrong username or password", 401)

  const got = Buffer.from(hash(password, row.pw_salt), "hex")
  const want = Buffer.from(row.pw_hash, "hex")
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new AuthError("wrong username or password", 401)
  }
  return { token: openSession(row.id), user: { id: row.id, username: row.username } }
}

function openSession(userId: string): string {
  const token = randomBytes(32).toString("hex")
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    new Date().toISOString(),
  )
  return token
}

export function userForToken(token: string | undefined): User | null {
  if (!token) return null
  const row = db
    .prepare(
      "SELECT u.id AS id, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
    )
    .get(token) as User | undefined
  return row ?? null
}

export function logout(token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token)
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n
}
