import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { gmailTools } from './gmail.js';
import type { GmailPart } from './gmail-mime.js';

const BASE = '/gmail/v1/users/me';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function tool(name: string) {
  const def = gmailTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

function call(ctx: TestContext, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return runTool(tool(name), { account: 'me', ...args }, ctx);
}

/** Path of an API call relative to the Gmail base. */
function path(c: RecordedCall): string {
  return c.url.pathname.replace(BASE, '');
}

/** Decoded RFC 5322 message from a send/draft call body. */
function rawMessage(c: RecordedCall, fromDraft = false): { headers: Record<string, string>; body: string } {
  const json = c.json as { raw?: string; message?: { raw?: string } };
  const raw = Buffer.from((fromDraft ? json.message?.raw : json.raw) ?? '', 'base64url').toString('utf8');
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of head!.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: rest.join('\r\n\r\n') };
}

function headers(h: Record<string, string>) {
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

function metaMessage(id: string, h: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'It&#39;s a snippet',
    internalDate: '1758621600000',
    payload: { mimeType: 'multipart/mixed', headers: headers(h) },
    ...extra,
  };
}

function textPayload(text: string, h: Record<string, string> = {}): GmailPart {
  return { mimeType: 'text/plain', headers: headers(h), body: { data: b64url(text), size: text.length } };
}

const SENT = { id: 'sent-1', threadId: 't-sent', labelIds: ['SENT'] };

/** A draft as drafts.get returns it with format=full. */
function draftFixture(id: string, text: string, h: Record<string, string> = { To: 'ann@example.com', Subject: 'Devis' }) {
  return { id, message: { id: `m-${id}`, threadId: `t-${id}`, payload: textPayload(text, h) } };
}

/** A Google that fails a request once with a 503, then answers normally (the send-as settings read is not the one). */
function flakyOnce(answer: (c: RecordedCall) => ReturnType<FakeGoogle>): FakeGoogle {
  let failed = false;
  return (c) => {
    if (c.url.pathname.endsWith('/settings/sendAs')) return { json: { sendAs: [] } };
    if (!failed) {
      failed = true;
      return { status: 503, json: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } };
    }
    return answer(c);
  };
}

// ---------------------------------------------------------------------------

test('tool contract: 13 gmail_* tools, described parameters, honest annotations', () => {
  const names = gmailTools.map((t) => t.name);
  assert.deepEqual(names, [
    'gmail_search', 'gmail_get_message', 'gmail_get_thread', 'gmail_get_attachment', 'gmail_send', 'gmail_reply', 'gmail_forward',
    'gmail_create_draft', 'gmail_send_draft', 'gmail_delete_draft', 'gmail_list_labels', 'gmail_modify_labels', 'gmail_trash',
  ]);
  for (const t of gmailTools) {
    assert.equal(t.service, 'gmail', t.name);
    assert.ok(t.title && t.description.length > 40, t.name);
    assert.ok('account' in t.inputSchema, `${t.name} has account`);
    for (const [key, schema] of Object.entries(t.inputSchema)) {
      assert.ok((schema as { description?: string }).description, `${t.name}.${key} is described`);
    }
  }
  const readOnly = names.filter((n) => tool(n).annotations.readOnlyHint);
  assert.deepEqual(readOnly, ['gmail_search', 'gmail_get_message', 'gmail_get_thread', 'gmail_get_attachment', 'gmail_list_labels']);
  const destructive = names.filter((n) => tool(n).annotations.destructiveHint);
  assert.deepEqual(destructive, ['gmail_delete_draft', 'gmail_trash']);
  assert.equal(tool('gmail_modify_labels').annotations.idempotentHint, true);
  assert.equal(tool('gmail_send').annotations.idempotentHint, false);
});

test('an account without Gmail access yields an error that mentions re-linking', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'cal', services: ['calendar'] }] });
  const res = await runTool(tool('gmail_search'), { account: 'cal', query: 'x' }, ctx);
  assert.equal(res.isError, true);
  assert.match(resultText(res), /re-link/i);
  assert.match(resultText(res), /Gmail/);
  assert.equal(apiCalls(ctx).length, 0);
});

// ---------------------------------------------------------------------------
// gmail_search
// ---------------------------------------------------------------------------

test('gmail_search lists, fetches metadata in parallel (max 5) and flattens rows', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
  let inflight = 0;
  let peak = 0;
  const ctx = createTestContext({
    google: async (c) => {
      if (path(c) === '/messages') return { json: { messages: ids.map((id) => ({ id, threadId: `t-${id}` })), nextPageToken: 'next-1', resultSizeEstimate: 201 } };
      const m = /^\/messages\/(m\d+)$/.exec(path(c));
      if (!m) return undefined;
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 3));
      inflight--;
      return { json: metaMessage(m[1]!, { From: 'Ann <ann@example.com>', To: 'me@example.com', Subject: `Subject ${m[1]}`, Date: 'x' }, m[1] === 'm1' ? { labelIds: ['INBOX'] } : {}) };
    },
  });
  const res = await call(ctx, 'gmail_search', { query: ' from:ann ', max_results: 12, page_token: 'p0', include_spam_trash: true });
  assert.equal(res.isError, undefined);
  const calls = apiCalls(ctx);
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.url.href, `https://gmail.googleapis.com${BASE}/messages?q=from%3Aann&maxResults=12&pageToken=p0&includeSpamTrash=true`);
  const gets = calls.slice(1);
  assert.equal(gets.length, 12);
  assert.equal(gets[0]!.url.search, '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date');
  assert.ok(peak <= 5 && peak >= 2, `peak concurrency ${peak}`);

  const out = resultJson<{ results: Record<string, unknown>[]; next_page_token: string; result_size_estimate?: number }>(res);
  assert.equal(out.next_page_token, 'next-1');
  assert.equal(out.result_size_estimate, undefined, "Gmail's ~201 estimate is not passed on");
  assert.equal(out.results.length, 12);
  assert.deepEqual(out.results[0], {
    id: 'm0',
    thread_id: 't-m0',
    date: '2025-09-23T10:00:00.000Z',
    from: 'Ann <ann@example.com>',
    to: 'me@example.com',
    subject: 'Subject m0',
    snippet: "It's a snippet",
    labels: ['INBOX', 'UNREAD'],
    unread: true,
    has_attachments: true,
  });
  assert.equal(out.results[1]!['unread'], false);
  assert.equal(out.results.map((r) => r['id']).join(','), ids.join(','), 'order of the list is preserved');
});

test('gmail_search with an empty query omits q and returns an empty result set cleanly', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages' ? { json: { resultSizeEstimate: 0 } } : undefined) });
  const res = await call(ctx, 'gmail_search', {});
  assert.equal(apiCalls(ctx)[0]!.url.search, '?maxResults=10');
  assert.deepEqual(resultJson(res), { note: 'No messages match this query.' });
});

