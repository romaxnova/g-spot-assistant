import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall, type TestContext } from '../../test-support.js';
import type { ToolContext, ToolDefinition } from '../registry.js';
import { runTool } from '../server.js';
import { driveTools, MAX_CONTENT_BYTES, moveParams } from './drive.js';
import { buildSearchQuery, escapeQ, exportPlan, extractFileId, friendlyType, GOOGLE_MIME, isTextLike, multipartRelated, withUtf8Charset } from './drive-files.js';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,webViewLink,shared,owners(emailAddress),trashed,shortcutDetails)';
const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,owners(emailAddress,displayName),shared,trashed,starred,description,permissions(id,type,role,emailAddress,domain,displayName),shortcutDetails';
const WRITE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,starred,trashed,description';

function tool(name: string): ToolDefinition {
  const def = driveTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return tool(name).handler(args, ctx);
}

function lastCall(ctx: TestContext): RecordedCall {
  const calls = apiCalls(ctx);
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no API call recorded');
  return call;
}

function endpoint(call: RecordedCall): string {
  return `${call.method} ${call.url.origin}${call.url.pathname}`;
}

const docFile = {
  id: ID,
  name: 'Plan',
  mimeType: GOOGLE_MIME.document,
  modifiedTime: '2026-09-01T10:00:00.000Z',
  createdTime: '2026-08-01T10:00:00.000Z',
  parents: ['folder1'],
  webViewLink: `https://docs.google.com/document/d/${ID}/edit`,
  owners: [{ emailAddress: 'me@example.com', displayName: 'Me' }],
  shared: true,
  permissions: [
    { id: 'p1', type: 'user', role: 'owner', emailAddress: 'me@example.com', displayName: 'Me' },
    { id: 'p2', type: 'anyone', role: 'reader' },
  ],
};

/** Fake Google answering files.get for ID with `file`, everything else through `rest`. */
function withFile(file: Record<string, unknown>, rest: FakeGoogle = () => undefined): FakeGoogle {
  return (call) => {
    if (call.method === 'GET' && call.url.pathname === `/drive/v3/files/${ID}` && !call.url.searchParams.has('alt')) return { json: file };
    return rest(call);
  };
}

/* ---------- Inventory ---------- */

test('tool inventory: names, service and honest annotations', () => {
  const byName = Object.fromEntries(driveTools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['drive_create_file', 'drive_get_file', 'drive_search', 'drive_share', 'drive_trash', 'drive_update_file']);
  for (const t of driveTools) {
    assert.equal(t.service, 'drive', t.name);
    assert.ok(t.inputSchema['account'], `${t.name} has account param`);
    assert.ok(t.title && t.description.length > 40, t.name);
  }
  for (const name of ['drive_search', 'drive_get_file']) {
    assert.equal(byName[name]!.annotations.readOnlyHint, true, name);
    assert.equal(byName[name]!.annotations.destructiveHint, false, name);
  }
  for (const name of ['drive_create_file', 'drive_update_file', 'drive_share']) {
    assert.equal(byName[name]!.annotations.readOnlyHint, false, name);
    assert.equal(byName[name]!.annotations.destructiveHint, false, name);
  }
  assert.equal(byName['drive_trash']!.annotations.readOnlyHint, false);
  assert.equal(byName['drive_trash']!.annotations.destructiveHint, true);
  assert.equal(byName['drive_update_file']!.annotations.idempotentHint, true);
  assert.equal(byName['drive_create_file']!.annotations.idempotentHint, false);
});

test('account without drive access yields an isError result that mentions re-linking', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'work', services: ['gmail'] }] });
  const result = await runTool(tool('drive_search'), { account: 'work', query: 'x' }, ctx);
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not granted Google Drive.*Re-link it with Google Drive/);
  await assert.rejects(run('drive_get_file', { account: 'work', file_id: ID }, ctx), /Re-link/);
  assert.equal(apiCalls(ctx).length, 0);
});

/* ---------- Pure helpers ---------- */

