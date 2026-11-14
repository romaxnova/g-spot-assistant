import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { makePdf, makePng } from '../../test-fixtures.js';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { driveTools } from './drive.js';
import { GOOGLE_MIME } from './drive-files.js';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const GMAIL = '/gmail/v1/users/me';
const ID = 'file1';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function run(name: string, args: Record<string, unknown>, ctx: TestContext): Promise<CallToolResult> {
  const def = driveTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return runTool(def, { account: 'me', ...args }, ctx);
}

function endpoint(c: RecordedCall): string {
  return `${c.method} ${c.url.origin}${c.url.pathname}`;
}

/** files.get for ID answers `file`; alt=media answers `media`; everything else goes to `rest`. */
function withFile(file: Record<string, unknown>, media?: Buffer, rest: FakeGoogle = () => undefined): FakeGoogle {
  return (c) => {
    if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${ID}`) {
      if (c.url.searchParams.get('alt') === 'media') return media ? { body: media } : undefined;
      if (c.url.searchParams.get('fields') !== 'thumbnailLink') return { json: file };
    }
    return rest(c);
  };
}

const pdf = makePdf([['Ticket de caisse', 'Total: 42,50 EUR'], ['Merci']]);
const png = makePng(4, 3);
const THUMB = 'https://lh3.googleusercontent.com/drive-storage/AJQWtB=s220';

function thumbnails(link: string = THUMB, image: Buffer = png): FakeGoogle {
  return (c) => {
    if (c.url.pathname === `/drive/v3/files/${ID}` && c.url.searchParams.get('fields') === 'thumbnailLink') return { json: { thumbnailLink: link } };
    if (c.url.hostname === 'lh3.googleusercontent.com') return { body: image, headers: { 'content-type': 'image/png' } };
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Reading binary files
// ---------------------------------------------------------------------------

test('drive_get_file extracts the text of a PDF', async () => {
  const ctx = createTestContext({ google: withFile({ id: ID, name: 'ticket.pdf', mimeType: 'application/pdf', size: String(pdf.length) }, pdf) });
  const out = resultJson(await run('drive_get_file', { file_id: ID }, ctx));
  assert.equal(out['content'], '## Page 1\nTicket de caisse\nTotal: 42,50 EUR\n\n## Page 2\nMerci');
  assert.equal(out['content_format'], 'text/markdown');
  assert.equal(out['extracted_from'], 'pdf');
  const download = apiCalls(ctx)[1]!;
  assert.equal(download.url.searchParams.get('alt'), 'media');
  assert.equal(download.url.searchParams.get('supportsAllDrives'), 'true');

  const paged = resultJson(await run('drive_get_file', { file_id: ID, max_chars: 200, offset: 30 }, ctx));
  assert.equal(paged['content'], '## Page 1\nTicket de caisse\nTotal: 42,50 EUR\n\n## Page 2\nMerci'.slice(30));
});

test('drive_get_file returns small images as image content', async () => {
  const ctx = createTestContext({ google: withFile({ id: ID, name: 'dot.png', mimeType: 'image/png', size: String(png.length) }, png) });
  const res = await run('drive_get_file', { file_id: ID }, ctx);
  assert.equal(res.content.length, 2);
  assert.deepEqual(res.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.equal(resultJson(res)['content_note'], 'The image follows.');
});

test('large and HEIC images are shown through Drive’s preview without downloading them', async () => {
  const big = { id: ID, name: 'IMG_0001.jpg', mimeType: 'image/jpeg', size: String(6 * 1024 * 1024) };
  const ctx = createTestContext({ google: withFile(big, undefined, thumbnails()) });
  const res = await run('drive_get_file', { file_id: ID }, ctx);
  assert.deepEqual(res.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.equal(resultJson(res)['content_note'], "The image is 6 MB; Drive's preview of it (at most 1600 px) follows.");
  const fetched = apiCalls(ctx).at(-1)!;
  assert.equal(fetched.url.href, 'https://lh3.googleusercontent.com/drive-storage/AJQWtB=s1600');
  assert.equal(fetched.headers['authorization'], 'Bearer test-access-token');
  assert.ok(!apiCalls(ctx).some((c) => c.url.searchParams.get('alt') === 'media'), 'the original is not downloaded');

  const heic = createTestContext({ google: withFile({ id: ID, name: 'IMG.HEIC', mimeType: 'image/heic', size: '2000' }, undefined, thumbnails()) });
  const heicRes = await run('drive_get_file', { file_id: ID }, heic);
  assert.equal(heicRes.content[1]?.type, 'image');
  assert.match(String(resultJson(heicRes)['content_note']), /image\/heic images cannot be shown as they are; Drive's preview/);

  // A small JPEG is sent as it is; a 2 MB one without a Drive preview is described, not sent (it would not fit a tool result).
  const small = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60 * 1024)]);
  const smallCtx = createTestContext({ google: withFile({ id: ID, name: 's.jpg', mimeType: 'image/jpeg', size: String(small.length) }, small, thumbnails('')) });
  assert.deepEqual((await run('drive_get_file', { file_id: ID }, smallCtx)).content[1], { type: 'image', data: small.toString('base64'), mimeType: 'image/jpeg' });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024)]);
  const noPreview = createTestContext({ google: withFile({ id: ID, name: 'b.jpg', mimeType: 'image/jpeg', size: String(jpeg.length) }, jpeg, thumbnails('')) });
  const original = await run('drive_get_file', { file_id: ID }, noPreview);
  assert.equal(original.content.length, 1);
  assert.match(String(resultJson(original)['content_note']), /The image is 2\.0 MB, above the 96 KB a tool result can carry, and Drive has no preview of it that fits/);
});

test('Drive previews step down in size until one fits a tool result', async () => {
  const bigThumb = Buffer.concat([png, Buffer.alloc(200 * 1024)]);
  const sizes: string[] = [];
  const ctx = createTestContext({
    google: withFile({ id: ID, name: 'photo.jpg', mimeType: 'image/jpeg', size: String(5 * 1024 * 1024) }, undefined, (c) => {
      if (c.url.pathname === `/drive/v3/files/${ID}` && c.url.searchParams.get('fields') === 'thumbnailLink') return { json: { thumbnailLink: THUMB } };
      if (c.url.hostname === 'lh3.googleusercontent.com') {
        sizes.push(c.url.pathname.split('=').pop()!);
        return { body: c.url.pathname.endsWith('=s800') ? png : bigThumb };
      }
      return undefined;
    }),
  });
  const res = await run('drive_get_file', { file_id: ID }, ctx);
  assert.deepEqual(sizes, ['s1600', 's1200', 's800']);
  assert.deepEqual(res.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.equal(resultJson(res)['content_note'], "The image is 5 MB; Drive's preview of it (at most 800 px) follows.");

  const tooBig = createTestContext({ google: withFile({ id: ID, name: 'photo.jpg', mimeType: 'image/jpeg', size: String(5 * 1024 * 1024) }, undefined, thumbnails(THUMB, bigThumb)) });
  const none = await run('drive_get_file', { file_id: ID }, tooBig);
  assert.equal(none.content.length, 1, 'no preview small enough: nothing oversized is sent');
  assert.match(String(resultJson(none)['content_note']), /no preview of it that fits/);
});

test('the preview is only fetched from Google hosts, and a refused preview does not flag the account', async () => {
  const foreign = createTestContext({ google: withFile({ id: ID, name: 'a.heic', mimeType: 'image/heic' }, undefined, thumbnails('https://thumbs.example.com/x=s220')) });
  const res = await run('drive_get_file', { file_id: ID }, foreign);
  assert.equal(res.content.length, 1);
  assert.match(String(resultJson(res)['content_note']), /Open web_view_link to view it/);
  assert.ok(!apiCalls(foreign).some((c) => c.url.hostname === 'thumbs.example.com'));

  const refused = createTestContext({
    google: withFile({ id: ID, name: 'a.heic', mimeType: 'image/heic' }, undefined, (c) =>
      c.url.hostname === 'lh3.googleusercontent.com' ? { status: 401, text: 'Unauthorized' } : thumbnails()(c),
    ),
  });
  const out = await run('drive_get_file', { file_id: ID }, refused);
  assert.equal(out.isError, undefined);
  assert.equal(out.content.length, 1);
  assert.equal(refused.accounts.get('me')?.status, 'ok', 'a content-host 401 is not a credential problem');
  assert.equal(apiCalls(refused).filter((c) => c.url.hostname === 'lh3.googleusercontent.com').length, 1, 'no refresh-and-retry');
});

test('a scanned PDF falls back to the preview of its first page; a Google Drawing is exported as PNG', async () => {
  const scan = makePdf([[]]);
  const ctx = createTestContext({ google: withFile({ id: ID, name: 'scan.pdf', mimeType: 'application/pdf', size: String(scan.length) }, scan, thumbnails()) });
  const res = await run('drive_get_file', { file_id: ID }, ctx);
  assert.equal(res.content[1]?.type, 'image');
  assert.match(String(resultJson(res)['content_note']), /no text layer.*Drive's preview of the first page follows \(at most 1600 px\)/);

  const drawing = createTestContext({
    google: withFile({ id: ID, name: 'Diagram', mimeType: 'application/vnd.google-apps.drawing' }, undefined, (c) =>
      c.url.pathname === `/drive/v3/files/${ID}/export` && c.url.searchParams.get('mimeType') === 'image/png' ? { body: png } : undefined,
    ),
  });
  const drawn = await run('drive_get_file', { file_id: ID }, drawing);
  assert.deepEqual(drawn.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
});

// ---------------------------------------------------------------------------
// Creating from bytes
// ---------------------------------------------------------------------------

const created = { id: 'new1', name: 'x', mimeType: 'application/pdf', webViewLink: 'https://drive/new1', parents: ['root'] };

test('drive_create_file uploads content_base64 as a file, typed by content_mime_type, the name or the bytes', async () => {
  const ctx = createTestContext({ google: () => ({ json: created }) });
  const bytes = Buffer.from('%PDF-1.4 hello');
  await run('drive_create_file', { name: 'hello.pdf', content_base64: bytes.toString('base64') }, ctx);
  let c = apiCalls(ctx).at(-1)!;
  assert.equal(endpoint(c), `POST ${UPLOAD}/files`);
  assert.equal(c.url.searchParams.get('uploadType'), 'multipart');
  assert.match(c.body!, /\r\n\r\n\{"name":"hello\.pdf"\}\r\n/);
  assert.match(c.body!, /Content-Type: application\/pdf\r\n\r\n%PDF-1\.4 hello\r\n/);

  await run('drive_create_file', { name: 'no-extension', content_base64: bytes.toString('base64') }, ctx);
  assert.match(apiCalls(ctx).at(-1)!.body!, /Content-Type: application\/pdf\r\n/, 'sniffed from the bytes');

  await run('drive_create_file', { name: 'Scan', kind: 'document', content_base64: bytes.toString('base64'), content_mime_type: 'application/pdf' }, ctx);
  assert.match(apiCalls(ctx).at(-1)!.body!, new RegExp(`\\{"name":"Scan","mimeType":"${GOOGLE_MIME.document}"\\}`), 'converted by OCR into a Doc');

  const before = apiCalls(ctx).length;
  const slides = await run('drive_create_file', { name: 'Deck', kind: 'presentation', content_base64: bytes.toString('base64'), content_mime_type: 'application/pdf' }, ctx);
  assert.match(resultText(slides), /Google cannot convert application\/pdf into a Google Slides deck; it converts PowerPoint/);
  const junk = await run('drive_create_file', { name: 'x.bin', content_base64: '@@@' }, ctx);
  assert.match(resultText(junk), /not valid base64/);
  const text = await run('drive_create_file', { name: 'Doc', kind: 'document', content: 'a,b', content_mime_type: 'text/csv' }, ctx);
  assert.match(resultText(text), /Google cannot convert text\/csv into a Google Doc/);
  const both = await run('drive_create_file', { name: 'x', content: 'a', content_base64: 'YQ==' }, ctx);
  assert.match(resultText(both), /Give only one of content, content_base64 or source \(got content and content_base64\)/);
  const nameless = await run('drive_create_file', { content: 'a' }, ctx);
  assert.match(resultText(nameless), /name is required/);
  assert.equal(apiCalls(ctx).length, before, 'refused before calling Google');
});

test('uploads above 5 MB open a resumable session and PUT the bytes to the returned upload URL', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 0x61);
  const session = `${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&upload_id=xyz`;
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'POST' && c.url.searchParams.get('uploadType') === 'resumable') return { json: {}, headers: { location: session } };
      if (c.method === 'PUT' && c.url.href === session) return { json: { ...created, name: 'big.bin', size: String(big.length) } };
      return undefined;
    },
  });
  const out = resultJson(await run('drive_create_file', { name: 'big.bin', content_base64: big.toString('base64'), parent_folder_id: 'folderA' }, ctx));
  assert.equal(out['size'], big.length);
  const [open, put] = apiCalls(ctx);
  assert.equal(endpoint(open!), `POST ${UPLOAD}/files`);
  assert.equal(open!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(open!.headers['x-upload-content-type'], 'application/octet-stream');
  assert.equal(open!.headers['x-upload-content-length'], String(big.length));
  assert.equal(open!.headers['content-type'], 'application/json; charset=UTF-8');
  assert.deepEqual(open!.json, { name: 'big.bin', parents: ['folderA'] });
  assert.equal(put!.url.href, session);
  assert.equal(put!.headers['content-type'], 'application/octet-stream');
  assert.equal(put!.body!.length, big.length);

  const rogue = createTestContext({ google: (c) => (c.method === 'POST' ? { json: {}, headers: { location: 'https://upload.example.com/upload/x' } } : { json: created }) });
  const res = await run('drive_create_file', { name: 'big.bin', content_base64: big.toString('base64') }, rogue);
  assert.equal(res.isError, true);
  assert.match(resultText(res), /did not open an upload session/);
  assert.equal(apiCalls(rogue).length, 1, 'the bytes never leave for another host');
});

// ---------------------------------------------------------------------------
// Creating from a source
// ---------------------------------------------------------------------------

function sourcesFake(calls: { copy?: unknown } = {}): FakeGoogle {
  return (c) => {
    const p = c.url.pathname;
    if (p === '/drive/v3/files/docx1') return { json: { id: 'docx1', name: 'Report.docx', mimeType: DOCX, size: '4' } };
    if (p === '/drive/v3/files/doc1') return { json: { id: 'doc1', name: 'Plan', mimeType: GOOGLE_MIME.document } };
    if (p === '/drive/v3/files/doc1/export') return { body: Buffer.from(`export ${c.url.searchParams.get('mimeType')}`) };
    if (p.endsWith('/copy')) return { json: calls.copy ?? { id: 'copy1', name: 'copy', mimeType: GOOGLE_MIME.document } };
    if (c.url.origin + p === `${UPLOAD}/files`) return { json: { id: 'up1', name: 'uploaded', mimeType: 'application/pdf' } };
    if (p === `${GMAIL}/messages/m1`) {
      return { json: { id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [{ partId: '1', mimeType: 'application/pdf', filename: 'ticket.pdf', body: { attachmentId: 'A1', size: 9 } }] } } };
    }
    if (p === `${GMAIL}/messages/m1/attachments/A1`) return { json: { size: 9, data: b64url('%PDF-1.4\n') } };
    return undefined;
  };
}

test('a Drive file of the same account is copied inside Google, converted when kind asks for it', async () => {
  const ctx = createTestContext({ google: sourcesFake() });
  const out = resultJson(await run('drive_create_file', { source: { drive_file_id: 'docx1' }, parent_folder_id: 'folderB' }, ctx));
  let c = apiCalls(ctx).at(-1)!;
  assert.equal(endpoint(c), `POST ${BASE}/files/docx1/copy`);
  assert.equal(c.url.searchParams.get('supportsAllDrives'), 'true');
  assert.deepEqual(c.json, { name: 'Report.docx', parents: ['folderB'] });
  assert.equal(out['how'], 'copied within Drive');

  // Without parent_folder_id the copy goes to My Drive's root, not next to the original.
  const converted = resultJson(await run('drive_create_file', { source: { drive_file_id: 'docx1' }, kind: 'document' }, ctx));
  c = apiCalls(ctx).at(-1)!;
  assert.deepEqual(c.json, { name: 'Report', parents: ['root'], mimeType: GOOGLE_MIME.document });
  assert.equal(converted['how'], 'copied within Drive and converted to a Google document');

  await run('drive_create_file', { source: { drive_file_id: 'doc1' }, name: 'Plan (copy)' }, ctx);
  assert.deepEqual(apiCalls(ctx).at(-1)!.json, { name: 'Plan (copy)', parents: ['root'] });

  const wrong = await run('drive_create_file', { source: { drive_file_id: 'doc1' }, kind: 'spreadsheet' }, ctx);
  assert.match(resultText(wrong), /A Google document cannot become a spreadsheet/);
  const notImportable = await run('drive_create_file', { source: { drive_file_id: 'docx1' }, kind: 'presentation' }, ctx);
  assert.match(resultText(notImportable), /cannot convert .*wordprocessingml\.document into a Google Slides deck/);
});

test('a Google Doc saved as a file is exported (docx by default, or export_format) and uploaded', async () => {
  const ctx = createTestContext({ google: sourcesFake() });
  const out = resultJson(await run('drive_create_file', { source: { drive_file_id: 'doc1' }, kind: 'file' }, ctx));
  let c = apiCalls(ctx).at(-1)!;
  assert.equal(endpoint(c), `POST ${UPLOAD}/files`);
  assert.match(c.body!, /\r\n\r\n\{"name":"Plan\.docx"\}\r\n/);
  assert.match(c.body!, new RegExp(`Content-Type: ${DOCX.replace(/\./g, '\\.')}\\r\\n\\r\\nexport ${DOCX.replace(/\./g, '\\.')}\\r\\n`));
  assert.equal(out['how'], 'uploaded from drive:doc1');

  await run('drive_create_file', { source: { drive_file_id: 'doc1', export_format: 'pdf' } }, ctx);
  c = apiCalls(ctx).at(-1)!;
  assert.match(c.body!, /\{"name":"Plan\.pdf"\}/);
  assert.match(c.body!, /Content-Type: application\/pdf\r\n\r\nexport application\/pdf\r\n/);
});

test('copies from another linked account travel through the connector; Google files stay Google files', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'me' }, { alias: 'other' }], google: sourcesFake() });
  const out = resultJson(await run('drive_create_file', { source: { drive_file_id: 'doc1', from_account: 'other' } }, ctx));
  const exportCall = apiCalls(ctx).find((c) => c.url.pathname.endsWith('/export'))!;
  assert.equal(exportCall.url.searchParams.get('mimeType'), DOCX);
  const up = apiCalls(ctx).at(-1)!;
  assert.equal(endpoint(up), `POST ${UPLOAD}/files`);
  assert.match(up.body!, new RegExp(`\\{"name":"Plan","mimeType":"${GOOGLE_MIME.document}"\\}`));
  assert.match(String(out['how']), /uploaded from drive:doc1 and converted to a Google document/);
  assert.ok(!apiCalls(ctx).some((c) => c.url.pathname.endsWith('/copy')), 'files.copy cannot cross accounts');
  assert.ok(ctx.accounts.get('other')?.lastUsedAt);
});

test('an email attachment is saved to Drive as it is, or converted', async () => {
  const ctx = createTestContext({ google: sourcesFake() });
  await run('drive_create_file', { source: { gmail_message_id: 'm1', gmail_part_id: '1' }, parent_folder_id: 'receipts' }, ctx);
  let c = apiCalls(ctx).at(-1)!;
  assert.match(c.body!, /\{"name":"ticket\.pdf","parents":\["receipts"\]\}/);
  assert.match(c.body!, /Content-Type: application\/pdf\r\n\r\n%PDF-1\.4\n\r\n/);

  await run('drive_create_file', { source: { gmail_message_id: 'm1', gmail_part_id: '1' }, kind: 'document' }, ctx);
  c = apiCalls(ctx).at(-1)!;
  assert.match(c.body!, new RegExp(`\\{"name":"ticket","mimeType":"${GOOGLE_MIME.document}"\\}`));

  const both = await run('drive_create_file', { source: { gmail_message_id: 'm1', gmail_part_id: '1', drive_file_id: 'doc1' } }, ctx);
  assert.match(resultText(both), /source needs exactly one source: drive_file_id, gmail_message_id with gmail_part_id, or upload_id \(got drive and gmail\)/);
  const folder = await run('drive_create_file', { kind: 'folder', name: 'x', source: { drive_file_id: 'doc1' } }, ctx);
  assert.match(resultText(folder), /A folder cannot have content; drop `source`/);
});

// ---------------------------------------------------------------------------
// Replacing content
// ---------------------------------------------------------------------------

test('drive_update_file replaces content with bytes or another file', async () => {
  const updated = { id: ID, name: 'notes.md', mimeType: 'text/markdown' };
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${ID}`) return { json: { name: 'notes.md', mimeType: 'text/markdown' } };
      if (c.method === 'PATCH') return { json: updated };
      return sourcesFake()(c);
    },
  });
  await run('drive_update_file', { file_id: ID, content_base64: png.toString('base64') }, ctx);
  let c = apiCalls(ctx).at(-1)!;
  assert.equal(endpoint(c), `PATCH ${UPLOAD}/files/${ID}`);
  assert.match(c.headers['content-type']!, /^multipart\/related/);
  assert.match(c.body!, /Content-Type: image\/png\r\n/);

  await run('drive_update_file', { file_id: ID, content_base64: Buffer.from('# Title').toString('base64') }, ctx);
  c = apiCalls(ctx).at(-1)!;
  assert.match(c.body!, /Content-Type: text\/markdown; charset=UTF-8\r\n\r\n# Title\r\n/, 'type taken from the current file name');

  await run('drive_update_file', { file_id: ID, source: { gmail_message_id: 'm1', gmail_part_id: '1' }, name: 'ticket.pdf' }, ctx);
  c = apiCalls(ctx).at(-1)!;
  assert.match(c.body!, /\{"name":"ticket\.pdf"\}/);
  assert.match(c.body!, /Content-Type: application\/pdf\r\n\r\n%PDF-1\.4\n\r\n/);

  const two = await run('drive_update_file', { file_id: ID, content: 'a', source: { drive_file_id: 'doc1' } }, ctx);
  assert.match(resultText(two), /Give only one of content, content_base64 or source/);
});