test('gmail_search adds draft_id when the query targets drafts', async () => {
  const ctx = createTestContext({
    google: (c) => {
      switch (path(c)) {
        case '/messages':
          return { json: { messages: [{ id: 'd-msg', threadId: 't' }, { id: 'other', threadId: 't' }] } };
        case '/drafts':
          return { json: { drafts: [{ id: 'r123', message: { id: 'd-msg' } }] } };
        case '/messages/d-msg':
        case '/messages/other':
          return { json: metaMessage(path(c).slice('/messages/'.length), { Subject: 'draft' }, { labelIds: ['DRAFT'] }) };
        default:
          return undefined;
      }
    },
  });
  const out = resultJson<{ results: { id: string; draft_id?: string }[] }>(await call(ctx, 'gmail_search', { query: 'in:drafts budget' }));
  assert.equal(apiCalls(ctx).find((c) => path(c) === '/drafts')!.url.search, '?maxResults=100');
  assert.deepEqual(out.results.map((r) => [r.id, r.draft_id]), [['d-msg', 'r123'], ['other', undefined]]);
});

test('gmail_search pages through drafts (up to 5 pages) when matching draft ids', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/messages') return { json: { messages: [{ id: 'late-msg', threadId: 't' }] } };
      if (path(c) === '/messages/late-msg') return { json: metaMessage('late-msg', { Subject: 'draft' }, { labelIds: ['DRAFT'] }) };
      if (path(c) !== '/drafts') return undefined;
      switch (c.url.searchParams.get('pageToken')) {
        case null:
          return { json: { drafts: [{ id: 'r1', message: { id: 'early-msg' } }], nextPageToken: 'p2' } };
        case 'p2':
          return { json: { drafts: [{ id: 'r2', message: { id: 'late-msg' } }], nextPageToken: 'p3' } };
        case 'p3':
          return { json: { drafts: [{ id: 'r3', message: { id: 'other' } }] } };
        default:
          return undefined;
      }
    },
  });
  const out = resultJson<{ results: { id: string; draft_id?: string }[] }>(await call(ctx, 'gmail_search', { query: 'in:drafts' }));
  assert.deepEqual(out.results.map((r) => [r.id, r.draft_id]), [['late-msg', 'r2']]);
  assert.deepEqual(apiCalls(ctx).filter((c) => path(c) === '/drafts').map((c) => c.url.searchParams.get('pageToken')), [null, 'p2', 'p3'], 'stops when Google returns no next page');

  const endless = createTestContext({
    google: (c) => {
      if (path(c) === '/messages') return { json: {} };
      if (path(c) === '/drafts') return { json: { drafts: [], nextPageToken: 'more' } };
      return undefined;
    },
  });
  await call(endless, 'gmail_search', { query: 'in:drafts' });
  assert.equal(apiCalls(endless).filter((c) => path(c) === '/drafts').length, 5, 'never more than 5 pages');
});

// ---------------------------------------------------------------------------
// gmail_get_message
// ---------------------------------------------------------------------------

const latin1Body = Buffer.from('Bonjour Caf\xe9,\n\nsee attached.\n\nOn Mon, Ann wrote:\n> old text\n', 'latin1');
const fullMessage = {
  id: 'full-1',
  threadId: 't-full',
  labelIds: ['INBOX'],
  internalDate: '1758621600000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: headers({
      From: 'Ann <ann@example.com>',
      To: 'me@example.com',
      Cc: 'bob@example.com',
      'Reply-To': 'list@example.com',
      Date: 'Tue, 23 Sep 2025 12:00:00 +0200',
      Subject: 'Docs',
      'Message-ID': '<orig@example.com>',
      'In-Reply-To': '<prev@example.com>',
    }),
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', headers: headers({ 'Content-Type': 'text/plain; charset=iso-8859-1' }), body: { data: b64url(latin1Body), size: 1 } },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64url('<p>Bonjour Café,</p><p>see attached.</p>') } },
        ],
      },
      { partId: '1', mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'ATT1', size: 2048 } },
      { partId: '2', mimeType: 'image/png', filename: '', body: { attachmentId: 'ATT2', size: 99 } },
      { partId: '3', mimeType: 'text/plain', filename: 'notes.txt', headers: headers({ 'Content-Type': 'text/plain; charset=windows-1251; name="notes.txt"' }), body: { attachmentId: 'ATT3', size: 12 } },
    ],
  },
};

test('gmail_get_message returns headers, decoded body, attachments and clipping info', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/full-1' ? { json: fullMessage } : undefined) });
  const res = await call(ctx, 'gmail_get_message', { message_id: 'full-1' });
  assert.equal(apiCalls(ctx)[0]!.url.search, '?format=full');
  assert.deepEqual(resultJson(res), {
    id: 'full-1',
    thread_id: 't-full',
    date: '2025-09-23T10:00:00.000Z',
    headers: {
      from: 'Ann <ann@example.com>',
      to: 'me@example.com',
      cc: 'bob@example.com',
      reply_to: 'list@example.com',
      date: 'Tue, 23 Sep 2025 12:00:00 +0200',
      subject: 'Docs',
      message_id_header: '<orig@example.com>',
      in_reply_to: '<prev@example.com>',
    },
    labels: ['INBOX'],
    body: 'Bonjour Café,\n\nsee attached.\n\nOn Mon, Ann wrote:\n> old text',
    body_source: 'text',
    truncated: false,
    total_chars: 'Bonjour Café,\n\nsee attached.\n\nOn Mon, Ann wrote:\n> old text'.length,
    // The unnamed image embedded in the body is counted, not listed.
    attachments: [
      { part_id: '1', attachment_id: 'ATT1', filename: 'report.pdf', mime_type: 'application/pdf', size: 2048 },
      { part_id: '3', attachment_id: 'ATT3', filename: 'notes.txt', mime_type: 'text/plain', size: 12, charset: 'windows-1251' },
    ],
    inline_images: 1,
  });

  const withInline = resultJson<{ attachments: { attachment_id: string; inline?: boolean }[]; inline_images?: number }>(
    await call(ctx, 'gmail_get_message', { message_id: 'full-1', include_inline_images: true }),
  );
  assert.deepEqual(
    withInline.attachments.map((a) => [a.attachment_id, a.inline ?? false]),
    [['ATT1', false], ['ATT2', true], ['ATT3', false]],
  );
  assert.equal(withInline.inline_images, undefined);
});

test('gmail_get_message strips quotes, clips with offset and falls back to HTML', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/full-1' ? { json: fullMessage } : undefined) });
  const stripped = resultJson<{ body: string }>(await call(ctx, 'gmail_get_message', { message_id: 'full-1', strip_quotes: true }));
  assert.equal(stripped.body, 'Bonjour Café,\n\nsee attached.');

  const htmlOnly = { ...fullMessage, payload: { ...fullMessage.payload, parts: [fullMessage.payload.parts[0]!.parts![1]] } };
  const ctx2 = createTestContext({ google: () => ({ json: htmlOnly }) });
  const fromHtml = resultJson<{ body: string; body_source: string; truncated: boolean; next_offset: number; total_chars: number }>(
    await call(ctx2, 'gmail_get_message', { message_id: 'full-1', max_chars: 200 }),
  );
  assert.equal(fromHtml.body_source, 'html');
  assert.equal(fromHtml.body, 'Bonjour Café,\n\nsee attached.');

  // Paging through a long body with max_chars / offset.
  const long = { ...fullMessage, payload: textPayload('x'.repeat(500)) };
  const ctx3 = createTestContext({ google: () => ({ json: long }) });
  const p1 = resultJson<{ body: string; truncated: boolean; next_offset: number; total_chars: number }>(await call(ctx3, 'gmail_get_message', { message_id: 'full-1', max_chars: 200 }));
  assert.deepEqual([p1.body.length, p1.truncated, p1.next_offset, p1.total_chars], [200, true, 200, 500]);
  const p3 = resultJson<{ body: string; truncated: boolean; next_offset?: number }>(await call(ctx3, 'gmail_get_message', { message_id: 'full-1', max_chars: 200, offset: 400 }));
  assert.deepEqual([p3.body.length, p3.truncated, p3.next_offset], [100, false, undefined]);
});

