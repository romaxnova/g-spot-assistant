import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLogger } from '../../log.js';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall, type TestAccountSpec, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { GOOGLE_MIME } from './drive-files.js';
import { driveSave, parsePath, savedName } from './drive-save.js';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const GMAIL = '/gmail/v1/users/me';
const FOLDER = GOOGLE_MIME.folder;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);
const md5 = (data: Buffer | string) => createHash('md5').update(data).digest('hex');

interface Node {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  md5Checksum?: string;
  size?: string;
  createdTime?: string;
  webViewLink?: string;
  description?: string;
  trashed?: boolean;
}

interface Upload {
  metadata: Record<string, unknown>;
  mediaType: string;
  media: string;
}

/**
 * A Drive that keeps what is created in it: folder lookups and listings filter
 * by the q expression, folders/copies/uploads add nodes, alt=media serves
 * `media`, drives.list answers from `drives` by name. Uploads named in
 * `failUploads` answer 403.
 */
function fakeDrive(initial: Node[], opts: { media?: Record<string, Buffer>; failUploads?: string[]; drives?: { id: string; name: string }[] } = {}) {
  const nodes = new Map(initial.map((n) => [n.id, { ...n }]));
  const uploads: Upload[] = [];
  let next = 1;
  const add = (n: Omit<Node, 'id'>): Node => {
    const id = `new${next++}`;
    const node = { id, webViewLink: `https://drive.google.com/file/d/${id}/view`, ...n };
    nodes.set(id, node);
    return node;
  };
  const unquote = (s: string | undefined) => s?.replace(/\\(.)/g, '$1');
  const google: FakeGoogle = (c) => {
    const p = c.url.pathname;
    if (c.method === 'POST' && c.url.origin + p === `${UPLOAD}/files`) {
      const m = /^--([0-9a-f]+)\r\nContent-Type: application\/json; charset=UTF-8\r\n\r\n(.*?)\r\n--\1\r\nContent-Type: ([^\r]+)\r\n\r\n([\s\S]*)\r\n--\1--\r\n$/s.exec(c.body ?? '');
      if (!m) return { status: 400, json: { error: { message: 'bad multipart' } } };
      const metadata = JSON.parse(m[2]!) as Record<string, unknown>;
      uploads.push({ metadata, mediaType: m[3]!, media: m[4]! });
      if (opts.failUploads?.includes(String(metadata['name']))) return { status: 403, json: { error: { message: 'The user has exceeded their Drive storage quota', errors: [{ reason: 'storageQuotaExceeded' }] } } };
      const node = add({ name: String(metadata['name']), mimeType: String(metadata['mimeType'] ?? m[3]!.split(';')[0]), parents: metadata['parents'] as string[], description: metadata['description'] as string | undefined, size: String(Buffer.byteLength(m[4]!)) });
      return { json: node };
    }
    if (c.url.origin + p === `${BASE}/files` && c.method === 'GET') {
      const q = c.url.searchParams.get('q') ?? '';
      const parent = unquote(/'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1]);
      const name = unquote(/name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]);
      const foldersOnly = q.includes(`mimeType = '${FOLDER}'`);
      const matches = [...nodes.values()].filter(
        (n) => !n.trashed && (!parent || n.parents?.includes(parent)) && (name === undefined || n.name === name) && (!foldersOnly || n.mimeType === FOLDER),
      );
      // Like Drive, a page may hold fewer files than asked for.
      const start = Number(c.url.searchParams.get('pageToken') ?? 0);
      const size = Math.min(500, Number(c.url.searchParams.get('pageSize') ?? 100));
      return { json: { files: matches.slice(start, start + size), nextPageToken: start + size < matches.length ? String(start + size) : undefined } };
    }
    if (c.method === 'GET' && p === '/drive/v3/drives') {
      const name = unquote(/name = '((?:[^'\\]|\\.)*)'/.exec(c.url.searchParams.get('q') ?? '')?.[1]);
      return { json: { drives: (opts.drives ?? []).filter((d) => d.name === name) } };
    }
    if (c.method === 'POST' && c.url.origin + p === `${BASE}/files`) {
      const body = c.json as Node;
      return { json: add({ name: body.name, mimeType: body.mimeType, parents: body.parents }) };
    }
    const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(p);
    if (copy && c.method === 'POST') {
      const source = nodes.get(copy[1]!);
      if (!source) return undefined;
      const body = c.json as Partial<Node>;
      const { id: _id, webViewLink: _link, ...rest } = source;
      return { json: add({ ...rest, name: body.name ?? source.name, parents: body.parents, description: body.description }) };
    }
    const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (file && c.method === 'GET') {
      if (c.url.searchParams.get('alt') === 'media') {
        const data = opts.media?.[file[1]!];
        return data ? { body: data } : undefined;
      }
      const node = nodes.get(file[1]!);
      return node ? { json: node } : undefined;
    }
    if (p === `${GMAIL}/messages/m1`) {
      return { json: { id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [{ partId: '1', mimeType: 'application/pdf', filename: 'devis.pdf', body: { attachmentId: 'A1', size: 9 } }] } } };
    }
    if (p === `${GMAIL}/messages/m1/attachments/A1`) return { json: { size: 9, data: Buffer.from('%PDF-1.4\n').toString('base64url') } };
    return undefined;
  };
  return { google, nodes, uploads };
}

