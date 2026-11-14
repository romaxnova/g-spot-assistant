import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../../google/client.js';
import { makePng } from '../../test-fixtures.js';
import { apiCalls, createTestContext, type RecordedCall } from '../../test-support.js';
import { ToolInputError } from '../registry.js';
import { GOOGLE_MIME } from './drive-files.js';
import { chooseExport, decodeBase64Strict, expandUploadLinks, normalizeMime, resolveFile, sourceKind, type ResolveOptions } from './file-sources.js';

const OPTS: ResolveOptions = { maxBytes: 1024 * 1024, nativeDefault: 'pdf' };
const DRIVE = '/drive/v3/files';
const GMAIL = '/gmail/v1/users/me';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('sourceKind wants exactly one source', () => {
  assert.equal(sourceKind({ drive_file_id: 'x' }), 'drive');
  assert.equal(sourceKind({ gmail_message_id: 'm', gmail_part_id: '1' }), 'gmail');
  assert.equal(sourceKind({ content: '' }), 'content', 'empty text is a valid, empty file');
  assert.equal(sourceKind({ content_base64: 'AA==' }), 'base64');
  assert.throws(() => sourceKind({}), /exactly one source/);
  assert.throws(() => sourceKind({ drive_file_id: 'x', content: 'y' }), /got drive and content/);
  assert.throws(() => sourceKind({ gmail_part_id: '1', content_base64: 'AA==' }), /got gmail and base64/);
});

test('decodeBase64Strict takes standard, URL-safe, data-URL and wrapped base64, and refuses anything else', () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x00, 0x41]);
  const forms = [
    bytes.toString('base64'),
    bytes.toString('base64url'),
    `data:application/octet-stream;base64,${bytes.toString('base64')}`,
    bytes.toString('base64').replace(/(.{2})/g, '$1\r\n'),
  ];
  for (const form of forms) assert.deepEqual(decodeBase64Strict(form, 'f'), bytes, form);
  assert.throws(() => decodeBase64Strict('not base64!', 'f.bin'), (e: Error) => e instanceof ToolInputError && /content_base64 of "f\.bin" is not valid base64/.test(e.message));
  assert.throws(() => decodeBase64Strict('abcde', 'f.bin'), ToolInputError, 'a length of 4n+1 cannot be base64');
});

test('normalizeMime keeps type/subtype, refuses header injection, falls back for untrusted values', () => {
  assert.equal(normalizeMime('Text/CSV; charset=utf-8'), 'text/csv');
  assert.equal(normalizeMime(DOCX), DOCX);
  assert.equal(normalizeMime('image/svg+xml'), 'image/svg+xml');
  assert.throws(() => normalizeMime('text/plain\r\nBcc: x@example.com'), ToolInputError);
  assert.throws(() => normalizeMime('pdf'), /is not a MIME type/);
  assert.equal(normalizeMime('garbage', 'application/octet-stream'), 'application/octet-stream');
  assert.equal(normalizeMime(undefined, ''), '');
});

test('chooseExport: PDF or the editable Office format by default, and only formats Google offers for the type', () => {
  assert.equal(chooseExport(GOOGLE_MIME.document, undefined, 'pdf'), 'pdf');
  assert.equal(chooseExport(GOOGLE_MIME.document, undefined, 'office'), 'docx');
  assert.equal(chooseExport(GOOGLE_MIME.spreadsheet, undefined, 'office'), 'xlsx');
  assert.equal(chooseExport(GOOGLE_MIME.presentation, 'png', 'pdf'), 'png');
  assert.throws(() => chooseExport(GOOGLE_MIME.spreadsheet, 'docx', 'pdf'), /cannot be exported as docx; choose one of: pdf, xlsx, ods, csv, tsv/);
  assert.throws(() => chooseExport('application/vnd.google-apps.form', undefined, 'pdf'), /cannot be exported as a file/);
});