// ---------------------------------------------------------------------------
// gmail_get_thread
// ---------------------------------------------------------------------------

test('gmail_get_thread orders chronologically, keeps the newest, strips quotes and clips', async () => {
  const msg = (id: string, ts: number, text: string, subject: string) => ({
    id,
    threadId: 'T1',
    labelIds: ['INBOX'],
    internalDate: String(ts),
    payload: {
      mimeType: 'multipart/mixed',
      headers: headers({ From: `${id}@example.com`, To: 'me@example.com', Subject: subject }),
      parts: [textPayload(text), { mimeType: 'application/pdf', filename: `${id}.pdf`, body: { attachmentId: `a-${id}` } }],
    },
  });
  const thread = {
    id: 'T1',
    messages: [msg('c', 3000, 'third\n> quoted', 'Re: Plan'), msg('a', 1000, 'first', 'Plan'), msg('b', 2000, 'y'.repeat(300), 'Fwd: Other')],
  };
  const ctx = createTestContext({ google: (c) => (path(c) === '/threads/T1' ? { json: thread } : undefined) });
  const res = await call(ctx, 'gmail_get_thread', { thread_id: 'T1', max_messages: 2, max_chars_per_message: 200 });
  assert.equal(apiCalls(ctx)[0]!.url.search, '?format=full');
  const out = resultJson<{ thread_id: string; subject: string; total_messages: number; omitted_older: number; messages: Record<string, unknown>[] }>(res);
  assert.equal(out.subject, 'Plan');
  assert.equal(out.total_messages, 3);
  assert.equal(out.omitted_older, 1);
  assert.deepEqual(out.messages.map((m) => m['id']), ['b', 'c']);
  assert.deepEqual(out.messages[1], {
    id: 'c',
    date: '1970-01-01T00:00:03.000Z',
    from: 'c@example.com',
    to: 'me@example.com',
    labels: ['INBOX'],
    body: 'third',
    truncated: false,
    total_chars: 5,
    attachments: ['c.pdf'],
  });
  assert.equal(out.messages[0]!['subject'], 'Fwd: Other', 'a differing subject is shown');
  assert.equal(out.messages[0]!['truncated'], true);
  assert.equal((out.messages[0]!['body'] as string).length, 200);

  const noStrip = resultJson<{ messages: { body: string }[] }>(await call(ctx, 'gmail_get_thread', { thread_id: 'T1', strip_quotes: false }));
  assert.equal(noStrip.messages[2]!.body, 'third\n> quoted');
});

// ---------------------------------------------------------------------------
// gmail_get_attachment
// ---------------------------------------------------------------------------

test('gmail_get_attachment returns text for text-like types and metadata for binary', async () => {
  const csv = 'name,qty\nwidget,3\n';
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/messages/m1/attachments/A%2F1') return { json: { size: csv.length, data: b64url(csv) } };
      if (path(c) === '/messages/m1/attachments/PNG') return { json: { size: 4, data: b64url(Buffer.from([0x89, 0x50, 0x4e, 0x47])) } };
      if (path(c) === '/messages/m1/attachments/JSON') return { json: { size: 9, data: b64url('{"a":1}\n') } };
      if (path(c) === '/messages/m1/attachments/HTML') return { json: { size: 9, data: b64url('<p>Hi<br>there</p>') } };
      return undefined;
    },
  });
  const text = resultJson(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'A/1', filename: 'data.csv', mime_type: 'text/csv' }));
  // The attachment id is not echoed back (it is hundreds of characters in real mail); CSV loses its trailing empty record.
  assert.deepEqual(text, { message_id: 'm1', filename: 'data.csv', mime_type: 'text/csv', size: csv.length, text: csv.trimEnd(), truncated: false, total_chars: csv.length - 1 });

  const binary = resultJson<{ note: string; text?: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'PNG', filename: 'a.png', mime_type: 'image/png' }));
  assert.match(binary.note, /labelled image\/png but its content is not a PNG, JPEG, GIF or WebP image/);
  assert.equal(binary.text, undefined);

  const sniffed = resultJson<{ text: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'JSON' }));
  assert.equal(sniffed.text, '{"a":1}', 'without hints, valid UTF-8 bytes are shown as plain text');
  const sniffedBinary = resultJson<{ note: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'PNG' }));
  assert.match(sniffedBinary.note, /\(application\/octet-stream\) cannot be read/);

  const html = resultJson<{ text: string; extracted_from: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'HTML', filename: 'page.html' }));
  assert.deepEqual([html.text, html.extracted_from], ['Hi\nthere', 'html']);

  const clipped = resultJson<{ text: string; truncated: boolean; next_offset: number }>(
    await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'A/1', mime_type: 'text/csv', max_chars: 200, offset: 5 }),
  );
  assert.equal(clipped.text, csv.trimEnd().slice(5));
});

test('gmail_get_attachment decodes text with the given charset (parameter or mime_type), UTF-8 otherwise', async () => {
  // "Привет" in windows-1251 is not valid UTF-8.
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  const latin1 = Buffer.from('Caf\xe9', 'latin1');
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/messages/m1/attachments/RU') return { json: { size: cp1251.length, data: b64url(cp1251) } };
      if (path(c) === '/messages/m1/attachments/FR') return { json: { size: latin1.length, data: b64url(latin1) } };
      return undefined;
    },
  });
  const byParam = resultJson<{ text: string; charset: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'RU', mime_type: 'text/plain', charset: 'windows-1251' }));
  assert.deepEqual([byParam.text, byParam.charset], ['Привет', 'windows-1251']);
  const byMime = resultJson<{ text: string; charset: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'FR', mime_type: 'text/plain; charset=ISO-8859-1' }));
  assert.deepEqual([byMime.text, byMime.charset], ['Café', 'ISO-8859-1']);
  const unknown = resultJson<{ text: string; charset: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'FR', mime_type: 'text/plain', charset: 'x-nonsense' }));
  assert.equal(unknown.text, 'Caf�', 'unknown labels fall back to UTF-8');
  // Undeclared and not UTF-8: read as Windows-1252 (Western) or Windows-1251 (Cyrillic), and said so.
  const none = resultJson<{ text: string; charset?: string; note?: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'FR', mime_type: 'text/plain' }));
  assert.deepEqual([none.text, none.charset], ['Café', 'windows-1252']);
  assert.match(none.note ?? '', /No character set was declared .* read as windows-1252/);
  const guessedRu = resultJson<{ text: string; charset?: string }>(await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'RU', mime_type: 'text/plain' }));
  assert.deepEqual([guessedRu.text, guessedRu.charset], ['Привет', 'windows-1251']);
});

test('gmail_get_attachment refuses attachments above 25 MB', async () => {
  const ctx = createTestContext({ google: () => ({ json: { size: 26 * 1024 * 1024, data: '' } }) });
  const res = await call(ctx, 'gmail_get_attachment', { message_id: 'm1', attachment_id: 'big' });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /26 MB, above the 25 MB limit/);
});

// ---------------------------------------------------------------------------
// gmail_send
// ---------------------------------------------------------------------------

