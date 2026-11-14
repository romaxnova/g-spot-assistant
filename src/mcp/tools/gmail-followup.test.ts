import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall, type TestContext } from '../../test-support.js';
import { createLogger } from '../../log.js';
import { runTool } from '../server.js';
import { gmailAwaitingReply, mailbox } from './gmail-followup.js';
import type { GmailMessage } from './gmail.js';

const GMAIL = '/gmail/v1/users/me';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** internalDate of a message sent `days` days (plus an hour, off the day boundary) ago. */
const ago = (days: number) => String(NOW - days * DAY - 60 * 60 * 1000);
const SEND_AS = {
  sendAs: [
    { sendAsEmail: 'me@example.com', displayName: 'Sam Sender', isPrimary: true },
    { sendAsEmail: 'Alias@Example.org', displayName: 'Sam (work)', verificationStatus: 'accepted' },
  ],
};

interface Row {
  thread_id: string;
  message_id: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  sent_at: string;
  days_waiting: number;
  messages: number;
  replies_received?: number;
  bounced?: boolean;
  auto_reply?: boolean;
  web_url: string;
}
interface Out {
  threads?: Row[];
  examined: number;
  next_page_token?: string;
  note?: string;
}

interface Extra {
  cc?: string;
  bcc?: string;
  subject?: string;
  labels?: string[];
  mimeType?: string;
  headers?: Record<string, string>;
}

function msg(id: string, from: string, to: string, days: number, extra: Extra = {}): GmailMessage {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: extra.subject ?? 'Devis toiture' },
  ];
  if (extra.cc) headers.push({ name: 'Cc', value: extra.cc });
  if (extra.bcc) headers.push({ name: 'Bcc', value: extra.bcc });
  for (const [name, value] of Object.entries(extra.headers ?? {})) headers.push({ name, value });
  const labelIds = extra.labels ?? (/me@example\.com|alias@/i.test(from) ? ['SENT'] : ['INBOX']);
  return { id, threadId: '', labelIds, internalDate: ago(days), payload: { mimeType: extra.mimeType ?? 'text/plain', headers } };
}

/** Gmail with these threads; threads.list returns `listed` (thread ids, newest first), or the page `pages` gives for the page token. */
function fake(threads: Record<string, GmailMessage[]>, listed: string[], opts: { sendAs?: unknown; nextPageToken?: string; pages?: Record<string, { ids: string[]; next?: string }> } = {}) {
  return (c: RecordedCall) => {
    const p = c.url.pathname.replace(GMAIL, '');
    if (p === '/settings/sendAs') return opts.sendAs ? { json: opts.sendAs } : undefined;
    if (p === '/threads') {
      const page = opts.pages?.[c.url.searchParams.get('pageToken') ?? ''] ?? { ids: listed, next: opts.nextPageToken };
      return { json: { threads: page.ids.map((id) => ({ id, snippet: 'not used' })), nextPageToken: page.next } };
    }
    const t = /^\/threads\/(.+)$/.exec(p)?.[1];
    if (t && threads[t]) return { json: { id: t, messages: threads[t]!.map((m) => ({ ...m, threadId: t })) } };
    return undefined;
  };
}

async function run(ctx: TestContext, args: Record<string, unknown> = {}): Promise<Out> {
  return resultJson<Out>(await runTool(gmailAwaitingReply, { account: 'me', ...args }, ctx));
}

function listCall(ctx: TestContext): URLSearchParams {
  return apiCalls(ctx).find((c) => c.url.pathname === `${GMAIL}/threads`)!.url.searchParams;
}

