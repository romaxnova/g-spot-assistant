import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { makePdf } from '../test-fixtures.js';
import { silentLogger } from '../log.js';
import { SqliteUploadVault, UploadStore } from '../uploads.js';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { cleanFilename, parseFormData, parseFormFiles, readableNames, uploadRouter } from './upload.js';

async function withServer(store: UploadStore, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/upload', uploadRouter(store, silentLogger));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a raw body POSTed to a link is staged once, typed by name or bytes', async () => {
  const store = new UploadStore();
  const pdf = makePdf([['hello']]);
  await withServer(store, async (base) => {
    const link = store.createLink();
    // curl --data-binary sends application/x-www-form-urlencoded: that says nothing about the file.
    const res = await fetch(`${base}/upload/${link.token}?filename=${encodeURIComponent('Счёт №5.pdf')}`, { method: 'POST', body: pdf, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 201);
    const out = (await res.json()) as Record<string, unknown>;
    assert.match(String(out['upload_id']), /^up_/);
    assert.deepEqual([out['filename'], out['mime_type'], out['size']], ['Счёт №5.pdf', 'application/pdf', pdf.length]);
    assert.match(String(out['next']), /\{"upload_id": "up_/);
    assert.deepEqual(store.get(String(out['upload_id']))?.data, pdf);

    const again = await fetch(`${base}/upload/${link.token}?filename=second.pdf`, { method: 'POST', body: pdf });
    assert.equal(again.status, 201, 'a link takes several uploads');
    const second = (await again.json()) as { upload_id: string; link_id: string };
    assert.notEqual(second.upload_id, out['upload_id']);
    assert.equal(store.list(second.link_id).length, 2);
  });
});

test('a multipart form upload (curl -F) keeps the file name and type', async () => {
  const store = new UploadStore();
  await withServer(store, async (base) => {
    const link = store.createLink();
    const form = new FormData();
    form.append('note', 'ignored');
    form.append('file', new Blob([makePdf([['x']])], { type: 'application/pdf' }), 'ticket.pdf');
    const res = await fetch(`${base}/upload/${link.token}`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const out = (await res.json()) as Record<string, unknown>;
    assert.deepEqual([out['filename'], out['mime_type']], ['ticket.pdf', 'application/pdf']);
  });
});

test('unknown links are refused before the body is read; empty and oversized uploads are refused', async () => {
  const store = new UploadStore({ maxFileBytes: 1024 });
  await withServer(store, async (base) => {
    const unknown = await fetch(`${base}/upload/not-a-real-token`, { method: 'POST', body: 'x' });
    assert.equal(unknown.status, 404);
    const empty = await fetch(`${base}/upload/${store.createLink().token}`, { method: 'POST', body: '' });
    assert.equal(empty.status, 400);
    const big = await fetch(`${base}/upload/${store.createLink().token}`, { method: 'POST', body: Buffer.alloc(200 * 1024, 1) });
    assert.equal(big.status, 413);
    assert.equal(store.totalBytes(), 0);
  });
});

test('file names lose paths and control characters', () => {
  assert.equal(cleanFilename('/mnt/user-data/uploads/scan.pdf'), 'scan.pdf');
  assert.equal(cleanFilename('C:\\\\Users\\\\x\\\\a.pdf'), 'a.pdf');
  assert.equal(cleanFilename('bad\r\nname.pdf'), 'bad name.pdf');
  assert.equal(cleanFilename('..'), undefined);
  assert.equal(cleanFilename(''), undefined);
});

test('parseFormData reads the first file field, with RFC 5987 names', () => {
  const body = Buffer.from(
    '--b0\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--b0\r\nContent-Disposition: form-data; name="file"; filename="x.bin"; filename*=UTF-8\'\'%D1%84.pdf\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n--b0--\r\n',
  );
  assert.deepEqual(parseFormData(body, 'multipart/form-data; boundary=b0'), { data: Buffer.from('%PDF'), filename: 'ф.pdf', mimeType: 'application/pdf' });
  assert.equal(parseFormData(body, 'multipart/form-data'), undefined, 'no boundary');
});

test('opening a link in a browser shows a page to pick files; an unknown link says so', async () => {
  const store = new UploadStore();
  await withServer(store, async (base) => {
    const link = store.createLink();
    const res = await fetch(`${base}/upload/${link.token}`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.match(html, /<form class="card" method="post" enctype="multipart\/form-data">/);
    assert.ok(!html.includes('<script'), 'no script: works under the strict CSP');
    assert.equal(store.hasLink(link.token), true, 'opening the page does not use the link up');
    const gone = await fetch(`${base}/upload/not-a-real-token`, { headers: { accept: 'text/html' } });
    assert.equal(gone.status, 404);
    assert.match(await gone.text(), /expired or was never valid\. Ask Claude for a new one/);
  });
});

test('a browser form with several files stages them all under the link, and file names are escaped on the page', async () => {
  const store = new UploadStore();
  await withServer(store, async (base) => {
    const link = store.createLink();
    const form = new FormData();
    form.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), 'IMG_1.jpg');
    form.append('file', new Blob([makePdf([['plan']])], { type: 'application/pdf' }), '<img src=x onerror=alert(1)>plan.pdf');
    const res = await fetch(`${base}/upload/${link.token}`, { method: 'POST', body: form, headers: { accept: 'text/html' } });
    assert.equal(res.status, 200, 'redirected to the confirmation page');
    assert.ok(res.redirected);
    const html = await res.text();
    assert.match(html, /2 files received/);
    for (const f of store.list(link.linkId)) assert.ok(html.includes(`<code>${f.id}</code>`), 'each file shows its reference');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;plan.pdf') && !html.includes('<img'), 'escaped');
    const staged = store.list(link.linkId);
    assert.deepEqual(staged.map((f) => [f.filename, f.mimeType]).sort(), [['<img src=x onerror=alert(1)>plan.pdf', 'application/pdf'], ['IMG_1.jpg', 'image/jpeg']]);
    assert.equal(store.list('ln_other').length, 0);
    assert.equal(store.hasLink(link.token), true, 'still open for more files');
    assert.match(html, /More files\?/);
  });
});

test('code gets JSON for several files; a form without a file and an oversized upload are refused, all or nothing', async () => {
  const store = new UploadStore({ maxFileBytes: 1024, maxRequestBytes: 4096, maxTotalBytes: 1500 });
  await withServer(store, async (base) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(100, 1)]), 'a.bin');
    form.append('file', new Blob([Buffer.alloc(200, 2)]), 'b.bin');
    const multi = await fetch(`${base}/upload/${store.createLink().token}`, { method: 'POST', body: form });
    assert.equal(multi.status, 201);
    const out = (await multi.json()) as { uploads: { upload_id: string; size: number }[]; link_id: string };
    assert.deepEqual(out.uploads.map((u) => u.size), [100, 200]);
    assert.match(out.link_id, /^ln_[0-9a-f]{16}$/);

    const noFile = new FormData();
    noFile.append('file', new Blob([]), '');
    const empty = await fetch(`${base}/upload/${store.createLink().token}`, { method: 'POST', body: noFile, headers: { accept: 'text/html' } });
    assert.equal(empty.status, 400);

    const tooMuch = new FormData();
    tooMuch.append('file', new Blob([Buffer.alloc(900, 3)]), 'c.bin');
    tooMuch.append('file', new Blob([Buffer.alloc(900, 4)]), 'd.bin');
    const refused = await fetch(`${base}/upload/${store.createLink().token}`, { method: 'POST', body: tooMuch });
    assert.equal(refused.status, 413, 'the staging area would overflow');
    assert.equal(store.list().length, 2, 'nothing of the refused upload was kept');
  });
});

