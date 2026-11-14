/**
 * SQLite storage using Node's built-in node:sqlite (no native dependency).
 * One file on the Railway volume holds accounts, OAuth state and sessions.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  alias TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  google_sub TEXT,
  label TEXT,
  refresh_token_enc TEXT NOT NULL,
  granted_scopes TEXT NOT NULL DEFAULT '',
  requested_services TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  status_detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_refresh_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS authorization_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scope TEXT NOT NULL DEFAULT '',
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  resource TEXT,
  subject_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  subject_email TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS link_requests (
  id_hash TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  services TEXT NOT NULL,
  label TEXT,
  expected_email TEXT,
  mode TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS google_states (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Folds the write-ahead log back into the main file (cheap; call periodically and before shutdown). */
export function checkpoint(db: Db, mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): void {
  db.exec(`PRAGMA wal_checkpoint(${mode})`);
}

/** Unix time in seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Delete expired rows from every short-lived table. Returns the number of rows removed. */
export function cleanupExpired(db: Db, at: number = now()): number {
  let removed = 0;
  const run = (sql: string) => {
    removed += Number(db.prepare(sql).run(at).changes);
  };
  run('DELETE FROM authorization_requests WHERE expires_at < ?');
  run('DELETE FROM authorization_codes WHERE expires_at < ?');
  run('DELETE FROM google_states WHERE expires_at < ?');
  run('DELETE FROM link_requests WHERE expires_at < ?');
  run('DELETE FROM sessions WHERE expires_at < ?');
  // Keep revoked/rotated tokens for a day so refresh-token reuse can still be detected, then drop them.
  run('DELETE FROM tokens WHERE expires_at < ? - 86400');
  return removed;
}