const EXISTING = Buffer.from('%PDF-1.4 old contract');

/** My Drive/Appartements/Lisbonne, holding one contract. */
const tree = (): Node[] => [
  { id: 'appts', name: 'Appartements', mimeType: FOLDER, parents: ['root'], createdTime: '2020-01-01T00:00:00Z' },
  { id: 'bgd', name: 'Lisbonne', mimeType: FOLDER, parents: ['appts'], createdTime: '2020-01-02T00:00:00Z', webViewLink: 'https://drive.google.com/drive/folders/bgd' },
  { id: 'old', name: 'Ugovor 2014.pdf', mimeType: 'application/pdf', parents: ['bgd'], md5Checksum: md5(EXISTING), size: String(EXISTING.length), webViewLink: 'https://drive.google.com/file/d/old/view' },
];

function setup(nodes: Node[] = tree(), opts: Parameters<typeof fakeDrive>[1] = {}, accounts?: TestAccountSpec[]) {
  const drive = fakeDrive(nodes, opts);
  const ctx = createTestContext({ google: drive.google, accounts });
  return { ctx, ...drive };
}

function save(ctx: TestContext, args: Record<string, unknown>) {
  return runTool(driveSave, { account: 'me', ...args }, ctx);
}

const isLookup = (c: RecordedCall) => c.method === 'GET' && c.url.pathname === '/drive/v3/files' && (c.url.searchParams.get('q') ?? '').startsWith('name = ');
const isListing = (c: RecordedCall) => c.method === 'GET' && c.url.pathname === '/drive/v3/files' && (c.url.searchParams.get('q') ?? '').startsWith("'");
const isFolderCreate = (c: RecordedCall) => c.method === 'POST' && c.url.origin + c.url.pathname === `${BASE}/files`;
const isUpload = (c: RecordedCall) => c.method === 'POST' && c.url.origin + c.url.pathname === `${UPLOAD}/files`;

/* ---------- Pure helpers ---------- */

test('parsePath trims, drops empty segments and a leading My Drive, and refuses incomplete paths', () => {
  assert.deepEqual(parsePath(' My Drive / Appartements//Lisbonne/ '), { segments: ['Appartements', 'Lisbonne'], written: [' Appartements', 'Lisbonne'], myDrive: true });
  assert.deepEqual(parsePath('/Appartements'), { segments: ['Appartements'], written: ['Appartements'], myDrive: false });
  assert.deepEqual(parsePath(''), { segments: [], written: [], myDrive: false });
  assert.deepEqual(parsePath('my drive'), { segments: [], written: [], myDrive: true });
  assert.throws(() => parsePath('…/Lisbonne'), /not a complete path/);
  assert.throws(() => parsePath('Appartements/../x'), /not a complete path/);
  assert.throws(() => parsePath(' shared drive/Contracts'), /shared drive whose name could not be read/);
});

test('savedName keeps a known extension and adds the type\'s one otherwise', () => {
  assert.equal(savedName('Ugovor o kupoprodaji – Ulica Primer 12 st. 3 – 2015', 'IMG_1234.jpg', 'image/jpeg'), 'Ugovor o kupoprodaji – Ulica Primer 12 st. 3 – 2015.jpg');
  assert.equal(savedName('Contrat.pdf', 'scan.pdf', 'application/pdf'), 'Contrat.pdf');
  assert.equal(savedName('Contrat v1.2', 'scan.pdf', 'application/pdf'), 'Contrat v1.2.pdf');
  assert.equal(savedName(undefined, 'IMG_1234.HEIC', 'image/heic'), 'IMG_1234.HEIC');
  assert.equal(savedName(undefined, 'scan', 'application/pdf'), 'scan.pdf');
  assert.equal(savedName('Plan', 'plan.dng', 'image/x-adobe-dng'), 'Plan.dng', 'an unknown type keeps the source\'s extension');
  assert.equal(savedName('  ', 'x.bin', 'application/octet-stream'), 'x.bin');
});

/* ---------- Folder ---------- */

