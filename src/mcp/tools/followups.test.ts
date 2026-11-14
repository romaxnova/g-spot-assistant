import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Service } from '../../config.js';
import { createLogger } from '../../log.js';
import { apiCalls, createMultiAccountContext, resultJson, resultText, type TestAccountSpec, type TestContext } from '../../test-support.js';
import { MAX_OPEN_FOLLOWUPS } from '../../followups/store.js';
import { DAY, HOUR, mailboxes, message, type FakeMailbox, type FakeMessage } from '../../followups/test-mailboxes.js';
import { runTool } from '../server.js';
import type { ToolDefinition } from '../registry.js';
import { todayIn } from './cross.js';
import { followupDigest, followupDismiss, followups, followupTools, followupTrack } from './followups.js';
import { openDatabase } from '../../db.js';
import { DigestScheduler, DigestSettingsStore } from '../../followups/digest.js';

const ME = 'me@example.com';
const PARTNER = 'partner@example.com';
const GMAIL = '/gmail/v1/users/me';
const NOW = Date.now();
const m = (id: string, threadId: string, ago: number, from: string, to: string, extra: Partial<FakeMessage> = {}) => message(NOW, id, threadId, ago, from, to, extra);

function setup(boxes: Record<string, FakeMailbox>, accounts?: TestAccountSpec[]): TestContext {
  const specs = accounts ?? Object.entries(boxes).map(([alias, b]) => ({ alias, email: b.email, services: ['gmail'] as Service[] }));
  return createMultiAccountContext({ accounts: specs, google: mailboxes(boxes, () => Date.now()) });
}

const call = (def: ToolDefinition, ctx: TestContext, args: Record<string, unknown> = {}): Promise<CallToolResult> => runTool(def, args, ctx);

function errorText(result: CallToolResult): string {
  assert.equal(result.isError, true, resultText(result));
  return resultText(result);
}