test('extractFileId accepts ids, root and every common Google URL shape', () => {
  assert.equal(extractFileId(ID), ID);
  assert.equal(extractFileId(' root '), 'root');
  assert.equal(extractFileId(`https://docs.google.com/document/d/${ID}/edit#heading=h.1`), ID);
  assert.equal(extractFileId(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=0`), ID);
  assert.equal(extractFileId(`https://docs.google.com/presentation/d/${ID}/edit`), ID);
  assert.equal(extractFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), ID);
  assert.equal(extractFileId(`https://drive.google.com/drive/folders/${ID}?usp=drive_link`), ID);
  assert.equal(extractFileId(`https://drive.google.com/drive/u/1/folders/${ID}`), ID);
  assert.equal(extractFileId(`https://drive.google.com/open?id=${ID}`), ID);
  assert.throws(() => extractFileId('not a file id!'), /neither a Drive file id nor/);
  assert.throws(() => extractFileId('https://drive.google.com/drive/my-drive'), /Could not find a file id/);
});

test('buildSearchQuery escapes quotes and combines filters', () => {
  assert.equal(escapeQ("Bob's \\ file"), "Bob\\'s \\\\ file");
  assert.equal(buildSearchQuery({ query: "Bob's plan" }), "(name contains 'Bob\\'s plan' or fullText contains 'Bob\\'s plan') and trashed = false");
  assert.equal(buildSearchQuery({ query: 'x', includeTrashed: true }), "(name contains 'x' or fullText contains 'x')");
  assert.equal(buildSearchQuery({ includeTrashed: true }), '');
  assert.equal(
    buildSearchQuery({ query: 'ignored', rawQ: "name = 'Budget'", folderId: 'root', type: 'spreadsheet', sharedWithMe: true }),
    "(name = 'Budget') and 'root' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and sharedWithMe = true",
  );
  assert.equal(buildSearchQuery({ type: 'folder', includeTrashed: true }), "mimeType = 'application/vnd.google-apps.folder'");
  assert.equal(buildSearchQuery({ type: 'pdf', includeTrashed: true }), "mimeType = 'application/pdf'");
  assert.equal(buildSearchQuery({ type: 'image', includeTrashed: true }), "mimeType contains 'image/'");
  assert.equal(
    buildSearchQuery({ type: 'other', includeTrashed: true }),
    "mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.document' and mimeType != 'application/vnd.google-apps.spreadsheet' and mimeType != 'application/vnd.google-apps.presentation' and mimeType != 'application/pdf' and not mimeType contains 'image/'",
  );
});

test('MIME classification and export plans', () => {
  assert.equal(friendlyType(GOOGLE_MIME.document), 'document');
  assert.equal(friendlyType(GOOGLE_MIME.folder), 'folder');
  assert.equal(friendlyType('application/vnd.google-apps.form'), 'form');
  assert.equal(friendlyType('application/pdf'), 'pdf');
  assert.equal(friendlyType('image/png'), 'image');
  assert.equal(friendlyType('text/csv'), 'text');
  assert.equal(friendlyType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'word');
  assert.equal(friendlyType('application/zip'), 'archive');
  assert.equal(friendlyType(undefined), 'other');
  for (const m of ['text/plain', 'text/markdown; charset=utf-8', 'application/json', 'application/xml', 'image/svg+xml', 'application/ld+json', 'application/x-yaml']) assert.ok(isTextLike(m), m);
  for (const m of ['application/pdf', 'image/png', 'application/octet-stream', 'application/vnd.ms-excel']) assert.ok(!isTextLike(m), m);

  assert.deepEqual(exportPlan(GOOGLE_MIME.document), { mimeType: 'text/markdown', fallbackMimeType: 'text/plain' });
  assert.deepEqual(exportPlan(GOOGLE_MIME.document, 'html'), { mimeType: 'text/html' });
  assert.equal(exportPlan(GOOGLE_MIME.spreadsheet)?.mimeType, 'text/csv');
  assert.match(exportPlan(GOOGLE_MIME.spreadsheet)?.note ?? '', /first tab only.*sheets_read/);
  assert.deepEqual(exportPlan(GOOGLE_MIME.presentation), { mimeType: 'text/plain' });
  assert.equal(exportPlan('text/plain'), undefined);
  assert.throws(() => exportPlan(GOOGLE_MIME.spreadsheet, 'markdown'), /not available for a Google spreadsheet; use csv/);
});

test('multipartRelated builds a JSON metadata part and a media part with the given boundary', () => {
  const { body, contentType } = multipartRelated({ name: 'a.txt', mimeType: GOOGLE_MIME.document }, Buffer.from('héllo', 'utf8'), 'text/plain; charset=UTF-8', 'BOUNDARY');
  assert.equal(contentType, 'multipart/related; boundary=BOUNDARY');
  assert.equal(
    body.toString('utf8'),
    [
      '--BOUNDARY',
      'Content-Type: application/json; charset=UTF-8',
      '',
      '{"name":"a.txt","mimeType":"application/vnd.google-apps.document"}',
      '--BOUNDARY',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'héllo',
      '--BOUNDARY--',
      '',
    ].join('\r\n'),
  );
  // Media bytes are copied verbatim (no re-encoding).
  assert.ok(body.includes(Buffer.from('héllo', 'utf8')));
  const auto = multipartRelated({}, Buffer.alloc(0), 'text/plain');
  assert.match(auto.contentType, /^multipart\/related; boundary=[0-9a-f]{32}$/);
  assert.equal(withUtf8Charset('text/csv'), 'text/csv; charset=UTF-8');
  assert.equal(withUtf8Charset('text/csv; charset=latin1'), 'text/csv; charset=latin1');
  assert.equal(withUtf8Charset('application/json'), 'application/json');
});

test('moveParams adds the target and removes every other parent', () => {
  assert.deepEqual(moveParams(['a', 'b'], 'c'), { addParents: 'c', removeParents: 'a,b' });
  assert.deepEqual(moveParams(['a', 'c'], 'c'), { addParents: undefined, removeParents: 'a' });
  assert.deepEqual(moveParams(['c'], 'c'), { addParents: undefined, removeParents: undefined });
  assert.deepEqual(moveParams([], 'c'), { addParents: 'c', removeParents: undefined });
});

/* ---------- drive_search ---------- */

test('drive_search sends the built q with all-drives flags and maps files compactly', async () => {
  const ctx = createTestContext({
    google: (call) =>
      call.url.pathname === '/drive/v3/files'
        ? {
            json: {
              nextPageToken: 'tok2',
              files: [
                { id: 'f1', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet, modifiedTime: '2026-09-02T00:00:00Z', parents: ['root'], webViewLink: 'https://x/1', shared: false, owners: [{ emailAddress: 'me@example.com' }] },
                { id: 'f2', name: 'scan.pdf', mimeType: 'application/pdf', size: '20480', trashed: true, shortcutDetails: undefined },
                { id: 'f3', name: 'link', mimeType: GOOGLE_MIME.shortcut, shortcutDetails: { targetId: 'f1', targetMimeType: GOOGLE_MIME.spreadsheet } },
              ],
            },
          }
        : undefined,
  });
  const out = resultJson(await run('drive_search', { account: 'me', query: "Bob's", folder_id: `https://drive.google.com/drive/folders/${ID}`, type: 'spreadsheet', max_results: 5, page_token: 'tok1', order_by: 'name' }, ctx));
  const call = lastCall(ctx);
  assert.equal(endpoint(call), `GET ${BASE}/files`);
  const expectedQ = `(name contains 'Bob\\'s' or fullText contains 'Bob\\'s') and '${ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  assert.equal(call.url.searchParams.get('q'), expectedQ);
  assert.equal(call.url.searchParams.get('orderBy'), 'name');
  assert.equal(call.url.searchParams.get('pageSize'), '5');
  assert.equal(call.url.searchParams.get('pageToken'), 'tok1');
  assert.equal(call.url.searchParams.get('fields'), LIST_FIELDS);
  assert.equal(call.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(call.url.searchParams.get('includeItemsFromAllDrives'), 'true');
  assert.deepEqual(out, {
    files: [
      { id: 'f1', name: 'Budget', type: 'spreadsheet', mime_type: GOOGLE_MIME.spreadsheet, modified_time: '2026-09-02T00:00:00Z', parents: ['root'], path: 'My Drive', owner: 'me@example.com', shared: false, web_view_link: 'https://x/1' },
      { id: 'f2', name: 'scan.pdf', type: 'pdf', mime_type: 'application/pdf', size: 20480, trashed: true },
      { id: 'f3', name: 'link', type: 'shortcut', mime_type: GOOGLE_MIME.shortcut, shortcut_target: { id: 'f1', type: 'spreadsheet' } },
    ],
    next_page_token: 'tok2',
    q_used: expectedQ,
  });
});

test('drive_search defaults: 20 results by modifiedTime desc, trashed excluded; no q at all when nothing restricts', async () => {
  const ctx = createTestContext({ google: () => ({ json: { files: [] } }) });
  let out = resultJson(await run('drive_search', { account: 'me' }, ctx));
  let call = lastCall(ctx);
  assert.equal(call.url.searchParams.get('q'), 'trashed = false');
  assert.equal(call.url.searchParams.get('orderBy'), 'modifiedTime desc');
  assert.equal(call.url.searchParams.get('pageSize'), '20');
  assert.equal(call.url.searchParams.has('pageToken'), false);
  assert.deepEqual(out, { q_used: 'trashed = false', note: 'No files matched.' });

  out = resultJson(await run('drive_search', { account: 'me', include_trashed: true }, ctx));
  call = lastCall(ctx);
  assert.equal(call.url.searchParams.has('q'), false);
  assert.equal(out['q_used'], undefined);

  await run('drive_search', { account: 'me', raw_q: "name = 'x'", shared_with_me: true }, ctx);
  assert.equal(lastCall(ctx).url.searchParams.get('q'), "(name = 'x') and trashed = false and sharedWithMe = true");
});

test('drive_search rejects a bad folder URL without calling Google', async () => {
  const ctx = createTestContext();
  const result = await run('drive_search', { account: 'me', folder_id: 'https://drive.google.com/drive/my-drive' }, ctx);
  assert.equal(result.isError, true);
  assert.equal(apiCalls(ctx).length, 0);
});

/* ---------- drive_get_file ---------- */

test('drive_get_file exports a Google Doc as markdown and returns metadata + permissions', async () => {
  const ctx = createTestContext({
    google: withFile(docFile, (call) => (call.url.pathname === `/drive/v3/files/${ID}/export` ? { text: '# Plan\n\nBody' } : undefined)),
  });
  const out = resultJson(await run('drive_get_file', { account: 'me', file_id: `https://docs.google.com/document/d/${ID}/edit` }, ctx));
  const [meta, exp] = apiCalls(ctx);
  assert.equal(endpoint(meta!), `GET ${BASE}/files/${ID}`);
  assert.equal(meta!.url.searchParams.get('fields'), FILE_FIELDS);
  assert.equal(meta!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(endpoint(exp!), `GET ${BASE}/files/${ID}/export`);
  assert.equal(exp!.url.searchParams.get('mimeType'), 'text/markdown');
  assert.deepEqual(out, {
    id: ID,
    name: 'Plan',
    type: 'document',
    mime_type: GOOGLE_MIME.document,
    modified_time: '2026-09-01T10:00:00.000Z',
    parents: ['folder1'],
    owner: 'me@example.com',
    shared: true,
    web_view_link: `https://docs.google.com/document/d/${ID}/edit`,
    created_time: '2026-08-01T10:00:00.000Z',
    owner_name: 'Me',
    permissions: [
      { id: 'p1', type: 'user', role: 'owner', email: 'me@example.com', name: 'Me' },
      { id: 'p2', type: 'anyone', role: 'reader' },
    ],
    content: '# Plan\n\nBody',
    content_format: 'text/markdown',
    truncated: false,
    total_chars: 12,
  });
});

test('drive_get_file falls back to text/plain when Google refuses markdown, but not on 404', async () => {
  const ctx = createTestContext({
    google: withFile(docFile, (call) => {
      if (call.url.pathname !== `/drive/v3/files/${ID}/export`) return undefined;
      if (call.url.searchParams.get('mimeType') === 'text/markdown') return { status: 400, json: { error: { message: 'Export format not supported', errors: [{ reason: 'badRequest' }] } } };
      return { text: 'Plain body' };
    }),
  });
  const out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID }, ctx));
  const exports = apiCalls(ctx).filter((c) => c.url.pathname.endsWith('/export'));
  assert.deepEqual(exports.map((c) => c.url.searchParams.get('mimeType')), ['text/markdown', 'text/plain']);
  assert.equal(out['content'], 'Plain body');
  assert.equal(out['content_format'], 'text/plain');
  assert.match(String(out['content_note']), /refused text\/markdown; exported as text\/plain/);

  const missing = createTestContext({ google: withFile(docFile, () => ({ status: 404, json: { error: { message: 'File not found', errors: [{ reason: 'notFound' }] } } })) });
  const result = await runTool(tool('drive_get_file'), { account: 'me', file_id: ID }, missing);
  assert.equal(result.isError, true);
  assert.match(resultText(result), /404.*File not found/);
  assert.equal(apiCalls(missing).filter((c) => c.url.pathname.endsWith('/export')).length, 1);
});