test('drive_save walks an existing path and uploads a chat file under a descriptive name with its description', async () => {
  const { ctx, uploads } = setup();
  const staged = ctx.uploads.put(JPEG, { filename: 'IMG_1234.jpg' });
  const out = resultJson(
    await save(ctx, {
      folder: 'My Drive/Appartements//Lisbonne/',
      files: [{ upload_id: staged.id, name: 'Ugovor o kupoprodaji – Ulica Primer 12 st. 3 – 2015', description: 'Purchase agreement, flat 3, 2015' }],
    }),
  );
  const lookups = apiCalls(ctx).filter(isLookup);
  assert.deepEqual(
    lookups.map((c) => c.url.searchParams.get('q')),
    [`name = 'Appartements' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`, `name = 'Lisbonne' and mimeType = '${FOLDER}' and 'appts' in parents and trashed = false`],
  );
  assert.equal(lookups[0]!.url.searchParams.get('fields'), 'files(id,name,createdTime,webViewLink)');
  assert.equal(lookups[0]!.url.searchParams.get('supportsAllDrives'), 'true');
  const listing = apiCalls(ctx).filter(isListing);
  assert.equal(listing.length, 1, 'the folder is listed once for duplicates');
  assert.equal(listing[0]!.url.searchParams.get('q'), "'bgd' in parents and trashed = false");
  assert.equal(listing[0]!.url.searchParams.get('fields'), 'nextPageToken,files(id,name,mimeType,md5Checksum,size,webViewLink)');
  assert.equal(apiCalls(ctx).filter(isFolderCreate).length, 0);
  assert.deepEqual(uploads[0]!.metadata, { name: 'Ugovor o kupoprodaji – Ulica Primer 12 st. 3 – 2015.jpg', parents: ['bgd'], description: 'Purchase agreement, flat 3, 2015' });
  assert.equal(uploads[0]!.mediaType, 'image/jpeg');
  assert.deepEqual(out['folder'], { id: 'bgd', path: 'My Drive/Appartements/Lisbonne', web_view_link: 'https://drive.google.com/drive/folders/bgd' });
  assert.deepEqual(out['files'], [
    { source: `upload:${staged.id}`, name: 'Ugovor o kupoprodaji – Ulica Primer 12 st. 3 – 2015.jpg', id: 'new1', web_view_link: 'https://drive.google.com/file/d/new1/view', size: Buffer.byteLength(JPEG.toString('utf8')), saved: true },
  ]);
  assert.match(String(out['note']), /drive_search.*text inside PDFs and images/);
});

test('drive_save takes the oldest of several folders with the same name and says so', async () => {
  const nodes = [
    ...tree(),
    { id: 'c-new', name: 'Contrats', mimeType: FOLDER, parents: ['bgd'], createdTime: '2024-05-01T00:00:00Z' },
    { id: 'c-old', name: 'Contrats', mimeType: FOLDER, parents: ['bgd'], createdTime: '2019-05-01T00:00:00Z', webViewLink: 'https://drive.google.com/drive/folders/c-old' },
  ];
  const { ctx, uploads } = setup(nodes);
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });
  const out = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne/Contrats', files: [{ upload_id: staged.id }] }));
  assert.deepEqual(out['folder'], { id: 'c-old', path: 'My Drive/Appartements/Lisbonne/Contrats', web_view_link: 'https://drive.google.com/drive/folders/c-old', ambiguous: true });
  assert.deepEqual(uploads[0]!.metadata['parents'], ['c-old']);
  assert.match(String(out['note']), /the oldest was used/);
});

test('drive_save creates the missing folders of a path, without looking inside the ones it created', async () => {
  const { ctx, uploads } = setup();
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });
  const out = resultJson(await save(ctx, { folder: "Appartements/Lisbonne/Partner's papers/Scans", files: [{ upload_id: staged.id }] }));
  const lookups = apiCalls(ctx).filter(isLookup).map((c) => c.url.searchParams.get('q'));
  assert.deepEqual(
    lookups.slice(2),
    [
      `name = 'Partner\\'s papers' and mimeType = '${FOLDER}' and 'bgd' in parents and trashed = false`,
      `name = 'Partner\\'s papers/Scans' and mimeType = '${FOLDER}' and 'bgd' in parents and trashed = false`,
    ],
    'a missing name is also tried with the next one (a folder name may hold "/"); nothing is looked up below a folder created by this call',
  );
  assert.equal(apiCalls(ctx).some((c) => c.url.pathname === '/drive/v3/drives'), false, 'only a missing first folder may be a shared drive');
  const creates = apiCalls(ctx).filter(isFolderCreate);
  assert.deepEqual(
    creates.map((c) => c.json),
    [
      { name: "Partner's papers", parents: ['bgd'], mimeType: FOLDER },
      { name: 'Scans', parents: ['new1'], mimeType: FOLDER },
    ],
  );
  assert.equal(creates[0]!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(apiCalls(ctx).filter(isListing).length, 0, 'a new folder has no duplicates to look for');
  assert.deepEqual(uploads[0]!.metadata['parents'], ['new2']);
  assert.deepEqual(out['folder'], { id: 'new2', path: "My Drive/Appartements/Lisbonne/Partner's papers/Scans", web_view_link: 'https://drive.google.com/file/d/new2/view', created: ["Partner's papers", 'Scans'] });
});

test('drive_save with create_folders false names the first missing folder and saves nothing', async () => {
  const { ctx, uploads } = setup();
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });
  const res = await save(ctx, { folder: 'Appartements/Lisbonne/Contrats 2015/Scans', create_folders: false, files: [{ upload_id: staged.id }] });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /no folder "Contrats 2015" in My Drive\/Appartements\/Lisbonne\. Set create_folders/);
  assert.match(resultText(res), /give a folder's id, or its path followed by its name/, "a folder's path is where it is, not the folder");
  assert.equal(apiCalls(ctx).filter(isFolderCreate).length, 0);
  assert.equal(uploads.length, 0);
});

