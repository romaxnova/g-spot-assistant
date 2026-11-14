import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db.js';
import { sha256Hex, SqliteUploadVault, UploadError, UploadStore } from './uploads.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('upload links take several uploads until they expire, and are kept only as hashes', () => {
  const c = clock();
  const store = new UploadStore({}, c.now);
  const link = store.createLink('scan.pdf');
  assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.hasLink(link.token), true);
  const staged = store.consumeLink(link.token, Buffer.from('%PDF-1.4'), {});
  assert.ok(staged);
  assert.equal(staged.filename, 'scan.pdf', 'the name given with the link');
  const more = store.consumeLink(link.token, Buffer.from('JPEG'), { filename: 'IMG_1.jpg' });
  assert.ok(more, 'a second upload (photos after a PDF) is accepted');
  assert.deepEqual(store.receivedThrough(link.token).map((f) => f.filename), ['scan.pdf', 'IMG_1.jpg']);
  assert.deepEqual(store.list(link.linkId).map((f) => f.filename).sort(), ['IMG_1.jpg', 'scan.pdf']);
  assert.ok(!JSON.stringify([...(store as unknown as { links: Map<string, unknown> }).links.keys()]).includes(link.token));

  const late = store.createLink();
  c.advance(29 * 60 * 1000);
  assert.equal(store.hasLink(late.token), true, 'a person gets 30 minutes to open it and pick files');
  c.advance(60 * 1000);
  assert.equal(store.hasLink(late.token), false);
  assert.equal(store.consumeLink(late.token, Buffer.from('x'), {}), undefined);
});

test('staged files expire 24 hours after their last change and can be read any number of times', () => {
  const c = clock();
  const store = new UploadStore({}, c.now);
  const file = store.put(Buffer.from('abc'), { filename: 'a.txt' });
  assert.match(file.id, /^up_[A-Za-z0-9_-]{22}$/);
  c.advance(23 * 3600 * 1000);
  store.append(file.id, 3, Buffer.from('def'));
  c.advance(23 * 3600 * 1000);
  for (let i = 0; i < 6; i++) assert.equal(store.get(file.id)?.data.toString(), 'abcdef', 'appending renews the 24 hours');
  c.advance(2 * 3600 * 1000);
  assert.equal(store.get(file.id), undefined);
});

test('in the database, staged files survive a restart, are encrypted at rest and open after a key rotation', () => {
  const c = clock();
  const db = openDatabase(':memory:');
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const secret = Buffer.from('%PDF-1.7 passport scan of Jane Doe');
  const before = new UploadStore({}, c.now, new SqliteUploadVault(db, [oldKey]));
  const file = before.put(secret, { filename: 'Jane Doe passport.pdf', mimeType: 'application/pdf' });
  before.append(file.id, secret.length, Buffer.from(' page 2'));

  const rows = db.prepare('SELECT * FROM staged_files').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  const raw = Buffer.concat(Object.values(rows[0]!).map((v) => (v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v)))));
  assert.ok(!raw.includes('passport') && !raw.includes('Jane') && !raw.includes('%PDF'), 'neither the name nor the bytes are stored in clear');
  assert.equal(rows[0]!['size'], secret.length + 7);

  const viaLink = before.consumeLinkFiles(before.createLink().token, [{ data: Buffer.from('jpeg'), filename: 'IMG_1.jpg', mimeType: 'image/jpeg' }])!;
  assert.deepEqual(before.list(viaLink[0]!.linkId).map((f) => [f.filename, f.size]), [['IMG_1.jpg', 4]], 'listing decrypts names and keeps the link');
  before.delete(viaLink[0]!.id);

  // A new process (a deploy) with the key rotated: the previous key still opens the file.
  const after = new UploadStore({}, c.now, new SqliteUploadVault(db, [newKey, oldKey]));
  const again = after.get(file.id);
  assert.equal(again?.data.toString(), `${secret.toString()} page 2`);
  assert.equal(again?.filename, 'Jane Doe passport.pdf');
  assert.equal(again?.mimeType, 'application/pdf');
  assert.equal(after.totalBytes(), secret.length + 7);

  // A blob moved to another row does not pass for that row's file: the ciphertext is bound to its id and field.
  const other = after.put(Buffer.from('other file'), { filename: 'other.txt' });
  const stolen = (db.prepare('SELECT data_enc FROM staged_files WHERE id = ?').get(file.id) as { data_enc: Uint8Array }).data_enc;
  db.prepare('UPDATE staged_files SET data_enc = ? WHERE id = ?').run(stolen, other.id);
  assert.equal(after.get(other.id), undefined, 'refused, and the tampered row is dropped');
  assert.equal(after.get(file.id)?.filename, 'Jane Doe passport.pdf');

  c.advance(24 * 3600 * 1000);
  assert.equal(after.get(file.id), undefined);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM staged_files').get() as { n: number }).n, 0, 'expired rows are deleted');
});