const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest of a package')]);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function updateCtx(current: Record<string, unknown>) {
  return createTestContext({
    google: (c) => {
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${ID}`) return { json: current };
      if (c.method === 'PATCH') return { json: { id: ID, ...current } };
      return undefined;
    },
  });
}

test('drive_update_file types content_base64 by name before bytes: an Office file stays an Office file', async () => {
  const word = updateCtx({ name: 'Report.docx', mimeType: DOCX });
  await run('drive_update_file', { file_id: ID, content_base64: ZIP_BYTES.toString('base64') }, word);
  assert.match(apiCalls(word).at(-1)!.body!, new RegExp(`Content-Type: ${DOCX.replace(/\./g, '\\.')}\r\n`), 'not application/zip');

  const renamed = updateCtx({ name: 'Report.docx', mimeType: DOCX });
  await run('drive_update_file', { file_id: ID, name: 'Budget.xlsx', content_base64: ZIP_BYTES.toString('base64') }, renamed);
  assert.match(apiCalls(renamed).at(-1)!.body!, new RegExp(`Content-Type: ${XLSX.replace(/\./g, '\\.')}\r\n`), 'the new name wins');
});

test('drive_update_file into a Google file sends only what Google converts, never a Google type', async () => {
  const sheet = updateCtx({ name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet });
  await run('drive_update_file', { file_id: ID, content_base64: ZIP_BYTES.toString('base64') }, sheet);
  const patch = apiCalls(sheet).at(-1)!;
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.body!, new RegExp(`Content-Type: ${XLSX.replace(/\./g, '\\.')}\r\n`), 'a ZIP going into a Sheet is an Excel file');

  const doc = updateCtx({ name: 'Plan', mimeType: GOOGLE_MIME.document });
  const html = Buffer.from('<h1>New plan</h1>').toString('base64');
  const refused = await run('drive_update_file', { file_id: ID, content_base64: html }, doc);
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), /Google cannot convert application\/octet-stream into a Google Doc/);
  assert.ok(!apiCalls(doc).some((c) => c.method === 'PATCH'));
  await run('drive_update_file', { file_id: ID, content_base64: html, content_mime_type: 'text/html' }, doc);
  assert.match(apiCalls(doc).at(-1)!.body!, /Content-Type: text\/html; charset=UTF-8\r\n\r\n<h1>New plan<\/h1>/);

  const form = updateCtx({ name: 'Survey', mimeType: 'application/vnd.google-apps.form' });
  assert.match(resultText(await run('drive_update_file', { file_id: ID, content_base64: html, content_mime_type: 'text/html' }, form)), /content of a Google form cannot be replaced/);
});

test('a text attachment in Latin-1 becomes a UTF-8 Sheet with its accents intact', async () => {
  const latin1 = Buffer.from('Libellé;Débit\nCafé;3,50\n', 'latin1');
  const ctx = createTestContext({
    google: (c) => {
      const p = c.url.pathname;
      if (p === `${GMAIL}/messages/bank`) {
        return {
          json: {
            id: 'bank',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [{ partId: '1', mimeType: 'text/csv', filename: 'releve.csv', headers: [{ name: 'Content-Type', value: 'text/csv; charset=ISO-8859-1' }], body: { attachmentId: 'CSV', size: latin1.length } }],
            },
          },
        };
      }
      if (p === `${GMAIL}/messages/bank/attachments/CSV`) return { json: { size: latin1.length, data: b64url(latin1) } };
      if (c.url.origin + p === `${UPLOAD}/files`) return { json: { id: 's1', name: 'releve', mimeType: GOOGLE_MIME.spreadsheet } };
      return undefined;
    },
  });
  await run('drive_create_file', { source: { gmail_message_id: 'bank', gmail_part_id: '1' }, kind: 'spreadsheet' }, ctx);
  const up = apiCalls(ctx).at(-1)!;
  assert.match(up.body!, new RegExp(`\\{"name":"releve","mimeType":"${GOOGLE_MIME.spreadsheet}"\\}`));
  assert.match(up.body!, /Content-Type: text\/csv; charset=UTF-8\r\n\r\nLibellé;Débit\nCafé;3,50\n\r\n/);
});

test('text content_mime_type is validated like every other type', async () => {
  const ctx = createTestContext({ google: () => ({ json: created }) });
  const bad = await run('drive_create_file', { name: 'x.txt', content: 'a', content_mime_type: 'text/plain\r\nX-Injected: 1' }, ctx);
  assert.match(resultText(bad), /is not a MIME type/);
  const badUpdate = await run('drive_update_file', { file_id: ID, content: 'a', content_mime_type: 'text/plain\nX: 1' }, ctx);
  assert.match(resultText(badUpdate), /is not a MIME type/);
  assert.equal(apiCalls(ctx).length, 0);
  await run('drive_create_file', { name: 'x.csv', content: 'a,b', content_mime_type: 'text/csv; charset=windows-1252' }, ctx);
  assert.match(apiCalls(ctx).at(-1)!.body!, /Content-Type: text\/csv; charset=UTF-8\r\n/, 'the text is UTF-8 whatever the label said');
});

test('a file staged from the chat is saved to Drive by upload_id', async () => {
  const ctx = createTestContext({ google: sourcesFake() });
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 chat'), { filename: 'contract.pdf' });
  const out = resultJson(await run('drive_create_file', { source: { upload_id: staged.id }, parent_folder_id: 'contracts' }, ctx));
  const c = apiCalls(ctx).at(-1)!;
  assert.equal(endpoint(c), `POST ${UPLOAD}/files`);
  assert.match(c.body!, /\{"name":"contract\.pdf","parents":\["contracts"\]\}/);
  assert.match(c.body!, /Content-Type: application\/pdf\r\n\r\n%PDF-1\.4 chat\r\n/);
  assert.equal(out['how'], `uploaded from upload:${staged.id}`);
});
