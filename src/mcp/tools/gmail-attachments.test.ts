import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { makePdf, makePng } from '../../test-fixtures.js';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { GOOGLE_MIME } from './drive-files.js';
import { gmailTools } from './gmail.js';

const GMAIL = '/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const DRIVE = '/drive/v3/files';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const SENT = { id: 'sent-1', threadId: 't-sent', labelIds: ['SENT'] };

function call(ctx: TestContext, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const def = gmailTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return runTool(def, { account: 'me', ...args }, ctx);
}

function gmailPath(c: RecordedCall): string {
  return c.url.pathname.replace(GMAIL, '');
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function parsePart(raw: string): MimePart {
  const at = raw.indexOf('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of raw.slice(0, at).replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: raw.slice(at + 4) };
}

/** The attachment parts of a sent multipart/mixed message: file name, type and decoded bytes. */
function attachmentsOf(raw: string): { filename: string; type: string; data: Buffer }[] {
  const top = parsePart(raw);
  const boundary = /boundary="([^"]+)"/.exec(top.headers['content-type'] ?? '')?.[1];
  assert.ok(boundary, `multipart/mixed expected, got ${top.headers['content-type']}`);
  return top.body
    .split(`--${boundary}`)
    .slice(2, -1)
    .map((p) => parsePart(p.replace(/^\r\n/, '')))
    .map((p) => ({
      filename: /filename="([^"]*)"/.exec(p.headers['content-disposition'] ?? '')?.[1] ?? '',
      type: p.headers['content-type'] ?? '',
      data: Buffer.from(p.body.replace(/\s+/g, ''), 'base64'),
    }));
}

function sentRaw(c: RecordedCall, draft = false): string {
  const json = c.json as { raw?: string; message?: { raw?: string } };
  return Buffer.from((draft ? json.message?.raw : json.raw) ?? '', 'base64url').toString('utf8');
}

const pdf = makePdf([['Ticket 20260919', 'Total 42,50 EUR']]);
const png = makePng(3, 2);

const withFiles = {
  id: 'm1',
  threadId: 't-m1',
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [{ name: 'Subject', value: 'Your ticket' }],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: b64url('see attached'), size: 12 } },
      { partId: '1', mimeType: 'application/pdf', filename: 'ticket.pdf', body: { attachmentId: 'ATT-PDF', size: pdf.length } },
      { partId: '2', mimeType: 'image/png', filename: 'photo.png', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="photo.png"' }], body: { attachmentId: 'ATT-PNG', size: png.length } },
      { partId: '3', mimeType: 'application/octet-stream', filename: 'scan.pdf', body: { attachmentId: 'ATT-SCAN', size: 100 } },
    ],
  },
};