test('gmail_send builds an RFC 5322 message and posts it as base64url', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/send' && c.method === 'POST' ? { json: SENT } : undefined) });
  const res = await call(ctx, 'gmail_send', {
    to: ['Ann Lee <ann@example.com>', 'bob@example.com'],
    cc: ['Zoë <zoe@example.com>'],
    bcc: ['hidden@example.com'],
    subject: 'Réunion',
    body_text: 'Bonjour',
    body_html: '<p>Bonjour</p>',
    reply_to: 'other@example.com',
  });
  assert.deepEqual(resultJson(res), { id: 'sent-1', thread_id: 't-sent', label_ids: ['SENT'], from: 'me@example.com', web_url: 'https://mail.google.com/mail/u/me@example.com/#all/sent-1' });
  const c = apiCalls(ctx)[0]!;
  assert.deepEqual(Object.keys(c.json as object), ['raw'], 'no threadId on a new message');
  const { headers: h } = rawMessage(c);
  assert.equal(h['from'], 'me@example.com');
  assert.equal(h['to'], 'Ann Lee <ann@example.com>, bob@example.com');
  assert.equal(h['cc'], '=?UTF-8?B?Wm/Dqw==?= <zoe@example.com>');
  assert.equal(h['bcc'], 'hidden@example.com');
  assert.equal(h['reply-to'], 'other@example.com');
  assert.equal(h['subject'], '=?UTF-8?B?UsOpdW5pb24=?=');
  assert.match(h['content-type']!, /^multipart\/alternative; boundary=/);
  assert.equal(h['in-reply-to'], undefined);
});

test('gmail_send is not retried after a 5xx (a repeat could deliver twice)', async () => {
  const ctx = createTestContext({ google: flakyOnce(() => ({ json: SENT })) });
  const res = await call(ctx, 'gmail_send', { to: ['a@example.com'], subject: 's', body_text: 'b' });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /503.*Not retried automatically/);
  assert.equal(apiCalls(ctx).length, 1);
});

test('gmail_send rejects invalid recipients without calling Google', async () => {
  const ctx = createTestContext();
  const res = await call(ctx, 'gmail_send', { to: ['not-an-address'], subject: 's', body_text: 'b' });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /to: "not-an-address" is not a valid email address/);
  assert.equal(apiCalls(ctx).length, 0);
});

// ---------------------------------------------------------------------------
// gmail_reply
// ---------------------------------------------------------------------------

const replyOriginal = metaMessage('orig', {
  From: 'Ann <ann@example.com>',
  To: 'me@example.com, Bob <bob@example.com>',
  Cc: 'carol@example.com',
  Subject: 'Plan',
  'Message-ID': '<orig@example.com>',
  References: '<first@example.com>',
});

test('gmail_reply answers the sender in the original thread with threading headers', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/messages/orig') return { json: replyOriginal };
      if (path(c) === '/messages/send') return { json: { id: 'r1', threadId: 't-orig' } };
      return undefined;
    },
  });
  const res = await call(ctx, 'gmail_reply', { message_id: 'orig', body_text: 'Sounds good' });
  assert.deepEqual(resultJson(res), { id: 'r1', thread_id: 't-orig', to: ['Ann <ann@example.com>'], web_url: 'https://mail.google.com/mail/u/me@example.com/#all/r1' });
  const [get, send] = apiCalls(ctx);
  assert.equal(get!.url.search, '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To');
  assert.equal((send!.json as { threadId: string }).threadId, 't-orig');
  const { headers: h, body } = rawMessage(send!);
  assert.equal(h['to'], 'Ann <ann@example.com>');
  assert.equal(h['cc'], undefined);
  assert.equal(h['subject'], 'Re: Plan');
  assert.equal(h['in-reply-to'], '<orig@example.com>');
  assert.equal(h['references'], '<first@example.com> <orig@example.com>');
  assert.equal(Buffer.from(body, 'base64').toString(), 'Sounds good');
});

test('gmail_reply builds References from In-Reply-To when the original has no References header (RFC 5322 3.6.4)', async () => {
  const send = (c: RecordedCall) => (path(c) === '/messages/send' ? { json: { id: 'r', threadId: 't-orig' } } : undefined);
  const withInReplyTo = metaMessage('orig', { From: 'ann@example.com', Subject: 'Plan', 'Message-ID': '<orig@example.com>', 'In-Reply-To': '<root@example.com>' });
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/orig' ? { json: withInReplyTo } : send(c)) });
  await call(ctx, 'gmail_reply', { message_id: 'orig', body_text: 'ok' });
  assert.equal(rawMessage(apiCalls(ctx)[1]!).headers['references'], '<root@example.com> <orig@example.com>');

  const several = metaMessage('orig', { From: 'ann@example.com', Subject: 'Plan', 'Message-ID': '<orig@example.com>', 'In-Reply-To': '<a@example.com> <b@example.com>' });
  const ctx2 = createTestContext({ google: (c) => (path(c) === '/messages/orig' ? { json: several } : send(c)) });
  await call(ctx2, 'gmail_reply', { message_id: 'orig', body_text: 'ok' });
  assert.equal(rawMessage(apiCalls(ctx2)[1]!).headers['references'], '<orig@example.com>', 'an In-Reply-To naming several messages is not used');

  const bare = metaMessage('orig', { From: 'ann@example.com', Subject: 'Plan', 'Message-ID': '<orig@example.com>' });
  const ctx3 = createTestContext({ google: (c) => (path(c) === '/messages/orig' ? { json: bare } : send(c)) });
  await call(ctx3, 'gmail_reply', { message_id: 'orig', body_text: 'ok' });
  assert.equal(rawMessage(apiCalls(ctx3)[1]!).headers['references'], '<orig@example.com>');
});

test('gmail_reply with reply_all keeps everyone but the account, honours Reply-To and extra_cc, and does not double the Re: prefix', async () => {
  const original = metaMessage('orig', { ...Object.fromEntries(replyOriginal.payload.headers.map((h) => [h.name, h.value])), 'Reply-To': 'list@example.com', Subject: 'RE: Plan' });
  const ctx = createTestContext({
    google: (c) => (path(c) === '/messages/orig' ? { json: original } : path(c) === '/messages/send' ? { json: { id: 'r2', threadId: 't-orig' } } : undefined),
  });
  const res = await call(ctx, 'gmail_reply', { message_id: 'orig', body_text: 'ok', reply_all: true, extra_cc: ['dave@example.com'] });
  assert.deepEqual(resultJson(res), { id: 'r2', thread_id: 't-orig', to: ['list@example.com'], cc: ['Bob <bob@example.com>', 'carol@example.com'], web_url: 'https://mail.google.com/mail/u/me@example.com/#all/r2' });
  const { headers: h } = rawMessage(apiCalls(ctx)[1]!);
  assert.equal(h['to'], 'list@example.com');
  assert.equal(h['cc'], 'Bob <bob@example.com>, carol@example.com, dave@example.com');
  assert.equal(h['subject'], 'RE: Plan');
});

// ---------------------------------------------------------------------------
// gmail_forward
// ---------------------------------------------------------------------------

