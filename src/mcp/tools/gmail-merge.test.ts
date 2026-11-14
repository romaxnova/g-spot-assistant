import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall, type TestContext } from '../../test-support.js';
import { createLogger } from '../../log.js';
import { runTool } from '../server.js';
import { badFieldRefs, fillTemplate, gmailCreateDrafts, mistypedRefs, templateFields } from './gmail-merge.js';

const GMAIL = '/gmail/v1/users/me';
const DRIVE = '/drive/v3/files';
const SIGNATURE = '<div dir="ltr">Sam Sender<br>01 23 45 67 89</div>';
const SEND_AS = { sendAs: [{ sendAsEmail: 'me@example.com', displayName: 'Sam Sender', signature: SIGNATURE, isPrimary: true, isDefault: true }] };
const PRICES = Buffer.from('%PDF-1.4 tarifs');

interface Row {
  draft_id?: string;
  message_id?: string;
  to: string;
  subject?: string;
  attachments?: string[];
  warning?: string;
  web_url?: string;
  error?: string;
}

interface MergeResult {
  created: number;
  failed?: number;
  drafts: Row[];
  next?: string;
}

function merge(ctx: TestContext, args: Record<string, unknown>): Promise<CallToolResult> {
  return runTool(gmailCreateDrafts, { account: 'me', ...args }, ctx);
}

/**
 * Gmail with a name and signature, drafts numbered D1, D2, ... (messages dm1, dm2, ...), and a Drive PDF "prices".
 * `failDraft` makes that draft upload (1-based) fail with a 400.
 */
function fakeGoogle(opts: { failDraft?: number } = {}): FakeGoogle {
  let drafts = 0;
  return (c) => {
    const p = c.url.pathname;
    if (p === `${GMAIL}/settings/sendAs`) return { json: SEND_AS };
    // Small drafts come as JSON, large ones through the upload endpoint.
    if (c.method === 'POST' && (p === `${GMAIL}/drafts` || p === `/upload${GMAIL}/drafts`)) {
      drafts++;
      if (drafts === opts.failDraft) return { status: 400, json: { error: { code: 400, message: 'Invalid To header', errors: [{ reason: 'invalidArgument' }] } } };
      return { json: { id: `D${drafts}`, message: { id: `dm${drafts}`, threadId: `t${drafts}` } } };
    }
    if (p === `${DRIVE}/prices` && c.url.searchParams.get('alt') === 'media') return { body: PRICES };
    if (p === `${DRIVE}/prices`) return { json: { id: 'prices', name: 'Tarifs 2026.pdf', mimeType: 'application/pdf', size: String(PRICES.length) } };
    return undefined;
  };
}

interface Leaf {
  type: string;
  filename?: string;
  data: Buffer;
}

interface Built {
  headers: Record<string, string>;
  text: string;
  html?: string;
  files: { filename: string; data: Buffer }[];
}

function splitEntity(raw: string): { head: string; body: string } {
  const at = raw.indexOf('\r\n\r\n');
  return { head: raw.slice(0, at).replace(/\r\n[ \t]/g, ' '), body: raw.slice(at + 4) };
}

/** Every leaf part of a MIME entity, multiparts walked, base64 decoded. */
function leaves(raw: string): Leaf[] {
  const { head, body } = splitEntity(raw);
  const type = /^Content-Type:\s*([^;\r\n]+)/im.exec(head)?.[1]?.trim().toLowerCase() ?? 'text/plain';
  const boundary = /boundary="([^"]+)"/i.exec(head)?.[1];
  if (type.startsWith('multipart/') && boundary) {
    return body.split(`--${boundary}`).slice(1, -1).flatMap((part) => leaves(part.replace(/^\r\n/, '')));
  }
  return [{ type, filename: /filename="([^"]*)"/i.exec(head)?.[1], data: Buffer.from(body.replace(/\s+/g, ''), 'base64') }];
}