/** A calendar day `days` after today in the default time zone. */
function dayAfterToday(days: number): string {
  const today = todayIn('Europe/Paris');
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

test('the follow-up tools are exported, with descriptions that say when to call them', () => {
  assert.deepEqual(followupTools.map((t) => t.name), ['followups', 'followup_track', 'followup_dismiss', 'followup_digest']);
  assert.match(followups.description, /what is pending.*start of a working session.*scheduled tasks/);
  assert.match(followupTrack.description, /whenever the user waits on someone/);
  assert.match(followupDismiss.description, /needs no follow-up.*draft_id hides only that draft/);
  assert.equal(followups.annotations.readOnlyHint, true);
  assert.equal(followupTrack.annotations.readOnlyHint, false);
  const schema = z.object(followups.inputSchema);
  assert.equal(schema.safeParse({ sections: ['owed', 'batches'], lookback_days: 90, max_per_section: 50 }).success, true);
  assert.equal(schema.safeParse({ sections: ['inbox'] }).success, false);
  assert.equal(schema.safeParse({ sections: [] }).success, false);
  assert.equal(schema.safeParse({ lookback_days: 91 }).success, false);
  assert.equal(schema.safeParse({ max_per_section: 0 }).success, false);
  const track = z.object(followupTrack.inputSchema);
  assert.equal(track.safeParse({ title: 'x'.repeat(201) }).success, false);
  assert.equal(track.safeParse({ notes: 'x'.repeat(2001) }).success, false);
  assert.equal(track.safeParse({ watch_threads: Array.from({ length: 11 }, (_, i) => ({ thread_id: `t${i}` })) }).success, false);
  const dismiss = z.object(followupDismiss.inputSchema);
  assert.equal(dismiss.safeParse({ threads: [] }).success, false);
  assert.equal(dismiss.safeParse({ threads: Array.from({ length: 51 }, (_, i) => ({ account: 'me', thread_id: `t${i}` })) }).success, false);
  assert.equal(dismiss.safeParse({ threads: [{ account: 'me', draft_id: 'r1' }] }).success, true);
});

test('followups: counts first, each section clipped to max_per_section with *_more, and a note when nothing is pending', async () => {
  const messages = [0, 1, 2, 3].map((i) => m(`o${i}`, `t${i}`, (2 + i) * DAY, `p${i}@example.com`, ME, { subject: `Question ${i}` }));
  const ctx = setup({ me: { email: ME, messages } });
  const result = await call(followups, ctx, { max_per_section: 2, owed_from: 'anyone' });
  const out = resultJson<{ counts: Record<string, number>; owed: { thread_id: string }[]; owed_more?: number; accounts: string[]; note?: string; drafts?: unknown }>(result);
  assert.equal(out.counts.owed, 4);
  assert.deepEqual(out.owed.map((o) => o.thread_id), ['t3', 't2']);
  assert.equal(out.owed_more, 2);
  assert.equal(out.drafts, undefined, 'empty sections are left out');
  assert.equal(out.note, undefined);
  const text = resultText(result);
  assert.ok(text.indexOf('"counts"') < text.indexOf('"owed"'), 'a cut from the end keeps the counts');

  const quiet = setup({ me: { email: ME, messages: [] } });
  const none = resultJson<{ note: string; counts: Record<string, number> }>(await call(followups, quiet));
  assert.match(none.note, /Nothing needs attention/);
  assert.equal(none.counts.owed, 0);

  const nobody = setup({}, [{ alias: 'cal', email: 'cal@example.com', services: ['calendar'] }]);
  assert.match(resultJson<{ note: string }>(await call(followups, nobody)).note, /No linked account has Gmail/);
});

test('followups never says nothing is pending when accounts could not be checked', async () => {
  const outage = { status: 500, json: { error: { code: 500, message: 'Backend Error' } } };
  const down = setup({ me: { email: ME, messages: [], failWith: outage } });
  const failed = resultJson<{ note: string; errors: { account: string; error: string }[] }>(await call(followups, down));
  assert.deepEqual(failed.errors.map((e) => e.account), ['me']);
  assert.match(failed.note, /No account could be checked/);
  assert.doesNotMatch(failed.note, /Nothing needs attention/);

  const half = setup({ me: { email: ME, messages: [] }, partner: { email: PARTNER, messages: [], failWith: outage } });
  const partial = resultJson<{ note: string }>(await call(followups, half));
  assert.match(partial.note, /Nothing needs attention in me\b.*partner could not be checked/);

  // Tracked items are listed, but the mail sections are unknown, not empty.
  await call(followupTrack, down, { title: 'Power of attorney' });
  const tracked = resultJson<{ note: string; tracked: unknown[] }>(await call(followups, down));
  assert.equal(tracked.tracked.length, 1);
  assert.match(tracked.note, /No account could be checked/);
});

test('followup_track creates an item: addresses checked and lower-cased, the first Gmail account by default', async () => {
  const accounts: TestAccountSpec[] = [
    { alias: 'cal', email: 'cal@example.com', services: ['calendar'] },
    { alias: 'me', email: ME, services: ['gmail'] },
  ];
  const ctx = setup({ me: { email: ME, messages: [] } }, accounts);
  const row = resultJson<Record<string, unknown>>(
    await call(followupTrack, ctx, {
      title: '  Procuration from the lawyer ',
      waiting_on: ['Ivan Kovačić <Counsel@Example.com>', 'counsel@example.com'],
      next_step: 'Send it to the 8 translators who replied',
      due: dayAfterToday(10),
      notes: '',
    }),
  );
  assert.match(String(row['id']), /^fu_/);
  assert.deepEqual({ ...row, id: undefined, created_at: undefined }, {
    id: undefined,
    created_at: undefined,
    account: 'me',
    title: 'Procuration from the lawyer',
    next_step: 'Send it to the 8 translators who replied',
    waiting_on: ['counsel@example.com'],
    due: dayAfterToday(10),
    status: 'waiting',
    age_days: 0,
  });
  assert.equal(ctx.followups.list().length, 1);
  assert.equal(apiCalls(ctx).length, 0, 'nothing is asked of Google');

  const today = resultJson<{ status: string }>(await call(followupTrack, ctx, { title: 'Today', due: dayAfterToday(0), account: 'CAL' }));
  assert.equal(today.status, 'due');
  assert.equal(ctx.followups.list()[1]!.account, 'cal');
});

test('followup_track refuses what it cannot use, with messages that say how to fix it', async () => {
  const ctx = setup({ me: { email: ME, messages: [m('x1', 'tx', DAY, 'ann@example.com', ME)] } });
  assert.match(errorText(await call(followupTrack, ctx, {})), /title: say what is awaited/);
  assert.match(errorText(await call(followupTrack, ctx, { title: '   ' })), /title/);
  assert.match(errorText(await call(followupTrack, ctx, { title: 'x', waiting_on: ['counsel'] })), /waiting_on: "counsel" is not an email address/);
  assert.match(errorText(await call(followupTrack, ctx, { title: 'x', waiting_on: ['a@b'] })), /not an email address/);
  assert.match(errorText(await call(followupTrack, ctx, { title: 'x', due: '2026-02-30' })), /due: "2026-02-30" is not a date written YYYY-MM-DD/);
  assert.match(errorText(await call(followupTrack, ctx, { title: 'x', due: 'next monday' })), /YYYY-MM-DD/);
  assert.match(errorText(await call(followupTrack, ctx, { title: 'x', account: 'work' })), /no linked account "work". Linked aliases: me/);
  assert.match(errorText(await call(followupTrack, ctx, { id: 'fu_nope', status: 'done' })), /No follow-up "fu_nope"/);
  assert.match(errorText(await call(followupTrack, ctx, { title: 'x', watch_threads: [{ thread_id: 'missing' }] })), /watch_threads: no thread "missing" in account "me"/);
  assert.equal(ctx.followups.list().length, 0, 'nothing was recorded');

  for (let i = 0; i < MAX_OPEN_FOLLOWUPS; i++) ctx.followups.create({ account: 'me', title: `item ${i}` });
  assert.match(errorText(await call(followupTrack, ctx, { title: 'one more' })), /200 follow-ups are already open/);
});

test('followup_track watches threads, taking a message id for its thread, in the account that holds it', async () => {
  const ctx = setup({
    me: { email: ME, messages: [m('l1', 'tw', 3 * DAY, ME, 'counsel@example.com')] },
    partner: { email: PARTNER, messages: [m('k1', 'tk', 2 * DAY, 'counsel@example.com', PARTNER), m('k2', 'tk', DAY, PARTNER, 'counsel@example.com')] },
  });
  const row = resultJson<{ watch_threads: unknown }>(
    await call(followupTrack, ctx, { title: 'Counsel', watch_threads: [{ thread_id: 'tw' }, { account: 'partner', thread_id: 'k2' }, { account: 'partner', thread_id: 'tk' }] }),
  );
  assert.deepEqual(row.watch_threads, [
    { account: 'me', thread_id: 'tw' },
    { account: 'partner', thread_id: 'tk' },
  ]);
  const minimal = apiCalls(ctx).filter((c) => c.url.searchParams.get('format') === 'minimal');
  assert.ok(minimal.length >= 3, 'existence is checked without reading any header');
});

test('followup_track updates: given fields change, "" and [] clear, done closes, keep_waiting forgets what arrived', async () => {
  const counsel = 'Ivan Kovačić <counsel@example.com>';
  const me: FakeMailbox = { email: ME, messages: [m('a1', 'ta', 2 * HOUR, counsel, ME, { subject: 'Question first' })] };
  const ctx = setup({ me });
  const id = ctx.followups.create({ account: 'me', title: 'Procuration', next_step: 'Forward it', notes: 'n', waiting_on: ['counsel@example.com'], due: '2026-12-01' }).id;
  // Created a day ago, so the question of two hours ago is its arrival.
  ctx.db.prepare('UPDATE followups SET created_at = ? WHERE id = ?').run(NOW - DAY, id);

  const first = resultJson<{ tracked: { id: string; status: string; arrived?: { message_id: string } }[] }>(await call(followups, ctx, { sections: ['tracked'] }));
  assert.equal(first.tracked[0]!.status, 'ready');
  assert.equal(first.tracked[0]!.arrived?.message_id, 'a1');

  // Not the awaited document: keep waiting, for newer mail only.
  const kept = resultJson<{ status: string; arrived?: unknown }>(await call(followupTrack, ctx, { id, keep_waiting: true }));
  assert.equal(kept.status, 'waiting');
  assert.equal(kept.arrived, undefined);
  assert.equal(ctx.followups.get(id)?.since, NOW - 2 * HOUR);
  const still = resultJson<{ tracked: { status: string }[] }>(await call(followups, ctx, { sections: ['tracked'] }));
  assert.equal(still.tracked[0]!.status, 'waiting', 'the same message does not count twice');
  me.messages.push(m('a2', 'ta', HOUR, counsel, ME, { subject: 'The document', parts: [{ filename: 'procuration.pdf', mimeType: 'application/pdf' }] }));
  const ready = resultJson<{ tracked: { status: string; arrived?: { message_id: string; has_attachments?: boolean } }[] }>(await call(followups, ctx, { sections: ['tracked'] }));
  assert.deepEqual([ready.tracked[0]!.status, ready.tracked[0]!.arrived?.message_id, ready.tracked[0]!.arrived?.has_attachments], ['ready', 'a2', true]);

  // Someone else to wait on: the old arrival no longer says anything.
  const rewatched = resultJson<{ status: string; waiting_on: string[] }>(await call(followupTrack, ctx, { id, waiting_on: ['notary@example.com'] }));
  assert.deepEqual([rewatched.status, rewatched.waiting_on], ['waiting', ['notary@example.com']]);

  const cleared = resultJson<Record<string, unknown>>(await call(followupTrack, ctx, { id, next_step: '', notes: '', due: '', waiting_on: [], title: 'Procuration (Kovačić)' }));
  assert.equal(cleared['title'], 'Procuration (Kovačić)');
  for (const key of ['next_step', 'notes', 'due', 'waiting_on']) assert.equal(cleared[key], undefined, key);

  const done = resultJson<{ status: string }>(await call(followupTrack, ctx, { id, status: 'done' }));
  assert.equal(done.status, 'done');
  assert.deepEqual(resultJson<{ tracked?: unknown }>(await call(followups, ctx, { sections: ['tracked'] })).tracked, undefined, 'closed items leave followups');
  assert.equal(resultJson<{ status: string }>(await call(followupTrack, ctx, { id, status: 'open' })).status, 'waiting');
  assert.match(errorText(await call(followupTrack, ctx, { id, title: ' ' })), /title cannot be empty/);
});

test('followup_dismiss hides threads until new mail, takes message ids, reports what it could not find, and undoes', async () => {
  const me: FakeMailbox = {
    email: ME,
    messages: [
      m('o1', 'to1', 2 * DAY, 'ann@example.com', ME),
      m('o2', 'to2', 3 * DAY, 'bob@example.com', ME),
      m('o3', 'to2', 2 * DAY, 'Spammer <s@example.net>', ME, { labels: ['SPAM'] }),
      m('d1', 'to2', 2 * DAY - HOUR, ME, 'bob@example.com', { labels: ['DRAFT'] }),
    ],
  };
  const ctx = setup({ me });
  const owed = async () => (resultJson<{ owed?: { thread_id: string }[] }>(await call(followups, ctx, { sections: ['owed'], owed_from: 'anyone' })).owed ?? []).map((o) => o.thread_id);
  assert.deepEqual(await owed(), ['to2', 'to1']);

  const out = resultJson<{ dismissed: number; failed?: { account: string; thread_id: string; error: string }[]; note?: string }>(
    await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'to1' }, { account: 'ME', thread_id: 'o2' }, { account: 'me', thread_id: 'gone' }] }),
  );
  assert.equal(out.dismissed, 2);
  assert.deepEqual(out.failed, [{ account: 'me', thread_id: 'gone', error: 'not found in this account' }]);
  assert.match(out.note!, /until a new message arrives/);
  const d = ctx.followups.dismissals('me');
  assert.deepEqual([...d.keys()].sort(), ['to1', 'to2'], 'the message id became its thread');
  assert.equal(d.get('to2')?.lastMessageMs, NOW - 2 * DAY + HOUR, 'the latest message, the draft included, spam not');
  assert.deepEqual(await owed(), []);

  me.messages.push(m('o4', 'to1', HOUR * 13, 'ann@example.com', ME));
  assert.deepEqual(await owed(), ['to1'], 'new mail brings a thread back');

  const undone = resultJson<{ restored: number; not_dismissed?: unknown[] }>(
    await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'to2' }, { account: 'me', thread_id: 'never' }], undo: true }),
  );
  assert.deepEqual(undone, { restored: 1, not_dismissed: [{ account: 'me', thread_id: 'never' }] });
  assert.deepEqual(await owed(), ['to2', 'to1']);

  // Undone with the message id it was dismissed with: the dismissal is found under its thread.
  await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'o2' }] });
  assert.deepEqual(await owed(), ['to1']);
  ctx.calls.length = 0;
  const byMessage = resultJson<{ restored: number; threads?: unknown[]; not_dismissed?: unknown[] }>(
    await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'o2' }], undo: true }),
  );
  assert.deepEqual(byMessage, { restored: 1 });
  assert.deepEqual(await owed(), ['to2', 'to1']);
  ctx.calls.length = 0;
  await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'to1' }] });
  ctx.calls.length = 0;
  await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'to1' }], undo: true });
  assert.equal(apiCalls(ctx).length, 0, 'a thread id undoes without asking Gmail');
});