test('drive_save takes a folder by id or URL and shows its path; refuses files, trashed and unknown folders', async () => {
  const LONG = '1AbCdEfGhIjKlMnOpQrStUv_0123456789';
  const nodes = [...tree(), { id: LONG, name: 'Scans', mimeType: FOLDER, parents: ['bgd'] }, { id: 'binned', name: 'Old', mimeType: FOLDER, parents: ['root'], trashed: true }];
  const { ctx, uploads } = setup(nodes);
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });

  let out = resultJson(await save(ctx, { folder: LONG, files: [{ upload_id: staged.id }] }));
  assert.deepEqual(out['folder'], { id: LONG, path: 'My Drive/Appartements/Lisbonne/Scans' });
  assert.deepEqual(uploads.at(-1)!.metadata['parents'], [LONG]);
  assert.equal(apiCalls(ctx).filter(isLookup).length, 0, 'an id is not looked up by name');

  out = resultJson(await save(ctx, { folder: 'https://drive.google.com/drive/folders/bgd?usp=sharing', files: [{ upload_id: staged.id }] }));
  assert.equal((out['folder'] as Record<string, unknown>)['path'], 'My Drive/Appartements/Lisbonne');
  assert.equal((out['files'] as Record<string, unknown>[])[0]!['duplicate'], undefined);

  out = resultJson(await save(ctx, { folder: 'root', files: [{ upload_id: staged.id }] }));
  assert.deepEqual(out['folder'], { id: 'root', path: 'My Drive' });
  assert.deepEqual(uploads.at(-1)!.metadata['parents'], ['root']);

  const before = uploads.length;
  const notFolder = await save(ctx, { folder: 'https://drive.google.com/file/d/old/view', files: [{ upload_id: staged.id }] });
  assert.match(resultText(notFolder), /"Ugovor 2014\.pdf" is a pdf, not a folder/);
  const trashed = await save(ctx, { folder: 'https://drive.google.com/drive/folders/binned', files: [{ upload_id: staged.id }] });
  assert.match(resultText(trashed), /is in the trash/);
  const unknown = await save(ctx, { folder: 'Contracts2015abcdefgh', files: [{ upload_id: staged.id }] });
  assert.match(resultText(unknown), /No folder "Contracts2015abcdefgh".*write it as a path, e\.g\. "My Drive\/Contracts2015abcdefgh"/);
  assert.equal(uploads.length, before);
});

/* ---------- Duplicates ---------- */

test('drive_save skips files whose identical copy is in the folder, including one saved earlier in the same call', async () => {
  const { ctx, uploads } = setup();
  const same = ctx.uploads.put(EXISTING, { filename: 'contract.pdf' });
  const fresh = ctx.uploads.put(Buffer.from('%PDF-1.4 new contract'), { filename: 'new.pdf' });
  const again = ctx.uploads.put(Buffer.from('%PDF-1.4 new contract'), { filename: 'new (copy).pdf' });
  const out = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', files: [{ upload_id: same.id }, { upload_id: fresh.id }, { upload_id: again.id }] }));
  assert.deepEqual(out['files'], [
    { source: `upload:${same.id}`, name: 'Ugovor 2014.pdf', id: 'old', web_view_link: 'https://drive.google.com/file/d/old/view', size: EXISTING.length, duplicate: true },
    { source: `upload:${fresh.id}`, name: 'new.pdf', id: 'new1', web_view_link: 'https://drive.google.com/file/d/new1/view', size: 21, saved: true },
    { source: `upload:${again.id}`, name: 'new.pdf', id: 'new1', web_view_link: 'https://drive.google.com/file/d/new1/view', size: 21, duplicate: true },
  ]);
  assert.equal(uploads.length, 1);
  assert.equal(apiCalls(ctx).filter(isListing).length, 1);
  assert.match(String(out['note']), /duplicate: the folder already held an identical file/);

  const off = setup();
  const a = off.ctx.uploads.put(EXISTING, { filename: 'contract.pdf' });
  const rows = resultJson(await save(off.ctx, { folder: 'Appartements/Lisbonne', skip_duplicates: false, files: [{ upload_id: a.id }, { upload_id: a.id }] }))['files'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => r['saved']), [true, true]);
  assert.equal(off.uploads.length, 2);
  assert.equal(apiCalls(off.ctx).filter(isListing).length, 0, 'no listing when duplicates are not skipped');
});

