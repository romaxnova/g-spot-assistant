import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { gmailUpdateDraft } from './gmail-update-draft.js';

const GMAIL = '/gmail/v1/users/me';

function call(ctx: TestContext, args: Record<string, unknown>): Promise<CallToolResult> {
  return runTool(gmailUpdateDraft, { account: 'me', draft_id: 'D1', ...args }, ctx);
}

const crlf = (lines: string[]) => lines.join('\r\n');

/** What Gmail's web composer stores for a reply draft from a send-as alias, with an image pasted into the text and a PDF attached. */
const HEAD = [
  'MIME-Version: 1.0',
  'Date: Wed, 24 Sep 2026 09:00:00 +0200',
  'References: <first@example.com>',
  ' <orig@example.com>',
  'In-Reply-To: <orig@example.com>',
  'Message-ID: <CAdraft1@mail.gmail.com>',
  'Subject: Re: Plan',
  'From: "R S" <alias@example.com>',
  'To: Ann <ann@example.com>',
  'Cc: bob@example.com',
  'X-Custom: kept as is',
];
const BODY_PART = crlf([
  'Content-Type: multipart/related; boundary="000000000000bbb"',
  '',
  '--000000000000bbb',
  'Content-Type: multipart/alternative; boundary="000000000000ccc"',
  '',
  '--000000000000ccc',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'Hello Ann,',
  '[image: logo.png]',
  '',
  '--000000000000ccc',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<div dir=3D"ltr">Hello <b>Ann</b>,<br><img src=3D"cid:ii_logo" alt=3D"logo.png"></div>',
  '',
  '--000000000000ccc--',
  '--000000000000bbb',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <ii_logo>',
  'X-Attachment-Id: ii_logo',
  '',
  'iVBORw0KGgoAAAANSUhEUg==',
  '--000000000000bbb--',
]);
const PDF_PART = crlf([
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  'Content-Transfer-Encoding: base64',
  'X-Attachment-Id: f_plan',
  '',
  'JVBERi0xLjQK',
]);
const REPLY_DRAFT = crlf([
  ...HEAD,
  'Content-Type: multipart/mixed; boundary="000000000000aaa"',
  '',
  '--000000000000aaa',
  BODY_PART,
  '--000000000000aaa',
  PDF_PART,
  '--000000000000aaa--',
  '',
]);

const PLAIN_DRAFT = crlf(['From: me@example.com', 'To: ann@example.com', 'Subject: Note', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'Just text.', '']);

function draftFake(raw: string, onPut?: (c: RecordedCall) => void) {
  return (c: RecordedCall) => {
    const p = c.url.pathname.replace(GMAIL, '');
    if (c.method === 'GET' && p === '/drafts/D1') {
      assert.equal(c.url.searchParams.get('format'), 'raw');
      return { json: { id: 'D1', message: { id: 'm-old', threadId: 't-draft', raw: Buffer.from(raw, 'latin1').toString('base64url') } } };
    }
    if (c.method === 'PUT' && (p === '/drafts/D1' || c.url.pathname === '/upload/gmail/v1/users/me/drafts/D1')) {
      onPut?.(c);
      return { json: { id: 'D1', message: { id: 'm-new', threadId: 't-draft' } } };
    }
    return undefined;
  };
}

function putRaw(ctx: TestContext): string {
  const put = apiCalls(ctx).find((c) => c.method === 'PUT');
  assert.ok(put, 'the draft was saved');
  const json = put.json as { message: { raw: string; threadId?: string } };
  assert.equal(json.message.threadId, 't-draft', 'the draft stays in its thread');
  return Buffer.from(json.message.raw, 'base64url').toString('latin1');
}

test('gmail_update_draft is described, account-scoped and marked destructive (drafts keep no history)', () => {
  assert.equal(gmailUpdateDraft.service, 'gmail');
  assert.equal(gmailUpdateDraft.annotations.destructiveHint, true);
  for (const [key, schema] of Object.entries(gmailUpdateDraft.inputSchema)) assert.ok((schema as { description?: string }).description, key);
});

test('changing only the subject leaves every other byte of the draft as it was', async () => {
  const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
  const out = resultJson<Record<string, unknown>>(await call(ctx, { subject: 'Re: Plan (v2)' }));
  assert.equal(REPLY_DRAFT.replace('Subject: Re: Plan\r\n', 'Subject: Re: Plan (v2)\r\n'), putRaw(ctx));
  assert.deepEqual([out['draft_id'], out['message_id'], out['thread_id']], ['D1', 'm-new', 't-draft']);
  assert.deepEqual(out['changed'], ['subject']);
  assert.deepEqual(out['attachments'], [
    { part_id: '0.1', filename: 'logo.png', mime_type: 'image/png', size: 16, inline: true },
    { part_id: '1', filename: 'plan.pdf', mime_type: 'application/pdf', size: 9 },
  ]);
});