test('followup_dismiss until: a later day, written YYYY-MM-DD; unknown accounts are refused', async () => {
  const ctx = setup({ me: { email: ME, messages: [m('o1', 'to1', 2 * DAY, 'ann@example.com', ME)] } });
  const threads = [{ account: 'me', thread_id: 'to1' }];
  assert.match(errorText(await call(followupDismiss, ctx, { threads, until: '2026-13-01' })), /until: "2026-13-01" is not a date/);
  assert.match(errorText(await call(followupDismiss, ctx, { threads, until: dayAfterToday(0) })), /is not after today/);
  assert.match(errorText(await call(followupDismiss, ctx, { threads: [{ account: 'nobody', thread_id: 'x' }] })), /no linked account "nobody"/);
  assert.equal(ctx.followups.dismissals('me').size, 0);

  const until = dayAfterToday(7);
  const out = resultJson<{ dismissed: number; until: string; note: string }>(await call(followupDismiss, ctx, { threads, until }));
  assert.deepEqual([out.dismissed, out.until], [1, until]);
  assert.match(out.note, new RegExp(`until ${until} or a new message`));
  assert.equal(ctx.followups.dismissals('me').get('to1')?.untilDate, until);
});

test('followup_dismiss: a draft_id (or a draft\'s message id) hides only that draft; a thread_id hides the whole thread', async () => {
  // Replies drafted to the translators who quoted, kept until the lawyer's document arrives; translator 3 wrote again
  // after the draft was saved.
  const subject = 'Demande de devis';
  const messages: FakeMessage[] = [];
  for (const i of [1, 2, 3, 4]) {
    messages.push(m(`q${i}a`, `q${i}`, 8 * DAY, ME, `t${i}@example.com`, { subject }));
    messages.push(m(`q${i}b`, `q${i}`, 6 * DAY, `t${i}@example.com`, ME, { subject: `Re: ${subject}` }));
    messages.push(m(`d${i}`, `q${i}`, 3 * DAY, ME, `t${i}@example.com`, { subject: `Re: ${subject}`, labels: ['DRAFT'] }));
  }
  messages.push(m('q3c', 'q3', 2 * DAY, `t3@example.com`, ME, { subject: `Re: ${subject}`, labels: ['INBOX', 'UNREAD'] }));
  // A shop's question the user decided not to answer, with a reply started and abandoned.
  messages.push(m('s1', 'shop', 4 * DAY, 'Boutique <contact@boutique.fr>', ME, { subject: 'Votre commande' }));
  messages.push(m('sd', 'shop', 4 * DAY - HOUR, ME, 'contact@boutique.fr', { subject: 'Re: Votre commande', labels: ['DRAFT'] }));
  const drafts = [...[1, 2, 3, 4].map((i) => ({ id: `r${i}`, messageId: `d${i}` })), { id: 'rshop', messageId: 'sd' }];
  const ctx = setup({ me: { email: ME, messages, drafts } });
  const look = async () => {
    const out = resultJson<{ batches?: { replied_count: number; replied: { thread_id: string; unread?: boolean }[] }[]; drafts?: { thread_id: string }[]; owed?: { thread_id: string }[] }>(
      await call(followups, ctx, { owed_from: 'anyone' }),
    );
    return { replied: out.batches?.[0]?.replied_count, drafts: (out.drafts ?? []).map((d) => d.thread_id).sort(), owed: (out.owed ?? []).map((o) => o.thread_id) };
  };
  assert.deepEqual(await look(), { replied: 4, drafts: ['q1', 'q2', 'q3', 'q4', 'shop'], owed: ['shop'] });

  // The drafts kept on purpose, by draft id, and by the draft's message id.
  const out = resultJson<{ dismissed: number; drafts_only?: number; note: string }>(
    await call(followupDismiss, ctx, { threads: [{ account: 'me', draft_id: 'r1' }, { account: 'me', draft_id: 'r3' }, { account: 'me', thread_id: 'd2' }] }),
  );
  assert.deepEqual([out.dismissed, out.drafts_only], [3, 3]);
  assert.match(out.note, /3 drafts are hidden from drafts only, until they are edited: their threads' owed, waiting and batch rows stay/);
  assert.deepEqual(await look(), { replied: 4, drafts: ['q4', 'shop'], owed: ['shop'] }, "translator 3's new reply stays in the batch");
  assert.equal(ctx.followups.dismissals('me').get('q3')?.lastMessageMs, NOW - 3 * DAY, 'until the draft is edited');

  // "No answer needed" for the shop: its thread, draft included.
  const shop = resultJson<{ dismissed: number; drafts_only?: number; note: string }>(await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'shop' }] }));
  assert.deepEqual([shop.dismissed, shop.drafts_only], [1, undefined]);
  assert.deepEqual(await look(), { replied: 4, drafts: ['q4'], owed: [] });

  // A thread hidden whole stays so when its draft is dismissed after; a draft hidden alone becomes the whole thread.
  await call(followupDismiss, ctx, { threads: [{ account: 'me', draft_id: 'rshop' }, { account: 'me', thread_id: 'q1' }] });
  assert.deepEqual(await look(), { replied: 3, drafts: ['q4'], owed: [] });
  assert.equal(ctx.followups.dismissals('me').get('shop')?.draftOnly, undefined);

  // Undone by draft id; refused without an id; an unknown draft is reported.
  assert.deepEqual(resultJson(await call(followupDismiss, ctx, { threads: [{ account: 'me', draft_id: 'r3' }], undo: true })), { restored: 1 });
  assert.deepEqual((await look()).drafts, ['q3', 'q4']);
  assert.match(errorText(await call(followupDismiss, ctx, { threads: [{ account: 'me' }] })), /thread_id or a draft_id/);
  const gone = resultJson<{ failed: unknown[] }>(await call(followupDismiss, ctx, { threads: [{ account: 'me', draft_id: 'r-gone' }] }));
  assert.deepEqual(gone.failed, [{ account: 'me', draft_id: 'r-gone', error: 'not found in this account' }]);
});

