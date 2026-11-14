import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Service } from '../config.js';
import { createLogger } from '../log.js';
import { apiCalls, createMultiAccountContext, TEST_KEY, type RecordedCall, type TestAccountSpec, type TestContext } from '../test-support.js';
import { codeOrSecurityNotice, computeFollowups, hasDocument, normalizeSubject, stillDismissed, type FollowupOptions } from './engine.js';
import { FollowupStore, type FollowupInput } from './store.js';
import { DAY, HOUR, mailboxes, message, serveMailbox, type FakeMailbox, type FakeMessage } from './test-mailboxes.js';

const NOW = Date.parse('2026-10-02T10:00:00Z');
const ME = 'me@example.com';
const PARTNER = 'partner@example.com';
const COUNSEL = 'Ivan Kovačić <counsel@example.com>';
const GMAIL = '/gmail/v1/users/me';

const m = (id: string, threadId: string, ago: number, from: string, to: string, extra: Partial<FakeMessage> = {}) => message(NOW, id, threadId, ago, from, to, extra);
const iso = (ms: number) => new Date(ms).toISOString();
/** JSON's view of a value: undefined fields dropped, as the tools serialise it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const threadUrl = (email: string, id: string) => `https://mail.google.com/mail/u/${email}/#all/${id}`;

interface Setup {
  ctx: TestContext;
  /** Records an item as if made `ago` ms before NOW. */
  track(input: Omit<FollowupInput, 'account'> & { account?: string }, ago?: number): string;
}

function setup(boxes: Record<string, FakeMailbox>, accounts?: TestAccountSpec[], now = NOW): Setup {
  const specs = accounts ?? Object.entries(boxes).map(([alias, b]) => ({ alias, email: b.email, services: ['gmail'] as Service[] }));
  const ctx = createMultiAccountContext({ accounts: specs, google: mailboxes(boxes, () => now) });
  let clock = now;
  ctx.followups = new FollowupStore(ctx.db, [TEST_KEY], () => clock);
  return {
    ctx,
    track(input, ago = 0) {
      clock = now - ago;
      const id = ctx.followups.create({ account: 'me', ...input }).id;
      clock = now;
      return id;
    },
  };
}

/** The engine at NOW. Owed mail from anyone, unless asked: most tests are not about whom the user wrote to before. */
function run(ctx: TestContext, opts: FollowupOptions = {}) {
  return computeFollowups(ctx, { now: NOW, owed_from: 'anyone', ...opts });
}

function calls(ctx: TestContext, path: string): RecordedCall[] {
  return apiCalls(ctx).filter((c) => c.url.pathname === GMAIL + path);
}

const alias = (c: RecordedCall) => c.headers['authorization']!.replace('Bearer token-', '');

test('drafts: unsent drafts older than drafts_min_hours, oldest first, with a link that opens each', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('dm1', 'td1', 2 * DAY + HOUR, ME, 'Ann Lee <ann@example.com>', { subject: 'Devis toiture', labels: ['DRAFT'] }),
      m('dm2', 'td2', 2 * HOUR, ME, 'bob@example.com', { labels: ['DRAFT'] }),
      m('dm3', 'td3', 13 * HOUR, ME, '', { subject: '', labels: ['DRAFT'] }),
    ],
    drafts: [{ id: 'r1', messageId: 'dm1' }, { id: 'r2', messageId: 'dm2' }, { id: 'r3', messageId: 'dm3' }],
  };
  const { ctx } = setup({ me });
  const report = await run(ctx, { sections: ['drafts'] });
  assert.deepEqual(plain(report.drafts), [
    {
      account: 'me',
      draft_id: 'r1',
      message_id: 'dm1',
      thread_id: 'td1',
      to: 'Ann Lee <ann@example.com>',
      subject: 'Devis toiture',
      saved_at: iso(NOW - 2 * DAY - HOUR),
      days: 2,
      web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1',
    },
    // Saved at 23:00 yesterday in Paris: a day ago, though only 13 hours.
    { account: 'me', draft_id: 'r3', message_id: 'dm3', thread_id: 'td3', saved_at: iso(NOW - 13 * HOUR), days: 1, web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm3' },
  ]);
  assert.equal(report.counts.drafts, 2);
  assert.equal(calls(ctx, '/drafts')[0]!.url.searchParams.get('maxResults'), '50');
  assert.deepEqual(calls(ctx, '/messages/dm1')[0]!.url.searchParams.getAll('metadataHeaders'), ['To', 'Subject']);
  assert.equal(calls(ctx, '/threads').length, 0, 'only the sections asked for are computed');

  const later = await run(ctx, { sections: ['drafts'], drafts_min_hours: 1 });
  assert.deepEqual(later.drafts.map((d) => d.draft_id), ['r1', 'r3', 'r2']);
});

test('waiting: own last message, old enough, to someone else; mail only to other linked accounts left out unless include_internal', async () => {
  const me: FakeMailbox = {
    email: ME,
    sendAs: [{ sendAsEmail: ME, isPrimary: true }, { sendAsEmail: 'alias@example.org', verificationStatus: 'accepted' }],
    messages: [
      m('a1', 'w-old', 5 * DAY, 'Sam <me@example.com>', 'Ann Lee <ann@example.com>', { subject: 'Question' }),
      m('b1', 'w-young', 1 * DAY, ME, 'bob@example.com'),
      m('f1', 'w-internal', 6 * DAY, ME, 'Partner <partner@example.com>'),
      m('g1', 'w-internal-cc', 7 * DAY, ME, 'partner@example.com, carol@example.com'),
      m('h1', 'w-alias', 4 * DAY, 'Sam (work) <alias@example.org>', 'dan@example.com'),
      m('i1', 'w-self', 4 * DAY, ME, 'Notes <me+notes@example.com>'),
      m('j1', 'answered', 8 * DAY, ME, 'eve@example.com'),
      m('j2', 'answered', 7 * DAY, 'eve@example.com', ME),
    ],
  };
  const { ctx } = setup({ me, partner: { email: PARTNER, messages: [] } });
  const report = await run(ctx, { sections: ['waiting'] });
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['w-alias', 'w-old', 'w-internal-cc'], 'newest first');
  assert.deepEqual(plain(report.waiting[1]), {
    account: 'me',
    thread_id: 'w-old',
    message_id: 'a1',
    to: 'Ann Lee <ann@example.com>',
    subject: 'Question',
    sent_at: iso(NOW - 5 * DAY),
    days_waiting: 5,
    web_url: threadUrl(ME, 'w-old'),
  });
  assert.equal(report.waiting[2]!.to, 'partner@example.com, carol@example.com');
  assert.deepEqual(report.accounts, ['me', 'partner']);

  const list = calls(ctx, '/threads').filter((c) => alias(c) === 'me');
  assert.deepEqual(list.map((c) => [c.url.searchParams.get('q'), c.url.searchParams.get('maxResults')]), [['in:sent newer_than:30d older_than:3d', '40']], 'sent mail old enough to wait on only');
  const headers = calls(ctx, '/threads/w-old')[0]!.url.searchParams.getAll('metadataHeaders');
  assert.ok(headers.includes('List-Id') && headers.includes('List-Unsubscribe') && headers.includes('Auto-Submitted'));

  const all = await run(ctx, { sections: ['waiting'], include_internal: true, lookback_days: 10, max_threads_per_account: 7 });
  assert.deepEqual(all.waiting.map((w) => w.thread_id), ['w-alias', 'w-old', 'w-internal', 'w-internal-cc']);
  assert.ok(calls(ctx, '/threads').some((c) => c.url.searchParams.get('q') === 'in:sent newer_than:10d older_than:3d' && c.url.searchParams.get('maxResults') === '7'));
  const strict = await run(ctx, { sections: ['waiting'], waiting_min_days: 6 });
  assert.deepEqual(strict.waiting.map((w) => w.thread_id), ['w-internal-cc']);
});