test('resolveFile: text content needs a file name; the type comes from the extension, text gets a UTF-8 charset', async () => {
  const ctx = createTestContext();
  const csv = await resolveFile(ctx, 'me', { content: 'a,é\n', filename: 'data.csv' }, OPTS);
  assert.deepEqual([csv.filename, csv.mimeType, csv.data.toString('utf8'), csv.origin], ['data.csv', 'text/csv; charset=UTF-8', 'a,é\n', 'content']);
  assert.equal((await resolveFile(ctx, 'me', { content: 'BEGIN:VCALENDAR', filename: 'invite.ics' }, OPTS)).mimeType, 'text/calendar; charset=UTF-8');
  assert.equal((await resolveFile(ctx, 'me', { content: '{}', filename: 'x', mime_type: 'application/json' }, OPTS)).mimeType, 'application/json');
  assert.equal((await resolveFile(ctx, 'me', { content: 'hello', filename: 'notes' }, OPTS)).mimeType, 'text/plain; charset=UTF-8');
  await assert.rejects(resolveFile(ctx, 'me', { content: 'x' }, OPTS), /needs a filename/);
  await assert.rejects(resolveFile(ctx, 'me', { content: 'x', filename: 'a.txt', mime_type: 'text/plain\nX: y' }, OPTS), /is not a MIME type/);
  await assert.rejects(resolveFile(ctx, 'me', { content: 'x'.repeat(20), filename: 'a.txt' }, { ...OPTS, maxBytes: 10 }), /"a\.txt" is .* MB, above the .* MB limit/);

  const png = makePng();
  const image = await resolveFile(ctx, 'me', { content_base64: png.toString('base64'), filename: 'pixel' }, OPTS);
  assert.equal(image.mimeType, 'image/png', 'sniffed when the name has no extension');
  assert.deepEqual(image.data, png);
  await assert.rejects(resolveFile(ctx, 'me', { content_base64: png.toString('base64') }, OPTS), /needs a filename/);
  assert.equal(apiCalls(ctx).length, 0, 'content sources never call Google');
});

function driveFake(): (c: RecordedCall) => { json?: unknown; body?: Buffer } | undefined {
  return (c) => {
    const p = c.url.pathname;
    const alt = c.url.searchParams.get('alt');
    if (p === `${DRIVE}/bin1` && alt === null) return { json: { id: 'bin1', name: 'scan.pdf', mimeType: 'application/pdf', size: '13' } };
    if (p === `${DRIVE}/bin1` && alt === 'media') return { body: Buffer.from('%PDF-1.4 fake') };
    if (p === `${DRIVE}/doc1`) return { json: { id: 'doc1', name: 'Plan', mimeType: GOOGLE_MIME.document } };
    if (p === `${DRIVE}/doc1/export`) return { body: Buffer.from(`exported as ${c.url.searchParams.get('mimeType')}`) };
    if (p === `${DRIVE}/lnk`) return { json: { id: 'lnk', name: 'shortcut', mimeType: GOOGLE_MIME.shortcut, shortcutDetails: { targetId: 'bin1' } } };
    if (p === `${DRIVE}/dir`) return { json: { id: 'dir', name: 'Photos', mimeType: GOOGLE_MIME.folder } };
    return undefined;
  };
}

