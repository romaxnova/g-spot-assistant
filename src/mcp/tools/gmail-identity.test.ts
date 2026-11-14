import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCalls, createTestContext, resultJson, type RecordedCall } from '../../test-support.js';
import { listAccountsResult, runTool } from '../server.js';
import { gmailTools } from './gmail.js';
import { gmailUpdateDraft } from './gmail-update-draft.js';
import { containsSignature, fromHeader, gmailIdentity, gmailWebUrl, identityFrom, readableFrom, withSignature } from './gmail-identity.js';
import type { GmailPart } from './gmail-mime.js';

const GMAIL = '/gmail/v1/users/me';
const SIGNATURE = '<div dir="ltr">Sam Sender<br>01 23 45 67 89<br><a href="https://example.com">example.com</a></div>';
const SEND_AS = {
  sendAs: [
    { sendAsEmail: 'me@example.com', displayName: 'Sam Sender', signature: SIGNATURE, isPrimary: true, isDefault: true },
    { sendAsEmail: 'Alias@Example.org', displayName: 'Sam (work)', signature: '', verificationStatus: 'accepted' },
    { sendAsEmail: 'pending@example.net', verificationStatus: 'pending' },
  ],
};

function tool(name: string) {
  const def = gmailTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

/** The raw message a send or draft call carried, decoded. */
function raw(c: RecordedCall): string {
  const json = c.json as { raw?: string; message?: { raw?: string } };
  return Buffer.from(json.raw ?? json.message?.raw ?? '', 'base64url').toString('utf8');
}

/** Decodes the text and HTML parts of a built message (single-part or multipart; base64 or quoted-printable). */
function parts(message: string): { text: string; html?: string } {
  const out: { text: string; html?: string } = { text: '' };
  for (const chunk of message.split(/\r\n--[^\r\n]+\r\n/)) {
    const split = chunk.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = chunk.slice(0, split);
    const type = /(?:^|\r\n)Content-Type:\s*(text\/(?:plain|html))/i.exec(head)?.[1]?.toLowerCase();
    if (!type) continue;
    let body = chunk.slice(split + 4).replace(/\r\n--[^\r\n]*--\r\n?$/, '');
    body = /Content-Transfer-Encoding:\s*base64/i.test(head)
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
      : /quoted-printable/i.test(head)
        ? Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')
        : body;
    if (type === 'text/html') out.html = body;
    else out.text = body;
  }
  return out;
}

function fake(sendAs: unknown = SEND_AS, extra?: (c: RecordedCall) => unknown) {
  return (c: RecordedCall) => {
    const p = c.url.pathname.replace(GMAIL, '');
    if (p === '/settings/sendAs') return sendAs instanceof Response ? sendAs : { json: sendAs };
    const answer = extra?.(c);
    if (answer) return answer as never;
    if (p === '/messages/send') return { json: { id: 'sent-1', threadId: 't-1', labelIds: ['SENT'] } };
    if (p === '/drafts') return { json: { id: 'D1', message: { id: 'dm1', threadId: 'dt1' } } };
    return undefined;
  };
}

test('identity: the account\'s own name and signature, its verified aliases, and a From header with the name', () => {
  const id = identityFrom('me@example.com', SEND_AS.sendAs);
  assert.equal(id.displayName, 'Sam Sender');
  assert.equal(id.signature?.text, 'Sam Sender\n01 23 45 67 89\nexample.com');
  assert.deepEqual(id.addresses, ['me@example.com', 'alias@example.org'], 'the pending alias is not the account');
  assert.equal(fromHeader(id), 'Sam Sender <me@example.com>');
  assert.equal(fromHeader(identityFrom('me@example.com', [])), 'me@example.com');
  assert.equal(identityFrom('me@example.com', [{ sendAsEmail: 'me@example.com', signature: '<div><br></div>' }]).signature, undefined, 'an empty-looking signature is none');
});

test('withSignature adds "-- " and the signature once, in text and HTML, and never twice', () => {
  const id = identityFrom('me@example.com', SEND_AS.sendAs);
  const plain = withSignature({ text: 'Bonjour,\nMerci.\n\n' }, id);
  assert.equal(plain.text, 'Bonjour,\nMerci.\n\n-- \nSam Sender\n01 23 45 67 89\nexample.com\n');
  assert.equal(plain.added, true);
  const rich = withSignature({ text: 'Bonjour', html: '<p>Bonjour</p>' }, id);
  assert.match(rich.html!, /<p>Bonjour<\/p>.*gmail_signature_prefix">-- <\/span>.*class="gmail_signature".*Sam Sender<br>01 23 45 67 89/s);
  const typed = withSignature({ text: 'Bonjour\n\nSam   Sender\n01 23 45 67 89\nexample.com' }, id);
  assert.equal(typed.added, false, 'already in the text (whitespace aside)');
  assert.equal(withSignature({ text: 'x' }, id, false).added, false);
  assert.equal(withSignature({ text: 'x' }, identityFrom('me@example.com', [])).added, false);
});

test('web links open the draft or message in the right account', () => {
  assert.equal(gmailWebUrl('me@example.com', 'draft', '1a0d'), 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=1a0d');
  assert.equal(gmailWebUrl('a+b@example.com', 'message', 'x/y'), 'https://mail.google.com/mail/u/a+b@example.com/#all/x%2Fy');
});

test('gmail_send goes out under the Gmail name with the signature; the settings are read once', async () => {
  const ctx = createTestContext({ google: fake() });
  const out = resultJson<{ from: string; signature_added?: boolean }>(await runTool(tool('gmail_send'), { account: 'me', to: ['ann@example.com'], subject: 'Devis', body_text: 'Bonjour,\nMerci.', body_html: '<p>Bonjour,</p><p>Merci.</p>' }, ctx));
  assert.equal(out.from, 'Sam Sender <me@example.com>');
  assert.equal(out.signature_added, true);
  const message = raw(apiCalls(ctx).at(-1)!);
  assert.match(message, /^From: Sam Sender <me@example.com>\r$/m);
  const body = parts(message);
  assert.match(body.text, /Merci\.\r?\n\r?\n-- \r?\nSam Sender\r?\n01 23 45 67 89/);
  assert.match(body.html ?? '', /class="gmail_signature"/);

  await runTool(tool('gmail_send'), { account: 'me', to: ['ann@example.com'], subject: 'Sans', body_text: 'Court.', signature: false }, ctx);
  assert.doesNotMatch(parts(raw(apiCalls(ctx).at(-1)!)).text, /Sam Sender/);
  assert.equal(ctx.calls.filter((c) => c.url.pathname.endsWith('/settings/sendAs')).length, 1, 'cached');
});

test('when Gmail\'s settings cannot be read, mail still goes out, from the bare address and unsigned', async () => {
  const denied = new Response(JSON.stringify({ error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } }), { status: 403, headers: { 'content-type': 'application/json' } });
  const ctx = createTestContext({ google: fake(denied) });
  const out = resultJson<{ id: string; from: string; signature_added?: boolean }>(await runTool(tool('gmail_send'), { account: 'me', to: ['ann@example.com'], subject: 's', body_text: 'b' }, ctx));
  assert.equal(out.id, 'sent-1');
  assert.equal(out.from, 'me@example.com');
  assert.equal(out.signature_added, undefined);
});

test('gmail_reply treats send-as aliases as the account: reply-all leaves them out', async () => {
  const original = {
    id: 'm1',
    threadId: 't-orig',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Ann <ann@example.com>' },
        { name: 'To', value: 'alias@example.org, bob@example.com' },
        { name: 'Cc', value: 'me@example.com' },
        { name: 'Subject', value: 'Plan' },
        { name: 'Message-ID', value: '<orig@example.com>' },
      ],
    },
  };
  const ctx = createTestContext({ google: fake(SEND_AS, (c) => (c.url.pathname.endsWith('/messages/m1') ? { json: original } : undefined)) });
  const out = resultJson<{ to: string[]; cc?: string[] }>(await runTool(tool('gmail_reply'), { account: 'me', message_id: 'm1', body_text: 'OK', reply_all: true }, ctx));
  assert.deepEqual(out.to, ['Ann <ann@example.com>']);
  assert.deepEqual(out.cc, ['bob@example.com']);
});