/** The message a drafts.create call carried: headers, text, HTML and attached files. */
function built(c: RecordedCall): Built {
  const raw = Buffer.from((c.json as { message: { raw: string } }).message.raw, 'base64url').toString('utf8');
  const headers: Record<string, string> = {};
  for (const line of splitEntity(raw).head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const parts = leaves(raw);
  const text = parts.find((l) => l.type === 'text/plain' && !l.filename);
  const html = parts.find((l) => l.type === 'text/html' && !l.filename);
  return {
    headers,
    text: (text?.data.toString('utf8') ?? '').replace(/\r\n/g, '\n'),
    html: html?.data.toString('utf8').replace(/\r\n/g, '\n'),
    files: parts.filter((l) => l.filename !== undefined).map((l) => ({ filename: l.filename!, data: l.data })),
  };
}

function draftCalls(ctx: TestContext): RecordedCall[] {
  return apiCalls(ctx).filter((c) => c.method === 'POST' && c.url.pathname === `${GMAIL}/drafts`);
}

const TEMPLATE = {
  subject: 'Devis pour {{ company }}',
  body_text: 'Bonjour {{first_name}},\nVoici le devis pour {{company}}.',
  body_html: '<p>Bonjour {{first_name}},</p><p>Voici le devis pour <b>{{ company }}</b>.</p>',
};

// ---------------------------------------------------------------------------

test('tool contract: a non-destructive, non-idempotent Gmail write with every parameter described', () => {
  assert.equal(gmailCreateDrafts.name, 'gmail_create_drafts');
  assert.equal(gmailCreateDrafts.service, 'gmail');
  assert.deepEqual(gmailCreateDrafts.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  for (const [key, schema] of Object.entries(gmailCreateDrafts.inputSchema)) {
    assert.ok((schema as { description?: string }).description, `${key} is described`);
  }
  assert.match(gmailCreateDrafts.description, /gmail_send_draft with draft_ids/);
});

test('templates: {{ field }} with inner spaces, names listed once, values put in one pass', () => {
  assert.deepEqual(templateFields('Hi {{ first_name }} {{a.b-c}}', '{{first_name}} {{bad name}} {{}}', undefined), ['first_name', 'a.b-c']);
  assert.deepEqual(badFieldRefs('Hi {{ first_name }} {{a.b-c}}', '{{first_name}} {{bad name}} {{prénom}} {{bad name}} {{}}', undefined), ['{{bad name}}']);
  assert.deepEqual(badFieldRefs(`{{${'x'.repeat(40)}}} {{${'y'.repeat(41)}}}`), [`{{${'y'.repeat(41)}}}`], 'a name is 40 characters at most');
  assert.equal(fillTemplate('Hi {{ name }}, {{name}}!', { name: 'Ann' }), 'Hi Ann, Ann!');
  assert.equal(fillTemplate('{{a}} {{b}}', { a: '{{b}}', b: 'x' }), '{{b}} x', 'a value is not filled in again');
  assert.equal(fillTemplate('<b>{{a}}</b>', { a: `Tom & "Jerry" <x> 'y'` }, true), '<b>Tom &amp; &quot;Jerry&quot; &lt;x&gt; &#39;y&#39;</b>');
  assert.equal(fillTemplate('{{constructor}}', {}), '{{constructor}}', 'only the recipient\'s own fields count');
});

test('two recipients get two drafts, each with its own subject, text and escaped HTML, under the Gmail name and signed', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const res = await merge(ctx, {
    ...TEMPLATE,
    recipients: [
      { to: ['Ann Lee <ann@example.com>'], fields: { first_name: 'Ann', company: 'Smith & Sons <Ltd>' } },
      { to: ['bob@example.com'], cc: ['carl@example.com'], fields: { first_name: 'Bob', company: `Acme "Q" 'R'`, unused: 'ignored' } },
    ],
  });
  assert.equal(res.isError, undefined, resultText(res));
  assert.deepEqual(resultJson<MergeResult>(res), {
    created: 2,
    drafts: [
      { draft_id: 'D1', message_id: 'dm1', to: 'Ann Lee <ann@example.com>', subject: 'Devis pour Smith & Sons <Ltd>', web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1' },
      { draft_id: 'D2', message_id: 'dm2', to: 'bob@example.com', subject: `Devis pour Acme "Q" 'R'`, web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm2' },
    ],
    next: 'Review them, then send with gmail_send_draft draft_ids: ["D1","D2"]',
  });

  const [first, second] = draftCalls(ctx).map(built);
  assert.equal(first!.headers['from'], 'Sam Sender <me@example.com>');
  assert.equal(first!.headers['to'], 'Ann Lee <ann@example.com>');
  assert.equal(first!.headers['subject'], 'Devis pour Smith & Sons <Ltd>');
  assert.equal(first!.headers['cc'], undefined);
  assert.equal(first!.text, 'Bonjour Ann,\nVoici le devis pour Smith & Sons <Ltd>.\n\n-- \nSam Sender\n01 23 45 67 89\n');
  assert.match(first!.html!, /^<p>Bonjour Ann,<\/p><p>Voici le devis pour <b>Smith &amp; Sons &lt;Ltd&gt;<\/b>\.<\/p>/);
  assert.match(first!.html!, /class="gmail_signature"[^>]*><div dir="ltr">Sam Sender<br>01 23 45 67 89<\/div>/);
  assert.equal(first!.files.length, 0);

  assert.equal(second!.headers['from'], 'Sam Sender <me@example.com>');
  assert.equal(second!.headers['to'], 'bob@example.com');
  assert.equal(second!.headers['cc'], 'carl@example.com');
  assert.equal(second!.headers['subject'], `Devis pour Acme "Q" 'R'`);
  assert.match(second!.text, /^Bonjour Bob,\nVoici le devis pour Acme "Q" 'R'\.\n\n-- \nSam Sender/);
  assert.match(second!.html!, /<b>Acme &quot;Q&quot; &#39;R&#39;<\/b>/);
});

test('shared attachments are fetched once and go in every draft; a recipient\'s own files only in theirs', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const res = await merge(ctx, {
    subject: 'Tarifs',
    body_text: 'Bonjour {{name}}, voici nos tarifs.',
    attachments: [{ drive_file_id: 'prices' }],
    recipients: [
      { to: ['ann@example.com'], fields: { name: 'Ann' }, attachments: [{ content: 'ref,qty\nA1,3\n', filename: 'commande-ann.csv' }] },
      { to: ['bob@example.com'], fields: { name: 'Bob' } },
    ],
    signature: false,
  });
  const out = resultJson<MergeResult>(res);
  assert.equal(out.created, 2);
  assert.deepEqual(out.drafts.map((d) => d.attachments), [['Tarifs 2026.pdf', 'commande-ann.csv'], ['Tarifs 2026.pdf']]);
  const downloads = apiCalls(ctx).filter((c) => c.url.pathname === `${DRIVE}/prices` && c.url.searchParams.get('alt') === 'media');
  assert.equal(downloads.length, 1, 'the shared file is fetched once');

  const [ann, bob] = draftCalls(ctx).map(built);
  assert.deepEqual(ann!.files.map((f) => f.filename), ['Tarifs 2026.pdf', 'commande-ann.csv']);
  assert.deepEqual(ann!.files[0]!.data, PRICES);
  assert.equal(ann!.files[1]!.data.toString(), 'ref,qty\nA1,3\n');
  assert.deepEqual(bob!.files.map((f) => f.filename), ['Tarifs 2026.pdf']);
  assert.deepEqual(bob!.files[0]!.data, PRICES);
  assert.equal(bob!.text, 'Bonjour Bob, voici nos tarifs.', 'signature: false');
});

test('a missing field is reported for each recipient that lacks it, and nothing is created', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const res = await merge(ctx, {
    ...TEMPLATE,
    recipients: [
      { to: ['ann@example.com'], fields: { first_name: 'Ann', company: 'Acme' } },
      { to: ['Bob <bob@example.com>'], fields: { first_name: 'Bob' } },
      { to: ['carl@example.com'] },
      { to: ['dan@example.com'], fields: { first_name: '', company: 'Empty is a value' } },
    ],
  });
  assert.equal(res.isError, true);
  const text = resultText(res);
  assert.match(text, /- recipient 2 \(bob@example\.com\): missing company\n/);
  assert.match(text, /- recipient 3 \(carl@example\.com\): missing company, first_name\n/, 'in order of first use (the subject first)');
  assert.doesNotMatch(text, /recipient [14]/);
  assert.match(text, /\{\{company\}\}, \{\{first_name\}\}/);
  assert.match(text, /Nothing was created\.$/);
  assert.equal(ctx.calls.length, 0, 'no Google call at all, not even for the name and signature');
});

test('an invalid address is refused before any Google call', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const res = await merge(ctx, {
    subject: 'Hello',
    body_text: 'Hi {{name}}',
    recipients: [
      { to: ['ann@example.com'], fields: { name: 'Ann' } },
      { to: ['bob@example.com'], bcc: ['not-an-address'], fields: { name: 'Bob' } },
    ],
  });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /- recipient 2 \(bob@example\.com\): bcc: "not-an-address" is not/);
  assert.match(resultText(res), /Correct the addresses\. Nothing was created\.$/);
  assert.equal(ctx.calls.length, 0);
});