test('gmail_forward re-attaches the original attachments and starts a new thread', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/messages/full-1') return { json: fullMessage };
      if (path(c) === '/messages/full-1/attachments/ATT1') return { json: { size: pdf.length, data: b64url(pdf) } };
      if (path(c) === '/messages/full-1/attachments/ATT2') return { json: { size: 3, data: b64url('png') } };
      if (path(c) === '/messages/full-1/attachments/ATT3') return { json: { size: 5, data: b64url('notes') } };
      if (path(c) === '/messages/send') return { json: SENT };
      return undefined;
    },
  });
  const res = await call(ctx, 'gmail_forward', { message_id: 'full-1', to: ['dave@example.com'], note: 'FYI' });
  // The image embedded in the original HTML is not re-attached: only real attachments travel.
  assert.deepEqual(resultJson(res), { id: 'sent-1', thread_id: 't-sent', attachments_included: 2, web_url: 'https://mail.google.com/mail/u/me@example.com/#all/sent-1' });
  const calls = apiCalls(ctx);
  assert.equal(calls[0]!.url.search, '?format=full');
  const send = calls.find((c) => path(c) === '/messages/send')!;
  assert.deepEqual(Object.keys(send.json as object), ['raw'], 'forwards do not join the original thread');
  const { headers: h, body } = rawMessage(send);
  assert.equal(h['to'], 'dave@example.com');
  assert.equal(h['subject'], 'Fwd: Docs');
  const boundary = /boundary="([^"]+)"/.exec(h['content-type']!)![1]!;
  const parts = body.split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 3);
  const text = Buffer.from(parts[0]!.split('\r\n\r\n')[1]!, 'base64').toString();
  assert.equal(
    text,
    'FYI\r\n\r\n---------- Forwarded message ---------\r\nFrom: Ann <ann@example.com>\r\nDate: Tue, 23 Sep 2025 12:00:00 +0200\r\nSubject: Docs\r\nTo: me@example.com\r\nCc: bob@example.com\r\n\r\n\r\nBonjour Café,\r\n\r\nsee attached.\r\n\r\nOn Mon, Ann wrote:\r\n> old text',
  );
  assert.match(parts[1]!, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.equal(Buffer.from(parts[1]!.split('\r\n\r\n')[1]!, 'base64').toString(), '%PDF-1.4 fake');
  assert.match(parts[2]!, /filename="notes\.txt"/);
});