test('lists sent threads nobody answered, newest first; answered threads and notes to self are left out', async () => {
  const threads = {
    // Asked, answered, followed up: the follow-up waits.
    chased: [
      msg('c1', 'me@example.com', 'Carol <carol@example.com>', 8),
      msg('c2', 'Carol <carol@example.com>', 'me@example.com', 7),
      msg('c3', 'Sam Sender <me@example.com>', 'Carol <carol@example.com>', 3, { subject: 'Re: Devis toiture' }),
    ],
    self: [msg('s1', 'me@example.com', 'Me <ME@example.com>', 4)],
    waiting: [msg('w1', 'Sam Sender <me@example.com>', 'Ann Lee <ann@example.com>,\r\n Bob <bob@example.com>', 5, { cc: 'dan@example.com', subject: 'Demande de\r\n devis' })],
    answered: [msg('a1', 'me@example.com', 'bob@example.com', 6), msg('a2', 'Bob <bob@example.com>', 'me@example.com', 3)],
  };
  const ctx = createTestContext({ google: fake(threads, ['chased', 'self', 'waiting', 'answered']) });
  const out = await run(ctx);

  assert.deepEqual(out.threads?.map((r) => r.thread_id), ['chased', 'waiting']);
  assert.equal(out.examined, 4);
  assert.equal(out.note, undefined);
  assert.deepEqual(out.threads![1], {
    thread_id: 'waiting',
    message_id: 'w1',
    to: 'Ann Lee <ann@example.com>, Bob <bob@example.com>',
    cc: 'dan@example.com',
    subject: 'Demande de devis',
    sent_at: new Date(Number(ago(5))).toISOString(),
    days_waiting: 5,
    messages: 1,
    web_url: 'https://mail.google.com/mail/u/me@example.com/#all/waiting',
  });
  const chased = out.threads![0]!;
  assert.equal(chased.message_id, 'c3');
  assert.equal(chased.days_waiting, 3);
  assert.equal(chased.messages, 3);
  assert.equal(chased.replies_received, 1);
  assert.equal(chased.cc, undefined);

  const reads = apiCalls(ctx).filter((c) => c.url.pathname.startsWith(`${GMAIL}/threads/`));
  assert.equal(reads.length, 4);
  assert.equal(reads[0]!.url.searchParams.get('format'), 'metadata');
  assert.deepEqual(reads[0]!.url.searchParams.getAll('metadataHeaders'), [
    'From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Content-Type', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence',
  ]);
});

test('drafts, spam and trash are not the latest message: the thread is judged on its last real one', async () => {
  const threads = {
    // Dan answered; my reply is still a draft (older than min_days, so only the DRAFT label keeps it out), so nothing waits on Dan.
    'draft-reply': [
      msg('d1', 'me@example.com', 'dan@example.com', 6),
      msg('d2', 'Dan <dan@example.com>', 'me@example.com', 5),
      msg('d3', 'me@example.com', 'dan@example.com', 3, { labels: ['DRAFT'] }),
    ],
    // A follow-up drafted but not sent: the sent message still waits, since 4 days.
    'draft-followup': [msg('e1', 'me@example.com', 'eve@example.com', 4), msg('e2', 'me@example.com', 'eve@example.com', 1, { labels: ['DRAFT'] })],
    // The latest message was trashed; the one before is a reply from Frank.
    trashed: [msg('f1', 'me@example.com', 'frank@example.com', 5), msg('f2', 'frank@example.com', 'me@example.com', 4), msg('f3', 'me@example.com', 'frank@example.com', 3, { labels: ['SENT', 'TRASH'] })],
    // Spam that landed in the thread after my message does not count as an answer.
    spammed: [msg('g1', 'me@example.com', 'gil@example.com', 6), msg('g2', 'spam@example.net', 'me@example.com', 2, { labels: ['SPAM'] })],
  };
  const ctx = createTestContext({ google: fake(threads, ['draft-reply', 'draft-followup', 'trashed', 'spammed']) });
  const out = await run(ctx);
  assert.deepEqual(
    out.threads?.map((r) => [r.thread_id, r.message_id, r.days_waiting, r.messages]),
    [
      ['draft-followup', 'e1', 4, 1],
      ['spammed', 'g1', 6, 1],
    ],
  );
});

test('mail sent from a send-as alias counts as the account\'s own; a note to an alias is a note to self', async () => {
  const threads = {
    alias: [msg('h1', 'ann@example.com', 'Alias@Example.org', 6), msg('h2', 'Sam (work) <Alias@Example.org>', 'ann@example.com', 3)],
    'to-alias': [msg('i1', 'me@example.com', 'alias@example.org', 3)],
  };
  const ctx = createTestContext({ google: fake(threads, ['alias', 'to-alias'], { sendAs: SEND_AS }) });
  const out = await run(ctx);
  assert.deepEqual(out.threads?.map((r) => [r.thread_id, r.message_id, r.replies_received]), [['alias', 'h2', 1]]);

  // Without Gmail's send-as settings the alias is someone else: Ann's thread then ends with a message from a stranger.
  const bare = createTestContext({ google: fake(threads, ['alias', 'to-alias']) });
  assert.deepEqual((await run(bare)).threads?.map((r) => r.thread_id), ['to-alias']);
});