test('owed: the latest message a person wrote is someone else\'s, to the account or in its conversation; lists, notifications and promotions are not', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('o1', 'o-direct', 2 * DAY, 'Ann Lee <ann@example.com>', ME, { subject: 'Devis signé', snippet: 'It&#39;s signed &amp; ready', labels: ['INBOX', 'UNREAD'] }),
      m('o2', 'o-cc', 3 * DAY, 'bob@example.com', 'carol@example.com', { cc: 'Me <me@example.com>' }),
      m('o3', 'o-not-addressed', 3 * DAY, 'frank@example.com', 'club@example.com'),
      m('o4a', 'o-conversation', 6 * DAY, ME, 'gil@example.com'),
      m('o4b', 'o-conversation', 5 * DAY, 'gil@example.com', 'team@example.com'),
      m('o5', 'o-noreply', 2 * DAY, 'Shop <no-reply@shop.example>', ME),
      m('o6', 'o-notifications', 2 * DAY, 'GitHub <notifications@github.com>', ME),
      m('o7', 'o-list', 2 * DAY, 'Club <club@example.com>', ME, { headers: { 'List-Id': '<club.example.com>' } }),
      m('o8', 'o-unsubscribe', 2 * DAY, 'News <news@example.com>', ME, { headers: { 'List-Unsubscribe': '<mailto:u@example.com>' } }),
      m('o9', 'o-promotion', 2 * DAY, 'deals@example.com', ME, { labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
      m('o10', 'o-fresh', 2 * HOUR, 'ivy@example.com', ME),
      m('o11', 'o-partner', 1 * DAY, 'Partner <partner@example.com>', ME, { snippet: 'x'.repeat(300) }),
      m('o12a', 'o-answered', 3 * DAY, 'hal@example.com', ME),
      m('o12b', 'o-answered', 2 * DAY, ME, 'hal@example.com'),
      // My out-of-office answered Jo: Jo still waits on me.
      m('o13a', 'o-ooo', 4 * DAY, 'jo@example.com', ME),
      m('o13b', 'o-ooo', 4 * DAY - HOUR, ME, 'jo@example.com', { headers: { 'Auto-Submitted': 'auto-replied' } }),
    ],
  };
  const { ctx } = setup({ me, partner: { email: PARTNER, messages: [] } });
  const report = await run(ctx, { sections: ['owed'] });
  assert.deepEqual(report.owed.map((o) => o.thread_id), ['o-conversation', 'o-ooo', 'o-cc', 'o-direct'], 'oldest first; mail between linked accounts is internal');
  assert.deepEqual(plain(report.owed[3]), {
    account: 'me',
    thread_id: 'o-direct',
    message_id: 'o1',
    from: 'Ann Lee <ann@example.com>',
    subject: 'Devis signé',
    received_at: iso(NOW - 2 * DAY),
    days: 2,
    unread: true,
    snippet: "It's signed & ready",
    web_url: threadUrl(ME, 'o-direct'),
  });
  const internal = await run(ctx, { sections: ['owed'], include_internal: true });
  const partner = internal.owed.find((o) => o.thread_id === 'o-partner')!;
  assert.equal(partner.internal, true, 'from another linked account, with include_internal');
  assert.equal(partner.snippet!.length, 140);
  assert.ok(partner.snippet!.endsWith('…'));
  assert.equal(report.owed[0]!.internal, undefined);
  assert.equal(report.counts.owed, 4);

  const q = calls(ctx, '/threads').find((c) => alias(c) === 'me')!.url.searchParams.get('q');
  assert.equal(q, `in:inbox newer_than:30d before:${(NOW - 12 * HOUR) / 1000} -category:promotions -category:social -category:updates -category:forums`, 'mail received long enough ago to be owed only');
  assert.equal(calls(ctx, '/drafts').length, 0);

  const sooner = await run(ctx, { sections: ['owed'], owed_min_hours: 1 });
  assert.ok(sooner.owed.some((o) => o.thread_id === 'o-fresh'));
});

test('batches: one subject sent separately to 3+ people; replies, answers and silence; their threads leave waiting and owed', async () => {
  const subject = 'Demande de devis - traduction';
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('b1a', 'b1', 8 * DAY, ME, 'Traductions Une <t1@example.com>', { subject }),
      m('b1b', 'b1', 6 * DAY, 'Traductions Une <t1@example.com>', ME, { subject: `Re: ${subject}` }),
      m('b1c', 'b1', 5 * DAY, ME, 't1@example.com', { subject: `Re: ${subject}` }),
      m('b2a', 'b2', 8 * DAY - HOUR, ME, 't2@example.com', { subject: 'Demande de devis -  Traduction' }),
      m('b2b', 'b2', 4 * DAY, 'Deux <t2@example.com>', ME, { subject: `RE : ${subject}` }),
      m('b3a', 'b3', 8 * DAY - 2 * HOUR, ME, 't3@example.com', { subject }),
      m('b4a', 'b4', 8 * DAY - 3 * HOUR, ME, 't4@example.com', { subject }),
      m('b4b', 'b4', 8 * DAY - 3 * HOUR - 60_000, 't4@example.com', ME, { subject: `Réponse automatique : ${subject}` }),
      // Two of a kind are no batch: each waits on its own.
      m('f1', 'fa', 6 * DAY, ME, 'x@example.com', { subject: 'Facture' }),
      m('f2', 'fb', 6 * DAY - HOUR, ME, 'y@example.com', { subject: 'Facture' }),
      // Nor is the same subject to the same person every week.
      m('r1', 'ra', 21 * DAY, ME, 'boss@example.com', { subject: 'Weekly report' }),
      m('r2', 'rb', 14 * DAY, ME, 'boss@example.com', { subject: 'Weekly report' }),
      m('r3', 'rc', 7 * DAY, ME, 'boss@example.com', { subject: 'Weekly report' }),
    ],
  };
  const { ctx } = setup({ me });
  const report = await run(ctx);
  assert.deepEqual(plain(report.batches), [
    {
      account: 'me',
      subject,
      sent_at: iso(NOW - 8 * DAY),
      sent: 4,
      replied_count: 2,
      no_reply_count: 2,
      replied: [
        { who: 'Deux <t2@example.com>', thread_id: 'b2', last_reply_at: iso(NOW - 4 * DAY), answered: false, web_url: threadUrl(ME, 'b2') },
        { who: 'Traductions Une <t1@example.com>', thread_id: 'b1', last_reply_at: iso(NOW - 6 * DAY), answered: true, web_url: threadUrl(ME, 'b1') },
      ],
      no_reply: [
        { who: 't3@example.com', thread_id: 'b3', sent_at: iso(NOW - 8 * DAY + 2 * HOUR), web_url: threadUrl(ME, 'b3') },
        { who: 't4@example.com', thread_id: 'b4', sent_at: iso(NOW - 8 * DAY + 3 * HOUR), web_url: threadUrl(ME, 'b4') },
      ],
    },
  ]);
  // Its pending threads are listed once, with the batch; the reply the user answered waits like any sent mail.
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['b1', 'fb', 'fa', 'rc', 'rb', 'ra']);
  assert.deepEqual(report.owed, []);
  assert.equal(report.counts.batches, 1);

  // Without the batches section, the same threads follow the usual rules.
  const flat = await run(ctx, { sections: ['owed', 'waiting'] });
  assert.deepEqual(flat.owed.map((o) => o.thread_id), ['b2']);
  assert.ok(['b3', 'b4'].every((id) => flat.waiting.some((w) => w.thread_id === id)));

  // A dismissed thread leaves the batch.
  ctx.followups.dismiss('me', 'b3', NOW - 8 * DAY + 2 * HOUR);
  const fewer = await run(ctx, { sections: ['batches'] });
  assert.deepEqual(fewer.batches[0]!.no_reply.map((n) => n.thread_id), ['b4']);
  assert.equal(fewer.batches[0]!.sent, 3);
});

test('a settled batch (every reply answered, nobody silent) is no longer a batch: its threads wait like any other', async () => {
  const subject = 'Procuration';
  const msgs: FakeMessage[] = [];
  for (const i of [1, 2, 3]) {
    msgs.push(m(`s${i}a`, `s${i}`, 10 * DAY, ME, `t${i}@example.com`, { subject }));
    msgs.push(m(`s${i}b`, `s${i}`, 9 * DAY, `t${i}@example.com`, ME, { subject: `Re: ${subject}` }));
    msgs.push(m(`s${i}c`, `s${i}`, 8 * DAY - i * HOUR, ME, `t${i}@example.com`, { subject: `Re: ${subject}` }));
  }
  const { ctx } = setup({ me: { email: ME, messages: msgs } });
  const report = await run(ctx);
  assert.deepEqual(report.batches, []);
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['s3', 's2', 's1']);
});

test('normalizeSubject: reply and forward prefixes, [tags], spacing, case and Unicode forms do not matter', () => {
  assert.equal(normalizeSubject('RE : [Ext] Fwd: TR: Devis   Traduction '), 'devis traduction');
  assert.equal(normalizeSubject('AW: WG: Fw: Angebot'), 'angebot');
  assert.equal(normalizeSubject('Re: Re:Réponse'), normalizeSubject('re: re: Réponse'));
  assert.equal(normalizeSubject('Récapitulatif'), 'récapitulatif', 'a word starting like a prefix is kept');
});

test('tracked: a new message from someone else in a watched thread makes the item ready; the arrival is kept', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('l1', 'tw', 5 * DAY, ME, COUNSEL, { subject: 'Punomoćje' }),
      m('l2', 'tw', 4 * DAY, COUNSEL, ME, { subject: 'Re: Punomoćje' }),
      m('l3', 'tw', 2 * DAY, ME, 'counsel@example.com', { subject: 'Re: Punomoćje' }),
      m('l4', 'tw', 1 * DAY, COUNSEL, ME, {
        subject: 'Re: Punomoćje',
        mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain' }, { mimeType: 'multipart/mixed', parts: [{ mimeType: 'application/pdf', filename: 'punomocje.pdf' }] }],
      }),
      m('l5', 'tw', 20 * HOUR, COUNSEL, ME, { subject: 'Re: Punomoćje', headers: { 'Auto-Submitted': 'auto-replied' } }),
    ],
  };
  const { ctx, track } = setup({ me });
  const id = track({ title: 'Power of attorney', next_step: 'Send it to the translators', due: '2026-10-10', watch_threads: [{ account: 'me', thread_id: 'tw' }] }, 3 * DAY);
  const waitingOnly = track({ title: 'Nothing yet', watch_threads: [{ account: 'me', thread_id: 'tw' }] }, 12 * HOUR);
  const report = await run(ctx, { sections: ['tracked'] });
  assert.deepEqual(plain(report.tracked[0]), {
    id,
    account: 'me',
    title: 'Power of attorney',
    next_step: 'Send it to the translators',
    watch_threads: [{ account: 'me', thread_id: 'tw' }],
    due: '2026-10-10',
    status: 'ready',
    arrived: { account: 'me', thread_id: 'tw', message_id: 'l4', from: COUNSEL, subject: 'Re: Punomoćje', date: iso(NOW - DAY), has_attachments: true, web_url: threadUrl(ME, 'tw') },
    created_at: iso(NOW - 3 * DAY),
    age_days: 3,
  });
  assert.equal(report.tracked[1]!.id, waitingOnly);
  assert.equal(report.tracked[1]!.status, 'waiting', 'only an auto-reply came after it');
  assert.deepEqual(report.counts, { ready: 1, handled: 0, overdue: 0, due: 0, owed: 0, drafts: 0, waiting: 0, batches: 0 });
  const full = calls(ctx, '/messages/l4')[0]!.url.searchParams;
  assert.equal(full.get('format'), 'full');
  assert.match(full.get('fields') ?? '', /parts\(mimeType,filename/);
  assert.ok(!(full.get('fields') ?? '').includes('body'), 'bodies are never fetched');
  assert.equal(ctx.followups.get(id)?.arrived?.message_id, 'l4', 'stored with the item');

  // The thread is gone: the item stays ready without looking again.
  me.messages = [];
  ctx.calls.length = 0;
  const again = await run(ctx, { sections: ['tracked'] });
  assert.equal(again.tracked[0]!.status, 'ready');
  assert.equal(again.tracked[0]!.arrived?.message_id, 'l4');
  assert.deepEqual(calls(ctx, '/threads/tw').length, 1, 'only the item still waiting looks at the thread');
});