test('large messages go through the media upload endpoint as message/rfc822; with a threadId as multipart/related', async () => {
  // A 5 MiB attachment becomes ~6.8 MB of base64, well above the JSON send limit.
  const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
  const withBig = { ...fullMessage, payload: { ...fullMessage.payload, parts: [fullMessage.payload.parts[0]!, { partId: '1', mimeType: 'application/zip', filename: 'big.zip', body: { attachmentId: 'BIG', size: big.length } }] } };
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/messages/full-1') return { json: withBig };
      if (path(c) === '/messages/full-1/attachments/BIG') return { json: { size: big.length, data: b64url(big) } };
      if (c.url.href.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?')) return { json: SENT };
      return undefined;
    },
  });
  const res = await call(ctx, 'gmail_forward', { message_id: 'full-1', to: ['dave@example.com'] });
  assert.deepEqual(resultJson(res), { id: 'sent-1', thread_id: 't-sent', attachments_included: 1, web_url: 'https://mail.google.com/mail/u/me@example.com/#all/sent-1' });
  const send = apiCalls(ctx).at(-1)!;
  assert.equal(send.method, 'POST');
  assert.equal(send.url.href, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media');
  assert.equal(send.headers['content-type'], 'message/rfc822');
  assert.equal(send.json, undefined);
  assert.match(send.body!, /^Date: .*\r\nFrom: me@example.com\r\nTo: dave@example.com\r\n/);
  assert.match(send.body!, /\r\nSubject: Fwd: Docs\r\n/);
  assert.match(send.body!, /filename="big\.zip"/);
  assert.ok(send.body!.length > 4 * 1024 * 1024);

  // A large reply must carry the threadId: JSON metadata part + message/rfc822 part.
  const ctx2 = createTestContext({
    google: (c) => {
      if (path(c) === '/messages/orig') return { json: replyOriginal };
      if (c.url.href.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?')) return { json: { id: 'r1', threadId: 't-orig' } };
      return undefined;
    },
  });
  const res2 = await call(ctx2, 'gmail_reply', { message_id: 'orig', body_text: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(res2.isError, undefined, resultText(res2));
  const reply = apiCalls(ctx2).at(-1)!;
  assert.equal(reply.url.href, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart');
  const boundary = /^multipart\/related; boundary=([0-9a-f]+)$/.exec(reply.headers['content-type']!)?.[1];
  assert.ok(boundary, reply.headers['content-type']);
  const parts = reply.body!.split(`--${boundary}`);
  assert.equal(parts.length, 4, 'preamble, metadata, message, closing');
  assert.equal(parts[1], '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"threadId":"t-orig"}\r\n');
  assert.match(parts[2]!, /^\r\nContent-Type: message\/rfc822\r\n\r\nDate: .*\r\nFrom: me@example.com\r\nTo: Ann <ann@example.com>\r\n/);
  assert.match(parts[2]!, /\r\nIn-Reply-To: <orig@example.com>\r\n/);
  assert.equal(parts[3], '--\r\n');
});

test('gmail_forward skips attachments when asked or when they exceed 20 MB', async () => {
  const huge = { ...fullMessage, payload: { ...fullMessage.payload, parts: [fullMessage.payload.parts[0]!, { partId: '1', mimeType: 'application/zip', filename: 'big.zip', body: { attachmentId: 'BIG', size: 21 * 1024 * 1024 } }] } };
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/full-1' ? { json: huge } : path(c) === '/messages/send' ? { json: SENT } : undefined) });
  const res = resultJson<{ attachments_included: number; note: string }>(await call(ctx, 'gmail_forward', { message_id: 'full-1', to: ['d@example.com'] }));
  assert.equal(res.attachments_included, 0);
  assert.match(res.note, /21 MB, above the 20 MB forwarding limit/);
  assert.ok(!apiCalls(ctx).some((c) => path(c).includes('/attachments/')), 'oversized attachments are not downloaded');

  const ctx2 = createTestContext({ google: (c) => (path(c) === '/messages/full-1' ? { json: fullMessage } : path(c) === '/messages/send' ? { json: SENT } : undefined) });
  const res2 = resultJson<{ attachments_included: number; note?: string }>(await call(ctx2, 'gmail_forward', { message_id: 'full-1', to: ['d@example.com'], include_attachments: false }));
  assert.deepEqual(res2, { id: 'sent-1', thread_id: 't-sent', attachments_included: 0, web_url: 'https://mail.google.com/mail/u/me@example.com/#all/sent-1' });
  assert.match(rawMessage(apiCalls(ctx2)[1]!).headers['content-type']!, /^text\/plain/);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test('gmail_create_draft creates, updates and builds reply drafts', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/drafts' && c.method === 'POST') return { json: { id: 'D1', message: { id: 'dm1', threadId: 'dt1' } } };
      if (path(c) === '/drafts/D1' && c.method === 'PUT') return { json: { id: 'D1', message: { id: 'dm2', threadId: 'dt1' } } };
      if (path(c) === '/messages/orig') return { json: replyOriginal };
      return undefined;
    },
  });
  const created = await call(ctx, 'gmail_create_draft', { to: ['ann@example.com'], subject: 'Hi', body_text: 'draft' });
  assert.deepEqual(resultJson(created), { draft_id: 'D1', message_id: 'dm1', thread_id: 'dt1', web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1' });
  const createCall = apiCalls(ctx)[0]!;
  assert.deepEqual(Object.keys((createCall.json as { message: object }).message), ['raw']);
  assert.equal(rawMessage(createCall, true).headers['subject'], 'Hi');

  const updated = await call(ctx, 'gmail_create_draft', { draft_id: 'D1', to: ['ann@example.com'], subject: 'Hi again', body_text: 'draft 2' });
  assert.deepEqual(resultJson(updated), { draft_id: 'D1', message_id: 'dm2', thread_id: 'dt1', updated: true, web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm2' });
  assert.equal(rawMessage(apiCalls(ctx)[1]!, true).headers['subject'], 'Hi again');

  const reply = await call(ctx, 'gmail_create_draft', { reply_to_message_id: 'orig', body_text: 'reply draft' });
  assert.equal(reply.isError, undefined, resultText(reply));
  const replyCall = apiCalls(ctx).at(-1)!;
  assert.equal(path(replyCall), '/drafts');
  assert.equal((replyCall.json as { message: { threadId: string } }).message.threadId, 't-orig');
  const { headers: h } = rawMessage(replyCall, true);
  assert.equal(h['to'], 'Ann <ann@example.com>');
  assert.equal(h['subject'], 'Re: Plan');
  assert.equal(h['in-reply-to'], '<orig@example.com>');
  assert.equal(h['references'], '<first@example.com> <orig@example.com>');
});

test('draft creation, draft sending and label creation are not retried after a 5xx', async () => {
  const draft = createTestContext({ google: flakyOnce(() => ({ json: { id: 'D1' } })) });
  assert.match(resultText(await call(draft, 'gmail_create_draft', { to: ['a@example.com'], subject: 's', body_text: 'b' })), /503.*Not retried automatically/);
  assert.equal(apiCalls(draft).length, 1);

  const flakySend = flakyOnce(() => ({ json: SENT }));
  const sendDraft = createTestContext({ google: (c) => (c.method === 'GET' ? { json: draftFixture('D1', 'Hello') } : flakySend(c)) });
  assert.match(resultText(await call(sendDraft, 'gmail_send_draft', { draft_id: 'D1' })), /503.*Not retried automatically/);
  assert.equal(apiCalls(sendDraft).filter((c) => c.method === 'POST').length, 1);

  const label = createTestContext({
    google: (c) => (path(c) === '/labels' && c.method === 'GET' ? { json: { labels: LABELS } } : path(c) === '/labels' && c.method === 'POST' ? { status: 503, json: { error: { message: 'Backend Error' } } } : undefined),
  });
  assert.match(resultText(await call(label, 'gmail_modify_labels', { message_ids: ['m1'], add_labels: ['Brand new'] })), /503.*Not retried automatically/);
  assert.equal(apiCalls(label).filter((c) => c.method === 'POST').length, 1);
});

test('gmail_create_draft requires recipients and a subject for new (non-reply) drafts', async () => {
  const ctx = createTestContext();
  assert.match(resultText(await call(ctx, 'gmail_create_draft', { subject: 's', body_text: 'b' })), /at least one recipient/);
  assert.match(resultText(await call(ctx, 'gmail_create_draft', { to: ['a@example.com'], body_text: 'b' })), /Provide a subject/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('gmail_send_draft and gmail_delete_draft hit the drafts endpoints', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/drafts/send' && c.method === 'POST') return { json: { id: 'sm', threadId: 'st', labelIds: ['SENT'] } };
      if (path(c) === '/drafts/D1' && c.method === 'GET') return { json: draftFixture('D1', 'Hello') };
      if (path(c) === '/drafts/D1' && c.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    },
  });
  assert.deepEqual(resultJson(await call(ctx, 'gmail_send_draft', { draft_id: 'D1' })), { id: 'sm', thread_id: 'st', label_ids: ['SENT'], web_url: 'https://mail.google.com/mail/u/me@example.com/#all/sm' });
  assert.equal(apiCalls(ctx)[0]!.url.searchParams.get('format'), 'full');
  assert.deepEqual(apiCalls(ctx)[1]!.json, { id: 'D1' });
  assert.deepEqual(resultJson(await call(ctx, 'gmail_delete_draft', { draft_id: 'D1' })), { deleted: true, draft_id: 'D1' });
  assert.equal(apiCalls(ctx)[2]!.method, 'DELETE');
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const LABELS = [
  { id: 'Label_7', name: 'Work/Invoices', type: 'user' },
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'Label_2', name: 'Travel', type: 'user' },
  { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
];

test('gmail_list_labels sorts system labels first, then by name', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/labels' ? { json: { labels: LABELS } } : undefined) });
  const out = resultJson<{ labels: { id: string }[] }>(await call(ctx, 'gmail_list_labels', {}));
  assert.deepEqual(out.labels.map((l) => l.id), ['CATEGORY_SOCIAL', 'INBOX', 'Label_2', 'Label_7']);
});

test('gmail_modify_labels resolves names, creates missing labels and batch-modifies', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (path(c) === '/labels' && c.method === 'GET') return { json: { labels: LABELS } };
      if (path(c) === '/labels' && c.method === 'POST') return { json: { id: 'Label_9', name: (c.json as { name: string }).name, type: 'user' } };
      if (path(c) === '/messages/batchModify') return new Response(null, { status: 204 });
      if (path(c) === '/threads/T1/modify') return { json: { id: 'T1' } };
      return undefined;
    },
  });
  const res = await call(ctx, 'gmail_modify_labels', {
    message_ids: ['m1', 'm2'],
    thread_ids: ['T1'],
    add_labels: ['starred', 'work/invoices', 'Receipts 2026', 'Label_2'],
    remove_labels: ['inbox', 'Unread'],
  });
  assert.deepEqual(resultJson(res), {
    messages_modified: 2,
    threads_modified: 1,
    added_label_ids: ['STARRED', 'Label_7', 'Label_9', 'Label_2'],
    removed_label_ids: ['INBOX', 'UNREAD'],
    created_labels: [{ id: 'Label_9', name: 'Receipts 2026' }],
  });
  const calls = apiCalls(ctx);
  assert.equal(calls.filter((c) => path(c) === '/labels' && c.method === 'GET').length, 1, 'labels are listed once');
  assert.deepEqual(calls.find((c) => path(c) === '/labels' && c.method === 'POST')!.json, { name: 'Receipts 2026', labelListVisibility: 'labelShow', messageListVisibility: 'show' });
  const change = { addLabelIds: ['STARRED', 'Label_7', 'Label_9', 'Label_2'], removeLabelIds: ['INBOX', 'UNREAD'] };
  assert.deepEqual(calls.find((c) => path(c) === '/messages/batchModify')!.json, { ids: ['m1', 'm2'], ...change });
  assert.deepEqual(calls.find((c) => path(c) === '/threads/T1/modify')!.json, change);
});

test('gmail_modify_labels: system-only changes need no label listing; unknown labels are reported', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/batchModify' ? new Response(null, { status: 204 }) : path(c) === '/labels' ? { json: { labels: LABELS } } : undefined) });
  const archived = await call(ctx, 'gmail_modify_labels', { message_ids: ['m1'], remove_labels: ['INBOX'] });
  assert.deepEqual(resultJson(archived), { messages_modified: 1, threads_modified: 0, removed_label_ids: ['INBOX'] });
  assert.deepEqual(apiCalls(ctx).map(path), ['/messages/batchModify']);
  assert.deepEqual(apiCalls(ctx)[0]!.json, { ids: ['m1'], removeLabelIds: ['INBOX'] });

  const unknownAdd = await call(ctx, 'gmail_modify_labels', { message_ids: ['m1'], add_labels: ['Nope'], create_missing: false });
  assert.equal(unknownAdd.isError, true);
  assert.match(resultText(unknownAdd), /Unknown label "Nope"/);
  const unknownRemove = await call(ctx, 'gmail_modify_labels', { message_ids: ['m1'], remove_labels: ['Nope'] });
  assert.equal(unknownRemove.isError, true);

  assert.equal((await call(ctx, 'gmail_modify_labels', { add_labels: ['STARRED'] })).isError, true);
  assert.equal((await call(ctx, 'gmail_modify_labels', { message_ids: ['m1'] })).isError, true);
});

test('gmail_modify_labels refuses to add TRASH or SPAM but still removes them', async () => {
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/batchModify' ? new Response(null, { status: 204 }) : undefined) });
  const trash = await call(ctx, 'gmail_modify_labels', { message_ids: ['m1'], add_labels: ['starred', ' trash '] });
  assert.equal(trash.isError, true);
  assert.match(resultText(trash), /use gmail_trash/);
  const spam = await call(ctx, 'gmail_modify_labels', { thread_ids: ['T1'], add_labels: ['SPAM'] });
  assert.equal(spam.isError, true);
  assert.match(resultText(spam), /SPAM is refused/);
  assert.equal(apiCalls(ctx).length, 0, 'nothing is modified');

  const restored = await call(ctx, 'gmail_modify_labels', { message_ids: ['m1'], remove_labels: ['TRASH', 'SPAM'], add_labels: ['INBOX'] });
  assert.deepEqual(resultJson(restored), { messages_modified: 1, threads_modified: 0, added_label_ids: ['INBOX'], removed_label_ids: ['TRASH', 'SPAM'] });
});

test('label modifications and trash/untrash are retried after a 5xx', async () => {
  const modify = createTestContext({ google: flakyOnce((c) => (path(c) === '/messages/batchModify' ? new Response(null, { status: 204 }) : path(c) === '/threads/T1/modify' ? { json: { id: 'T1' } } : undefined)) });
  const res = await call(modify, 'gmail_modify_labels', { message_ids: ['m1'], remove_labels: ['INBOX'] });
  assert.equal(res.isError, undefined, resultText(res));
  assert.deepEqual(apiCalls(modify).map(path), ['/messages/batchModify', '/messages/batchModify']);

  const threadModify = createTestContext({ google: flakyOnce((c) => (path(c) === '/threads/T1/modify' ? { json: { id: 'T1' } } : undefined)) });
  assert.equal((await call(threadModify, 'gmail_modify_labels', { thread_ids: ['T1'], add_labels: ['STARRED'] })).isError, undefined);
  assert.deepEqual(apiCalls(threadModify).map(path), ['/threads/T1/modify', '/threads/T1/modify']);

  const trash = createTestContext({ google: flakyOnce(() => ({ json: { id: 'x' } })) });
  assert.equal((await call(trash, 'gmail_trash', { message_ids: ['m1'] })).isError, undefined);
  assert.deepEqual(apiCalls(trash).map(path), ['/messages/m1/trash', '/messages/m1/trash']);

  const untrash = createTestContext({ google: flakyOnce(() => ({ json: { id: 'x' } })) });
  assert.equal((await call(untrash, 'gmail_trash', { thread_ids: ['T1'], action: 'untrash' })).isError, undefined);
  assert.deepEqual(apiCalls(untrash).map(path), ['/threads/T1/untrash', '/threads/T1/untrash']);
});

// ---------------------------------------------------------------------------
// gmail_trash
// ---------------------------------------------------------------------------

test('gmail_trash trashes and untrashes messages and threads', async () => {
  const ctx = createTestContext({ google: (c) => (c.method === 'POST' ? { json: { id: 'x' } } : undefined) });
  assert.deepEqual(resultJson(await call(ctx, 'gmail_trash', { message_ids: ['m1', 'm2'], thread_ids: ['T1'] })), { action: 'trash', messages: 2, threads: 1 });
  assert.deepEqual(apiCalls(ctx).map(path).sort(), ['/messages/m1/trash', '/messages/m2/trash', '/threads/T1/trash']);
  assert.deepEqual(resultJson(await call(ctx, 'gmail_trash', { message_ids: ['m1'], action: 'untrash' })), { action: 'untrash', messages: 1, threads: 0 });
  assert.equal(path(apiCalls(ctx).at(-1)!), '/messages/m1/untrash');
  assert.equal((await call(ctx, 'gmail_trash', {})).isError, true);
});

test('Google API errors propagate as error results', async () => {
  const ctx = createTestContext({ google: () => ({ status: 404, json: { error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] } } }) });
  const res = await call(ctx, 'gmail_get_message', { message_id: 'missing' });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /Gmail API error 404 \(notFound\)/);
});