test('the duplicate check pages through the folder listing', async () => {
  const many: Node[] = Array.from({ length: 1200 }, (_, i) => ({ id: `f${i}`, name: `f${i}.pdf`, mimeType: 'application/pdf', parents: ['bgd'], md5Checksum: md5(`file ${i}`) }));
  const { ctx, uploads } = setup([...tree(), ...many]);
  const late = ctx.uploads.put(Buffer.from('file 600'), { filename: 'x.pdf' });
  const beyond = ctx.uploads.put(Buffer.from('file 1100'), { filename: 'y.pdf' });
  const rows = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', files: [{ upload_id: late.id }, { upload_id: beyond.id }] }))['files'] as Record<string, unknown>[];
  assert.equal(rows[0]!['duplicate'], true, 'found on the second page');
  assert.equal(rows[1]!['saved'], true, 'past the first 1000 children nothing is compared');
  const pages = apiCalls(ctx).filter(isListing);
  assert.deepEqual(pages.map((c) => c.url.searchParams.get('pageSize')), ['1000', '500']);
  assert.equal(uploads.length, 1);
});

/* ---------- Sources ---------- */

test('a link_id saves every file uploaded through the link, numbering a given name', async () => {
  const { ctx, uploads } = setup();
  const link = ctx.uploads.createLink();
  ctx.uploads.consumeLinkFiles(link.token, [
    { data: JPEG, filename: 'IMG_0001.jpg' },
    { data: Buffer.from('%PDF-1.4 page 2'), filename: 'page2.pdf' },
  ]);
  const order = ctx.uploads.list(link.linkId).sort((a, b) => a.createdAt - b.createdAt);
  const out = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', files: [{ upload_id: link.linkId, name: 'Ugovor 2015.jpg', description: 'Contract pages' }] }));
  const rows = out['files'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => r['source']), order.map((f) => `upload:${f.id}`));
  const ext = (f: { filename?: string }) => (f.filename?.endsWith('.pdf') ? 'pdf' : 'jpg');
  assert.deepEqual(rows.map((r) => r['name']), order.map((f, i) => `Ugovor 2015 (${i + 1}).${ext(f)}`));
  assert.deepEqual(uploads.map((u) => u.metadata['description']), ['Contract pages', 'Contract pages']);

  // Unnamed, the files keep their own names; an empty link is that item's error only.
  const empty = ctx.uploads.createLink();
  const again = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', skip_duplicates: false, files: [{ upload_id: link.linkId }, { upload_id: empty.linkId }] }));
  const named = (again['files'] as Record<string, unknown>[]).map((r) => r['name'] ?? r['error']);
  assert.deepEqual(named.slice(0, 2), order.map((f) => f.filename));
  assert.match(String(named[2]), new RegExp(`Nothing has been uploaded through ${empty.linkId}`));
});

test('one failing file does not stop the others', async () => {
  const { ctx, uploads } = setup(tree(), { failUploads: ['quota.pdf'] });
  const ok = ctx.uploads.put(Buffer.from('%PDF-1.4 ok'), { filename: 'ok.pdf' });
  const quota = ctx.uploads.put(Buffer.from('%PDF-1.4 big'), { filename: 'quota.pdf' });
  const res = await save(ctx, {
    folder: 'Appartements/Lisbonne',
    files: [
      { upload_id: 'up_missing' },
      { upload_id: ok.id },
      { gmail_message_id: 'm1' },
      { upload_id: ok.id, drive_file_id: 'old' },
      { drive_file_id: 'appts' },
      { upload_id: quota.id },
      { gmail_message_id: 'm1', gmail_part_id: '1', name: 'Devis traduction' },
    ],
  });
  assert.equal(res.isError, undefined, 'a partial failure is not a failed call');
  const out = resultJson(res);
  const rows = out['files'] as Record<string, unknown>[];
  assert.equal(rows.length, 7);
  assert.match(String(rows[0]!['error']), /No staged file "up_missing"/);
  assert.equal(rows[0]!['source'], 'upload:up_missing');
  assert.equal(rows[1]!['saved'], true);
  assert.match(String(rows[2]!['error']), /gmail_part_id/);
  assert.equal(rows[2]!['source'], 'gmail:m1/?');
  assert.match(String(rows[3]!['error']), /exactly one source.*\(got drive and upload\)/);
  assert.match(String(rows[4]!['error']), /"Appartements" is a folder; drive_save copies files/);
  assert.match(String(rows[5]!['error']), /403 \(storageQuotaExceeded\)/);
  assert.deepEqual(rows[6], { source: 'gmail:m1/1', name: 'Devis traduction.pdf', id: 'new2', web_view_link: 'https://drive.google.com/file/d/new2/view', size: 9, saved: true });
  assert.deepEqual(uploads.map((u) => u.metadata['name']), ['ok.pdf', 'quota.pdf', 'Devis traduction.pdf']);
});