test('tracked: mail from a waiting_on address is found in another linked account\'s mailbox, whatever the accounts asked for', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('x1', 'tx', 5 * DAY, 'counsel@example.com', ME),
      m('x2', 'ty', 1 * DAY, COUNSEL, ME, { subject: 'Out of office', headers: { 'Auto-Submitted': 'auto-replied' } }),
    ],
  };
  const partner: FakeMailbox = {
    email: PARTNER,
    messages: [
      m('y1', 'tm', 20 * HOUR, COUNSEL, 'Partner <partner@example.com>', { subject: 'Punomoćje', mimeType: 'multipart/mixed', parts: [{ mimeType: 'application/pdf', filename: 'punomocje.pdf' }] }),
      m('y2', 'tm2', 30 * HOUR, COUNSEL, PARTNER, { subject: 'Older' }),
      // Partner's own mail matches no waiting_on address, and her own sent mail never counts.
      m('y3', 'tm3', 10 * HOUR, 'Partner <partner@example.com>', 'counsel@example.com'),
    ],
  };
  const { ctx, track } = setup({ me, partner });
  const id = track({ title: 'Power of attorney from the lawyer', waiting_on: ['counsel@example.com'] }, 2 * DAY);
  const report = await run(ctx, { sections: ['tracked'], accounts: ['me'] });
  assert.equal(report.tracked[0]!.status, 'ready');
  assert.deepEqual(plain(report.tracked[0]!.arrived), {
    account: 'partner',
    thread_id: 'tm',
    message_id: 'y1',
    from: COUNSEL,
    subject: 'Punomoćje',
    date: iso(NOW - 20 * HOUR),
    has_attachments: true,
    web_url: threadUrl(PARTNER, 'tm'),
  });
  const searches = calls(ctx, '/messages').filter((c) => c.url.searchParams.get('q')?.startsWith('from:('));
  assert.deepEqual(searches.map(alias).sort(), ['me', 'partner']);
  for (const s of searches) {
    assert.equal(s.url.searchParams.get('q'), `from:(counsel@example.com) after:${Math.floor((NOW - 2 * DAY) / 1000)}`);
    assert.equal(s.url.searchParams.get('maxResults'), '5');
  }
  assert.equal(ctx.followups.get(id)?.arrived?.account, 'partner');
});

test('tracked: the user writing from the home account into a watched thread held by another mailbox is not what was awaited', async () => {
  const me: FakeMailbox = { email: ME, sendAs: [{ sendAsEmail: ME, isPrimary: true }, { sendAsEmail: 'alias@example.org', verificationStatus: 'accepted' }], messages: [] };
  const partner: FakeMailbox = {
    email: PARTNER,
    messages: [
      m('k1', 'tk', 5 * DAY, COUNSEL, PARTNER, { subject: 'Punomoćje' }),
      // The user answers the lawyer from their own account, and from its alias, with partner in Cc: it lands in partner's thread.
      m('k2', 'tk', 1 * DAY, 'Me <me@example.com>', COUNSEL, { cc: PARTNER, subject: 'Re: Punomoćje' }),
      m('k3', 'tk', 20 * HOUR, 'Sam (work) <alias@example.org>', COUNSEL, { cc: PARTNER, subject: 'Re: Punomoćje' }),
      // A home account without Gmail is known by its linked address.
      m('c1', 'tc', 5 * DAY, COUNSEL, PARTNER, { subject: 'Ugovor' }),
      m('c2', 'tc', 1 * DAY, 'cal@example.com', COUNSEL, { cc: PARTNER, subject: 'Re: Ugovor' }),
    ],
  };
  const accounts: TestAccountSpec[] = [
    { alias: 'me', email: ME, services: ['gmail'] },
    { alias: 'partner', email: PARTNER, services: ['gmail'] },
    { alias: 'cal', email: 'cal@example.com', services: ['calendar'] },
  ];
  const { ctx, track } = setup({ me, partner }, accounts);
  const id = track({ title: 'Power of attorney', watch_threads: [{ account: 'partner', thread_id: 'tk' }] }, 3 * DAY);
  const fromCal = track({ account: 'cal', title: 'Contract', watch_threads: [{ account: 'partner', thread_id: 'tc' }] }, 3 * DAY);
  const report = await run(ctx, { sections: ['tracked'] });
  assert.deepEqual(report.tracked.map((t) => [t.id, t.status]), [[id, 'waiting'], [fromCal, 'waiting']]);
  assert.equal(report.errors, undefined);
  assert.equal(ctx.followups.get(id)?.arrived, undefined, 'nothing stored');

  partner.messages.push(m('k5', 'tk', 12 * HOUR, COUNSEL, PARTNER, { subject: 'Re: Punomoćje' }), m('c3', 'tc', 12 * HOUR, COUNSEL, PARTNER, { subject: 'Re: Ugovor' }));
  const answered = await run(ctx, { sections: ['tracked'] });
  assert.deepEqual(answered.tracked.map((t) => [t.id, t.status, t.arrived?.message_id]), [[id, 'ready', 'k5'], [fromCal, 'ready', 'c3']]);
});

test('owed: a thread a ready tracked item covers (its arrival, its watched threads) is listed under the item only', async () => {
  const NOTARY = 'Notary <notary@example.fr>';
  const me: FakeMailbox = {
    email: ME,
    messages: [
      // The lawyer's reply in the watched thread makes the item ready, and is still unanswered.
      m('p1', 'tp', 3 * DAY, ME, COUNSEL, { subject: 'Punomoćje' }),
      m('p2', 'tp', 21 * HOUR, COUNSEL, ME, { subject: 'Re: Punomoćje' }),
      // The notary's older message in the watched thread, then mail from a waiting_on address in another thread: not
      // the answer awaited in the watched thread, only reported.
      m('q1', 'tq', 3 * DAY, NOTARY, ME, { subject: 'Rendez-vous' }),
      m('q2', 'tq2', 20 * HOUR, NOTARY, ME, { subject: 'Documents' }),
      // A thread an item still waiting watches is owed as usual.
      m('w1', 'tw', 2 * DAY, 'Ana <ana@translations.example>', ME, { subject: 'Devis' }),
    ],
  };
  const { ctx, track } = setup({ me });
  const lawyer = track({ title: 'Power of attorney', watch_threads: [{ account: 'me', thread_id: 'tp' }] }, 3 * DAY);
  const notary = track({ title: 'Notary documents', waiting_on: ['notary@example.fr'], watch_threads: [{ account: 'me', thread_id: 'tq' }] }, 2 * DAY);
  const quote = track({ title: 'Quote', watch_threads: [{ account: 'me', thread_id: 'tw' }] }, DAY);

  const alone = await run(ctx, { sections: ['owed'] });
  assert.deepEqual(alone.owed.map((o) => o.thread_id), ['tq', 'tw', 'tp', 'tq2'], 'without tracked, every thread is owed');

  const report = await run(ctx);
  assert.deepEqual(report.tracked.map((t) => [t.id, t.status, t.arrived?.thread_id, t.other_mail?.thread_id, t.other_mail?.reason]), [
    [lawyer, 'ready', 'tp', undefined, undefined],
    [notary, 'waiting', undefined, 'tq2', 'other_conversation'],
    [quote, 'waiting', undefined, undefined, undefined],
  ]);
  assert.equal(report.tracked[1]!.other_mail?.web_url, threadUrl(ME, 'tq2'));
  assert.deepEqual(report.owed.map((o) => o.thread_id), ['tq', 'tw', 'tq2'], 'only the ready item covers its threads');
  assert.equal(report.counts.ready, 1);
  assert.equal(ctx.followups.get(notary)?.arrived, undefined, 'other mail is not stored');
});