test('followups says when listings were cut, and never that nothing is pending then; max_threads_per_account reads more', async () => {
  // Three conversations the user answered: nothing owed, but only two are read.
  const messages = [0, 1, 2].flatMap((i) => [m(`a${i}`, `t${i}`, (5 + i) * DAY, `p${i}@example.com`, ME), m(`b${i}`, `t${i}`, (4 + i) * DAY, ME, `p${i}@example.com`)]);
  const ctx = setup({ me: { email: ME, messages } });
  const cut = resultJson<{ note: string; truncated?: unknown }>(await call(followups, ctx, { sections: ['owed'], max_threads_per_account: 2 }));
  assert.deepEqual(cut.truncated, [{ account: 'me', sections: ['owed'] }]);
  assert.doesNotMatch(cut.note, /Nothing needs attention/);
  assert.match(cut.note, /Nothing found in the threads read in me\b.*max_threads_per_account/);
  const whole = resultJson<{ note: string; truncated?: unknown }>(await call(followups, ctx, { sections: ['owed'], max_threads_per_account: 3 }));
  assert.equal(whole.truncated, undefined);
  assert.match(whole.note, /Nothing needs attention/);
});

test('followups names what was cut and how much was read; max_threads_per_account is offered only while it reads more', async () => {
  const messages: FakeMessage[] = [];
  for (let i = 0; i < 120; i++) messages.push(m(`d${i}`, `td${i}`, DAY + i * HOUR, ME, `p${i}@example.com`, { labels: ['DRAFT'] }));
  for (let i = 0; i < 3; i++) messages.push(m(`s${i}`, `ts${i}`, (5 + i) * DAY, ME, `q${i}@example.com`));
  const box: FakeMailbox = { email: ME, messages, drafts: messages.slice(0, 60).map((x, i) => ({ id: `r${i}`, messageId: x.id })) };
  const ctx = setup({ me: box });
  const note = async (args: Record<string, unknown>) => resultJson<{ note?: string }>(await call(followups, ctx, { sections: ['drafts', 'waiting'], ...args })).note;

  const drafts = await note({});
  assert.match(drafts!, /^Only the 50 most recent drafts in me were read \(see truncated\): older ones were not looked at\. max_threads_per_account \(up to 100\) reads more\.$/);
  assert.equal(await note({ max_threads_per_account: 60 }), undefined, 'every draft read');
  assert.match((await note({ max_threads_per_account: 2 }))!, /^Only the 2 most recently active threads per list in me and the 50 most recent drafts in me were read .*max_threads_per_account \(up to 100\) reads more\.$/);

  box.drafts = messages.slice(0, 120).map((x, i) => ({ id: `r${i}`, messageId: x.id }));
  const most = await note({ max_threads_per_account: 100 });
  assert.match(most!, /^Only the 100 most recent drafts in me were read \(see truncated\): older ones were not looked at\.$/, 'nothing more to offer');
});