test('a Drive file of the same account is copied inside Google; its md5 is compared when Drive has one', async () => {
  const nodes = [
    ...tree(),
    { id: 'scan1', name: 'scan.jpg', mimeType: 'image/jpeg', parents: ['root'], md5Checksum: md5('other bytes'), size: '11' },
    { id: 'dup1', name: 'contract copy.pdf', mimeType: 'application/pdf', parents: ['root'], md5Checksum: md5(EXISTING) },
    { id: 'doc1', name: 'Notes', mimeType: GOOGLE_MIME.document, parents: ['root'] },
  ];
  const { ctx, uploads } = setup(nodes);
  const out = resultJson(
    await save(ctx, {
      folder: 'Appartements/Lisbonne',
      files: [{ drive_file_id: 'https://drive.google.com/file/d/scan1/view', name: 'Ugovor 2015', description: 'scan' }, { drive_file_id: 'dup1' }, { drive_file_id: 'doc1', name: 'Notes Lisbonne' }],
    }),
  );
  const copies = apiCalls(ctx).filter((c) => c.url.pathname.endsWith('/copy'));
  assert.deepEqual(copies.map((c) => `${c.method} ${c.url.origin}${c.url.pathname}`), [`POST ${BASE}/files/scan1/copy`, `POST ${BASE}/files/doc1/copy`]);
  assert.deepEqual(copies[0]!.json, { name: 'Ugovor 2015.jpg', parents: ['bgd'], description: 'scan' });
  assert.deepEqual(copies[1]!.json, { name: 'Notes Lisbonne', parents: ['bgd'] }, 'a Google Doc gets no extension');
  assert.equal(copies[0]!.url.searchParams.get('supportsAllDrives'), 'true');
  const meta = apiCalls(ctx).find((c) => c.url.pathname === '/drive/v3/files/scan1')!;
  assert.equal(meta.url.searchParams.get('fields'), 'id,name,mimeType,md5Checksum,shortcutDetails');
  assert.ok(!apiCalls(ctx).some((c) => c.url.searchParams.get('alt') === 'media'), 'no bytes go through the connector');
  assert.equal(uploads.length, 0);
  const rows = out['files'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r['source'], r['saved'] ?? false, r['duplicate'] ?? false]), [
    ['drive:https://drive.google.com/file/d/scan1/view', true, false],
    ['drive:dup1', false, true],
    ['drive:doc1', true, false],
  ]);
  assert.equal(rows[1]!['id'], 'old');
});

test('a Drive file of another account travels as bytes; a Google Doc becomes a Google Doc again', async () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const nodes = [...tree(), { id: 'partnerscan', name: 'kupoprodaja.pdf', mimeType: 'application/pdf', parents: ['x'], size: '20' }, { id: 'partnerdoc', name: 'Spisak', mimeType: GOOGLE_MIME.document, parents: ['x'] }];
  const { google, uploads } = fakeDrive(nodes, { media: { partnerscan: Buffer.from('%PDF-1.4 partner scan') } });
  const ctx = createTestContext({
    accounts: [{ alias: 'me' }, { alias: 'partner' }],
    google: (c) => (c.url.pathname === '/drive/v3/files/partnerdoc/export' ? { body: Buffer.from('PK docx bytes') } : google(c)),
  });
  const out = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', files: [{ drive_file_id: 'partnerscan', from_account: 'partner' }, { drive_file_id: 'partnerdoc', from_account: 'Partner' }] }));
  assert.ok(!apiCalls(ctx).some((c) => c.url.pathname.endsWith('/copy')), 'files.copy cannot cross accounts');
  assert.ok(apiCalls(ctx).some((c) => c.url.pathname === '/drive/v3/files/partnerscan' && c.url.searchParams.get('alt') === 'media'));
  assert.equal(apiCalls(ctx).find((c) => c.url.pathname.endsWith('/export'))!.url.searchParams.get('mimeType'), DOCX);
  assert.deepEqual(uploads[0]!.metadata, { name: 'kupoprodaja.pdf', parents: ['bgd'] });
  assert.equal(uploads[0]!.media, '%PDF-1.4 partner scan');
  assert.deepEqual(uploads[1]!.metadata, { name: 'Spisak', parents: ['bgd'], mimeType: GOOGLE_MIME.document });
  assert.equal(uploads[1]!.mediaType, DOCX);
  assert.deepEqual((out['files'] as Record<string, unknown>[]).map((r) => r['saved']), [true, true]);
  assert.ok(ctx.accounts.get('partner')?.lastUsedAt);
});

test('drive_save logs counts only: no names, paths, descriptions or sources', async () => {
  const lines: string[] = [];
  const drive = fakeDrive(tree());
  const ctx = { ...createTestContext({ google: drive.google }), log: createLogger('debug', {}, (l) => lines.push(l)) };
  const staged = ctx.uploads.put(JPEG, { filename: 'IMG_secret.jpg' });
  await runTool(driveSave, { account: 'me', folder: 'Appartements/Lisbonne/Kupoprodaja', files: [{ upload_id: staged.id, name: 'Ugovor Ulica Primer', description: 'Apartment 1' }, { upload_id: 'up_gone' }] }, ctx);
  const saveLine = lines.find((l) => l.includes('"msg":"drive save"'));
  assert.ok(saveLine);
  assert.match(saveLine, /"files":2,"saved":1,"duplicates":0,"failed":1,"folders_created":1/);
  for (const l of lines) assert.doesNotMatch(l, /Ugovor|Primer|Apartment|Lisbonne|Appartements|Kupoprodaja|secret|up_/);
});

/* ---------- Review follow-ups ---------- */