test('a blank left in the template is flagged in every draft it lands in', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'Rendez-vous',
      body_text: 'Bonjour {{name}},\nAppelez-moi au [téléphone].',
      body_html: '<p>Bonjour {{name}},</p><p>Appelez-moi au [téléphone].</p>',
      recipients: [
        { to: ['ann@example.com'], fields: { name: 'Ann' } },
        { to: ['bob@example.com'], fields: { name: 'Bob' } },
      ],
    }),
  );
  assert.equal(out.created, 2);
  for (const d of out.drafts) assert.match(d.warning ?? '', /unfilled blanks: "\[téléphone\]"\. Fill them in/);
  assert.match(out.next ?? '', /draft_ids: \["D1","D2"\]/);
});

test('a failed draft costs only its own recipient: the others are created and listed for sending', async () => {
  const ctx = createTestContext({ google: fakeGoogle({ failDraft: 2 }) });
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'Invitation',
      body_text: 'Bonjour {{name}}',
      recipients: [
        { to: ['ann@example.com'], fields: { name: 'Ann' } },
        { to: ['bob@example.com'], fields: { name: 'Bob' } },
        { to: ['carl@example.com'], fields: { name: 'Carl' } },
      ],
    }),
  );
  assert.equal(out.created, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.drafts[0]!.draft_id, 'D1');
  assert.deepEqual(Object.keys(out.drafts[1]!).sort(), ['error', 'to']);
  assert.equal(out.drafts[1]!.to, 'bob@example.com');
  assert.match(out.drafts[1]!.error!, /400.*Invalid To header/);
  assert.equal(out.drafts[2]!.draft_id, 'D3');
  assert.equal(out.next, 'Review them, then send with gmail_send_draft draft_ids: ["D1","D3"]');
});