test('followup_track says when nothing would remind the user: the daily digest is off', async () => {
  const ctx = setup({ me: { email: ME, messages: [] } });
  ctx.digest = new DigestScheduler(new DigestSettingsStore(openDatabase(':memory:'), 'Europe/Paris'), () => ctx, ctx.log);
  const off = resultJson<{ title: string; note?: string }>(await call(followupTrack, ctx, { title: 'Quote' }));
  assert.equal(off.title, 'Quote');
  assert.match(off.note!, /digest is off.*followup_digest/);
  ctx.digest.settings.update({ enabled: true });
  assert.equal(resultJson<{ note?: string }>(await call(followupTrack, ctx, { title: 'Quote 2' })).note, undefined);
  assert.match(followupTrack.description, /notifies no one by itself/);
});

test('the tools log ids and counts, never titles, notes, addresses or subjects', async () => {
  const lines: string[] = [];
  const ctx = setup({ me: { email: ME, messages: [m('o1', 'to1', 2 * DAY, 'Ann Secret <ann@example.com>', ME, { subject: 'Secret subject' })] } });
  ctx.log = createLogger('debug', {}, (l) => lines.push(l));
  const row = resultJson<{ id: string }>(await call(followupTrack, ctx, { title: 'Secret title', notes: 'Secret notes', waiting_on: ['counsel@example.com'] }));
  await call(followupTrack, ctx, { id: row.id, next_step: 'Secret step', status: 'done' });
  await call(followups, ctx);
  await call(followupDismiss, ctx, { threads: [{ account: 'me', thread_id: 'to1' }] });
  assert.ok(lines.some((l) => l.includes(row.id)), 'ids are fine');
  assert.ok(lines.some((l) => l.includes('"tool":"followup_dismiss"')));
  for (const l of lines) assert.doesNotMatch(l, /@|Secret|secret|counsel|Ann/i);
});