function gmailFake(c: RecordedCall) {
  const p = gmailPath(c);
  if (p === '/messages/m1') return { json: withFiles };
  if (p === '/messages/m1/attachments/ATT-PDF') return { json: { size: pdf.length, data: b64url(pdf) } };
  if (p === '/messages/m1/attachments/ATT-PNG') return { json: { size: png.length, data: b64url(png) } };
  if (p === '/messages/m1/attachments/ATT-SCAN') return { json: { size: 100, data: b64url(makePdf([[]])) } };
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('gmail_get_message lists part ids for attachments', async () => {
  const ctx = createTestContext({ google: gmailFake });
  const out = resultJson<{ attachments: { part_id: string; filename: string }[] }>(await call(ctx, 'gmail_get_message', { message_id: 'm1' }));
  assert.deepEqual(out.attachments.map((a) => [a.part_id, a.filename]), [['1', 'ticket.pdf'], ['2', 'photo.png'], ['3', 'scan.pdf']]);
});

test('gmail_get_attachment by part_id looks the part up and extracts PDF text', async () => {
  const ctx = createTestContext({ google: gmailFake });
  const out = resultJson(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', part_id: '1' }));
  assert.deepEqual(out, {
    message_id: 'm1',
    part_id: '1',
    filename: 'ticket.pdf',
    mime_type: 'application/pdf',
    size: pdf.length,
    extracted_from: 'pdf',
    format: 'text/markdown',
    text: '## Page 1\nTicket 20260919\nTotal 42,50 EUR',
    truncated: false,
    total_chars: 41,
  });
  assert.deepEqual(apiCalls(ctx).map(gmailPath), ['/messages/m1', '/messages/m1/attachments/ATT-PDF']);
  assert.equal(apiCalls(ctx)[0]!.url.searchParams.get('format'), 'full');
});

test('gmail_get_attachment returns images as image content and explains unreadable files', async () => {
  const ctx = createTestContext({ google: gmailFake });
  const image = await call(ctx, 'gmail_get_attachment', { message_id: 'm1', part_id: '2' });
  assert.equal(image.isError, undefined);
  assert.equal(image.content.length, 2);
  assert.deepEqual(image.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.equal(resultJson<{ filename: string }>(image).filename, 'photo.png');

  // Labelled octet-stream, recognised as a PDF from its bytes; no text layer.
  const scan = resultJson<{ note: string; text?: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', part_id: '3' }));
  assert.match(scan.note, /no text layer/);
  assert.equal(scan.text, undefined);

  const missing = await call(ctx, 'gmail_get_attachment', { message_id: 'm1', part_id: '7' });
  assert.equal(missing.isError, true);
  assert.match(resultText(missing), /no attachment with part_id "7"\. Its attachments: 1 \(ticket\.pdf\), 2 \(photo\.png\), 3 \(scan\.pdf\)/);

  const neither = await call(ctx, 'gmail_get_attachment', { message_id: 'm1' });
  assert.equal(neither.isError, true);
  assert.match(resultText(neither), /Give part_id \(preferred\) or attachment_id/);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function sendFake(c: RecordedCall) {
  const p = c.url.pathname;
  if (p === `${GMAIL}/messages/send`) return { json: SENT };
  if (p === `${DRIVE}/doc1`) return { json: { id: 'doc1', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet } };
  if (p === `${DRIVE}/doc1/export`) return { body: Buffer.from(`%PDF export of ${c.url.searchParams.get('mimeType')}`) };
  return gmailFake(c);
}

test('gmail_send attaches written files, Drive files (Google files as PDF) and attachments of other emails', async () => {
  const ctx = createTestContext({ google: sendFake });
  const res = await call(ctx, 'gmail_send', {
    to: ['ann@example.com'],
    subject: 'Files',
    body_text: 'Here you go',
    attachments: [
      { content: 'name,qty\nwidget,3\n', filename: 'stock.csv' },
      { drive_file_id: 'doc1' },
      { gmail_message_id: 'm1', gmail_part_id: '1', filename: 'ticket-copy.pdf' },
      { content_base64: png.toString('base64'), filename: 'dot.png' },
    ],
  });
  assert.equal(res.isError, undefined, resultText(res));
  assert.deepEqual(resultJson(res), {
    id: 'sent-1',
    thread_id: 't-sent',
    label_ids: ['SENT'],
    attachments: [
      { filename: 'stock.csv', mime_type: 'text/csv', size: 18 },
      { filename: 'Budget.pdf', mime_type: 'application/pdf', size: 30 },
      { filename: 'ticket-copy.pdf', mime_type: 'application/pdf', size: pdf.length },
      { filename: 'dot.png', mime_type: 'image/png', size: png.length },
    ],
    from: 'me@example.com',
    web_url: 'https://mail.google.com/mail/u/me@example.com/#all/sent-1',
  });
  const send = apiCalls(ctx).at(-1)!;
  assert.equal(send.url.pathname, `${GMAIL}/messages/send`);
  const files = attachmentsOf(sentRaw(send));
  assert.deepEqual(files.map((f) => [f.filename, f.type]), [
    ['stock.csv', 'text/csv; charset=UTF-8; name="stock.csv"'],
    ['Budget.pdf', 'application/pdf; name="Budget.pdf"'],
    ['ticket-copy.pdf', 'application/pdf; name="ticket-copy.pdf"'],
    ['dot.png', 'image/png; name="dot.png"'],
  ]);
  assert.equal(files[0]!.data.toString(), 'name,qty\nwidget,3\n');
  assert.equal(files[1]!.data.toString(), '%PDF export of application/pdf');
  assert.deepEqual(files[2]!.data, pdf);
  assert.deepEqual(files[3]!.data, png);
});

test('an unusable attachment is reported by position and nothing is sent', async () => {
  const ctx = createTestContext({ google: sendFake });
  const res = await call(ctx, 'gmail_send', {
    to: ['ann@example.com'],
    subject: 'Files',
    body_text: 'x',
    attachments: [{ content: 'ok', filename: 'a.txt' }, { content: 'no name' }],
  });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /^attachments\[1\]: A content attachment needs a filename/);
  assert.equal(apiCalls(ctx).length, 0);

  const two = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ drive_file_id: 'doc1', content: 'x', filename: 'a' }] });
  assert.match(resultText(two), /attachments\[0\]: .*exactly one source.*got drive and content/);
});

test('attachments above 25 MB in total are refused before sending', async () => {
  const big = Buffer.alloc(13 * 1024 * 1024, 0x42);
  const ctx = createTestContext({
    google: (c) => {
      const p = c.url.pathname;
      if (p === `${DRIVE}/big` && c.url.searchParams.get('alt') === 'media') return { body: big };
      if (p === `${DRIVE}/big`) return { json: { id: 'big', name: 'video.bin', mimeType: 'application/octet-stream', size: String(big.length) } };
      return p === `${GMAIL}/messages/send` ? { json: SENT } : undefined;
    },
  });
  const res = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ drive_file_id: 'big' }, { drive_file_id: 'big' }] });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /add up to more than Gmail's 25 MB limit \(26 MB after 2 of 2\)\. Share large files as Drive links/);
  assert.ok(!apiCalls(ctx).some((c) => c.url.pathname.endsWith('/messages/send')), 'nothing sent');
});