test('files no configured key can open are dropped at start, so they stop counting against the quota', () => {
  const db = openDatabase(':memory:');
  const oldKey = randomBytes(32);
  const before = new UploadStore({ maxTotalBytes: 10 }, Date.now, new SqliteUploadVault(db, [oldKey]));
  const file = before.put(Buffer.from('12345678'));
  // Rotated without TOKEN_ENCRYPTION_KEY_PREVIOUS: the file is unreadable, and must not fill the staging area.
  const after = new UploadStore({ maxTotalBytes: 10 }, Date.now, new SqliteUploadVault(db, [randomBytes(32)]));
  assert.equal(after.totalBytes(), 0);
  assert.equal(after.get(file.id), undefined);
  assert.ok(after.put(Buffer.from('12345678')));
});

test('appending checks the offset, and sizes are capped per file and in total', () => {
  const store = new UploadStore({ maxFileBytes: 10, maxTotalBytes: 16 });
  const file = store.put(Buffer.from('12345'));
  assert.throws(() => store.append(file.id, 0, Buffer.from('67')), (e: Error) => e instanceof UploadError && /offset 0 does not match the 5 bytes already staged/.test(e.message));
  assert.throws(() => store.append(file.id, 5, Buffer.from('6789012')), /larger than/);
  store.append(file.id, 5, Buffer.from('67890'));
  assert.throws(() => store.put(Buffer.from('1234567')), /staging area would be over its/);
  assert.throws(() => store.put(Buffer.from('12345678901')), /larger than/);
  assert.throws(() => store.append('up_missing', 0, Buffer.from('x')), /No staged file "up_missing"/);
  assert.equal(store.totalBytes(), 10);
});

test('the number of open links is bounded', () => {
  const store = new UploadStore({ maxLinks: 2 });
  store.createLink();
  store.createLink();
  assert.throws(() => store.createLink(), /Too many upload links/);
});

test('sha256Hex matches sha256sum', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('an open link survives a restart: same token, files so far, name hint; the database holds neither token nor name', () => {
  const c = clock();
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const before = new UploadStore({}, c.now, new SqliteUploadVault(db, [key]));
  const link = before.createLink('scan-confidentiel.pdf');
  const other = before.createLink();
  assert.ok(before.consumeLinkFiles(other.token, [{ data: Buffer.from('%PDF-1.4 one'), filename: 'one.pdf' }]));
  assert.ok(before.consumeLinkFiles(other.token, [{ data: Buffer.from('%PDF-1.4 two'), filename: 'two.pdf' }]));

  const rows = db.prepare('SELECT token_hash, meta_enc FROM upload_links').all() as { token_hash: string; meta_enc: Uint8Array | null }[];
  assert.equal(rows.length, 2);
  const dump = JSON.stringify(rows.map((r) => [r.token_hash, Buffer.from(r.meta_enc ?? []).toString('latin1')]));
  for (const secret of [link.token, other.token, 'scan-confidentiel']) assert.ok(!dump.includes(secret), 'only hashes and ciphertext are stored');

  c.advance(60_000);
  const after = new UploadStore({}, c.now, new SqliteUploadVault(db, [key])); // a deploy
  assert.equal(after.linkState(link.token), 'open');
  assert.deepEqual(after.receivedThrough(other.token).map((f) => f.filename), ['one.pdf', 'two.pdf'], 'oldest first, as the page lists them');
  const staged = after.consumeLinkFiles(link.token, [{ data: Buffer.from('%PDF-1.4 scan') }]);
  assert.equal(staged?.[0]?.filename, 'scan-confidentiel.pdf', 'the name hint survived');
  assert.equal(staged?.[0]?.linkId, link.linkId);
  assert.equal(after.consumeLinkFiles(other.token, [{ data: Buffer.from('%PDF-1.4 three'), filename: 'three.pdf' }])?.length, 1, 'more uploads still count against the same link');
  assert.equal(after.receivedThrough(other.token).length, 3);

  // A key the link's name was not sealed with: the link still works, only its name hint is lost.
  const rekeyed = new UploadStore({}, c.now, new SqliteUploadVault(db, [randomBytes(32)]));
  assert.equal(rekeyed.linkState(link.token), 'open');

  c.advance(31 * 60_000);
  after.sweep();
  assert.equal(after.linkState(link.token), 'gone');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM upload_links').get() as { n: number }).n, 0, 'expired links leave the database');
  assert.equal(new UploadStore({}, c.now, new SqliteUploadVault(db, [key])).linkState(link.token), 'gone');
});

test('a link whose upload finished late is kept two more minutes, across a restart too', () => {
  const c = clock();
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const store = new UploadStore({}, c.now, new SqliteUploadVault(db, [key]));
  const link = store.createLink();
  const claim = store.reserveLink(link.token, () => {});
  assert.equal(typeof claim, 'number');
  c.advance(30 * 60_000 + 1000); // the upload ends a second after the link expired
  assert.ok(store.consumeLinkFiles(link.token, [{ data: Buffer.from('x'), filename: 'x.txt' }], claim as number));
  const restarted = new UploadStore({}, c.now, new SqliteUploadVault(db, [key]));
  assert.equal(restarted.linkState(link.token), 'open', 'the confirmation page still shows after a deploy');
  assert.deepEqual(restarted.receivedThrough(link.token).map((f) => f.filename), ['x.txt']);
});