test('a Gmail call that fails while checking a watched thread is an error result, not a crash', async () => {
  const ctx = setup({ me: { email: ME, messages: [], failWith: { status: 403, json: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } } } });
  const text = errorText(await call(followupTrack, ctx, { title: 'x', watch_threads: [{ thread_id: 't1' }] }));
  assert.match(text, /lacks permission/);
  assert.equal(ctx.followups.list().length, 0);
});


test('followup_digest: shows the settings, changes them, refuses bad input, and send_now puts one into the inbox', async () => {
  const ctx = setup({ me: { email: ME, messages: [m('d1', 'td1', 1 * DAY, ME, 'ann@example.com', { labels: ['DRAFT'] })] } });
  ctx.digest = new DigestScheduler(new DigestSettingsStore(openDatabase(':memory:'), 'Europe/Paris'), () => ctx, ctx.log);

  const shown = resultJson<Record<string, unknown>>(await call(followupDigest, ctx));
  assert.equal(shown['enabled'], false);
  assert.equal(shown['time'], '08:00');
  assert.equal(shown['accounts'], 'all linked Gmail accounts');

  const on = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { enabled: true, time: '07:45', lang: 'fr', deliver_to: 'me' }));
  assert.deepEqual([on['enabled'], on['time'], on['lang'], on['deliver_to']], [true, '07:45', 'fr', 'me']);
  assert.match(errorText(await call(followupDigest, ctx, { time: '25:00' })), /HH:MM|time/i);
  assert.match(errorText(await call(followupDigest, ctx, { deliver_to: 'nobody' })), /No linked account "nobody"/);
  assert.equal(resultJson<Record<string, unknown>>(await call(followupDigest, ctx))['time'], '07:45', 'a refused change changes nothing');

  const weekly = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { frequency: 'weekly', weekday: 'monday', time: '09:00' }));
  assert.deepEqual([weekly['schedule'], weekly['frequency'], weekly['weekday']], ['every monday at 09:00', 'weekly', 'monday']);
  const sent = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { send_now: true }));
  assert.match(String(sent['send_now']), /^Delivered to me's inbox/);
  const insert = apiCalls(ctx).find((c) => c.method === 'POST' && c.url.pathname === `${GMAIL}/messages`);
  assert.ok(insert, 'inserted into the inbox');
  assert.equal(insert.url.searchParams.get('internalDateSource'), 'receivedTime');

  const bare = setup({ me: { email: ME, messages: [] } });
  assert.match(errorText(await call(followupDigest, bare)), /no follow-up digest/);
});