test('gmail_forward puts the signature under the note and above the forwarded message', async () => {
  const text = 'Original text';
  const original: { id: string; threadId: string; payload: GmailPart } = {
    id: 'm1',
    threadId: 't',
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'x@example.com' }, { name: 'Subject', value: 'Offre' }], body: { data: Buffer.from(text).toString('base64url'), size: text.length } },
  };
  const ctx = createTestContext({ google: fake(SEND_AS, (c) => (c.url.pathname.endsWith('/messages/m1') ? { json: original } : undefined)) });
  await runTool(tool('gmail_forward'), { account: 'me', message_id: 'm1', to: ['b@example.com'], note: 'Pour info' }, ctx);
  const body = parts(raw(apiCalls(ctx).at(-1)!)).text.replace(/\r\n/g, '\n');
  assert.match(body, /^Pour info\n\n-- \nSam Sender\n01 23 45 67 89\nexample\.com\n\n---------- Forwarded message ---------/);
});

test('gmail_create_draft signs the draft and links to it in Gmail', async () => {
  const ctx = createTestContext({ google: fake() });
  const out = resultJson<{ signature_added?: boolean; web_url: string }>(await runTool(tool('gmail_create_draft'), { account: 'me', to: ['ann@example.com'], subject: 'Devis', body_text: 'Bonjour' }, ctx));
  assert.equal(out.signature_added, true);
  assert.equal(out.web_url, 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1');
  assert.match(parts(raw(apiCalls(ctx).at(-1)!)).text, /-- \r?\nSam Sender/);
});

test('gmail_update_draft signs new text once; the text Claude kept from the draft is not signed twice', async () => {
  const draft = ['From: me@example.com', 'To: ann@example.com', 'Subject: Note', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'Old text', ''].join('\r\n');
  const ctx = createTestContext({
    google: fake(SEND_AS, (c) => {
      const p = c.url.pathname;
      if (c.method === 'GET' && p === `${GMAIL}/drafts/D1`) return { json: { id: 'D1', message: { id: 'm-old', threadId: 't', raw: Buffer.from(draft).toString('base64url') } } };
      if (c.method === 'PUT') return { json: { id: 'D1', message: { id: 'm-new', threadId: 't' } } };
      return undefined;
    }),
  });
  const first = resultJson<{ signature_added?: boolean; web_url: string }>(await runTool(gmailUpdateDraft, { account: 'me', draft_id: 'D1', body_text: 'New text' }, ctx));
  assert.equal(first.signature_added, true);
  assert.equal(first.web_url, 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=m-new');
  const saved = Buffer.from((apiCalls(ctx).find((c) => c.method === 'PUT')!.json as { message: { raw: string } }).message.raw, 'base64url').toString('utf8');
  assert.match(parts(saved).text, /New text\r?\n\r?\n-- \r?\nSam Sender/);

  const again = resultJson<{ signature_added?: boolean }>(await runTool(gmailUpdateDraft, { account: 'me', draft_id: 'D1', body_text: 'New text\n\n-- \nSam Sender\n01 23 45 67 89\nexample.com' }, ctx));
  assert.equal(again.signature_added, undefined);
  const subjectOnly = resultJson<{ signature_added?: boolean }>(await runTool(gmailUpdateDraft, { account: 'me', draft_id: 'D1', subject: 'Note 2' }, ctx));
  assert.equal(subjectOnly.signature_added, undefined, 'the text was not touched');
});

test('list_accounts shows each Gmail account\'s name, signature and other send-as addresses', async () => {
  const ctx = createTestContext({ google: fake() });
  const text = (await listAccountsResult(ctx)).content[0];
  const out = JSON.parse(text?.type === 'text' ? text.text : '{}') as { accounts: Record<string, unknown>[] };
  assert.equal(out.accounts[0]!['gmail_name'], 'Sam Sender');
  assert.equal(out.accounts[0]!['gmail_signature'], 'Sam Sender\n01 23 45 67 89\nexample.com');
  assert.deepEqual(out.accounts[0]!['send_as'], ['alias@example.org']);
});

test('a blank body_html is no HTML body: the mail stays text only, never an HTML part holding just the signature', async () => {
  const id = identityFrom('me@example.com', SEND_AS.sendAs);
  assert.equal(withSignature({ text: 'Bonjour', html: '  ' }, id).html, undefined);
  const ctx = createTestContext({ google: fake() });
  await runTool(tool('gmail_send'), { account: 'me', to: ['ann@example.com'], subject: 's', body_text: 'Bonjour', body_html: '' }, ctx);
  const message = raw(apiCalls(ctx).at(-1)!);
  assert.doesNotMatch(message, /text\/html/);
  assert.match(parts(message).text, /Bonjour\r?\n\r?\n-- \r?\nSam Sender/);
});

test('a signature counts as present only as whole lines: "Tom" is not found in "tomorrow"', () => {
  const tom = identityFrom('me@example.com', [{ sendAsEmail: 'me@example.com', isPrimary: true, signature: 'Tom' }]);
  assert.equal(withSignature({ text: 'Hi Ann,\nSee you tomorrow at 10.' }, tom).added, true);
  assert.equal(withSignature({ text: 'Le marché est conclu.\nTom' }, tom).added, false, 'a line that is the signature');
  assert.equal(containsSignature('A\nSam Sender\n01 23 45 67 89\nexample.com\nB', { html: '', text: 'Sam  Sender\n\n01 23 45 67 89\nexample.com' }), true);
  assert.equal(containsSignature('Sam Sender and 01 23 45 67 89 example.com', { html: '', text: 'Sam Sender\n01 23 45 67 89' }), false);
});

test('a draft written from a send-as alias gets that alias\'s signature, or none; a known signature is never doubled', async () => {
  const sendAs = {
    sendAs: [
      { sendAsEmail: 'me@example.com', displayName: 'Sam Sender', signature: SIGNATURE, isPrimary: true },
      { sendAsEmail: 'contact@biz.example', displayName: 'Biz', signature: '<div>Biz SARL</div>', verificationStatus: 'accepted' },
      { sendAsEmail: 'plain@biz.example', verificationStatus: 'accepted' },
    ],
  };
  const save = async (from: string, body: string) => {
    const draft = [`From: ${from}`, 'To: ann@example.com', 'Subject: Note', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'Old', ''].join('\r\n');
    const ctx = createTestContext({
      google: fake(sendAs, (c) => {
        if (c.method === 'GET' && c.url.pathname === `${GMAIL}/drafts/D1`) return { json: { id: 'D1', message: { id: 'm-old', raw: Buffer.from(draft).toString('base64url') } } };
        if (c.method === 'PUT') return { json: { id: 'D1', message: { id: 'm-new' } } };
        return undefined;
      }),
    });
    await runTool(gmailUpdateDraft, { account: 'me', draft_id: 'D1', body_text: body }, ctx);
    const put = apiCalls(ctx).find((c) => c.method === 'PUT')!;
    return parts(Buffer.from((put.json as { message: { raw: string } }).message.raw, 'base64url').toString('utf8')).text.replace(/\r\n/g, '\n');
  };
  assert.equal(await save('Biz <contact@biz.example>', 'Nouveau texte'), 'Nouveau texte\n\n-- \nBiz SARL\n');
  assert.equal(await save('plain@biz.example', 'Nouveau texte'), 'Nouveau texte', 'an alias without a signature gets none, not the account\'s');
  assert.equal(await save('Biz <contact@biz.example>', 'Nouveau texte\n\n-- \nBiz SARL'), 'Nouveau texte\n\n-- \nBiz SARL');
  assert.equal(await save('Sam Sender <me@example.com>', 'Texte'), 'Texte\n\n-- \nSam Sender\n01 23 45 67 89\nexample.com\n');
});

test('a shared mailbox the account only sends on behalf of (treatAsAlias false) is not the account: reply-all keeps it', async () => {
  const sendAs = { sendAs: [...SEND_AS.sendAs, { sendAsEmail: 'team@example.com', treatAsAlias: false, verificationStatus: 'accepted' }] };
  const id = identityFrom('me@example.com', sendAs.sendAs);
  assert.deepEqual(id.addresses, ['me@example.com', 'alias@example.org']);
  assert.deepEqual(id.sendAs, ['me@example.com', 'alias@example.org', 'team@example.com']);
  const original = {
    id: 'm1',
    threadId: 't',
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'client@example.net' }, { name: 'To', value: 'team@example.com' }, { name: 'Cc', value: 'me@example.com' }, { name: 'Subject', value: 'Q' }] },
  };
  const ctx = createTestContext({ google: fake(sendAs, (c) => (c.url.pathname.endsWith('/messages/m1') ? { json: original } : undefined)) });
  const out = resultJson<{ to: string[]; cc?: string[] }>(await runTool(tool('gmail_reply'), { account: 'me', message_id: 'm1', body_text: 'OK', reply_all: true }, ctx));
  assert.deepEqual(out.cc, ['team@example.com']);
});