test('a newer upload on the same link aborts the older one; an upload that started in time is accepted after expiry', () => {
  let t = 0;
  const store = new UploadStore({}, () => t);
  const link = store.createLink();
  const aborted: string[] = [];
  const first = store.reserveLink(link.token, () => aborted.push('first'));
  const second = store.reserveLink(link.token, () => aborted.push('second'));
  assert.ok(typeof first === 'number' && typeof second === 'number');
  assert.deepEqual(aborted, ['first'], 'the double tap replaces the first upload');
  assert.equal(store.consumeLinkFiles(link.token, [{ data: Buffer.from('a') }], first as number), undefined, 'the superseded upload cannot use the link');
  t += 31 * 60 * 1000; // the upload started at minute 0 and ends after the link's 30 minutes
  assert.equal(store.reserveLink(link.token, () => {}), 'gone', 'no new upload starts once the link has expired');
  const staged = store.consumeLinkFiles(link.token, [{ data: Buffer.from('b'), filename: 'b.txt' }], second as number);
  assert.equal(staged?.length, 1, 'but the one in progress finishes');
  assert.deepEqual(store.receivedThrough(link.token).map((f) => f.filename), ['b.txt'], 'and its page still shows it');
  t += 3 * 60 * 1000;
  assert.equal(store.linkState(link.token), 'gone');

  const idle = store.createLink();
  const claim = store.reserveLink(idle.token, () => {}) as number;
  store.releaseLink(idle.token, claim);
  t += 31 * 60 * 1000;
  assert.equal(store.linkState(idle.token), 'gone', 'a released link expires as usual');
});

test('staging is all or nothing: a failed save keeps nothing and leaves the link usable; too many files are refused', () => {
  const store = new UploadStore({ maxFilesPerLink: 3 });
  const vault = (store as unknown as { vault: { save: (f: unknown) => void; saveAll: (f: unknown[]) => void } }).vault;
  const original = vault.saveAll.bind(vault);
  vault.saveAll = () => {
    throw new Error('disk full');
  };
  const link = store.createLink();
  assert.throws(() => store.consumeLinkFiles(link.token, [{ data: Buffer.from('a') }, { data: Buffer.from('b') }]), /disk full/);
  assert.equal(store.list().length, 0);
  assert.equal(store.linkState(link.token), 'open', 'the person can try again');
  vault.saveAll = original;
  assert.throws(() => store.consumeLinkFiles(link.token, [1, 2, 3, 4].map((n) => ({ data: Buffer.from([n]) }))), /One link takes at most 3 files/);
  assert.equal(store.consumeLinkFiles(link.token, [{ data: Buffer.from('a') }, { data: Buffer.from('b') }])?.length, 2);
  assert.throws(() => store.consumeLinkFiles(link.token, [{ data: Buffer.from('c') }, { data: Buffer.from('d') }]), /at most 3 files \(2 already came through it\)/);
});