test('bodies and snippets lose invisible preheader padding and link tracking parameters', async () => {
  const padded = `Deploy crashed ͏ ͏ ͏\r\n${'  ͏  '.repeat(30)}\r\n\r\n\r\nRestart ( https://railway.com/p/1?utm_campaign=x&utm_source=customer.io )\r\n`;
  const message = {
    id: 'pad-1',
    threadId: 't-pad',
    internalDate: '1758621600000',
    labelIds: ['INBOX'],
    snippet: 'Your receipt #2162 &#847; &#847; &#847; &#847;',
    payload: textPayload(padded),
  };
  const ctx = createTestContext({ google: (c) => (path(c) === '/messages/pad-1' ? { json: message } : path(c) === '/messages' ? { json: { messages: [{ id: 'pad-1', threadId: 't-pad' }] } } : undefined) });
  const read = resultJson<{ body: string }>(await call(ctx, 'gmail_get_message', { message_id: 'pad-1' }));
  assert.equal(read.body, 'Deploy crashed\n\nRestart ( https://railway.com/p/1 )');
  const search = resultJson<{ results: { snippet: string }[] }>(await call(ctx, 'gmail_search', {}));
  assert.equal(search.results[0]!.snippet, 'Your receipt #2162');
});

// ---------------------------------------------------------------------------
// Unfilled blanks and batch sending
// ---------------------------------------------------------------------------

test('gmail_send, gmail_reply and gmail_forward refuse unfilled blanks unless allowed; nothing reaches Google', async () => {
  const ctx = createTestContext({ google: () => ({ json: SENT }) });
  const refused = resultText(await call(ctx, 'gmail_send', { to: ['a@example.com'], subject: 'Devis', body_text: 'Bonjour,\nJoignable au [téléphone].\nSam' }));
  assert.match(refused, /Not sent.*"\[téléphone\]".*allow_placeholders: true/s);
  assert.match(resultText(await call(ctx, 'gmail_send', { to: ['a@example.com'], subject: 'Offre pour {{company}}', body_text: 'b' })), /"\{\{company\}\}"/);
  assert.match(resultText(await call(ctx, 'gmail_send', { to: ['a@example.com'], subject: 's', body_text: 'b', body_html: '<p>Tel: 06 XX XX XX XX</p>' })), /"06 XX XX XX XX"/);
  assert.match(resultText(await call(ctx, 'gmail_reply', { message_id: 'm1', body_text: 'Merci [Prénom] !' })), /Not sent.*\[Prénom\]/);
  assert.match(resultText(await call(ctx, 'gmail_forward', { message_id: 'm1', to: ['b@example.com'], note: 'Voir [détails]' })), /Not sent/);
  assert.equal(apiCalls(ctx).length, 0);

  assert.equal(resultJson<{ id: string }>(await call(ctx, 'gmail_send', { to: ['a@example.com'], subject: 's', body_text: 'Code [promo]', allow_placeholders: true })).id, 'sent-1');
});