test('a recipient whose own attachment cannot be used gets an error row; a bad shared attachment stops everything', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'Docs',
      body_text: 'Hi',
      recipients: [{ to: ['ann@example.com'], attachments: [{ content: 'no name' }] }, { to: ['bob@example.com'] }],
    }),
  );
  assert.equal(out.created, 1);
  assert.equal(out.failed, 1);
  assert.match(out.drafts[0]!.error!, /^recipients\[0\]\.attachments\[0\]: A content attachment needs a filename/);
  assert.equal(out.drafts[1]!.draft_id, 'D1');

  const ctx2 = createTestContext({ google: fakeGoogle() });
  const shared = await merge(ctx2, { subject: 'Docs', body_text: 'Hi', attachments: [{ content: 'no name' }], recipients: [{ to: ['ann@example.com'] }] });
  assert.equal(shared.isError, true);
  assert.match(resultText(shared), /^attachments\[0\]: .* Nothing was created\.$/);
  assert.equal(draftCalls(ctx2).length, 0);
});

test('shared and own attachments above 25 MB together are refused for that draft only', async () => {
  const big = Buffer.alloc(13 * 1024 * 1024, 0x41).toString('base64');
  const ctx = createTestContext({ google: fakeGoogle() });
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'Plans',
      body_text: 'Hi',
      attachments: [{ content_base64: big, filename: 'plan-a.bin' }],
      recipients: [{ to: ['ann@example.com'], attachments: [{ content_base64: big, filename: 'plan-b.bin' }] }, { to: ['bob@example.com'] }],
    }),
  );
  assert.equal(out.failed, 1);
  assert.match(out.drafts[0]!.error!, /add up to 26 MB, above Gmail's 25 MB limit/);
  assert.equal(out.drafts[1]!.draft_id, 'D1');
});

test('no draft is started once the call has run for two minutes, so the result gets back in time', async (t) => {
  let now = Date.parse('2026-09-25T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const inner = fakeGoogle();
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'POST' && c.url.pathname === `${GMAIL}/drafts`) now += 70_000; // each upload takes 70 s
      return inner(c);
    },
  });
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'S',
      body_text: 'Hi {{n}}',
      recipients: ['a', 'b', 'c'].map((n) => ({ to: [`${n}@example.com`], fields: { n } })),
    }),
  );
  assert.equal(out.created, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.drafts[2]!.to, 'c@example.com');
  assert.match(out.drafts[2]!.error!, /ran out of time.*again with only the recipients that have an error/);
  assert.equal(draftCalls(ctx).length, 2);
});