test('tracked: overdue and due are judged by the day in the default time zone; ready first, then overdue, due, waiting', async () => {
  // 22:30 UTC on 2 October is already 3 October in Paris.
  const late = Date.parse('2026-10-02T22:30:00Z');
  const { ctx, track } = setup({ me: { email: ME, messages: [] } }, undefined, late);
  const none = track({ title: 'no date' }, DAY);
  const later = track({ title: 'later', due: '2026-10-04' }, DAY);
  const today = track({ title: 'today', due: '2026-10-03' }, DAY);
  const yesterday = track({ title: 'yesterday', due: '2026-10-02' }, DAY);
  const ready = track({ title: 'ready', due: '2026-10-20' }, DAY);
  ctx.followups.update(ready, { arrived: { account: 'me', thread_id: 't', message_id: 'm', date: iso(late - HOUR) } });
  const done = track({ title: 'done', due: '2026-09-01' }, DAY);
  ctx.followups.close(done);

  const report = await computeFollowups(ctx, { now: late, sections: ['tracked'] });
  assert.deepEqual(
    report.tracked.map((t) => [t.id, t.status]),
    [
      [ready, 'ready'],
      [yesterday, 'overdue'],
      [today, 'due'],
      [later, 'waiting'],
      [none, 'waiting'],
    ],
  );
  assert.deepEqual(report.counts, { ready: 1, handled: 0, overdue: 1, due: 1, owed: 0, drafts: 0, waiting: 0, batches: 0 });
  assert.equal(apiCalls(ctx).length, 0, 'nothing to look for, nothing asked of Google');
});

test('dismissed threads stay hidden until a newer message arrives, or until their until date', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('d1', 'od', 2 * DAY, 'ann@example.com', ME),
      m('w1', 'wd', 5 * DAY, ME, 'bob@example.com'),
      m('dr', 'tdd', 2 * DAY, ME, 'cy@example.com', { labels: ['DRAFT'] }),
    ],
    drafts: [{ id: 'r1', messageId: 'dr' }],
  };
  const { ctx } = setup({ me });
  const before = await run(ctx);
  assert.deepEqual([before.owed.length, before.waiting.length, before.drafts.length], [1, 1, 1]);

  ctx.followups.dismiss('me', 'od', NOW - 2 * DAY);
  ctx.followups.dismiss('me', 'wd', NOW - 5 * DAY, '2026-10-03');
  ctx.followups.dismiss('me', 'tdd', NOW - 2 * DAY);
  const hidden = await run(ctx);
  assert.deepEqual([hidden.owed, hidden.waiting, hidden.drafts], [[], [], []]);

  // Ann writes again; the draft is edited; the until date comes (3 October in Paris).
  me.messages.push(m('d2', 'od', 14 * HOUR, 'ann@example.com', ME));
  me.messages.find((x) => x.id === 'dr')!.at = NOW - 13 * HOUR;
  const back = await computeFollowups(ctx, { now: Date.parse('2026-10-02T22:30:00Z'), owed_from: 'anyone' });
  assert.deepEqual(back.owed.map((o) => o.message_id), ['d2']);
  assert.deepEqual(back.waiting.map((w) => w.thread_id), ['wd']);
  assert.deepEqual(back.drafts.map((d) => d.draft_id), ['r1']);

  assert.equal(stillDismissed({ dismissedAt: 0, lastMessageMs: 100 }, 100, '2026-10-02'), true);
  assert.equal(stillDismissed({ dismissedAt: 0, lastMessageMs: 100 }, 101, '2026-10-02'), false);
  assert.equal(stillDismissed({ dismissedAt: 0, lastMessageMs: 100, untilDate: '2026-10-03' }, 100, '2026-10-02'), true);
  assert.equal(stillDismissed({ dismissedAt: 0, lastMessageMs: 100, untilDate: '2026-10-03' }, 100, '2026-10-03'), false);
  assert.equal(stillDismissed(undefined, 100, '2026-10-02'), false);
});

test('drafts: only those saved within the look-back are listed; a dismissed one stays hidden until edited', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('d-old', 'told', 400 * DAY, ME, 'cy@example.com', { labels: ['DRAFT'] }),
      m('d-60', 't60', 60 * DAY, ME, 'cy@example.com', { labels: ['DRAFT'] }),
      m('d-kept', 'tkeep', 20 * DAY, ME, 'cy@example.com', { labels: ['DRAFT'] }),
      m('d-new', 'tnew', 2 * DAY, ME, 'cy@example.com', { labels: ['DRAFT'] }),
    ],
    drafts: [{ id: 'r-old', messageId: 'd-old' }, { id: 'r60', messageId: 'd-60' }, { id: 'rkeep', messageId: 'd-kept' }, { id: 'rnew', messageId: 'd-new' }],
  };
  const { ctx } = setup({ me });
  ctx.followups.dismiss('me', 'tkeep', NOW - 20 * DAY, undefined, true);
  const report = await run(ctx, { sections: ['drafts'] });
  assert.deepEqual(report.drafts.map((d) => d.draft_id), ['rnew']);
  assert.equal(calls(ctx, '/drafts')[0]!.url.searchParams.get('q'), 'newer_than:30d', 'Gmail lists the recent drafts only');
  const longer = await run(ctx, { sections: ['drafts'], lookback_days: 90 });
  assert.deepEqual(longer.drafts.map((d) => d.draft_id), ['r60', 'rnew']);
  me.messages.find((x) => x.id === 'd-kept')!.at = NOW - DAY;
  assert.deepEqual((await run(ctx, { sections: ['drafts'] })).drafts.map((d) => d.draft_id), ['rnew', 'rkeep'], 'edited: back');
});

test('an account that fails is reported in errors; the others still answer', async () => {
  const me: FakeMailbox = { email: ME, messages: [m('a1', 'w1', 5 * DAY, ME, 'ann@example.com')] };
  const partner: FakeMailbox = { email: PARTNER, messages: [], failWith: { status: 500, json: { error: { code: 500, message: 'Backend Error' } } } };
  const accounts: TestAccountSpec[] = [
    { alias: 'me', email: ME, services: ['gmail'] },
    { alias: 'partner', email: PARTNER, services: ['gmail'] },
    { alias: 'dead', email: 'dead@example.com', services: ['gmail'], status: 'needs_relink' },
    { alias: 'cal', email: 'cal@example.com', services: ['calendar'] },
  ];
  const { ctx } = setup({ me, partner }, accounts);
  const report = await run(ctx, { accounts: ['me', ' PARTNER ', 'dead', 'ghost', 'cal'] });
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['w1']);
  assert.deepEqual(report.accounts, ['me', 'partner', 'dead', 'ghost', 'cal']);
  const errors = new Map(report.errors?.map((e) => [e.account, e.error]));
  assert.deepEqual([...errors.keys()].sort(), ['cal', 'dead', 'ghost', 'partner']);
  assert.match(errors.get('partner')!, /Gmail API error 500/);
  assert.match(errors.get('dead')!, /needs to be re-linked/);
  assert.match(errors.get('ghost')!, /Unknown account alias/);
  assert.match(errors.get('cal')!, /was not granted Gmail/);

  const byDefault = await run(ctx);
  assert.deepEqual(byDefault.accounts, ['me', 'partner', 'dead'], 'by default, every account with Gmail, working or not');
  assert.deepEqual(byDefault.errors?.map((e) => e.account).sort(), ['dead', 'partner']);
});

test('work is bounded: each thread read once, at most 5 requests at a time per account, accounts in parallel', async () => {
  const boxes: Record<string, FakeMailbox> = {};
  for (const name of ['me', 'partner', 'office', 'work']) {
    const email = `${name}@example.com`;
    const messages: FakeMessage[] = [];
    for (let i = 0; i < 45; i++) {
      messages.push(m(`${name}-${i}a`, `${name}-t${i}`, 5 * DAY + i * HOUR, email, `p${i}@example.com`, { subject: `Subject ${i}` }));
      if (i % 2) messages.push(m(`${name}-${i}b`, `${name}-t${i}`, 2 * DAY + i * HOUR, `p${i}@example.com`, email, { subject: `Re: Subject ${i}` }));
    }
    boxes[name] = { email, messages };
  }
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const accounts = Object.entries(boxes).map(([a, b]) => ({ alias: a, email: b.email, services: ['gmail'] as Service[] }));
  const ctx = createMultiAccountContext({
    accounts,
    google: async (a, call) => {
      if (call.url.pathname.endsWith('/settings/sendAs')) return undefined;
      active.set(a, (active.get(a) ?? 0) + 1);
      peak.set(a, Math.max(peak.get(a) ?? 0, active.get(a)!));
      await delay(2);
      active.set(a, active.get(a)! - 1);
      return serveMailbox(boxes[a]!, call, NOW);
    },
  });
  const started = Date.now();
  const report = await computeFollowups(ctx, { now: NOW });
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual([...peak.keys()].sort(), ['me', 'office', 'partner', 'work']);
  for (const [a, n] of peak) assert.ok(n <= 5, `${a}: ${n} requests at once`);
  const reads = apiCalls(ctx).filter((c) => /\/threads\/[^/]+$/.test(c.url.pathname)).map((c) => `${alias(c)} ${c.url.pathname}`);
  assert.equal(reads.length, new Set(reads).size, 'a thread in both the sent and the inbox lists is read once');
  assert.equal(reads.length, 4 * 40, '40 threads per account by default');
  assert.equal(report.errors, undefined);
});