test('adding a file keeps the formatted text, the pasted image, the other attachment and the reply headers', async () => {
  const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
  const staged = ctx.uploads.put(Buffer.from('%PDF-1.4 new'), { filename: 'contract.pdf' });
  const out = resultJson<Record<string, unknown>>(await call(ctx, { add_attachments: [{ upload_id: staged.id }] }));
  const raw = putRaw(ctx);
  for (const line of HEAD) assert.ok(raw.includes(`${line}\r\n`), `header kept: ${line}`);
  assert.ok(raw.includes(BODY_PART), 'text, HTML and the pasted image are byte-identical');
  assert.ok(raw.includes(PDF_PART), 'the existing attachment is byte-identical');
  assert.match(raw, /Content-Disposition: attachment; filename="contract\.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQgbmV3\r\n--000000000000aaa--/);
  assert.deepEqual(out['added_attachments'], [{ filename: 'contract.pdf', mime_type: 'application/pdf', size: 12 }]);
  assert.deepEqual(
    (out['attachments'] as { part_id: string; filename: string }[]).map((a) => `${a.part_id} ${a.filename}`),
    ['0.1 logo.png', '1 plan.pdf', '2 contract.pdf'],
    'listed from the saved message, with its part ids',
  );
});

test('removing an attachment by name or part id drops only that part', async () => {
  for (const key of ['PLAN.PDF', '1']) {
    const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
    const out = resultJson<Record<string, unknown>>(await call(ctx, { remove_attachments: [key] }));
    const raw = putRaw(ctx);
    assert.ok(!raw.includes('plan.pdf'), key);
    assert.ok(raw.includes(BODY_PART), `${key}: body kept`);
    assert.deepEqual(out['removed_attachments'], ['plan.pdf']);
  }
  const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
  const missing = await call(ctx, { remove_attachments: ['budget.xlsx'] });
  assert.equal(missing.isError, true);
  assert.match(resultText(missing), /no attachment "budget\.xlsx"\. Its attachments: .*1 \(plan\.pdf\)/);
  assert.ok(!apiCalls(ctx).some((c) => c.method === 'PUT'));
});

test('new text replaces the body (and its pasted image) but keeps headers and attachments', async () => {
  const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
  await call(ctx, { body_text: 'Hi Ann,\nnew version attached.', body_html: '<p>Hi Ann,<br>new version attached.</p>' });
  const raw = putRaw(ctx);
  assert.ok(!raw.includes('ii_logo'), 'the old body with its image is gone');
  assert.ok(raw.includes(PDF_PART), 'attachments stay');
  assert.ok(raw.includes('In-Reply-To: <orig@example.com>\r\n'));
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="[^"]+"\r\n\r\n--[^\r]+\r\nContent-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
  assert.ok(raw.includes(Buffer.from('Hi Ann,\r\nnew version attached.').toString('base64')));
});

test('recipients are replaced, and an empty cc removes the field', async () => {
  const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
  await call(ctx, { to: ['Zoë <zoe@example.com>', 'ann@example.com'], cc: [], bcc: ['boss@example.com'] });
  const raw = putRaw(ctx);
  assert.ok(raw.includes('To: =?UTF-8?B?Wm/Dqw==?= <zoe@example.com>, ann@example.com\r\n'));
  assert.ok(!/^Cc:/im.test(raw));
  assert.ok(raw.includes('Bcc: boss@example.com\r\n'));
  assert.ok(raw.includes('From: "R S" <alias@example.com>\r\n'), 'the send-as alias stays');
});

test('a plain-text draft becomes multipart/mixed when a file is added', async () => {
  const ctx = createTestContext({ google: draftFake(PLAIN_DRAFT) });
  await call(ctx, { add_attachments: [{ content: 'a,b\n1,2\n', filename: 'data.csv' }] });
  const raw = putRaw(ctx);
  assert.match(raw, /^From: me@example.com\r\nTo: ann@example.com\r\nSubject: Note\r\nMIME-Version: 1.0\r\nContent-Type: multipart\/mixed; boundary=/);
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8\r\n\r\nJust text\.\r\n/);
  assert.match(raw, /filename="data\.csv"/);
});