test('two calls saving at once into the same missing path create each folder once', async () => {
  const { ctx, nodes, uploads } = setup();
  const quotes = ctx.uploads.put(Buffer.from('%PDF-1.4 quote'), { filename: 'devis.pdf' });
  const scan = ctx.uploads.put(JPEG, { filename: 'scan.jpg' });
  const [a, b] = await Promise.all([
    save(ctx, { folder: 'Traductions/Serbie', files: [{ upload_id: quotes.id }] }),
    save(ctx, { folder: 'Traductions/Serbie', files: [{ upload_id: scan.id }] }),
  ]);
  const folders = [...nodes.values()].filter((n) => n.mimeType === FOLDER && ['Traductions', 'Serbie'].includes(n.name));
  assert.deepEqual(folders.map((f) => f.name), ['Traductions', 'Serbie'], 'one Traductions, one Serbie');
  const serbie = folders[1]!.id;
  assert.deepEqual(uploads.map((u) => u.metadata['parents']), [[serbie], [serbie]]);
  assert.deepEqual([resultJson(a)['folder'], resultJson(b)['folder']].map((f) => (f as Record<string, unknown>)['ambiguous']), [undefined, undefined]);
  assert.equal([a, b].filter((r) => ((resultJson(r)['folder'] as Record<string, unknown>)['created'] as unknown[] | undefined)?.length === 2).length, 1, 'one call created the path, the other found it');
});

test('a Google Doc, Sheet or Slides deck already in the folder under the same name is a duplicate', async () => {
  const nodes = [
    ...tree(),
    { id: 'doc1', name: 'Brief traduction', mimeType: GOOGLE_MIME.document, parents: ['root'] },
    { id: 'doc2', name: 'Other brief', mimeType: GOOGLE_MIME.document, parents: ['root'] },
    { id: 'partnerdoc', name: 'Spisak', mimeType: GOOGLE_MIME.document, parents: ['x'] },
  ];
  const { google, nodes: all } = fakeDrive(nodes);
  const ctx = createTestContext({
    accounts: [{ alias: 'me' }, { alias: 'partner' }],
    google: (c) => (c.url.pathname === '/drive/v3/files/partnerdoc/export' ? { body: Buffer.from('PK docx bytes') } : google(c)),
  });
  const first = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', files: [{ drive_file_id: 'doc1' }, { drive_file_id: 'partnerdoc', from_account: 'partner' }] }));
  assert.deepEqual((first['files'] as Record<string, unknown>[]).map((r) => r['saved']), [true, true]);
  const listing = apiCalls(ctx).find(isListing)!;
  assert.equal(listing.url.searchParams.get('fields'), 'nextPageToken,files(id,name,mimeType,md5Checksum,size,webViewLink)');

  const again = resultJson(
    await save(ctx, { folder: 'Appartements/Lisbonne', files: [{ drive_file_id: 'doc1' }, { drive_file_id: 'partnerdoc', from_account: 'partner' }, { drive_file_id: 'doc2', name: 'Brief traduction (v2)' }] }),
  );
  const rows = again['files'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r['name'], r['saved'] ?? false, r['duplicate'] ?? false]), [
    ['Brief traduction', false, true],
    ['Spisak', false, true],
    ['Brief traduction (v2)', true, false],
  ]);
  assert.match(String(again['note']), /for a Google Doc, Sheet or Slides deck: one with the same name/);
  const copies = [...all.values()].filter((n) => n.parents?.includes('bgd') && n.mimeType === GOOGLE_MIME.document);
  assert.equal(copies.length, 3, 'nothing saved twice');

  const forced = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne', skip_duplicates: false, files: [{ drive_file_id: 'doc1' }] }));
  assert.equal((forced['files'] as Record<string, unknown>[])[0]!['saved'], true);
});

test('a path as drive_search shows it for a shared drive is saved in that shared drive, not in a new My Drive folder', async () => {
  const nodes = [...tree(), { id: 'sdc', name: 'Contracts', mimeType: FOLDER, parents: ['SD'], webViewLink: 'https://drive.google.com/drive/folders/sdc' }];
  const { ctx, uploads } = setup(nodes, { drives: [{ id: 'SD', name: 'Household' }] });
  const lease = ctx.uploads.put(Buffer.from('%PDF-1.4 lease'), { filename: 'lease.pdf' });

  const out = resultJson(await save(ctx, { folder: 'Household/Contracts/2015', files: [{ upload_id: lease.id }] }));
  assert.deepEqual(out['folder'], { id: 'new1', path: 'Household/Contracts/2015', web_view_link: 'https://drive.google.com/file/d/new1/view', created: ['2015'] });
  const drivesCall = apiCalls(ctx).find((c) => c.url.pathname === '/drive/v3/drives')!;
  assert.equal(drivesCall.url.searchParams.get('q'), "name = 'Household'");
  assert.deepEqual(apiCalls(ctx).filter(isFolderCreate).map((c) => c.json), [{ name: '2015', parents: ['sdc'], mimeType: FOLDER }]);
  assert.deepEqual(uploads[0]!.metadata['parents'], ['new1']);

  // Written from My Drive, the same names stay in My Drive; a My Drive folder never asks for shared drives.
  const before = apiCalls(ctx).filter((c) => c.url.pathname === '/drive/v3/drives').length;
  const mine = resultJson(await save(ctx, { folder: 'My Drive/Household', files: [{ upload_id: lease.id }] }));
  assert.deepEqual((mine['folder'] as Record<string, unknown>)['created'], ['Household']);
  assert.equal((mine['folder'] as Record<string, unknown>)['path'], 'My Drive/Household');
  await save(ctx, { folder: 'Appartements', files: [{ upload_id: lease.id }] });
  assert.equal(apiCalls(ctx).filter((c) => c.url.pathname === '/drive/v3/drives').length, before);

  // "Shared drive" (a shared drive whose name could not be read) cannot be walked: the id is needed.
  const generic = await save(ctx, { folder: 'Shared drive/Contracts', files: [{ upload_id: lease.id }] });
  assert.equal(generic.isError, true);
  assert.match(resultText(generic), /shared drive whose name could not be read.*folder id/);
});