test('min_days applies to the latest message, not to the one the search found', async () => {
  const threads = { recent: [msg('r1', 'me@example.com', 'ann@example.com', 5), msg('r2', 'me@example.com', 'ann@example.com', 1)] };
  const ctx = createTestContext({ google: fake(threads, ['recent']) });
  const out = await run(ctx);
  assert.equal(out.threads, undefined);
  assert.equal(out.examined, 1);

  const all = await run(ctx, { min_days: 0 });
  assert.deepEqual(all.threads?.map((r) => [r.message_id, r.days_waiting]), [['r2', 1]]);
});

test('the search: sent mail of the period, older than min_days, narrowed by query', async () => {
  const ctx = createTestContext({ google: fake({}, []) });
  await run(ctx);
  assert.equal(listCall(ctx).get('q'), 'in:sent newer_than:30d older_than:2d');
  assert.equal(listCall(ctx).get('maxResults'), '25');
  assert.equal(listCall(ctx).get('pageToken'), null);

  const narrowed = createTestContext({ google: fake({}, []) });
  await run(narrowed, { days: 90, min_days: 0, query: '  subject:devis ', max_results: 50 });
  assert.equal(listCall(narrowed).get('q'), 'in:sent newer_than:90d subject:devis');
  assert.equal(listCall(narrowed).get('maxResults'), '50');

  const both = createTestContext({ google: fake({}, []) });
  await run(both, { days: 30, min_days: 7, query: 'to:@example.com' });
  assert.equal(listCall(both).get('q'), 'in:sent newer_than:30d older_than:7d to:@example.com');
});

test('the window is never empty: each default gives way to the other bound, and a conflicting pair is refused', async () => {
  const q = async (args: Record<string, unknown>) => {
    const ctx = createTestContext({ google: fake({}, []) });
    await run(ctx, args);
    return listCall(ctx).get('q');
  };
  // "Waiting for more than a month?": 30 days before min_days, not the empty newer_than:30d older_than:30d.
  assert.equal(await q({ min_days: 30 }), 'in:sent newer_than:60d older_than:30d');
  assert.equal(await q({ min_days: 0 }), 'in:sent newer_than:30d');
  // "Anything unanswered from yesterday?": min_days drops below days.
  assert.equal(await q({ days: 1 }), 'in:sent newer_than:1d');
  assert.equal(await q({ days: 2 }), 'in:sent newer_than:2d older_than:1d');
  assert.equal(await q({ days: 3 }), 'in:sent newer_than:3d older_than:2d');

  for (const [days, minDays] of [[30, 30], [5, 10]] as const) {
    const ctx = createTestContext({ google: fake({}, []) });
    const res = await runTool(gmailAwaitingReply, { account: 'me', days, min_days: minDays }, ctx);
    assert.equal(res.isError, true);
    assert.match(resultText(res), new RegExp(`min_days \\(${minDays}\\) must be less than days \\(${days}\\).*Raise days \\(e\\.g\\. to ${minDays + 30}\\)`));
    assert.equal(apiCalls(ctx).length, 0, 'nothing is searched');
  }
});

test('paging: page_token goes to Gmail, next_page_token comes back, and an empty page says to look further back', async () => {
  const threads = { answered: [msg('a1', 'me@example.com', 'bob@example.com', 6), msg('a2', 'bob@example.com', 'me@example.com', 3)] };
  const ctx = createTestContext({ google: fake(threads, ['answered'], { nextPageToken: 'p3' }) });
  const out = await run(ctx, { page_token: 'p2' });
  assert.equal(listCall(ctx).get('pageToken'), 'p2');
  assert.deepEqual(out, {
    examined: 1,
    next_page_token: 'p3',
    note: 'None of the sent mail examined is waiting for a reply. Call again with page_token to look further back.',
  });

  const last = createTestContext({ google: fake({}, []) });
  assert.deepEqual(await run(last), { examined: 0, note: 'None of the sent mail examined is waiting for a reply.' });
});

test('a thread gone between the search and the read is skipped', async () => {
  const threads = { waiting: [msg('w1', 'me@example.com', 'ann@example.com', 4)] };
  const ctx = createTestContext({ google: fake(threads, ['gone', 'waiting']) });
  const out = await run(ctx);
  assert.deepEqual(out.threads?.map((r) => r.thread_id), ['waiting']);
  assert.equal(out.examined, 1);
});