test('the settings read is a background read: one try, a short timeout, and it does not mark the account as used', async () => {
  let reads = 0;
  const ctx = createTestContext({
    google: (c) => {
      if (c.url.pathname.endsWith('/settings/sendAs')) {
        reads++;
        return { status: 503, json: { error: { code: 503, message: 'Backend Error' } } };
      }
      return undefined;
    },
  });
  const id = await gmailIdentity(ctx, 'me');
  assert.equal(reads, 1, 'not retried');
  assert.equal(id.signature, undefined);

  const ok = createTestContext({ google: fake() });
  await listAccountsResult(ok);
  assert.equal(ok.accounts.get('me')?.lastUsedAt ?? null, null, 'listing accounts is not using them');
});

test('results show the sender readably, never header-encoded', () => {
  const id = identityFrom('me@example.com', [{ sendAsEmail: 'me@example.com', isPrimary: true, displayName: 'François Élie' }]);
  assert.equal(readableFrom(id), 'François Élie <me@example.com>');
  assert.match(fromHeader(id), /^=\?UTF-8\?/);
  assert.equal(readableFrom(identityFrom('me@example.com', [{ sendAsEmail: 'me@example.com', isPrimary: true, displayName: 'Dupont, Jean' }])), '"Dupont, Jean" <me@example.com>');
});