test('resolveFile: Drive files are downloaded; Google Docs are exported (PDF by default, the Office format for copies, or export_format)', async () => {
  const ctx = createTestContext({ google: driveFake() });
  const file = await resolveFile(ctx, 'me', { drive_file_id: 'bin1' }, OPTS);
  assert.deepEqual([file.filename, file.mimeType, file.data.toString(), file.origin, file.sourceMimeType], ['scan.pdf', 'application/pdf', '%PDF-1.4 fake', 'drive:bin1', 'application/pdf']);
  const [meta, download] = apiCalls(ctx);
  assert.equal(meta!.url.searchParams.get('fields'), 'id,name,mimeType,size,shortcutDetails');
  assert.equal(meta!.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(download!.url.searchParams.get('supportsAllDrives'), 'true');

  const pdf = await resolveFile(ctx, 'me', { drive_file_id: 'https://docs.google.com/document/d/doc1/edit' }, OPTS);
  assert.deepEqual([pdf.filename, pdf.mimeType, pdf.data.toString(), pdf.sourceName, pdf.sourceMimeType], ['Plan.pdf', 'application/pdf', 'exported as application/pdf', 'Plan', GOOGLE_MIME.document]);
  const docx = await resolveFile(ctx, 'me', { drive_file_id: 'doc1' }, { ...OPTS, nativeDefault: 'office' });
  assert.deepEqual([docx.filename, docx.mimeType], ['Plan.docx', DOCX]);
  const md = await resolveFile(ctx, 'me', { drive_file_id: 'doc1', export_format: 'md', filename: 'Plan (notes).md' }, OPTS);
  assert.deepEqual([md.filename, md.mimeType, md.data.toString()], ['Plan (notes).md', 'text/markdown', 'exported as text/markdown']);

  assert.equal((await resolveFile(ctx, 'me', { drive_file_id: 'lnk' }, OPTS)).filename, 'scan.pdf', 'shortcuts are followed');
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'dir' }, OPTS), /"Photos" is a folder/);
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'bin1', export_format: 'pdf' }, OPTS), /export_format only applies to Google Docs/);
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'doc1', export_format: 'xlsx' }, OPTS), /cannot be exported as xlsx/);
  await assert.rejects(resolveFile(ctx, 'me', { content: 'x', filename: 'a', export_format: 'pdf' }, OPTS), /export_format only applies to a drive_file_id source/);
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'not a url' }, OPTS), ToolInputError);

  const before = apiCalls(ctx).length;
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'bin1' }, { ...OPTS, maxBytes: 4 }), /"scan\.pdf" is .* MB, above the/);
  assert.equal(apiCalls(ctx).length, before + 1, 'refused from the metadata, before downloading');
});

test('resolveFile: a Drive export Google refuses as too large gets a clear message', async () => {
  const ctx = createTestContext({
    google: (c) =>
      c.url.pathname.endsWith('/export')
        ? { status: 403, json: { error: { code: 403, message: 'This file is too large to be exported.', errors: [{ reason: 'exportSizeLimitExceeded' }] } } }
        : driveFake()(c),
  });
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'doc1' }, OPTS), /too large for Google to export as pdf \(the export limit is 10 MB\)/);
});

const gmailMessage = {
  id: 'm1',
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: b64url('hi'), size: 2 } },
      { partId: '1', mimeType: 'application/pdf', filename: 'ticket.pdf', body: { attachmentId: 'FRESH-ID', size: 5 } },
      { partId: '2', mimeType: 'application/octet-stream', filename: 'small.csv', body: { data: b64url('a,b'), size: 3 } },
    ],
  },
};

function gmailFake(): (c: RecordedCall) => { json?: unknown } | undefined {
  return (c) => {
    const p = c.url.pathname.replace(GMAIL, '');
    if (p === '/messages/m1') return { json: gmailMessage };
    if (p === '/messages/m1/attachments/FRESH-ID' || p === '/messages/m1/attachments/OLD-ID') return { json: { size: 5, data: b64url('%PDF-') } };
    return undefined;
  };
}