test('gmail_forward checks only the note, not the forwarded message', async () => {
  const original = { ...metaMessage('m1', { From: 'x@example.com', Subject: 'Offre' }), payload: textPayload('Merci de compléter [Nom] et [téléphone].', { From: 'x@example.com', Subject: 'Offre' }) };
  const ctx = createTestContext({ google: (c) => (c.method === 'GET' ? { json: original } : { json: SENT }) });
  assert.equal(resultJson<{ id: string }>(await call(ctx, 'gmail_forward', { message_id: 'm1', to: ['b@example.com'], note: 'Pour info' })).id, 'sent-1');
});

test('gmail_create_draft points out blanks but still saves the draft', async () => {
  const ctx = createTestContext({ google: () => ({ json: { id: 'D1', message: { id: 'dm', threadId: 'dt' } } }) });
  const out = resultJson<{ draft_id: string; warning?: string }>(await call(ctx, 'gmail_create_draft', { to: ['a@example.com'], subject: 'Devis', body_text: 'Mon numéro : [téléphone]' }));
  assert.equal(out.draft_id, 'D1');
  assert.match(out.warning ?? '', /"\[téléphone\]".*before sending/);
  const clean = resultJson<{ warning?: string }>(await call(ctx, 'gmail_create_draft', { to: ['a@example.com'], subject: 'Devis', body_text: 'Mon numéro : 01 23 45 67 89' }));
  assert.equal(clean.warning, undefined);
});

test('gmail_send_draft refuses a draft with blanks in its own text, not in quoted text, and explains a wrong id', async () => {
  const drafts: Record<string, unknown> = {
    D1: draftFixture('D1', 'Bonjour,\nAppelez-moi au [téléphone].'),
    D2: draftFixture('D2', 'Merci, c\'est noté.\n\nLe lun. 22 sept. 2026, Ann <ann@example.com> a écrit :\n> Merci de compléter [Nom]'),
  };
  const ctx = createTestContext({
    google: (c) => {
      const id = path(c).split('/')[2]!;
      if (c.method === 'GET') return drafts[id] ? { json: drafts[id] } : { status: 404, json: { error: { code: 404, message: 'Requested entity was not found.' } } };
      return { json: { id: `sent-${(c.json as { id: string }).id}`, threadId: 't' } };
    },
  });
  assert.match(resultText(await call(ctx, 'gmail_send_draft', { draft_id: 'D1' })), /Not sent.*"\[téléphone\]"/s);
  assert.equal(apiCalls(ctx).filter((c) => c.method === 'POST').length, 0);
  assert.equal(resultJson<{ id: string }>(await call(ctx, 'gmail_send_draft', { draft_id: 'D2' })).id, 'sent-D2');
  assert.match(resultText(await call(ctx, 'gmail_send_draft', { draft_id: 'r-123' })), /Nothing was sent.*"r-123".*draft id/s);
  assert.equal(resultJson<{ id: string }>(await call(ctx, 'gmail_send_draft', { draft_id: 'D1', allow_placeholders: true })).id, 'sent-D1');
});

test('gmail_send_draft with draft_ids checks every draft first, then sends them in order and reports each', async () => {
  const drafts: Record<string, unknown> = {
    A: draftFixture('A', 'Bonjour A', { To: 'a@example.com', Subject: 'Devis A' }),
    B: draftFixture('B', 'Bonjour B, tél. [téléphone]', { To: 'b@example.com', Subject: 'Devis B' }),
    C: draftFixture('C', 'Bonjour C', { To: 'c@example.com', Subject: 'Devis C' }),
  };
  let failC = false;
  const ctx = createTestContext({
    google: (c) => {
      const id = path(c).split('/')[2]!;
      if (c.method === 'GET') return drafts[id] ? { json: drafts[id] } : { status: 404, json: { error: { code: 404, message: 'Requested entity was not found.' } } };
      const sending = (c.json as { id: string }).id;
      if (failC && sending === 'C') return { status: 400, json: { error: { code: 400, message: 'Invalid To header' } } };
      return { json: { id: `sent-${sending}`, threadId: `t-${sending}` } };
    },
  });
  const refused = resultText(await call(ctx, 'gmail_send_draft', { draft_ids: ['A', 'B', 'C'] }));
  assert.match(refused, /Nothing was sent: 1 of the 3 drafts.*- B \(Devis B → b@example.com\): "\[téléphone\]"/s);
  assert.match(resultText(await call(ctx, 'gmail_send_draft', { draft_ids: ['A', 'Z'] })), /Nothing was sent.*"Z"/s);
  assert.equal(apiCalls(ctx).filter((c) => c.method === 'POST').length, 0);

  drafts['B'] = draftFixture('B', 'Bonjour B, tél. 01 23 45 67 89', { To: 'b@example.com', Subject: 'Devis B' });
  failC = true;
  const out = resultJson<{ sent: number; failed?: number; results: Record<string, string>[]; note?: string }>(await call(ctx, 'gmail_send_draft', { draft_ids: ['A', 'B', 'C', 'A'] }));
  assert.equal(out.sent, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results.map((r) => [r['draft_id'], r['id'] ?? r['error']]), [['A', 'sent-A'], ['B', 'sent-B'], ['C', 'Gmail API error 400: Invalid To header']]);
  assert.equal(out.results[1]!['subject'], 'Devis B');
  assert.match(out.note ?? '', /still in the drafts folder/);
  assert.deepEqual(apiCalls(ctx).filter((c) => c.method === 'POST').map((c) => (c.json as { id: string }).id), ['A', 'B', 'C']);
});

test('gmail_send_draft needs a draft id and caps a batch at 25', async () => {
  const ctx = createTestContext();
  assert.match(resultText(await call(ctx, 'gmail_send_draft', {})), /Give draft_id/);
  assert.match(resultText(await call(ctx, 'gmail_send_draft', { draft_ids: Array.from({ length: 26 }, (_, i) => `D${i}`) })), /draft_ids|25/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('gmail_send_draft also reads the HTML version: a blank only there is refused too', async () => {
  const html = '<div>Bonjour,<br>Mon numéro : [téléphone]</div>';
  const draft = {
    id: 'H1',
    message: {
      id: 'm-H1',
      threadId: 't',
      payload: {
        mimeType: 'multipart/alternative',
        headers: headers({ To: 'ann@example.com', Subject: 'Devis' }),
        parts: [textPayload('Bonjour,\nMon numéro : 01 23 45 67 89'), { mimeType: 'text/html', headers: [], body: { data: b64url(html), size: html.length } }],
      },
    },
  };
  const ctx = createTestContext({ google: (c) => (c.method === 'GET' ? { json: draft } : { json: SENT }) });
  assert.match(resultText(await call(ctx, 'gmail_send_draft', { draft_id: 'H1' })), /Not sent.*"\[téléphone\]"/s);
  assert.equal(apiCalls(ctx).filter((c) => c.method === 'POST').length, 0);
});