test('a folder whose name contains "/" is found from the path drive_search shows', async () => {
  const nodes = [...tree(), { id: 'slash', name: 'Ugovori 2014/2015', mimeType: FOLDER, parents: ['bgd'], webViewLink: 'https://drive.google.com/drive/folders/slash' }];
  const { ctx, uploads } = setup(nodes);
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });
  const out = resultJson(await save(ctx, { folder: 'My Drive/Appartements/Lisbonne/Ugovori 2014/2015', create_folders: false, files: [{ upload_id: staged.id }] }));
  assert.deepEqual(out['folder'], { id: 'slash', path: 'My Drive/Appartements/Lisbonne/Ugovori 2014/2015', web_view_link: 'https://drive.google.com/drive/folders/slash' });
  assert.deepEqual(uploads[0]!.metadata['parents'], ['slash']);
  assert.equal(apiCalls(ctx).filter(isFolderCreate).length, 0);

  // Without such a folder, the missing name is still the first segment.
  const plain = setup();
  const res = await save(plain.ctx, { folder: 'Appartements/Lisbonne/Ugovori 2014/2015', create_folders: false, files: [{ upload_id: staged.id }] });
  assert.match(resultText(res), /no folder "Ugovori 2014" in My Drive\/Appartements\/Lisbonne/);
});

test('a folder named with spaces around "/" is found from the path drive_search shows, and from the same names written closer', async () => {
  const nodes = [
    ...tree(),
    { id: 'bills', name: 'Bills / Receipts', mimeType: FOLDER, parents: ['root'], webViewLink: 'https://drive.google.com/drive/folders/bills' },
    { id: 'tight', name: 'Ugovori 2014/2015', mimeType: FOLDER, parents: ['bgd'] },
  ];
  const { ctx, uploads } = setup(nodes);
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });
  const out = resultJson(await save(ctx, { folder: 'My Drive/Bills / Receipts', files: [{ upload_id: staged.id }] }));
  assert.deepEqual(out['folder'], { id: 'bills', path: 'My Drive/Bills / Receipts', web_view_link: 'https://drive.google.com/drive/folders/bills' });
  assert.deepEqual(uploads[0]!.metadata['parents'], ['bills']);
  const spaced = resultJson(await save(ctx, { folder: 'Appartements/Lisbonne/Ugovori 2014 / 2015', files: [{ upload_id: staged.id }] }));
  assert.equal((spaced['folder'] as Record<string, unknown>)['id'], 'tight');
  assert.equal(apiCalls(ctx).filter(isFolderCreate).length, 0, 'no folder created');
  assert.deepEqual(parsePath(' My Drive /Bills / Receipts'), { segments: ['Bills', 'Receipts'], written: ['Bills ', ' Receipts'], myDrive: true });
});

test('a folder outside My Drive (a computer backed up by Drive for desktop) is taken by id, and its path never claims My Drive', async () => {
  const nodes = [
    ...tree(),
    { id: 'laptop', name: 'My Laptop', mimeType: FOLDER },
    { id: 'lapDocs', name: 'Documents', mimeType: FOLDER, parents: ['laptop'] },
    { id: 'LaptopScans_0123456789', name: 'Scans', mimeType: FOLDER, parents: ['lapDocs'] },
  ];
  const { ctx, uploads } = setup(nodes);
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf' });
  const out = resultJson(await save(ctx, { folder: 'LaptopScans_0123456789', files: [{ upload_id: staged.id }] }));
  assert.equal((out['folder'] as Record<string, unknown>)['path'], '…/My Laptop/Documents/Scans');
  assert.deepEqual(uploads[0]!.metadata['parents'], ['LaptopScans_0123456789']);
  // That path cannot be walked from My Drive: the id is needed.
  const walked = await save(ctx, { folder: '…/My Laptop/Documents/Scans', files: [{ upload_id: staged.id }] });
  assert.match(resultText(walked), /not a complete path/);
  assert.equal(apiCalls(ctx).filter(isFolderCreate).length, 0);
});