test('drive_get_file exports a Sheet as CSV with the first-tab note and honours export_format', async () => {
  const sheet = { ...docFile, mimeType: GOOGLE_MIME.spreadsheet };
  const ctx = createTestContext({ google: withFile(sheet, (call) => (call.url.pathname.endsWith('/export') ? { text: 'a,b\n1,2\n' } : undefined)) });
  const out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID }, ctx));
  assert.equal(lastCall(ctx).url.searchParams.get('mimeType'), 'text/csv');
  assert.equal(out['content'], 'a,b\n1,2', 'trailing empty record dropped by trimCsv');
  assert.match(String(out['content_note']), /first tab only/);

  const bad = await run('drive_get_file', { account: 'me', file_id: ID, export_format: 'markdown' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad), /not available for a Google spreadsheet/);

  const html = createTestContext({ google: withFile(docFile, () => ({ text: '<p>x</p>' })) });
  await run('drive_get_file', { account: 'me', file_id: ID, export_format: 'html' }, html);
  assert.equal(lastCall(html).url.searchParams.get('mimeType'), 'text/html');
});

test('drive_get_file downloads text-like files with alt=media and pages with max_chars/offset', async () => {
  const text = 'x'.repeat(250) + 'END';
  const file = { id: ID, name: 'notes.md', mimeType: 'text/markdown', size: String(text.length) };
  const ctx = createTestContext({ google: withFile(file, (call) => (call.url.searchParams.get('alt') === 'media' ? { text } : undefined)) });
  let out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID, max_chars: 200 }, ctx));
  const dl = lastCall(ctx);
  assert.equal(endpoint(dl), `GET ${BASE}/files/${ID}`);
  assert.equal(dl.url.searchParams.get('alt'), 'media');
  assert.equal(dl.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(out['content'], 'x'.repeat(200));
  assert.equal(out['content_format'], 'text/markdown');
  assert.equal(out['truncated'], true);
  assert.equal(out['total_chars'], 253);
  assert.equal(out['next_offset'], 200);

  out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID, max_chars: 200, offset: 200 }, ctx));
  assert.equal(out['content'], 'x'.repeat(50) + 'END');
  assert.equal(out['truncated'], false);
  assert.equal(out['next_offset'], undefined);

  const empty = createTestContext({ google: withFile({ ...file, size: '0' }, () => ({ text: '' })) });
  out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID }, empty));
  assert.equal(out['content_note'], 'The file is empty.');
  assert.equal(out['total_chars'], 0);
});