test('logs carry counts only: no addresses, subjects or query', async () => {
  const lines: string[] = [];
  const threads = { waiting: [msg('w1', 'me@example.com', 'Ann Lee <ann@example.com>', 4, { subject: 'Secret quote' })] };
  const ctx = { ...createTestContext({ google: fake(threads, ['waiting']) }), log: createLogger('debug', {}, (l) => lines.push(l)) };
  await runTool(gmailAwaitingReply, { account: 'me', query: 'subject:secret' }, ctx);
  assert.ok(lines.some((l) => l.includes('"awaiting":1')));
  for (const l of lines) assert.doesNotMatch(l, /@|Ann|Secret|secret|quote/i);
});

test('threads are listed, not messages: a thread with sent mail on two pages comes back once', async () => {
  const threads = {
    // The request (20 days ago) and its follow-up (3 days ago), with other sent mail between them.
    x: [msg('x1', 'me@example.com', 'sup@example.com', 20), msg('x2', 'me@example.com', 'sup@example.com', 3, { subject: 'Re: Devis toiture' })],
    y: [msg('y1', 'me@example.com', 'ann@example.com', 10)],
  };
  const pages = { '': { ids: ['x'], next: 'p2' }, p2: { ids: ['y'] } };
  const first = createTestContext({ google: fake(threads, [], { pages }) });
  const one = await run(first);
  assert.deepEqual(one.threads?.map((r) => [r.thread_id, r.message_id]), [['x', 'x2']]);
  assert.equal(one.next_page_token, 'p2');
  assert.deepEqual(apiCalls(first).map((c) => c.url.pathname.replace(GMAIL, '')), ['/threads', '/threads/x']);

  const second = createTestContext({ google: fake(threads, [], { pages }) });
  const two = await run(second, { page_token: 'p2' });
  assert.deepEqual(two.threads?.map((r) => r.thread_id), ['y']);
  assert.equal(two.examined, 1);
  assert.equal(two.next_page_token, undefined);
});

test('auto-replies, read receipts and bounces are no answer: the thread still waits, flagged', async () => {
  const threads = {
    ooo: [msg('o1', 'me@example.com', 'roofer@example.com', 5), msg('o2', 'Roofer <roofer@example.com>', 'me@example.com', 5, { headers: { 'Auto-Submitted': 'auto-replied' } })],
    ack: [msg('k1', 'me@example.com', 'shop@example.com', 6), msg('k2', 'shop@example.com', 'me@example.com', 6, { headers: { 'X-Autoreply': 'yes' } })],
    outlook: [msg('l1', 'me@example.com', 'lea@example.com', 7), msg('l2', 'lea@example.com', 'me@example.com', 7, { subject: 'Réponse automatique : Devis toiture' })],
    precedence: [msg('p1', 'me@example.com', 'pat@example.com', 8), msg('p2', 'pat@example.com', 'me@example.com', 8, { headers: { Precedence: 'auto_reply' } })],
    receipt: [
      msg('r1', 'me@example.com', 'rita@example.com', 9),
      msg('r2', 'rita@example.com', 'me@example.com', 8, { mimeType: 'multipart/report', headers: { 'Content-Type': 'multipart/report; report-type=disposition-notification; boundary="b"' } }),
    ],
    bounce: [msg('b1', 'me@example.com', 'typo@exampel.com', 10), msg('b2', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'me@example.com', 10)],
    ndr: [
      msg('n1', 'me@example.com', 'gone@example.com', 11),
      msg('n2', 'Microsoft Outlook <MicrosoftExchange329e71ec@example.com>', 'me@example.com', 11, {
        mimeType: 'multipart/report',
        headers: { 'Content-Type': 'multipart/report; report-type="delivery-status"; boundary="b"' },
      }),
    ],
    // An auto-acknowledgement, then a person answered: nothing waits.
    'ack-then-answer': [
      msg('a1', 'me@example.com', 'desk@example.com', 12),
      msg('a2', 'desk@example.com', 'me@example.com', 12, { headers: { 'Auto-Submitted': 'auto-generated' } }),
      msg('a3', 'Agent <desk@example.com>', 'me@example.com', 11),
    ],
    // Human replies: through a mailing list (Precedence: list) and one marked Auto-Submitted: no.
    list: [msg('m1', 'me@example.com', 'club@example.com', 13), msg('m2', 'Max <max@example.com>', 'club@example.com', 12, { headers: { Precedence: 'list' } })],
    'submitted-no': [msg('s1', 'me@example.com', 'sam@example.com', 13), msg('s2', 'sam@example.com', 'me@example.com', 12, { headers: { 'Auto-Submitted': 'no' } })],
    // My own out-of-office answered Val: Val waits for me, not I for Val.
    'own-ooo': [msg('v1', 'val@example.com', 'me@example.com', 14), msg('v2', 'me@example.com', 'val@example.com', 14, { headers: { 'Auto-Submitted': 'auto-replied' } })],
  };
  const ctx = createTestContext({ google: fake(threads, Object.keys(threads)) });
  const out = await run(ctx);
  assert.deepEqual(
    out.threads?.map((r) => [r.thread_id, r.message_id, r.bounced ?? false, r.auto_reply ?? false, r.replies_received ?? 0, r.messages]),
    [
      ['ooo', 'o1', false, true, 0, 2],
      ['ack', 'k1', false, true, 0, 2],
      ['outlook', 'l1', false, true, 0, 2],
      ['precedence', 'p1', false, true, 0, 2],
      ['receipt', 'r1', false, true, 0, 2],
      ['bounce', 'b1', true, false, 0, 2],
      ['ndr', 'n1', true, false, 0, 2],
    ],
  );
});