test('gmail_reply carries attachments in the thread', async () => {
  const original = { id: 'orig', threadId: 't-orig', payload: { headers: [{ name: 'From', value: 'Ann <ann@example.com>' }, { name: 'Subject', value: 'Plan' }, { name: 'Message-ID', value: '<orig@example.com>' }] } };
  const ctx = createTestContext({ google: (c) => (gmailPath(c) === '/messages/orig' ? { json: original } : sendFake(c)) });
  const res = resultJson<{ attachments: { filename: string }[] }>(
    await call(ctx, 'gmail_reply', { message_id: 'orig', body_text: 'Attached', attachments: [{ content: 'BEGIN:VCALENDAR\nEND:VCALENDAR', filename: 'invite.ics' }] }),
  );
  assert.deepEqual(res.attachments.map((a) => a.filename), ['invite.ics']);
  const send = apiCalls(ctx).at(-1)!;
  assert.equal((send.json as { threadId: string }).threadId, 't-orig');
  assert.deepEqual(attachmentsOf(sentRaw(send)).map((f) => f.type), ['text/calendar; charset=UTF-8; name="invite.ics"']);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test('gmail_create_draft attaches files; large drafts go through the drafts upload endpoint (with the thread as metadata)', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x43);
  const original = { id: 'orig', threadId: 't-orig', payload: { headers: [{ name: 'From', value: 'ann@example.com' }, { name: 'Subject', value: 'Plan' }, { name: 'Message-ID', value: '<orig@example.com>' }] } };
  const ctx = createTestContext({
    google: (c) => {
      if (gmailPath(c) === '/messages/orig') return { json: original };
      if (c.url.pathname === `${GMAIL}/drafts` || c.url.href.startsWith(`${UPLOAD}/drafts`)) return { json: { id: 'D1', message: { id: 'dm1', threadId: 't-d' } } };
      return undefined;
    },
  });
  const small = await call(ctx, 'gmail_create_draft', { to: ['ann@example.com'], subject: 'Hi', body_text: 'draft', attachments: [{ content: 'a,b', filename: 'x.csv' }] });
  assert.deepEqual(resultJson(small), { draft_id: 'D1', message_id: 'dm1', thread_id: 't-d', attachments: [{ filename: 'x.csv', mime_type: 'text/csv', size: 3 }], web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1' });
  let c = apiCalls(ctx).at(-1)!;
  assert.equal(`${c.method} ${c.url.pathname}`, `POST ${GMAIL}/drafts`);
  assert.deepEqual(attachmentsOf(sentRaw(c, true)).map((f) => f.filename), ['x.csv']);

  const attachments = [{ content_base64: big.toString('base64'), filename: 'big.bin' }];
  await call(ctx, 'gmail_create_draft', { to: ['ann@example.com'], subject: 'Big', body_text: 'draft', attachments });
  c = apiCalls(ctx).at(-1)!;
  assert.equal(`${c.method} ${c.url.href}`, `POST ${UPLOAD}/drafts?uploadType=media`);
  assert.equal(c.headers['content-type'], 'message/rfc822');
  assert.match(c.body!, /\r\nSubject: Big\r\n/);

  await call(ctx, 'gmail_create_draft', { draft_id: 'D1', to: ['ann@example.com'], subject: 'Big 2', body_text: 'draft', attachments });
  c = apiCalls(ctx).at(-1)!;
  assert.equal(`${c.method} ${c.url.href}`, `PUT ${UPLOAD}/drafts/D1?uploadType=media`);

  await call(ctx, 'gmail_create_draft', { reply_to_message_id: 'orig', body_text: 'reply', attachments });
  c = apiCalls(ctx).at(-1)!;
  assert.equal(`${c.method} ${c.url.href}`, `POST ${UPLOAD}/drafts?uploadType=multipart`);
  const boundary = /^multipart\/related; boundary=([0-9a-f]+)$/.exec(c.headers['content-type']!)?.[1];
  assert.ok(boundary);
  const parts = c.body!.split(`--${boundary}`);
  assert.equal(parts[1], '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"message":{"threadId":"t-orig"}}\r\n');
  assert.match(parts[2]!, /^\r\nContent-Type: message\/rfc822\r\n\r\nDate: /);
  assert.match(parts[2]!, /\r\nIn-Reply-To: <orig@example.com>\r\n/);
});

test('a message above 35 MB once encoded is refused before uploading', async () => {
  const ctx = createTestContext({ google: () => ({ json: SENT }) });
  const body = 'x'.repeat(4 * 1024 * 1024);
  const attachments = [
    { content_base64: Buffer.alloc(6 * 1024 * 1024, 1).toString('base64'), filename: 'a.bin' },
    { content_base64: Buffer.alloc(6 * 1024 * 1024, 2).toString('base64'), filename: 'b.bin' },
    { content_base64: Buffer.alloc(6 * 1024 * 1024, 3).toString('base64'), filename: 'c.bin' },
    { content_base64: Buffer.alloc(6 * 1024 * 1024, 4).toString('base64'), filename: 'd.bin' },
  ];
  const res = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: body, attachments });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /The message is 3\d\.\d MB once encoded, above Gmail's 35 MB limit/);
  assert.equal(apiCalls(ctx).length, 0);
});