test('logs carry counts only: no addresses, names, subjects, titles or queries', async () => {
  const lines: string[] = [];
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('o1', 'o1', 2 * DAY, 'Ann Secretname <ann@example.com>', ME, { subject: 'Confidential matter', snippet: 'secret snippet' }),
      m('w1', 'w1', 5 * DAY, ME, 'bob@example.com', { subject: 'Confidential quote' }),
    ],
  };
  const partner: FakeMailbox = { email: PARTNER, messages: [], failWith: { status: 500, json: { error: { code: 500, message: 'Backend Error' } } } };
  const { ctx, track } = setup({ me, partner });
  track({ title: 'Secret title', notes: 'Secret notes', waiting_on: ['counsel@example.com'] }, DAY);
  ctx.log = createLogger('debug', {}, (l) => lines.push(l));
  const report = await run(ctx);
  assert.equal(report.counts.owed, 1);
  assert.ok(lines.some((l) => l.includes('"msg":"followups"') && l.includes('"owed":1')));
  for (const l of lines) assert.doesNotMatch(l, /@|Secret|secret|Confidential|counsel|Ann/i);
});

test('a ready item covers its threads up to its arrival: later mail there is listed again, and its threads leave waiting', async () => {
  // The user asked the lawyer from their own account; he sent the document to partner's account instead.
  const me: FakeMailbox = { email: ME, messages: [m('l1', 'law', 6 * DAY, ME, COUNSEL, { subject: 'Punomoćje' })] };
  const partner: FakeMailbox = { email: PARTNER, messages: [m('y1', 'inh', 4 * DAY, COUNSEL, PARTNER, { subject: 'Punomoćje' })] };
  const { ctx, track } = setup({ me, partner });
  const id = track({ title: 'Power of attorney', waiting_on: ['counsel@example.com'] }, 5 * DAY);

  const alone = await run(ctx, { sections: ['owed', 'waiting'] });
  assert.deepEqual([alone.owed.map((o) => o.thread_id), alone.waiting.map((w) => w.thread_id)], [['inh'], []], 'he answered, to partner: the request waits no more; his mail to her is owed');
  const report = await run(ctx);
  assert.deepEqual(report.tracked.map((t) => [t.id, t.status, t.arrived?.message_id]), [[id, 'ready', 'y1']]);
  assert.deepEqual([report.owed, report.waiting], [[], []], 'the arrival, and the request it answers, are listed under the item only');

  // The lawyer writes again in the user's own thread after the arrival: that is news, owed like any mail.
  me.messages.push(m('l4', 'law', 2 * DAY, COUNSEL, ME, { subject: 'Re: Punomoćje' }));
  const later = await run(ctx);
  assert.equal(later.tracked[0]!.arrived?.message_id, 'y1');
  assert.deepEqual(later.owed.map((o) => [o.account, o.thread_id, o.message_id]), [['me', 'law', 'l4']]);

  // The user answers him: what they sent after the arrival waits like any sent mail.
  me.messages.push(m('l5', 'law', DAY, ME, COUNSEL, { subject: 'Re: Punomoćje' }));
  const answered = await run(ctx, { waiting_min_days: 1 });
  assert.deepEqual([answered.owed, answered.waiting.map((w) => w.message_id)], [[], ['l5']]);
});

test('a closed item keeps covering what it awaited: the request it answered does not wait again, later mail is listed', async () => {
  // The user asked the lawyer from their own account; he sent the document to partner's account. The user then sent it to
  // the translators and closed the item.
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('l1', 'law', 6 * DAY, ME, COUNSEL, { subject: 'Punomoćje' }),
      m('n1', 'tn', 6 * DAY, ME, 'notary@example.fr', { subject: 'Acte' }),
      m('q1', 'tq', 6 * DAY, ME, 'roofer@example.com', { subject: 'Devis' }),
    ],
  };
  const partner: FakeMailbox = { email: PARTNER, messages: [m('y1', 'inh', 4 * DAY, COUNSEL, PARTNER, { subject: 'Punomoćje' }), m('a1', 'ta', 3 * DAY, 'notary@example.fr', PARTNER, { subject: 'Acte' })] };
  const { ctx, track } = setup({ me, partner });
  const lawyer = track({ title: 'Power of attorney', waiting_on: ['counsel@example.com'] }, 5 * DAY);
  const notary = track({ title: 'Signed deed', waiting_on: ['notary@example.fr'] }, 5 * DAY);
  // Closed without anything arriving (handled some other way): it covers nothing.
  const quote = track({ title: 'Quote', watch_threads: [{ account: 'me', thread_id: 'tq' }] }, 5 * DAY);
  const ready = await run(ctx);
  assert.deepEqual(ready.tracked.map((t) => [t.id, t.status]), [[lawyer, 'ready'], [notary, 'ready'], [quote, 'waiting']]);
  assert.deepEqual([ready.owed, ready.waiting.map((w) => w.thread_id)], [[], ['tq']]);

  for (const id of [lawyer, notary, quote]) ctx.followups.close(id);
  for (const sections of [undefined, ['owed', 'waiting'] as const]) {
    const closed = await run(ctx, { sections: sections && [...sections] });
    assert.deepEqual(closed.tracked, []);
    assert.deepEqual(closed.owed, [], 'the arrivals were handled with their items');
    assert.deepEqual(closed.waiting.map((w) => w.thread_id), ['tq'], 'the lawyer and the notary answered: nobody to chase');
  }

  // The lawyer writes again in the user's thread: news, owed like any mail.
  me.messages.push(m('l4', 'law', 2 * DAY, COUNSEL, ME, { subject: 'Re: Punomoćje' }));
  assert.deepEqual((await run(ctx)).owed.map((o) => o.message_id), ['l4']);
});

test('a ready item that waits on addresses only clears what the user sent those people alone before it arrived', async () => {
  const NOTARY = 'Notary <notary@example.fr>';
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('n1', 'tn', 6 * DAY, ME, NOTARY, { subject: 'Acte' }),
      m('n2', 'tn2', 6 * DAY, ME, `${NOTARY}, ann@example.com`, { subject: 'Acte (copie)' }),
      m('n3', 'tn3', 5 * DAY, ME, 'Partner <partner@example.com>', { cc: NOTARY, subject: 'Acte (dossier)' }),
      m('n4', 'tn4', 20 * HOUR, ME, NOTARY, { subject: 'Autre question' }),
    ],
  };
  const partner: FakeMailbox = { email: PARTNER, messages: [m('a1', 'ta', 3 * DAY, NOTARY, PARTNER, { subject: 'Acte signé' })] };
  const { ctx, track } = setup({ me, partner });
  track({ title: 'Signed deed', waiting_on: ['notary@example.fr'] }, 7 * DAY);
  const report = await run(ctx, { waiting_min_days: 0 });
  assert.equal(report.tracked[0]!.status, 'ready');
  // Ann may still owe an answer; the question sent after the arrival is a new one. A linked account in copy changes nothing.
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['tn4', 'tn2']);
  assert.deepEqual(report.owed, []);
});

test('batch: replies the user answered are no longer pending in it, so they wait like any sent mail; unread replies are flagged', async () => {
  const subject = 'Demande de devis - traduction';
  const me: FakeMailbox = {
    email: ME,
    messages: [
      ...[1, 2, 3, 4].map((i) => m(`q${i}a`, `q${i}`, 10 * DAY + i * HOUR, ME, `t${i}@example.com`, { subject })),
      m('q1b', 'q1', 8 * DAY, 't1@example.com', ME, { subject: `Re: ${subject}` }),
      m('q1c', 'q1', 5 * DAY, ME, 't1@example.com', { subject: `Re: ${subject}` }),
      m('q2b', 'q2', 8 * DAY - HOUR, 't2@example.com', ME, { subject: `Re: ${subject}` }),
      m('q2c', 'q2', 5 * DAY - HOUR, ME, 't2@example.com', { subject: `Re: ${subject}` }),
      m('q4b', 'q4', 2 * DAY, 'Quatre <t4@example.com>', ME, { subject: `Re: ${subject}`, labels: ['INBOX', 'UNREAD'] }),
    ],
  };
  const { ctx } = setup({ me });
  const report = await run(ctx);
  const batch = report.batches[0]!;
  assert.deepEqual([batch.sent, batch.replied_count, batch.no_reply_count], [4, 3, 1]);
  assert.deepEqual(
    plain(batch.replied).map((r) => ({ thread_id: r.thread_id, answered: r.answered, unread: r.unread })),
    [
      { thread_id: 'q4', answered: false, unread: true },
      { thread_id: 'q1', answered: true, unread: undefined },
      { thread_id: 'q2', answered: true, unread: undefined },
    ],
  );
  assert.deepEqual(report.waiting.map((w) => [w.thread_id, w.days_waiting]), [['q2', 5], ['q1', 5]], 'the translators answered still owe the next step');
  assert.deepEqual(report.owed, [], 'the unanswered reply is listed with its batch');
});