test('refusals: nothing to change, empty to, unknown draft, attachments over 25 MB', async () => {
  const ctx = createTestContext({ google: draftFake(REPLY_DRAFT) });
  assert.match(resultText(await call(ctx, {})), /Nothing to change/);
  assert.match(resultText(await call(ctx, { to: [] })), /to cannot be empty/);
  assert.equal(apiCalls(ctx).length, 0);

  const missing = createTestContext({ google: () => ({ status: 404, json: { error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] } } }) });
  assert.match(resultText(await call(missing, { subject: 'x' })), /No draft "D1" in this account\. It needs the draft id/);

  const big = createTestContext({ google: draftFake(REPLY_DRAFT) });
  const staged = [0, 1].map(() => big.uploads.put(Buffer.alloc(13 * 1024 * 1024, 7), { filename: 'big.bin' }));
  const res = await call(big, { add_attachments: staged.map((s) => ({ upload_id: s.id })) });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /25 MB limit/);
  assert.ok(!apiCalls(big).some((c) => c.method === 'PUT'));
});

/** Attachment bodies (base64 text) by file name, read with a plain split of the saved message: an independent view. */
function bodiesByName(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/filename="?([^"\r\n;]+)"?[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?:--|$)/g)) out[m[1]!] = m[2]!;
  return out;
}

test('new text keeps attachments nested inside the old text (Apple Mail layout) and a draft that is only a file', async () => {
  const apple = crlf([
    'MIME-Version: 1.0',
    'Subject: Report',
    'From: R S <alias@example.com>',
    'To: ann@example.com',
    'Content-Type: multipart/alternative; boundary="Apple-Mail=_A"',
    '',
    '--Apple-Mail=_A',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'Hi, see attached.',
    '--Apple-Mail=_A',
    'Content-Type: multipart/mixed; boundary="Apple-Mail=_B"',
    '',
    '--Apple-Mail=_B',
    'Content-Type: text/html; charset=us-ascii',
    '',
    '<html><body>Hi, see attached.</body></html>',
    '--Apple-Mail=_B',
    'Content-Disposition: attachment; filename=report.pdf',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjcgcmVwb3J0',
    '--Apple-Mail=_B',
    'Content-Type: text/html; charset=us-ascii',
    '',
    '<html><body>Regards</body></html>',
    '--Apple-Mail=_B--',
    '',
    '--Apple-Mail=_A--',
    '',
  ]);
  const ctx = createTestContext({ google: draftFake(apple) });
  const out = resultJson<Record<string, unknown>>(await call(ctx, { body_text: 'New text.' }));
  const raw = putRaw(ctx);
  assert.equal(bodiesByName(raw)['report.pdf'], 'JVBERi0xLjcgcmVwb3J0', 'the PDF survives byte for byte');
  assert.ok(!raw.includes('Hi, see attached.') && !raw.includes('Regards'), 'the old text is gone');
  assert.match(raw, /Content-Type: multipart\/mixed; boundary=/);
  assert.deepEqual((out['attachments'] as { filename: string }[]).map((a) => a.filename), ['report.pdf']);

  const scan = crlf([
    'MIME-Version: 1.0',
    'Subject: Scan',
    'From: me@example.com',
    'To: ann@example.com',
    'Content-Type: application/pdf; name="scan.pdf"',
    'Content-Disposition: attachment; filename="scan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQgc2Nhbg==',
    '',
  ]);
  const only = createTestContext({ google: draftFake(scan) });
  await call(only, { body_text: 'The scan is attached.' });
  const saved = putRaw(only);
  assert.equal(bodiesByName(saved)['scan.pdf'], 'JVBERi0xLjQgc2Nhbg==');
  assert.match(saved, /^MIME-Version: 1\.0\r\nSubject: Scan\r\nFrom: me@example\.com\r\nTo: ann@example\.com\r\nContent-Type: multipart\/mixed/);
  assert.equal(saved.match(/^From:/gm)?.length, 1, 'the message headers are not copied into the attachment');
  assert.ok(saved.includes(Buffer.from('The scan is attached.').toString('base64')));
});

test('removals are resolved on the draft as fetched, before new text renumbers the parts', async () => {
  const scans = crlf([
    'MIME-Version: 1.0',
    'Subject: Scans',
    'From: me@example.com',
    'To: ann@example.com',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'SU5WT0lDRQ==',
    '--B',
    'Content-Type: application/pdf; name="contract.pdf"',
    'Content-Disposition: attachment; filename="contract.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'Q09OVFJBQ1Q=',
    '--B--',
    '',
  ]);
  const ctx = createTestContext({ google: draftFake(scans) });
  const out = resultJson<Record<string, unknown>>(await call(ctx, { body_text: 'Invoice attached.', remove_attachments: ['1'] }));
  const raw = putRaw(ctx);
  assert.deepEqual(out['removed_attachments'], ['contract.pdf']);
  assert.ok(raw.includes('SU5WT0lDRQ==') && !raw.includes('Q09OVFJBQ1Q='), 'part 1 of the draft as fetched (contract.pdf) is the one removed');
});