// ---------------------------------------------------------------------------
// Edge cases from review
// ---------------------------------------------------------------------------

const latin1Csv = Buffer.from('Libellé;Débit\nCafé;3,50\n', 'latin1');

const oddMessages: Record<string, unknown> = {
  // A bank statement in Latin-1, as Outlook sends CSV files: labelled as Excel, with the charset declared.
  bank: {
    id: 'bank',
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: b64url('statement attached'), size: 18 } },
        {
          partId: '1',
          mimeType: 'application/vnd.ms-excel',
          filename: 'releve.csv',
          headers: [{ name: 'Content-Type', value: 'application/vnd.ms-excel; charset=ISO-8859-1; name="releve.csv"' }],
          body: { attachmentId: 'CSV', size: latin1Csv.length },
        },
      ],
    },
  },
  // A message that is nothing but one PDF: Gmail gives its only part the empty part id.
  bare: { id: 'bare', payload: { partId: '', mimeType: 'application/pdf', filename: 'scan.pdf', body: { attachmentId: 'BARE', size: pdf.length } } },
  // An attached email Gmail shows only part by part.
  nested: {
    id: 'nested',
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: b64url('fyi'), size: 3 } },
        { partId: '1', mimeType: 'message/rfc822', filename: 'forwarded.eml', body: { size: 0 }, parts: [{ partId: '1.0', mimeType: 'text/plain', body: { data: b64url('inner'), size: 5 } }] },
      ],
    },
  },
};

function oddFake(c: RecordedCall) {
  const p = gmailPath(c);
  const id = /^\/messages\/([^/]+)$/.exec(p)?.[1];
  if (id && oddMessages[id]) return { json: oddMessages[id] };
  if (p === '/messages/bank/attachments/CSV') return { json: { size: latin1Csv.length, data: b64url(latin1Csv) } };
  if (p === '/messages/bare/attachments/BARE') return { json: { size: pdf.length, data: b64url(pdf) } };
  if (p === '/messages/send') return { json: SENT };
  return undefined;
}