test('the SQLite vault saves a batch in one transaction', () => {
  const db = openDatabase(':memory:');
  const vault = new SqliteUploadVault(db, [randomBytes(32)]);
  const file = (id: string) => ({ id, data: Buffer.from(id), createdAt: 1, expiresAt: 10 });
  vault.saveAll([file('up_a'), file('up_b')]);
  assert.equal(vault.list(0).length, 2);
  const broken = { ...file('up_c'), data: undefined as unknown as Buffer };
  assert.throws(() => vault.saveAll([file('up_d'), broken]));
  assert.deepEqual(vault.list(0).map((f) => f.id).sort(), ['up_a', 'up_b'], 'the batch was rolled back');
});

test('file names keep quotes browsers encode as %22; after an upload the page lists what arrived and takes more', async () => {
  const body = Buffer.from(
    '--b0\r\nContent-Disposition: form-data; name="file"; filename="a %22quoted%22 name.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n' +
      '--b0\r\nContent-Disposition: form-data; name="file"; filename="old \\"style\\".pdf"\r\n\r\n%PDF\r\n--b0--\r\n',
  );
  assert.deepEqual(
    parseFormFiles(body, 'multipart/form-data; boundary=b0').map((f) => f.filename),
    ['a "quoted" name.jpg', 'old "style".pdf'],
  );
  const store = new UploadStore();
  await withServer(store, async (base) => {
    const link = store.createLink();
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4')]), 'plan.pdf');
    const first = await fetch(`${base}/upload/${link.token}`, { method: 'POST', body: form, headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(first.status, 303, 'post/redirect/get: reloading the result is a GET, never a resend');
    const shown = await (await fetch(`${base}/upload/${link.token}`, { headers: { accept: 'text/html' } })).text();
    assert.match(shown, /File received/);
    assert.match(shown, /<strong>plan\.pdf<\/strong>/);
    assert.match(shown, /Reference: <code>up_/, 'the reference sits on its own line, not in a column cut off on a phone');
    const photos = new FormData();
    photos.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9])]), 'IMG_2.jpg');
    const later = await fetch(`${base}/upload/${link.token}`, { method: 'POST', body: photos, headers: { accept: 'text/html' } });
    assert.match(await later.text(), /2 files received/);
    assert.equal(store.list().length, 2);
  });
});

test('too many requests get a readable page', async () => {
  const store = new UploadStore();
  await withServer(store, async (base) => {
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) last = await fetch(`${base}/upload/nope-${i}`, { headers: { accept: 'text/html' } });
    assert.equal(last!.status, 429);
    assert.match(await last!.text(), /Too many attempts from this connection/);
  });
});

test('photos a phone named meaninglessly get readable names, numbered across the uploads of a link', async () => {
  const jpeg = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])], { type: 'image/jpeg' });
  const store = new UploadStore();
  await withServer(store, async (base) => {
    const link = store.createLink();
    const form = new FormData();
    form.append('file', jpeg(), '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D.jpeg');
    form.append('file', jpeg(), 'image.jpg');
    form.append('file', jpeg(), 'IMG_1234.jpg');
    form.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'D2E3F4A5-B6C7-4D8E-9F0A-1B2C3D4E5F6A.pdf');
    await fetch(`${base}/upload/${link.token}`, { method: 'POST', body: form, headers: { accept: 'text/html' } });
    const more = new FormData();
    more.append('file', jpeg(), 'FFFFFFFF-4E5F-4A6B-8C7D-9E0F1A2B3C4D.JPG');
    more.append('file', new Blob([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/quicktime' }), '11111111-2222-4333-8444-555555555555.MOV');
    const page = await (await fetch(`${base}/upload/${link.token}`, { method: 'POST', body: more, headers: { accept: 'text/html' } })).text();
    const names = store.list(link.linkId).map((f) => f.filename).sort();
    assert.deepEqual(names, ['D2E3F4A5-B6C7-4D8E-9F0A-1B2C3D4E5F6A.pdf', 'IMG_1234.jpg', 'photo-1.jpeg', 'photo-2.jpg', 'photo-3.jpg', 'video-1.mov']);
    assert.match(page, /photo-3\.jpg/, 'the page shows the name the file will carry');
  });
  assert.deepEqual(readableNames([{ filename: 'image.png', mimeType: 'image/png' }], ['Photo-1.png']), ['photo-2.png'], 'a name already on the link is not reused');
  assert.deepEqual(readableNames([{ filename: undefined, mimeType: 'image/png' }, { filename: 'image', mimeType: 'image/heic' }], []), [undefined, 'photo-1.heic']);
});