test('logs carry counts and the alias, never addresses, names or subjects', async () => {
  const lines: string[] = [];
  const ctx = createTestContext({ google: fakeGoogle({ failDraft: 1 }) });
  ctx.log = createLogger('debug', {}, (line) => lines.push(line));
  await merge(ctx, {
    subject: 'Secret subject {{name}}',
    body_text: 'Private text',
    recipients: [
      { to: ['ann@example.com'], fields: { name: 'Annabelle' } },
      { to: ['bob@example.com'], fields: { name: 'Bobby' } },
    ],
  });
  const logged = lines.join('\n');
  assert.match(logged, /"created":1/);
  assert.match(logged, /"failed":1/);
  assert.doesNotMatch(logged, /@|Secret|Private|Annabelle|Bobby|Invalid To/);
});

test('a {{...}} that is not a field name ({{first name}}, {{ }}) is refused before any Google call', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const res = await merge(ctx, {
    subject: 'Bonjour {{prénom}}',
    body_text: 'Bonjour {{prénom}}, {{first name}} {{ok}}',
    body_html: '<p>{{ }}</p>',
    recipients: [
      { to: ['ann@example.com'], fields: { prénom: 'Ann', ok: '1' } },
      { to: ['bob@example.com'], fields: { prénom: 'Bob', ok: '2' } },
    ],
  });
  assert.equal(res.isError, true);
  const text = resultText(res);
  assert.match(text, /\{\{first name\}\}, \{\{ \}\}/);
  assert.doesNotMatch(text, /\{\{prénom\}\},/, 'an accented name is a field');
  assert.match(text, /accents are fine, spaces are not/);
  assert.match(text, /Nothing was created\.$/);
  assert.equal(ctx.calls.length, 0);
});

test('accented field names work, whichever way the accent was typed', () => {
  const composed = 'pr\u00e9nom';
  const decomposed = 'pre\u0301nom';
  assert.deepEqual(templateFields(`Bonjour {{${decomposed}}}`), [composed]);
  assert.equal(fillTemplate(`Bonjour {{${decomposed}}} et {{ ${composed} }}`, { [composed]: 'Élodie' }), 'Bonjour Élodie et Élodie');
  assert.equal(fillTemplate(`Bonjour {{${composed}}}`, { [decomposed]: 'Élodie' }), 'Bonjour Élodie');
  assert.deepEqual(badFieldRefs('{{prénom}} {{société}} {{名前}}'), []);
});

test('rows show recipients as written, not header-encoded', async () => {
  const ctx = createTestContext({ google: fakeGoogle({ failDraft: 2 }) });
  const long = 'Élodie Martin-Dupont de la Fontaine-Bérénice';
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'Hi',
      body_text: 'Hi {{n}}',
      recipients: [
        { to: [`${long} <elodie@example.com>`], fields: { n: 'Élodie' } },
        { to: ['"Lee, Ann" <ann@example.com>', 'bob@example.com'], fields: { n: 'Ann' } },
      ],
      signature: false,
    }),
  );
  assert.equal(out.drafts[0]!.to, `${long} <elodie@example.com>`);
  assert.equal(out.drafts[1]!.to, '"Lee, Ann" <ann@example.com>, bob@example.com');
  assert.ok(out.drafts[1]!.error, 'error rows too');
  assert.match(built(draftCalls(ctx)[0]!).headers['to']!, /^=\?UTF-8\?B\?.*<elodie@example\.com>$/, 'the header itself stays encoded');
});

test('an account error on the first upload stops the batch with one error; later on, it stops the rest', async () => {
  const denied = (n: number, at: number) =>
    n === at ? { status: 403, json: { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } } } : undefined;
  const recipientsList = ['a', 'b', 'c'].map((n) => ({ to: [`${n}@example.com`], fields: { n } }));

  for (const at of [1, 2]) {
    let n = 0;
    const inner = fakeGoogle();
    const ctx = createTestContext({
      google: (c) => {
        if (c.method === 'POST' && c.url.pathname === `${GMAIL}/drafts`) return denied(++n, at) ?? inner(c);
        return inner(c);
      },
    });
    const res = await merge(ctx, { subject: 'S', body_text: 'Hi {{n}}', recipients: recipientsList });
    assert.equal(draftCalls(ctx).length, at, 'no upload after the account error');
    if (at === 1) {
      assert.equal(res.isError, true);
      assert.match(resultText(res), /lacks permission.*No draft was created\.$/s);
    } else {
      const out = resultJson<MergeResult>(res);
      assert.equal(out.created, 1);
      assert.equal(out.failed, 2);
      assert.match(out.drafts[1]!.error!, /lacks permission/);
      assert.match(out.drafts[2]!.error!, /^Not created: stopped at the account error above/);
      assert.equal(out.next, 'Review them, then send with gmail_send_draft draft_ids: ["D1"]');
    }
  }
});