test('every linked account with Gmail is looked at by default: one that needs re-linking is reported, for its mail and for arrivals', async () => {
  const accounts: TestAccountSpec[] = [
    { alias: 'me', email: ME, services: ['gmail'] },
    { alias: 'partner', email: PARTNER, services: ['gmail'], status: 'needs_relink' },
  ];
  const partner: FakeMailbox = { email: PARTNER, messages: [m('y1', 'tm', DAY, COUNSEL, PARTNER, { subject: 'Punomoćje' })] };
  const { ctx, track } = setup({ me: { email: ME, messages: [] }, partner }, accounts);
  track({ title: 'Power of attorney', waiting_on: ['counsel@example.com'] }, 2 * DAY);
  const report = await run(ctx);
  assert.deepEqual(report.accounts, ['me', 'partner']);
  assert.deepEqual(report.errors?.map((e) => e.account), ['partner']);
  assert.match(report.errors![0]!.error, /needs to be re-linked/);
  assert.equal(report.tracked[0]!.status, 'waiting');

  // Asked about the home account only, the arrival search still says where it could not look.
  const tracked = await run(ctx, { sections: ['tracked'], accounts: ['me'] });
  assert.deepEqual(tracked.errors?.map((e) => e.account), ['partner']);
  assert.equal(apiCalls(ctx).filter((c) => alias(c) === 'partner').length, 0, 'nothing is asked of Google for it');
});

test('each section lists its own age window, so recent mail does not crowd out what waited longest; cut listings are reported', async () => {
  const messages: FakeMessage[] = [];
  for (let i = 0; i < 45; i++) {
    // A busy day: 45 requests sent in the last 45 hours, and 45 messages received and answered in the last 11.
    messages.push(m(`s${i}`, `ts${i}`, (i + 1) * HOUR, ME, `p${i}@example.com`, { subject: `Question ${i}` }));
    messages.push(m(`r${i}a`, `tr${i}`, 11 * HOUR - i * 10 * 60_000, `c${i}@example.com`, ME, { subject: `Hello ${i}` }));
    messages.push(m(`r${i}b`, `tr${i}`, 10 * HOUR - i * 10 * 60_000, ME, `c${i}@example.com`, { subject: `Re: Hello ${i}` }));
  }
  messages.push(m('quote', 'tquote', 10 * DAY, ME, 'roofer@example.com', { subject: 'Devis toiture' }));
  messages.push(m('notary', 'tnotary', 6 * DAY, 'notary@example.fr', ME, { subject: 'Question' }));
  const box: FakeMailbox = { email: ME, messages };
  // Gmail may answer with short pages: they are followed.
  const ctx = createMultiAccountContext({
    accounts: [{ alias: 'me', email: ME, services: ['gmail'] }],
    google: (_a, call) => {
      if (call.url.pathname === `${GMAIL}/threads` && Number(call.url.searchParams.get('maxResults')) > 15) call.url.searchParams.set('maxResults', '15');
      return serveMailbox(box, call, NOW);
    },
  });
  const report = await run(ctx);
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['tquote']);
  assert.deepEqual(report.owed.map((o) => o.thread_id), ['tnotary']);
  assert.deepEqual(report.truncated, [{ account: 'me', sections: ['batches'] }], 'the requests and answers of the last 3 days are more than the 40 read');

  const lists = calls(ctx, '/threads');
  assert.deepEqual([...new Set(lists.map((c) => c.url.searchParams.get('q')))], [
    'in:sent newer_than:30d older_than:3d',
    'in:sent newer_than:3d',
    `in:inbox newer_than:30d before:${Math.floor((NOW - 12 * HOUR) / 1000)} -category:promotions -category:social -category:updates -category:forums`,
  ]);
  assert.ok(lists.some((c) => c.url.searchParams.get('pageToken')), 'later pages are asked for');
  assert.equal(apiCalls(ctx).filter((c) => /\/threads\/[^/]+$/.test(c.url.pathname)).length, 1 + 40 + 1, 'at most 40 threads per listing');

  // Fewer threads read: every cut listing is named with the sections it feeds.
  const small = await run(ctx, { max_threads_per_account: 1, waiting_min_days: 0, owed_min_hours: 0 });
  assert.deepEqual(small.truncated, [{ account: 'me', sections: ['owed', 'waiting', 'batches'] }]);
  assert.equal((await run(ctx, { sections: ['tracked'] })).truncated, undefined);
});

test('drafts: the 50 most recent are read, or as many as max_threads_per_account when more, pages followed; more is reported as cut', async () => {
  const messages = Array.from({ length: 120 }, (_, i) => m(`d${i}`, `td${i}`, DAY + i * HOUR, ME, 'ann@example.com', { labels: ['DRAFT'] }));
  const box: FakeMailbox = { email: ME, messages: messages.slice(0, 60), drafts: messages.slice(0, 60).map((x, i) => ({ id: `r${i}`, messageId: x.id })) };
  // Gmail may answer with short pages: they are followed.
  const ctx = createMultiAccountContext({
    accounts: [{ alias: 'me', email: ME, services: ['gmail'] }],
    google: (_a, call) => {
      if (call.url.pathname === `${GMAIL}/drafts` && Number(call.url.searchParams.get('maxResults')) > 30) call.url.searchParams.set('maxResults', '30');
      return serveMailbox(box, call, NOW);
    },
  });
  const report = await run(ctx, { sections: ['drafts'] });
  assert.equal(report.drafts.length, 50);
  assert.deepEqual(report.truncated, [{ account: 'me', sections: ['drafts'] }]);
  assert.equal(new Set(report.drafts.map((d) => d.draft_id)).size, 50);

  const more = await run(ctx, { sections: ['drafts'], max_threads_per_account: 70 });
  assert.equal(more.drafts.length, 60, 'every draft read');
  assert.equal(more.truncated, undefined);

  box.messages = messages;
  box.drafts = messages.map((x, i) => ({ id: `r${i}`, messageId: x.id }));
  const most = await run(ctx, { sections: ['drafts'], max_threads_per_account: 100 });
  assert.equal(most.drafts.length, 100);
  assert.deepEqual(most.truncated, [{ account: 'me', sections: ['drafts'] }]);
});

test('ages are calendar days in the default time zone, as the user and the digest count them', async () => {
  // Read at 20:00 in Paris on 2 October: what dates from 22:00 on 29 September is 3 days old, not 2 periods of 24 hours.
  const at = Date.parse('2026-10-02T18:00:00Z');
  const ago = at - Date.parse('2026-09-29T20:00:00Z');
  const me: FakeMailbox = {
    email: ME,
    messages: [
      message(at, 'dr', 'tdr', ago, ME, 'ann@example.com', { subject: 'Dossier de Pacs', labels: ['DRAFT'] }),
      message(at, 'o1', 'to', ago, 'bob@example.com', ME),
      message(at, 'w1', 'tw', ago, ME, 'cy@example.com'),
    ],
    drafts: [{ id: 'r1', messageId: 'dr' }],
  };
  const { ctx, track } = setup({ me }, undefined, at);
  track({ title: 'x' }, ago);
  const report = await computeFollowups(ctx, { now: at, waiting_min_days: 2, owed_from: 'anyone' });
  assert.deepEqual([report.drafts[0]?.days, report.owed[0]?.days, report.waiting[0]?.days_waiting, report.tracked[0]?.age_days], [3, 3, 3, 3]);
});

test('once an account has failed, its reads still queued are not sent to Google', async () => {
  const messages = Array.from({ length: 40 }, (_, i) => m(`s${i}`, `ts${i}`, 5 * DAY + i * HOUR, ME, `p${i}@example.com`, { subject: `Question ${i}` }));
  const box: FakeMailbox = { email: ME, messages };
  const ctx = createMultiAccountContext({
    accounts: [{ alias: 'me', email: ME, services: ['gmail'] }],
    google: async (_a, call) => {
      if (call.url.pathname.endsWith('/threads/ts0')) return { status: 429, json: { error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } } };
      if (call.url.pathname.includes('/threads/')) await delay(5);
      return serveMailbox(box, call, NOW);
    },
  });
  const report = await computeFollowups(ctx, { now: NOW, sections: ['waiting'] });
  assert.deepEqual(report.errors?.map((e) => e.account), ['me']);
  assert.deepEqual(report.waiting, []);
  // The run answers as soon as the account fails; reads left in its queue would go on behind it.
  await delay(200);
  const reads = apiCalls(ctx).filter((c) => /\/threads\/[^/]+$/.test(c.url.pathname)).length;
  assert.ok(reads < 20, `${reads} reads: the queue stops once the account failed`);
});

test('owed by default: only from people the account wrote to (in the mail read, or found by one search each), linked accounts, or its own conversations', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      // Written to in a sent thread the run reads anyway: no search needed.
      m('s1', 'ts1', 10 * DAY, ME, 'Ann <ann@example.com>', { subject: 'Devis' }),
      m('s1b', 'ts1', 9 * DAY, 'ann@example.com', ME, { subject: 'Re: Devis' }),
      m('s1c', 'ts1', 8 * DAY, ME, 'ann@example.com', { subject: 'Re: Devis' }),
      m('a1', 'ta', 2 * DAY, 'Ann <ann@example.com>', ME, { subject: 'Nouvelle question' }),
      // Written to long ago, outside the look-back: found by a search.
      m('old', 'told', 200 * DAY, ME, 'Bob <bob@example.com>', { subject: 'Ancien' }),
      m('b1', 'tb', 2 * DAY, 'Bob <bob@example.com>', ME, { subject: 'Suite' }),
      // Never written to: a newsletter without list headers, a stranger.
      m('c1', 'tc', 2 * DAY, 'Club <contact@club.example>', ME, { subject: 'Assemblée' }),
      m('d1', 'td', 2 * DAY, 'dan@example.com', ME, { subject: 'Proposition' }),
      // A linked account is always someone to answer.
      m('f1', 'tf', 2 * DAY, 'Partner <partner@example.com>', ME, { subject: 'Dimanche' }),
    ],
  };
  // Mail from a linked account is internal (include_internal lists it).
  const { ctx } = setup({ me, partner: { email: PARTNER, messages: [] } });
  const report = await computeFollowups(ctx, { now: NOW, sections: ['owed', 'waiting'] });
  assert.deepEqual(report.owed.map((o) => o.thread_id).sort(), ['ta', 'tb']);
  // The correspondent searches (no date); the after: ones ask whether a row was answered another way.
  const searches = calls(ctx, '/messages').filter((c) => alias(c) === 'me').map((c) => c.url.searchParams.get('q')).filter((q) => !q?.includes(' after:'));
  assert.deepEqual(searches.sort(), ['in:sent {to:bob@example.com cc:bob@example.com bcc:bob@example.com}', 'in:sent {to:contact@club.example cc:contact@club.example bcc:contact@club.example}', 'in:sent {to:dan@example.com cc:dan@example.com bcc:dan@example.com}']);
  assert.ok(calls(ctx, '/messages').filter((c) => !c.url.searchParams.get('q')?.includes(' after:')).every((c) => c.url.searchParams.get('maxResults') === '1'));

  const anyone = await computeFollowups(ctx, { now: NOW, sections: ['owed'], owed_from: 'anyone' });
  assert.deepEqual(anyone.owed.map((o) => o.thread_id).sort(), ['ta', 'tb', 'tc', 'td']);
});