test('a CSV that Outlook labels as Excel is read as text in its declared charset', async () => {
  const ctx = createTestContext({ google: oddFake });
  const out = resultJson<{ text: string; charset: string; note?: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'bank', part_id: '1' }));
  assert.equal(out.text, 'Libellé;Débit\nCafé;3,50');
  assert.equal(out.charset, 'ISO-8859-1');
  assert.equal(out.note, undefined);
});

test('a re-attached text file keeps its bytes and declares its charset', async () => {
  const ctx = createTestContext({ google: oddFake });
  const res = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 'Relevé', body_text: 'ci-joint', attachments: [{ gmail_message_id: 'bank', gmail_part_id: '1' }] });
  assert.equal(res.isError, undefined, resultText(res));
  const [file] = attachmentsOf(sentRaw(apiCalls(ctx).at(-1)!));
  assert.equal(file!.type, 'text/csv; charset=ISO-8859-1; name="releve.csv"');
  assert.deepEqual(file!.data, latin1Csv);
});

test('a message that is one bare attachment exposes it as part_id "root"', async () => {
  const ctx = createTestContext({ google: oddFake });
  const listed = resultJson<{ attachments: { part_id: string; filename: string }[] }>(await call(ctx, 'gmail_get_message', { message_id: 'bare' }));
  assert.deepEqual(listed.attachments.map((a) => [a.part_id, a.filename]), [['root', 'scan.pdf']]);
  const read = resultJson<{ text: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'bare', part_id: 'root' }));
  assert.match(read.text, /^## Page 1\nTicket 20260919/);
  const sent = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ gmail_message_id: 'bare', gmail_part_id: 'root' }] });
  assert.deepEqual(resultJson<{ attachments: { filename: string }[] }>(sent).attachments.map((a) => a.filename), ['scan.pdf']);
});

test('an attached email Gmail only shows part by part is refused rather than sent as an empty file', async () => {
  const ctx = createTestContext({ google: oddFake });
  const read = await call(ctx, 'gmail_get_attachment', { message_id: 'nested', part_id: '1' });
  assert.equal(read.isError, true);
  assert.match(resultText(read), /attached email that Gmail only provides part by part/);
  const sent = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ gmail_message_id: 'nested', gmail_part_id: '1' }] });
  assert.equal(sent.isError, true);
  assert.match(resultText(sent), /attachments\[0\]: "forwarded\.eml" is an attached email/);
  assert.ok(!apiCalls(ctx).some((c) => gmailPath(c) === '/messages/send'));
});

// ---------------------------------------------------------------------------
// Files staged from the chat
// ---------------------------------------------------------------------------

test('a file staged from the chat is attached by upload_id, optionally checked by SHA-256', async () => {
  const ctx = createTestContext({ google: (c) => (gmailPath(c) === '/messages/send' ? { json: SENT } : undefined) });
  const staged = ctx.uploads.put(pdf, { filename: 'Счёт.pdf', mimeType: 'application/pdf' });
  const sha = createHash('sha256').update(pdf).digest('hex');
  const res = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 'Invoice', body_text: 'attached', attachments: [{ upload_id: staged.id, sha256: sha }] });
  assert.equal(res.isError, undefined, resultText(res));
  const [file] = attachmentsOf(sentRaw(apiCalls(ctx).at(-1)!));
  assert.deepEqual(file!.data, pdf);
  assert.match(file!.type, /^application\/pdf; name="____\.pdf"; name\*=UTF-8''/);

  const wrongSha = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ upload_id: staged.id, sha256: '0'.repeat(64) }] });
  assert.match(resultText(wrongSha), /attachments\[0\]: "Счёт\.pdf" has SHA-256 [0-9a-f]{64}, not the expected 0{64}/);
  const gone = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ upload_id: 'up_expired' }] });
  assert.match(resultText(gone), /No staged file "up_expired": staged files are kept for 24 hours/);
  const mixed = await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'x', attachments: [{ upload_id: staged.id, from_account: 'other' }] });
  assert.match(resultText(mixed), /from_account only applies to drive_file_id and gmail_message_id/);
});