test('Bcc recipients count: a request sent to oneself with the suppliers in Bcc waits for them', async () => {
  const threads = {
    bcc: [msg('b1', 'me@example.com', 'Sam Sender <me@example.com>', 5, { bcc: 'roofer1@example.com, roofer2@example.com' })],
    undisclosed: [msg('u1', 'me@example.com', 'undisclosed-recipients:;', 4, { bcc: 'roofer3@example.com' })],
    'bcc-self': [msg('s1', 'me@example.com', 'me@example.com', 3, { bcc: 'me+archive@example.com' })],
  };
  const ctx = createTestContext({ google: fake(threads, Object.keys(threads)) });
  const out = await run(ctx);
  assert.deepEqual(
    out.threads?.map((r) => [r.thread_id, r.to, r.bcc]),
    [
      ['undisclosed', 'undisclosed-recipients:;', 'roofer3@example.com'],
      ['bcc', 'Sam Sender <me@example.com>', 'roofer1@example.com, roofer2@example.com'],
    ],
  );
});

test('+tag and, for Gmail, dotted or googlemail.com variants of the own address are the account itself', async () => {
  assert.equal(mailbox(' Me+Todo@Example.com '), 'me@example.com');
  assert.equal(mailbox('Sa.M+x@googlemail.com'), 'sam@gmail.com');
  assert.equal(mailbox('sa.m@example.com'), 'sa.m@example.com', 'dots only fold for Gmail');
  assert.equal(mailbox('undisclosed-recipients:;'), 'undisclosed-recipients:;');

  const sendAs = { sendAs: [{ sendAsEmail: 'me@example.com', isPrimary: true }, { sendAsEmail: 'sam.sender@gmail.com', verificationStatus: 'accepted' }] };
  const threads = {
    plus: [msg('p1', 'me@example.com', 'me+todo@example.com', 5)],
    dots: [msg('d1', 'me@example.com', 'samsender+notes@googlemail.com', 4)],
    // From a dotted variant of the Gmail alias, to someone else: it waits.
    variant: [msg('v1', 's.a.m.s.e.n.d.e.r@gmail.com', 'ann@example.com', 3)],
  };
  const ctx = createTestContext({ google: fake(threads, Object.keys(threads), { sendAs }) });
  assert.deepEqual((await run(ctx)).threads?.map((r) => r.thread_id), ['variant']);
});

test('long recipient lists are cut to five addresses and a count; the page token comes before the rows', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `r${i}@example.com`).join(', ');
  const ctx = createTestContext({ google: fake({ mass: [msg('x1', 'me@example.com', 'me@example.com', 4, { bcc: many })] }, ['mass'], { sendAs: SEND_AS, nextPageToken: 'p2' }) });
  const result = await runTool(gmailAwaitingReply, { account: 'me' }, ctx);
  const out = resultJson<Out>(result);
  assert.equal(out.threads![0]!.bcc, 'r0@example.com, r1@example.com, r2@example.com, r3@example.com, r4@example.com +35 more');
  const text = resultText(result);
  assert.ok(text.indexOf('next_page_token') < text.indexOf('"threads"'), 'a cut from the end keeps the page token');
});