test('drive_get_file refuses text over 10 MB and never downloads unreadable binaries, folders or shortcuts', async () => {
  const cases: { file: Record<string, unknown>; note: RegExp }[] = [
    { file: { id: ID, name: 'big.txt', mimeType: 'text/plain', size: String(MAX_CONTENT_BYTES + 1) }, note: /10\.0 MB exceeds the 10 MB limit/ },
    { file: { id: ID, name: 'backup.zip', mimeType: 'application/zip', size: '5000', webViewLink: 'https://x' }, note: /content of this file type \(application\/zip, 5000 bytes\) cannot be read/ },
    { file: { id: ID, name: 'song.mp3', mimeType: 'audio/mpeg', size: '5000' }, note: /\(audio\/mpeg, 5000 bytes\) cannot be read; PDF, Word, Excel/ },
    { file: { id: ID, name: 'Photos', mimeType: GOOGLE_MIME.folder }, note: new RegExp(`folder.*drive_search folder_id="${ID}"`) },
    { file: { id: ID, name: 'lnk', mimeType: GOOGLE_MIME.shortcut, shortcutDetails: { targetId: 'tgt', targetMimeType: GOOGLE_MIME.document } }, note: /shortcut to document "tgt"/ },
  ];
  for (const c of cases) {
    const ctx = createTestContext({ google: withFile(c.file) });
    const out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID }, ctx));
    assert.match(String(out['content_note']), c.note, c.file['name'] as string);
    assert.equal(out['content'], undefined);
    assert.equal(apiCalls(ctx).length, 1, `${c.file['name']}: metadata call only`);
  }
  const notNative = createTestContext({ google: withFile({ id: ID, name: 'a.txt', mimeType: 'text/plain' }) });
  const bad = await run('drive_get_file', { account: 'me', file_id: ID, export_format: 'text' }, notNative);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad), /only applies to Google Docs/);
});