test('a file name never reaches images pasted into the text, and a shared name must be told apart by part id', async () => {
  const pasted = crlf([
    'MIME-Version: 1.0',
    'Subject: Photos',
    'From: me@example.com',
    'To: ann@example.com',
    'Content-Type: multipart/mixed; boundary="M"',
    '',
    '--M',
    'Content-Type: multipart/related; boundary="R"',
    '',
    '--R',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<div>Look <img src="cid:ii_1"></div>',
    '--R',
    'Content-Type: image/png; name="image.png"',
    'Content-Disposition: inline; filename="image.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <ii_1>',
    '',
    'UEFTVEVE',
    '--R--',
    '--M',
    'Content-Type: image/png; name="image.png"',
    'Content-Disposition: attachment; filename="image.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'QVRUQUNIRUQ=',
    '--M',
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Disposition: attachment; filename="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'QQ==',
    '--M',
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Disposition: attachment; filename="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'Qg==',
    '--M--',
    '',
  ]);
  const ctx = createTestContext({ google: draftFake(pasted) });
  const out = resultJson<Record<string, unknown>>(await call(ctx, { remove_attachments: ['image.png'] }));
  const raw = putRaw(ctx);
  assert.deepEqual(out['removed_attachments'], ['image.png']);
  assert.ok(raw.includes('UEFTVEVE') && raw.includes('cid:ii_1'), 'the pasted image stays with the text that shows it');
  assert.ok(!raw.includes('QVRUQUNIRUQ='), 'the attached image.png is gone');

  const shared = createTestContext({ google: draftFake(pasted) });
  const refused = await call(shared, { remove_attachments: ['a.pdf'] });
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), /"a\.pdf" names 2 attachments \(part ids 2, 3\)\. Give the part id of each one to remove\. Nothing was changed\./);
  assert.ok(!apiCalls(shared).some((c) => c.method === 'PUT'));
});

test('new text on a draft without MIME headers gets MIME-Version; leaving the thread is reported', async () => {
  const bare = crlf(['From: me@example.com', 'To: ann@example.com', 'Subject: Re: Plan', 'In-Reply-To: <orig@example.com>', '', 'old', '']);
  const ctx = createTestContext({
    google: (c) => {
      const answer = draftFake(bare)(c);
      return c.method === 'PUT' ? { json: { id: 'D1', message: { id: 'm-new', threadId: 't-other' } } } : answer;
    },
  });
  const out = resultJson<Record<string, unknown>>(await call(ctx, { body_text: 'new', subject: 'Something else' }));
  const put = apiCalls(ctx).find((c) => c.method === 'PUT')!;
  const raw = Buffer.from((put.json as { message: { raw: string } }).message.raw, 'base64url').toString('latin1');
  assert.match(raw, /^MIME-Version: 1\.0\r\n/m);
  assert.equal(out['thread_id'], 't-other');
  assert.match(String(out['note']), /moved the draft out of its thread/);
});

test('the saved draft is read back and blanks still in it are pointed out, whichever field the edit touched', async () => {
  const withBlank = (text: string) => (c: RecordedCall) => {
    if (c.method === 'GET' && c.url.pathname === `${GMAIL}/messages/m-new`) {
      assert.equal(c.url.searchParams.get('format'), 'full');
      return { json: { id: 'm-new', threadId: 't-draft', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Note' }], body: { data: Buffer.from(text).toString('base64url') } } } };
    }
    return draftFake(PLAIN_DRAFT)(c);
  };
  const left = createTestContext({ google: withBlank('Appelez-moi au [téléphone].') });
  const out = resultJson<{ warning?: string }>(await call(left, { subject: 'Note' }));
  assert.match(out.warning ?? '', /"\[téléphone\]".*gmail_send_draft refuses/);

  const filled = createTestContext({ google: withBlank('Appelez-moi au 01 23 45 67 89.') });
  assert.equal(resultJson<{ warning?: string }>(await call(filled, { body_text: 'Appelez-moi au 01 23 45 67 89.' })).warning, undefined);

  // A draft that cannot be read back is still saved; the check is advisory.
  const unreadable = createTestContext({ google: draftFake(PLAIN_DRAFT) });
  const saved = resultJson<{ draft_id: string; warning?: string }>(await call(unreadable, { subject: 'Note 2' }));
  assert.equal(saved.draft_id, 'D1');
  assert.equal(saved.warning, undefined);
});