test('owed leaves out one-time codes, security notices, French and other no-reply senders, and circulars to a crowd', async () => {
  const crowd = Array.from({ length: 12 }, (_, i) => `p${i}@example.com`).join(', ');
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('c1', 'tc1', 2 * DAY, 'AXA <service@axa.example>', ME, { subject: 'Votre code de vérification' }),
      m('c2', 'tc2', 2 * DAY, 'Bank <alerts@bank.example>', ME, { subject: 'Information', snippet: 'Votre code de confirmation est 482913' }),
      m('c3', 'tc3', 2 * DAY, 'AXA <service@axa.example>', ME, { subject: 'Nouvelle connexion à votre espace client' }),
      m('c4', 'tc4', 2 * DAY, 'DGFiP <ne-pas-repondre@dgfip.example>', ME, { subject: 'Avis' }),
      m('c5', 'tc5', 2 * DAY, 'Mairie <noreponse@mairie.example>', ME, { subject: 'Info' }),
      m('c6', 'tc6', 2 * DAY, 'Club <president@club.example>', `${ME}, ${crowd}`, { subject: 'Circulaire' }),
      // A person asking for a building's access code is a question.
      m('k1', 'tk1', 2 * DAY, 'Syndic <gestion@syndic.example>', ME, { subject: 'Interphone', snippet: "Pouvez-vous m'envoyer le code d'accès ?" }),
      // A crowd the user wrote in is a conversation.
      m('g1', 'tg', 4 * DAY, ME, crowd, { subject: 'Réunion' }),
      m('g2', 'tg', 2 * DAY, 'p1@example.com', `${ME}, ${crowd}`, { subject: 'Re: Réunion' }),
    ],
  };
  const { ctx } = setup({ me });
  const report = await run(ctx, { sections: ['owed'] });
  assert.deepEqual(report.owed.map((o) => o.thread_id).sort(), ['tg', 'tk1']);
});

test('waiting: forwards nobody answered are FYI unless include_forwards; waiting_max_days leaves out older requests', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('f1', 'tf1', 5 * DAY, ME, 'anna@example.com', { subject: 'Fwd: Facture' }),
      // The forwarded booking sits in the thread: its sender is no reply from Anna.
      m('f2a', 'tf2', 7 * DAY, 'SNCF <voyages@sncf.example>', ME, { subject: 'Convocation' }),
      m('f2', 'tf2', 6 * DAY, ME, 'anna@example.com', { subject: 'TR: Convocation' }),
      // A forward that drew a reply, then the user's follow-up: a conversation like any other.
      m('f3', 'tf3', 9 * DAY, ME, 'ben@example.com', { subject: 'Fwd: Devis' }),
      m('f3b', 'tf3', 8 * DAY, 'ben@example.com', ME, { subject: 'Re: Fwd: Devis' }),
      m('f3c', 'tf3', 7 * DAY, ME, 'ben@example.com', { subject: 'Re: Fwd: Devis' }),
      m('q1', 'tq1', 4 * DAY, ME, 'cy@example.com', { subject: 'Question' }),
      m('q2', 'tq2', 25 * DAY, ME, 'dee@example.com', { subject: 'Vieille question' }),
    ],
  };
  const { ctx } = setup({ me });
  assert.deepEqual((await run(ctx, { sections: ['waiting'] })).waiting.map((w) => w.thread_id), ['tq1', 'tf3', 'tq2']);
  assert.deepEqual((await run(ctx, { sections: ['waiting'], include_forwards: true })).waiting.map((w) => w.thread_id), ['tq1', 'tf1', 'tf2', 'tf3', 'tq2']);
  assert.deepEqual((await run(ctx, { sections: ['waiting'], waiting_max_days: 21 })).waiting.map((w) => w.thread_id), ['tq1', 'tf3']);
});