test('drive_get_file include_content=false makes a single metadata call', async () => {
  const ctx = createTestContext({ google: withFile(docFile) });
  const out = resultJson(await run('drive_get_file', { account: 'me', file_id: ID, include_content: false }, ctx));
  assert.equal(apiCalls(ctx).length, 1);
  assert.equal(out['content'], undefined);
  assert.equal(out['name'], 'Plan');
});

/* ---------- drive_create_file ---------- */

const created = { id: 'new1', name: 'Doc', mimeType: GOOGLE_MIME.document, webViewLink: 'https://docs/new1', parents: ['folderX'] };

test('drive_create_file creates a folder with a metadata-only POST', async () => {
  const ctx = createTestContext({ google: () => ({ json: { ...created, name: 'Photos', mimeType: GOOGLE_MIME.folder } }) });
  const out = resultJson(await run('drive_create_file', { account: 'me', name: 'Photos', kind: 'folder', parent_folder_id: `https://drive.google.com/drive/folders/${ID}`, description: 'd' }, ctx));
  const call = lastCall(ctx);
  assert.equal(endpoint(call), `POST ${BASE}/files`);
  assert.equal(call.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(call.url.searchParams.get('fields'), WRITE_FIELDS);
  assert.deepEqual(call.json, { name: 'Photos', parents: [ID], description: 'd', mimeType: GOOGLE_MIME.folder });
  assert.deepEqual(out, { id: 'new1', name: 'Photos', type: 'folder', mime_type: GOOGLE_MIME.folder, web_view_link: 'https://docs/new1', parents: ['folderX'] });

  const bad = await run('drive_create_file', { account: 'me', name: 'x', kind: 'folder', content: 'nope' }, ctx);
  assert.equal(bad.isError, true);
});

test('drive_create_file uploads markdown as a Google Doc through a multipart POST', async () => {
  const ctx = createTestContext({ google: () => ({ json: created }) });
  const out = resultJson(await run('drive_create_file', { account: 'me', name: 'Doc', kind: 'document', content: '# Hi', content_mime_type: 'text/markdown', parent_folder_id: 'root' }, ctx));
  const call = lastCall(ctx);
  assert.equal(endpoint(call), `POST ${UPLOAD}/files`);
  assert.equal(call.url.searchParams.get('uploadType'), 'multipart');
  assert.equal(call.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(call.url.searchParams.get('fields'), WRITE_FIELDS);
  const boundary = call.headers['content-type']!.match(/^multipart\/related; boundary=([0-9a-f]{32})$/)?.[1];
  assert.ok(boundary, 'multipart content type with boundary');
  assert.equal(
    call.body,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"Doc","parents":["root"],"mimeType":"${GOOGLE_MIME.document}"}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n# Hi\r\n--${boundary}--\r\n`,
  );
  assert.deepEqual(out, { id: 'new1', name: 'Doc', type: 'document', mime_type: GOOGLE_MIME.document, web_view_link: 'https://docs/new1', parents: ['folderX'] });
});

test('drive_create_file: empty Google Sheet is metadata-only; kind=file keeps its own MIME; presentations refuse content', async () => {
  const ctx = createTestContext({ google: () => ({ json: created }) });
  await run('drive_create_file', { account: 'me', name: 'Sheet', kind: 'spreadsheet' }, ctx);
  let call = lastCall(ctx);
  assert.equal(endpoint(call), `POST ${BASE}/files`);
  assert.deepEqual(call.json, { name: 'Sheet', mimeType: GOOGLE_MIME.spreadsheet });

  await run('drive_create_file', { account: 'me', name: 'data.json', content: '{"a":1}', content_mime_type: 'application/json' }, ctx);
  call = lastCall(ctx);
  assert.equal(endpoint(call), `POST ${UPLOAD}/files`);
  assert.match(call.body!, /\r\n\r\n\{"name":"data\.json"\}\r\n/);
  assert.match(call.body!, /Content-Type: application\/json\r\n\r\n\{"a":1\}\r\n/);

  await run('drive_create_file', { account: 'me', name: 'empty.txt' }, ctx);
  assert.deepEqual(lastCall(ctx).json, { name: 'empty.txt', mimeType: 'text/plain' });

  // content_mime_type defaults per kind: text/csv for a spreadsheet (Drive does not import text/plain into a Sheet), text/plain otherwise.
  await run('drive_create_file', { account: 'me', name: 'Sheet', kind: 'spreadsheet', content: 'a,b\n1,2\n' }, ctx);
  call = lastCall(ctx);
  assert.equal(endpoint(call), `POST ${UPLOAD}/files`);
  assert.match(call.body!, new RegExp(`\\r\\n\\r\\n\\{"name":"Sheet","mimeType":"${GOOGLE_MIME.spreadsheet}"\\}\\r\\n`));
  assert.match(call.body!, /Content-Type: text\/csv; charset=UTF-8\r\n\r\na,b\n1,2\n\r\n/);
  await run('drive_create_file', { account: 'me', name: 'Doc', kind: 'document', content: 'plain' }, ctx);
  assert.match(lastCall(ctx).body!, /Content-Type: text\/plain; charset=UTF-8\r\n\r\nplain\r\n/);
  await run('drive_create_file', { account: 'me', name: 'Sheet', kind: 'spreadsheet', content: 'a\tb', content_mime_type: 'text/tab-separated-values' }, ctx);
  assert.match(lastCall(ctx).body!, /Content-Type: text\/tab-separated-values; charset=UTF-8\r\n\r\na\tb\r\n/);

  const before = apiCalls(ctx).length;
  const bad = await run('drive_create_file', { account: 'me', name: 'Deck', kind: 'presentation', content: 'slide' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad), /cannot convert text into a presentation/);
  assert.equal(apiCalls(ctx).length, before);
});

/* ---------- drive_update_file ---------- */

const updated = { id: ID, name: 'Renamed', mimeType: 'text/plain', modifiedTime: '2026-09-03T00:00:00Z', size: '12', parents: ['dest'], webViewLink: 'https://x', starred: true, description: 'new' };

test('drive_update_file moves by reading the current parents, then PATCHing addParents/removeParents', async () => {
  const ctx = createTestContext({
    google: (call) => {
      if (call.method === 'GET') return { json: { parents: ['old1', 'old2'] } };
      if (call.method === 'PATCH') return { json: updated };
      return undefined;
    },
  });
  const out = resultJson(await run('drive_update_file', { account: 'me', file_id: ID, name: 'Renamed', move_to_folder_id: `https://drive.google.com/drive/folders/dest`, starred: true }, ctx));
  const [read, patch] = apiCalls(ctx);
  assert.equal(endpoint(read!), `GET ${BASE}/files/${ID}`);
  assert.equal(read!.url.searchParams.get('fields'), 'parents');
  assert.equal(read!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(endpoint(patch!), `PATCH ${BASE}/files/${ID}`);
  assert.equal(patch!.url.searchParams.get('addParents'), 'dest');
  assert.equal(patch!.url.searchParams.get('removeParents'), 'old1,old2');
  assert.equal(patch!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(patch!.url.searchParams.get('fields'), WRITE_FIELDS);
  assert.deepEqual(patch!.json, { name: 'Renamed', starred: true });
  assert.deepEqual(out, { id: ID, name: 'Renamed', type: 'text', mime_type: 'text/plain', modified_time: '2026-09-03T00:00:00Z', size: 12, parents: ['dest'], starred: true, web_view_link: 'https://x', description: 'new' });
});

test('drive_update_file: restore_from_trash sends trashed=false; an empty description is sent (it clears); a move to the current folder adds nothing; nothing to update is an error', async () => {
  const ctx = createTestContext({
    google: (call) => (call.method === 'GET' ? { json: { parents: ['dest'] } } : { json: updated }),
  });
  await run('drive_update_file', { account: 'me', file_id: ID, restore_from_trash: true, description: '' }, ctx);
  let patch = lastCall(ctx);
  assert.equal(patch.method, 'PATCH');
  // Drive clears the description only when the field is present and empty; stripping '' would silently do nothing.
  assert.deepEqual(patch.json, { description: '', trashed: false });
  assert.equal(patch.url.searchParams.has('addParents'), false);

  await run('drive_update_file', { account: 'me', file_id: ID, description: '' }, ctx);
  patch = lastCall(ctx);
  assert.equal(patch.method, 'PATCH');
  assert.deepEqual(patch.json, { description: '' });

  await run('drive_update_file', { account: 'me', file_id: ID, move_to_folder_id: 'dest' }, ctx);
  patch = lastCall(ctx);
  assert.equal(patch.url.searchParams.has('addParents'), false);
  assert.equal(patch.url.searchParams.has('removeParents'), false);
  assert.deepEqual(patch.json, {});

  const before = apiCalls(ctx).length;
  const bad = await run('drive_update_file', { account: 'me', file_id: ID }, ctx);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad), /Nothing to update/);
  assert.equal(apiCalls(ctx).length, before);
});

test('drive_update_file replaces content with a multipart PATCH on the upload host, carrying metadata and move params', async () => {
  const ctx = createTestContext({
    google: (call) => (call.method === 'GET' ? { json: { parents: ['old'] } } : { json: updated }),
  });
  await run('drive_update_file', { account: 'me', file_id: ID, content: 'a,b\n', content_mime_type: 'text/csv', name: 'Renamed', move_to_folder_id: 'dest' }, ctx);
  const patch = lastCall(ctx);
  assert.equal(endpoint(patch), `PATCH ${UPLOAD}/files/${ID}`);
  assert.equal(patch.url.searchParams.get('uploadType'), 'multipart');
  assert.equal(patch.url.searchParams.get('addParents'), 'dest');
  assert.equal(patch.url.searchParams.get('removeParents'), 'old');
  assert.equal(patch.url.searchParams.get('supportsAllDrives'), 'true');
  assert.match(patch.headers['content-type']!, /^multipart\/related; boundary=/);
  assert.match(patch.body!, /\r\n\r\n\{"name":"Renamed"\}\r\n/);
  assert.match(patch.body!, /Content-Type: text\/csv; charset=UTF-8\r\n\r\na,b\n\r\n/);

  await run('drive_update_file', { account: 'me', file_id: ID, content: 'only content' }, ctx);
  assert.match(lastCall(ctx).body!, /\r\n\r\n\{\}\r\n/);
  assert.match(lastCall(ctx).body!, /Content-Type: text\/plain; charset=UTF-8\r\n\r\nonly content\r\n/);

  // An empty description travels in the multipart metadata part too.
  await run('drive_update_file', { account: 'me', file_id: ID, content: 'x', description: '' }, ctx);
  assert.match(lastCall(ctx).body!, /\r\n\r\n\{"description":""\}\r\n/);
});

/* ---------- drive_share ---------- */

test('drive_share adds a user permission with notification settings and returns the link', async () => {
  const ctx = createTestContext({
    google: (call) => {
      if (call.method === 'GET') return { json: { name: 'Plan', webViewLink: 'https://docs/plan' } };
      if (call.method === 'POST') return { json: { id: 'perm9', type: 'user', role: 'writer', emailAddress: 'bob@example.com' } };
      return undefined;
    },
  });
  const out = resultJson(await run('drive_share', { account: 'me', file_id: ID, email_address: 'bob@example.com', role: 'writer', notify: false, message: 'hi' }, ctx));
  const [meta, post] = apiCalls(ctx);
  assert.equal(endpoint(meta!), `GET ${BASE}/files/${ID}`);
  assert.equal(meta!.url.searchParams.get('fields'), 'name,webViewLink');
  assert.equal(endpoint(post!), `POST ${BASE}/files/${ID}/permissions`);
  assert.equal(post!.url.searchParams.get('sendNotificationEmail'), 'false');
  assert.equal(post!.url.searchParams.get('emailMessage'), 'hi');
  assert.equal(post!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.deepEqual(post!.json, { type: 'user', role: 'writer', emailAddress: 'bob@example.com' });
  assert.deepEqual(out, { file_id: ID, file_name: 'Plan', permission_id: 'perm9', type: 'user', role: 'writer', email: 'bob@example.com', web_view_link: 'https://docs/plan' });
});

test('drive_share: anyone-with-link is not discoverable and sends no notification params; domain and validation', async () => {
  const ctx = createTestContext({
    google: (call) => (call.method === 'GET' ? { json: { name: 'Plan', webViewLink: 'https://docs/plan' } } : { json: { id: 'anyoneWithLink', type: 'anyone', role: 'reader' } }),
  });
  await run('drive_share', { account: 'me', file_id: ID, type: 'anyone' }, ctx);
  let post = lastCall(ctx);
  assert.deepEqual(post.json, { type: 'anyone', role: 'reader', allowFileDiscovery: false });
  assert.equal(post.url.searchParams.has('sendNotificationEmail'), false);
  assert.equal(post.url.searchParams.has('emailMessage'), false);

  await run('drive_share', { account: 'me', file_id: ID, type: 'domain', domain: 'example.com', role: 'commenter', notify: false, message: 'ignored' }, ctx);
  post = lastCall(ctx);
  assert.deepEqual(post.json, { type: 'domain', role: 'commenter', domain: 'example.com' });
  assert.equal(post.url.searchParams.has('sendNotificationEmail'), false);

  const before = apiCalls(ctx).length;
  for (const args of [{ type: 'group' }, { type: 'domain' }, { action: 'remove' }]) {
    const bad = await run('drive_share', { account: 'me', file_id: ID, ...args }, ctx);
    assert.equal(bad.isError, true, JSON.stringify(args));
  }
  assert.equal(apiCalls(ctx).length, before, 'validation errors make no API call');
});

test('drive_share removes a permission with DELETE', async () => {
  // Google answers permissions.delete with an empty 204; a Response with a 204 status may carry no body.
  const ctx = createTestContext({ google: (call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined) });
  const out = resultJson(await run('drive_share', { account: 'me', file_id: ID, action: 'remove', permission_id: 'perm9' }, ctx));
  const call = lastCall(ctx);
  assert.equal(endpoint(call), `DELETE ${BASE}/files/${ID}/permissions/perm9`);
  assert.equal(call.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(apiCalls(ctx).length, 1);
  assert.deepEqual(out, { file_id: ID, permission_id: 'perm9', removed: true });
});

/* ---------- drive_trash ---------- */

test('drive_trash PATCHes trashed=true and points at the restore path', async () => {
  const ctx = createTestContext({ google: () => ({ json: { id: ID, name: 'Old', mimeType: GOOGLE_MIME.folder, trashed: true } }) });
  const out = resultJson(await run('drive_trash', { account: 'me', file_id: `https://drive.google.com/file/d/${ID}/view` }, ctx));
  const call = lastCall(ctx);
  assert.equal(endpoint(call), `PATCH ${BASE}/files/${ID}`);
  assert.equal(call.url.searchParams.get('supportsAllDrives'), 'true');
  assert.deepEqual(call.json, { trashed: true });
  assert.deepEqual(out, { id: ID, name: 'Old', type: 'folder', trashed: true, note: 'Restore with drive_update_file restore_from_trash=true.' });
});

test('Google API errors propagate as clear tool errors through runTool', async () => {
  const ctx = createTestContext({ google: () => ({ status: 403, json: { error: { message: 'The user does not have sufficient permissions for this file.', errors: [{ reason: 'forbidden' }] } } }) });
  const result = await runTool(tool('drive_trash'), { account: 'me', file_id: ID }, ctx);
  assert.equal(result.isError, true);
  assert.match(resultText(result), /Google Drive API error 403 \(forbidden\)/);
});

test('drive content is cleaned per format: CSV trimmed, prose de-padded, data formats kept', async () => {
  const { readableContent } = await import('./drive.js');
  assert.equal(readableContent(',,,,\r\n,Statistic,,,,Total Budget,\r\n,Date,Sum,,\r\n', 'text/csv'), '\n,Statistic,,,,Total Budget\n,Date,Sum');
  assert.equal(readableContent('Title  \r\n\r\n\r\n\r\nBody​ text\n', 'text/markdown'), 'Title\n\nBody text');
  assert.equal(readableContent('{"a":"x​y"}\r\n', 'application/json'), '{"a":"x​y"}\n');
});
