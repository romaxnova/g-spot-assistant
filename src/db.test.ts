import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compact, fileSizes, MAX_CACHED_STATEMENTS, openDatabase } from './db.js';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('one prepared statement per SQL text, reused; the least recently used goes first past the cap', () => {
  const db = openDatabase(':memory:');
  const first = db.prepare('SELECT 1 AS one');
  assert.equal(db.prepare('SELECT 1 AS one'), first, 'the same statement again');
  assert.deepEqual({ ...(first.get() as object) }, { one: 1 }, 'and it still runs');
  assert.notEqual(db.prepare('SELECT 2 AS two'), first);
  for (let i = 0; i < MAX_CACHED_STATEMENTS; i++) db.prepare(`SELECT ${i + 10}`);
  assert.notEqual(db.prepare('SELECT 1 AS one'), first, 'evicted after the cap, prepared again');
  const kept = db.prepare('SELECT 3');
  db.prepare('SELECT 4');
  assert.equal(db.prepare('SELECT 3'), kept);
  db.close();
});

test('a database file returns freed space to the system, and its write-ahead log does not keep its largest size', (t) => {
  const path = join(tempDir(t), 'c.sqlite');
  const db = openDatabase(path);
  assert.equal(Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 2, 'incremental');
  assert.equal(Number((db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit), 16 * 1024 * 1024);
  db.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)');
  const insert = db.prepare('INSERT INTO blobs (data) VALUES (?)');
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  db.exec('BEGIN');
  for (let i = 0; i < 24; i++) insert.run(chunk);
  db.exec('COMMIT');
  db.exec('DELETE FROM blobs');
  const before = fileSizes(db);
  assert.ok(before.freePages * before.pageSize > 20 * 1024 * 1024, 'deleted rows leave free pages');
  compact(db);
  const after = fileSizes(db);
  assert.equal(after.freePages, 0);
  assert.ok(after.pages * after.pageSize < 1024 * 1024, `the file shrank to ${after.pages * after.pageSize} bytes`);
  assert.equal(statSync(`${path}-wal`).size, 0, 'the write-ahead log is emptied');
  assert.ok(statSync(path).size < 1024 * 1024);
  db.close();
});

test('a file made before incremental vacuum is converted once when opened, keeping its data', (t) => {
  const path = join(tempDir(t), 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec('PRAGMA journal_mode = WAL');
  old.exec("CREATE TABLE accounts (alias TEXT PRIMARY KEY, email TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  old.prepare("INSERT INTO accounts VALUES ('me', 'me@example.com', 'x', 1, 1)").run();
  // Space left by deleted uploads, which a file without auto-vacuum keeps for good.
  old.exec('CREATE TABLE junk (data BLOB)');
  const insert = old.prepare('INSERT INTO junk VALUES (?)');
  for (let i = 0; i < 16; i++) insert.run(new Uint8Array(1024 * 1024));
  old.exec('DROP TABLE junk');
  old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(statSync(path).size > 16 * 1024 * 1024);
  assert.equal(Number((old.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 0);
  old.close();
  const db = openDatabase(path);
  assert.equal(Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 2);
  assert.equal((db.prepare('SELECT email FROM accounts').get() as { email: string }).email, 'me@example.com');
  assert.ok(statSync(path).size < 1024 * 1024, 'the freed space is given back');
  assert.ok(statSync(`${path}-wal`).size < 1024 * 1024, 'and the rewrite is not left in the log');
  db.close();
  const again = openDatabase(path);
  assert.equal(Number((again.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 2, 'no second conversion needed');
  again.close();
});