test('resolveFile: Gmail attachments are found by part id in a fresh fetch, or by an older attachment id and their size', async () => {
  const ctx = createTestContext({ google: gmailFake() });
  const byPart = await resolveFile(ctx, 'me', { gmail_message_id: 'm1', gmail_part_id: '1' }, OPTS);
  assert.deepEqual([byPart.filename, byPart.mimeType, byPart.data.toString(), byPart.origin], ['ticket.pdf', 'application/pdf', '%PDF-', 'gmail:m1/1']);
  const [fetch, download] = apiCalls(ctx);
  assert.equal(fetch!.url.searchParams.get('format'), 'full');
  assert.equal(download!.url.pathname, `${GMAIL}/messages/m1/attachments/FRESH-ID`);

  const before = apiCalls(ctx).length;
  const inline = await resolveFile(ctx, 'me', { gmail_message_id: 'm1', gmail_part_id: '2', filename: 'renamed.csv' }, OPTS);
  assert.deepEqual([inline.filename, inline.mimeType, inline.data.toString()], ['renamed.csv', 'text/csv', 'a,b'], 'octet-stream is refined from the file name');
  assert.equal(apiCalls(ctx).length, before + 1, 'bytes embedded in the message need no attachment call');

  const byOldId = await resolveFile(ctx, 'me', { gmail_message_id: 'm1', gmail_attachment_id: 'OLD-ID' }, OPTS);
  assert.deepEqual([byOldId.filename, byOldId.mimeType], ['ticket.pdf', 'application/pdf'], 'the part is recognised by its size');

  await assert.rejects(resolveFile(ctx, 'me', { gmail_message_id: 'm1', gmail_part_id: '9' }, OPTS), /no attachment with part_id "9"\. .*1 \(ticket\.pdf\), 2 \(small\.csv\)/);
  await assert.rejects(resolveFile(ctx, 'me', { gmail_message_id: 'm1' }, OPTS), /Give gmail_part_id/);
  await assert.rejects(resolveFile(ctx, 'me', { gmail_part_id: '1' }, OPTS), /needs gmail_message_id/);
  await assert.rejects(resolveFile(ctx, 'me', { gmail_message_id: 'm1', gmail_part_id: '1' }, { ...OPTS, maxBytes: 4 }), /"ticket\.pdf" is .* MB, above the/);
});

test('resolveFile reads Drive files and Gmail attachments from from_account, which must grant that service', async () => {
  const ctx = createTestContext({
    accounts: [{ alias: 'me' }, { alias: 'mail', services: ['gmail'] }],
    google: (c) => gmailFake()(c) ?? driveFake()(c),
  });
  await assert.rejects(resolveFile(ctx, 'me', { drive_file_id: 'bin1', from_account: 'mail' }, OPTS), (e: Error) => e instanceof AccountError && /was not granted Google Drive/.test(e.message));
  const blob = await resolveFile(ctx, 'me', { gmail_message_id: 'm1', gmail_part_id: '1', from_account: 'mail' }, OPTS);
  assert.equal(blob.filename, 'ticket.pdf');
  assert.ok(ctx.accounts.get('mail')?.lastUsedAt, 'the other account made the calls');
  assert.equal(ctx.accounts.get('me')?.lastUsedAt ?? null, null);
});

test('a link_id stands for every file uploaded through the link', async () => {
  const ctx = createTestContext();
  const link = ctx.uploads.createLink();
  ctx.uploads.consumeLinkFiles(link.token, [{ data: Buffer.from('%PDF-1.4 plan'), filename: 'plan.pdf', mimeType: 'application/pdf' }]);
  const single = await resolveFile(ctx, 'me', { upload_id: link.linkId }, OPTS);
  assert.equal(single.filename, 'plan.pdf', 'a link with one file works as a single source');
  ctx.uploads.consumeLinkFiles(link.token, [{ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filename: 'IMG_1.jpg' }]);
  await assert.rejects(resolveFile(ctx, 'me', { upload_id: link.linkId }, OPTS), /carried 2 files .*: name one upload_id here/);

  const expanded = expandUploadLinks(ctx, [{ upload_id: link.linkId }, { content: 'x', filename: 'x.txt' }])!;
  assert.deepEqual(
    expanded.map((s) => s.upload_id ?? s.filename),
    [...ctx.uploads.list(link.linkId).sort((a, b) => a.createdAt - b.createdAt).map((f) => f.id), 'x.txt'],
    'oldest first, other sources kept in place',
  );
  assert.throws(() => expandUploadLinks(ctx, [{ upload_id: link.linkId, filename: 'renamed.pdf' }]), /filename and sha256 need one upload_id each/);
  assert.throws(() => expandUploadLinks(ctx, [{ upload_id: 'ln_0000000000000000' }]), /Nothing has been uploaded through ln_0000000000000000/);
  const plain = [{ upload_id: 'up_x' }];
  assert.equal(expandUploadLinks(ctx, plain), plain, 'lists without link ids are returned as they are');
});