test('tracked expects_attachment: only mail with a document makes the item ready; a signature logo is no document; the rest is other_mail', async () => {
  const logo = { mimeType: 'multipart/related', parts: [{ mimeType: 'text/html' }, { mimeType: 'image/png', filename: 'image001.png' }] };
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('l1', 'tl', 5 * DAY, ME, COUNSEL, { subject: 'Punomoćje' }),
      // The lawyer writes about something else, with his logo, in a new thread.
      m('l2', 'tinfo', 1 * DAY, COUNSEL, ME, { subject: 'Infostan', mimeType: 'multipart/related', parts: [logo] }),
    ],
  };
  const { ctx, track } = setup({ me });
  const byAddress = track({ title: 'Power of attorney', waiting_on: ['counsel@example.com'], expects_attachment: true }, 3 * DAY);
  const inThread = track({ title: 'Power of attorney (thread)', watch_threads: [{ account: 'me', thread_id: 'tl' }], expects_attachment: true }, 3 * DAY);
  me.messages.push(m('l3', 'tl', 20 * HOUR, COUNSEL, ME, { subject: 'Re: Punomoćje', snippet: 'Sutra' }));
  const report = await run(ctx, { sections: ['tracked'] });
  const row = (id: string) => report.tracked.find((t) => t.id === id)!;
  assert.equal(row(byAddress).status, 'waiting');
  assert.deepEqual([row(byAddress).other_mail?.message_id, row(byAddress).other_mail?.reason, row(byAddress).other_mail?.has_attachments], ['l3', 'no_attachment', undefined]);
  assert.equal(row(byAddress).expects_attachment, true);
  assert.deepEqual([row(inThread).status, row(inThread).other_mail?.message_id, row(inThread).other_mail?.reason], ['waiting', 'l3', 'no_attachment']);

  // The document comes, in the thread.
  me.messages.push(m('l4', 'tl', 10 * HOUR, COUNSEL, ME, { subject: 'Re: Punomoćje', mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain' }, { mimeType: 'application/pdf', filename: 'punomocje.pdf' }] }));
  // And a later word without it: the document is still what counts.
  me.messages.push(m('l5', 'tl', 5 * HOUR, COUNSEL, ME, { subject: 'Re: Punomoćje' }));
  const ready = await run(ctx, { sections: ['tracked'] });
  for (const id of [byAddress, inThread]) {
    const t = ready.tracked.find((x) => x.id === id)!;
    assert.deepEqual([t.status, t.arrived?.message_id, t.arrived?.has_attachments, t.other_mail], ['ready', 'l4', true, undefined]);
  }
});

test('codeOrSecurityNotice: never a reply, and in the text only with the code next to the word', () => {
  for (const s of ['Re: code review for the login page', 'Re: Authentication code changes', 'RE: Security deposit and access code', 'TR: password reset for the clinic account']) assert.equal(codeOrSecurityNotice(s, ''), false, s);
  assert.equal(codeOrSecurityNotice('Interphone', "Pouvez-vous m'envoyer le code d'accès de l'immeuble ? Je serai au 12 rue des Lilas 75011"), false);
  assert.equal(codeOrSecurityNotice('Merci', 'Merci pour votre confirmation. Le code promo vaut pour 2026'), false);
  assert.equal(codeOrSecurityNotice('Votre code de vérification', ''), true);
  assert.equal(codeOrSecurityNotice('Information', 'Votre code de confirmation est 482913'), true);
});

test('expects_attachment: pictures shown in the text (signature icons, pasted images) are no document; the document is searched for on its own', async () => {
  const icons = { mimeType: 'multipart/related', parts: [{ mimeType: 'text/html' }, { mimeType: 'image/png', filename: 'linkedin.png' }, { mimeType: 'image/png', filename: 'image.png' }] };
  assert.equal(hasDocument({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain' }, icons] }), false);
  assert.equal(hasDocument({ mimeType: 'multipart/mixed', parts: [icons, { mimeType: 'image/jpeg', filename: 'scan.jpg' }] }), true, 'a photo attached, not shown inline');
  const me: FakeMailbox = { email: ME, messages: [m('l1', 'tl', HOUR, COUNSEL, ME, { subject: 'Re: Punomoćje', mimeType: 'multipart/related', parts: [icons] })] };
  const { ctx, track } = setup({ me });
  const id = track({ title: 'Power of attorney', waiting_on: ['counsel@example.com'], expects_attachment: true }, DAY);
  const report = await run(ctx, { sections: ['tracked'] });
  assert.equal(report.tracked.find((t) => t.id === id)!.status, 'waiting');
  const qs = calls(ctx, '/messages').map((c) => c.url.searchParams.get('q'));
  assert.ok(qs.some((q) => q?.endsWith(' has:attachment')) && qs.some((q) => !q?.includes('has:attachment')));
});

test('an account given as an unknown address fails alone and is never logged as an address', async () => {
  const lines: string[] = [];
  const { ctx } = setup({ me: { email: ME, messages: [] } });
  ctx.log = createLogger('debug', {}, (l) => lines.push(l));
  const report = await run(ctx, { accounts: ['someone.else@example.org'] });
  assert.deepEqual(report.errors?.map((e) => e.account), ['someone.else@example.org']);
  for (const l of lines) assert.doesNotMatch(l, /@/);
});

test('an arrival stored under earlier rules (another conversation, no document) is looked at again', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('w1', 'tw', 5 * DAY, ME, COUNSEL, { subject: 'Punomoćje' }),
      m('o1', 'tother', DAY, COUNSEL, ME, { subject: 'Infostan' }),
    ],
  };
  const { ctx, track } = setup({ me });
  const elsewhere = track({ title: 'Power of attorney', waiting_on: ['counsel@example.com'], watch_threads: [{ account: 'me', thread_id: 'tw' }] }, 3 * DAY);
  const noDoc = track({ title: 'Signed form', waiting_on: ['counsel@example.com'], expects_attachment: true }, 3 * DAY);
  const fine = track({ title: 'Any word', waiting_on: ['counsel@example.com'] }, 3 * DAY);
  const stored = { account: 'me', thread_id: 'tother', message_id: 'o1', date: iso(NOW - DAY) };
  for (const id of [elsewhere, noDoc, fine]) ctx.followups.update(id, { arrived: stored });
  const report = await run(ctx, { sections: ['tracked'] });
  const row = (id: string) => report.tracked.find((t) => t.id === id)!;
  assert.deepEqual([row(elsewhere).status, row(elsewhere).other_mail?.reason], ['waiting', 'other_conversation']);
  assert.deepEqual([row(noDoc).status, row(noDoc).other_mail?.reason], ['waiting', 'no_attachment']);
  assert.equal(row(fine).status, 'ready');
  assert.equal(ctx.followups.get(elsewhere)?.arrived, undefined, 'the stored arrival is forgotten');
});

test('answered another way: owed and waiting leave once the matter moved on in another thread or another linked account', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      // Ann asked; the user answered her in a new thread.
      m('a1', 'ta', 3 * DAY, 'Ann <ann@example.com>', ME, { subject: 'Question' }),
      m('a2', 'ta2', 2 * DAY, ME, 'ann@example.com', { subject: 'Réponse' }),
      // Bob asked; only the user's out-of-office went to him since.
      m('b1', 'tb', 3 * DAY, 'bob@example.com', ME, { subject: 'Devis' }),
      m('b0', 'tb0', 10 * DAY, ME, 'bob@example.com', { subject: 'Avant' }),
      m('b2', 'tb2', 3 * DAY - HOUR, ME, 'bob@example.com', { subject: 'Absent', headers: { 'Auto-Submitted': 'auto-replied' } }),
      // The user asked Cy; Cy answered in a new thread. The user asked Dee and Eve; only Dee answered elsewhere.
      m('c1', 'tc', 6 * DAY, ME, 'cy@example.com', { subject: 'Demande' }),
      m('c2', 'tc2', 4 * DAY, 'cy@example.com', ME, { subject: 'Autre sujet' }),
      m('c3', 'tc2', 3 * DAY, ME, 'cy@example.com', { subject: 'Re: Autre sujet' }),
      m('d1', 'td', 6 * DAY, ME, 'dee@example.com, eve@example.com', { subject: 'Réunion' }),
      m('d2', 'td2', 4 * DAY, 'dee@example.com', ME, { subject: 'Ok' }),
      m('d3', 'td2', 3 * DAY, ME, 'dee@example.com', { subject: 'Re: Ok' }),
      // The user asked the notary; the notary answered partner's account.
      m('n1', 'tn', 6 * DAY, ME, 'notary@example.fr', { subject: 'Acte' }),
    ],
  };
  const partner: FakeMailbox = { email: PARTNER, messages: [m('y1', 'tm', 4 * DAY, 'notary@example.fr', PARTNER, { subject: 'Acte signé' })] };
  const { ctx } = setup({ me, partner });
  const report = await run(ctx, { sections: ['owed', 'waiting'] });
  assert.deepEqual(report.owed.filter((o) => o.account === 'me').map((o) => o.thread_id), ['tb'], 'Ann was answered in a new thread; an auto-reply is no answer');
  assert.deepEqual(report.waiting.map((w) => w.thread_id), ['td'], 'Cy and the notary answered another way; Eve did not');
  // Asked about one account only, the others are not searched: the notary's answer to partner is not seen.
  const alone = await run(ctx, { sections: ['waiting'], accounts: ['me'] });
  assert.deepEqual(alone.waiting.map((w) => w.thread_id).sort(), ['td', 'tn']);
});

test('a ready item the user already wrote back on is marked handled, and not counted as ready', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('l1', 'tl', 5 * DAY, ME, COUNSEL, { subject: 'Punomoćje' }),
      m('l2', 'tl', 3 * DAY, COUNSEL, ME, { subject: 'Re: Punomoćje' }),
      m('l3', 'tl', 2 * DAY, ME, COUNSEL, { subject: 'Re: Punomoćje' }),
      m('n1', 'tn', 2 * DAY, 'notary@example.fr', ME, { subject: 'Acte' }),
    ],
  };
  const { ctx, track } = setup({ me });
  const lawyer = track({ title: 'Power of attorney', watch_threads: [{ account: 'me', thread_id: 'tl' }] }, 4 * DAY);
  const notary = track({ title: 'Deed', waiting_on: ['notary@example.fr'] }, 4 * DAY);
  const report = await run(ctx, { sections: ['tracked'] });
  const row = (id: string) => report.tracked.find((t) => t.id === id)!;
  assert.deepEqual([row(lawyer).status, row(lawyer).handled], ['ready', true]);
  assert.deepEqual([row(notary).status, row(notary).handled], ['ready', undefined]);
  assert.deepEqual([report.counts.ready, report.counts.handled], [1, 1]);
});

test('drafts: one left in a thread that was answered since is superseded; owed_max_days drops what waited too long', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('o1', 'tr', 4 * DAY, 'ann@example.com', ME, { subject: 'Question' }),
      m('dr', 'tr', 3 * DAY, ME, 'ann@example.com', { subject: 'Re: Question', labels: ['DRAFT'] }),
      m('o2', 'tr', 2 * DAY, ME, 'ann@example.com', { subject: 'Re: Question' }),
      m('dn', 'tn', 2 * DAY, ME, 'bob@example.com', { subject: 'Nouveau', labels: ['DRAFT'] }),
      m('old', 'told', 25 * DAY, 'cy@example.com', ME, { subject: 'Ancien' }),
    ],
    drafts: [{ id: 'r1', messageId: 'dr' }, { id: 'r2', messageId: 'dn' }],
  };
  const { ctx } = setup({ me });
  const report = await run(ctx, { sections: ['drafts', 'owed'], owed_max_days: 21 });
  assert.deepEqual(report.drafts.map((d) => [d.draft_id, d.superseded]), [['r1', true], ['r2', undefined]]);
  assert.deepEqual(report.owed.map((o) => o.thread_id), []);
  assert.deepEqual((await run(ctx, { sections: ['owed'] })).owed.map((o) => o.thread_id), ['told']);
});

test('a lookup that fails keeps its row and fails no account', async () => {
  const me: FakeMailbox = { email: ME, messages: [m('a1', 'ta', 3 * DAY, 'Ann <ann@example.com>', ME, { subject: 'Question' }), m('a0', 'ta0', 9 * DAY, ME, 'ann@example.com')] };
  const partner: FakeMailbox = { email: PARTNER, messages: [m('d1', 'td', 2 * DAY, PARTNER, 'x@example.com', { labels: ['DRAFT'] })], drafts: [{ id: 'r1', messageId: 'd1' }] };
  const boxes = { me, partner };
  const ctx = createMultiAccountContext({
    accounts: [{ alias: 'me', email: ME, services: ['gmail'] }, { alias: 'partner', email: PARTNER, services: ['gmail'] }],
    google: async (a, call) => {
      // Partner's mailbox refuses the searches that ask whether Ann was answered.
      if (a === 'partner' && (call.url.searchParams.get('q') ?? '').includes('after:')) return { status: 500, json: { error: { code: 500, message: 'Backend Error' } } };
      if (a === 'partner' && call.url.pathname.includes('/drafts')) await delay(30);
      return serveMailbox(boxes[a as 'me' | 'partner'], call, NOW);
    },
  });
  ctx.followups = new FollowupStore(ctx.db, [TEST_KEY], () => NOW);
  const report = await run(ctx, { sections: ['owed', 'drafts'] });
  assert.equal(report.errors, undefined, 'no account failed');
  assert.deepEqual(report.owed.map((o) => o.thread_id), ['ta'], 'kept: whether it was answered could not be checked');
  assert.deepEqual(report.drafts.map((d) => d.draft_id), ['r1'], "partner's own rows stay");
});