test('followup_digest: aliases are read like everywhere else and must have Gmail; turning it on pins the inbox it goes to', async () => {
  const ctx = setup({ me: { email: ME, messages: [] }, partner: { email: PARTNER, messages: [] } }, [
    { alias: 'work', email: 'work@example.com', services: ['calendar', 'drive'] },
    { alias: 'me', email: ME, services: ['gmail'] },
    { alias: 'partner', email: PARTNER, services: ['gmail'] },
  ]);
  ctx.digest = new DigestScheduler(new DigestSettingsStore(openDatabase(':memory:'), 'Europe/Paris'), () => ctx, ctx.log);

  assert.equal(resultJson<Record<string, unknown>>(await call(followupDigest, ctx))['deliver_to'], 'me', 'the inbox it would go to, by alias');
  const noGmail = errorText(await call(followupDigest, ctx, { enabled: true, deliver_to: 'work' }));
  assert.match(noGmail, /"work" is not linked with Gmail.*Aliases with Gmail: me, partner/);
  assert.match(errorText(await call(followupDigest, ctx, { accounts: ['me', 'work'] })), /"work" is not linked with Gmail/);
  assert.equal(ctx.digest.settings.get().enabled, false, 'a refused change changes nothing');

  // "Turn on the morning summary": the inbox is pinned, so it stays that inbox whatever happens to the accounts.
  const on = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { enabled: true }));
  assert.equal(on['deliver_to'], 'me');
  assert.equal(ctx.digest.settings.get().deliver_to, 'me');
  ctx.accounts.markNeedsRelink('me', 'test');
  const weekly = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { frequency: 'weekly', weekday: 'monday', time: '09:00' }));
  assert.deepEqual([weekly['schedule'], weekly['frequency'], weekly['weekday']], ['every monday at 09:00', 'weekly', 'monday']);
  const sent = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { send_now: true }));
  assert.match(String(sent['send_now']), /^Could not deliver it: me needs to be re-linked on the admin page\./);
  assert.match(String(sent['note']), /^me needs to be re-linked on the admin page, so no digest can be delivered/);
  assert.equal(apiCalls(ctx).filter((c) => c.method === 'POST').length, 0, "nothing put into partner's inbox");

  // Aliases in any case, as the store keeps them.
  const mixed = resultJson<Record<string, unknown>>(await call(followupDigest, ctx, { deliver_to: ' Partner ', accounts: ['ME', 'partner'] }));
  assert.deepEqual([mixed['deliver_to'], mixed['accounts']], ['partner', ['me', 'partner']]);
  assert.match(errorText(await call(followupDigest, ctx, { deliver_to: 'nobody' })), /No linked account "nobody"/);

  // Without any Gmail account, it is not turned on.
  const calOnly = setup({}, [{ alias: 'work', email: 'work@example.com', services: ['calendar'] }]);
  calOnly.digest = new DigestScheduler(new DigestSettingsStore(openDatabase(':memory:'), 'Europe/Paris'), () => calOnly, calOnly.log);
  assert.match(errorText(await call(followupDigest, calOnly, { enabled: true })), /No linked account has Gmail/);
  assert.equal(calOnly.digest.settings.get().enabled, false);
});