test('an empty body_html is no HTML part at all, not one holding only the signature', async () => {
  const ctx = createTestContext({ google: fakeGoogle() });
  const out = resultJson<MergeResult>(
    await merge(ctx, { subject: 'S', body_text: 'Hello {{n}}, the real body', body_html: '  ', recipients: [{ to: ['ann@example.com'], fields: { n: 'Ann' } }] }),
  );
  assert.equal(out.created, 1);
  const draft = built(draftCalls(ctx)[0]!);
  assert.equal(draft.html, undefined);
  assert.match(draft.text, /^Hello Ann, the real body\n\n-- \nSam Sender/);
});

test('an upload is not started when it could end after claude.ai stops waiting', async (t) => {
  let now = Date.parse('2026-09-25T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const inner = fakeGoogle();
  const ctx = createTestContext({
    google: (c) => {
      if (c.url.pathname === `${DRIVE}/prices` && c.url.searchParams.get('alt') === 'media') now += 175_000; // a slow download
      return inner(c);
    },
  });
  const out = resultJson<MergeResult>(
    await merge(ctx, {
      subject: 'S',
      body_text: 'Hi {{n}}',
      recipients: [
        { to: ['a@example.com'], fields: { n: 'a' } },
        { to: ['b@example.com'], fields: { n: 'b' }, attachments: [{ drive_file_id: 'prices' }] },
        { to: ['c@example.com'], fields: { n: 'c' } },
      ],
    }),
  );
  assert.equal(out.created, 1);
  assert.equal(out.failed, 2);
  assert.match(out.drafts[1]!.error!, /ran out of time/);
  assert.match(out.drafts[2]!.error!, /ran out of time/);
  assert.equal(draftCalls(ctx).length, 1);
});

test('single-brace typos of a given field are refused before any Google call; hyphens, dots and accents are fine', async () => {
  assert.deepEqual(mistypedRefs(['first-name', 'a.b', 'prénom', 'ok'], 'Bonjour {first-name}, {{a.b} {prénom}} {{ok}} {axb}'), ['{first-name}', '{{a.b}', '{prénom}}']);
  assert.deepEqual(mistypedRefs(['bad name', 'x'], '{bad name} {{x}}'), [], 'only real field names, and {{x}} is right');
  const ctx = createTestContext({ google: fakeGoogle() });
  const res = await merge(ctx, {
    subject: 'Devis',
    body_text: 'Bonjour {first_name},',
    recipients: [{ to: ['ann@example.com'], fields: { first_name: 'Ann' } }],
  });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /\{first_name\}: a field is written between double braces.*Nothing was created\./);
  assert.equal(ctx.calls.length, 0);
});

test('a line break in a value is a line break in the HTML draft too', () => {
  assert.equal(fillTemplate('<p>{{adresse}}</p>', { adresse: '1 rue X\n75001 Paris' }, true), '<p>1 rue X<br>75001 Paris</p>');
  assert.equal(fillTemplate('{{adresse}}', { adresse: '1 rue X\n75001 Paris' }), '1 rue X\n75001 Paris');
});

test('a recipient\'s own files are waited for only until the deadline; a late failure cannot crash the process', async () => {
  const { beforeDeadline } = await import('./gmail-merge.js');
  assert.equal(await beforeDeadline(Promise.resolve('ok'), 1000), 'ok');
  const slow = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late failure')), 30));
  assert.equal(typeof (await beforeDeadline(slow, 5)), 'symbol', 'out of time');
  assert.equal(typeof (await beforeDeadline(Promise.reject(new Error('x')), 0)), 'symbol');
  await new Promise((r) => setTimeout(r, 50)); // the late rejection is handled: no unhandledRejection
  await assert.rejects(beforeDeadline(Promise.reject(new Error('fast failure')), 1000), /fast failure/);
});