test('followup_track expects_attachment: set on an item made ready by a message without one, it waits again for the document', async () => {
  const counsel = 'Ivan Kovačić <counsel@example.com>';
  const me: FakeMailbox = { email: ME, messages: [m('a1', 'ta', 2 * HOUR, counsel, ME, { subject: 'Infostan' })] };
  const ctx = setup({ me });
  const id = ctx.followups.create({ account: 'me', title: 'Procuration', waiting_on: ['counsel@example.com'] }).id;
  ctx.db.prepare('UPDATE followups SET created_at = ? WHERE id = ?').run(NOW - DAY, id);
  const first = resultJson<{ tracked: { status: string }[] }>(await call(followups, ctx, { sections: ['tracked'] }));
  assert.equal(first.tracked[0]!.status, 'ready');

  const fixed = resultJson<{ status: string; expects_attachment?: boolean }>(await call(followupTrack, ctx, { id, expects_attachment: true }));
  assert.deepEqual([fixed.status, fixed.expects_attachment], ['waiting', true]);
  const again = resultJson<{ tracked: { status: string; other_mail?: { message_id: string; reason: string } }[] }>(await call(followups, ctx, { sections: ['tracked'] }));
  assert.deepEqual([again.tracked[0]!.status, again.tracked[0]!.other_mail?.message_id, again.tracked[0]!.other_mail?.reason], ['waiting', 'a1', 'no_attachment']);

  const made = resultJson<{ id: string; expects_attachment?: boolean }>(await call(followupTrack, ctx, { title: 'Certificat', waiting_on: ['x@example.com'], expects_attachment: true }));
  assert.equal(ctx.followups.get(made.id)?.expects_attachment, true, 'stored');
  const off = resultJson<{ expects_attachment?: boolean }>(await call(followupTrack, ctx, { id: made.id, expects_attachment: false }));
  assert.equal(off.expects_attachment, undefined);
});
