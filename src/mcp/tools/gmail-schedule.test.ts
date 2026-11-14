import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../log.js';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { gmailScheduleSend, LATE_MS, ScheduledSender } from './gmail-schedule.js';

const BASE = '/gmail/v1/users/me';
const path = (c: RecordedCall) => c.url.pathname.replace(BASE, '');
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const HOUR = 60 * 60 * 1000;

interface FakeDraft {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}

/** A fake Gmail with editable drafts; sends and inbox notices are recorded. */
function gmail(drafts: Record<string, FakeDraft>) {
  const ctx = createTestContext({
    google: (c) => {
      const p = path(c);
      const id = /^\/drafts\/([^/]+)$/.exec(p)?.[1];
      if (id && c.method === 'GET') {
        const d = drafts[decodeURIComponent(id)];
        if (!d) return { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
        return {
          json: { id, message: { id: d.messageId, threadId: `t-${id}`, payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: d.to }, { name: 'Subject', value: d.subject }], body: { data: b64(d.text) } } } },
        };
      }
      if (p === '/drafts/send') {
        const sentId = (c.json as { id: string }).id;
        delete drafts[sentId];
        return { json: { id: `sent-${sentId}`, threadId: 't' } };
      }
      if (p === '/messages' && c.method === 'POST') return { json: { id: 'notice' } };
      if (p === '/messages') return { json: { messages: [] } };
      return undefined;
    },
  });
  return ctx;
}

const call = (ctx: TestContext, args: Record<string, unknown>) => runTool(gmailScheduleSend, { account: 'me', ...args }, ctx);
const inAnHour = () => new Date(Date.now() + HOUR).toISOString();
const notices = (ctx: TestContext) =>
  apiCalls(ctx)
    .filter((c) => path(c) === '/messages' && c.method === 'POST')
    .map((c) => {
      const raw = Buffer.from((c.json as { raw: string }).raw, 'base64url').toString('utf8');
      const [head, body] = raw.split('\r\n\r\n');
      return `${head}\n\n${Buffer.from(body!.replace(/\s+/g, ''), 'base64').toString('utf8')}`;
    });

test('a draft scheduled for later goes out at its time, by the connector alone; not before', async () => {
  const drafts = { r1: { to: 'ann@example.com', subject: 'Bonjour', text: 'Merci !', messageId: 'm1' } };
  const ctx = gmail(drafts);
  const at = Date.now() + HOUR;
  const out = resultJson<{ scheduled: { id: string; draft_id: string; send_at: string; subject: string }[]; note: string }>(await call(ctx, { draft_id: 'r1', send_at: new Date(at).toISOString() }));
  assert.equal(out.scheduled[0]!.draft_id, 'r1');
  assert.equal(out.scheduled[0]!.subject, 'Bonjour');
  assert.match(out.scheduled[0]!.send_at, /\+0[12]:00$/, 'shown in the default time zone');
  assert.match(out.note, /sends it at .* by itself, with no chat open/);
  let clock = at - 60_000;
  const sender = new ScheduledSender(ctx.schedules!, () => ctx, ctx.log, () => clock);
  assert.deepEqual(await sender.tick(), { sent: 0, failed: 0 });
  assert.ok(!apiCalls(ctx).some((c) => path(c) === '/drafts/send'));
  clock = at + 30_000;
  assert.deepEqual(await sender.tick(), { sent: 1, failed: 0 });
  assert.equal(ctx.schedules!.get(out.scheduled[0]!.id)?.status, 'sent');
  assert.deepEqual(await sender.tick(), { sent: 0, failed: 0 }, 'once only');
  assert.equal(apiCalls(ctx).filter((c) => path(c) === '/drafts/send').length, 1);
});

test('a draft to a sensitive contact is scheduled only after its review, and is not sent if edited after the approval', async () => {
  const drafts: Record<string, FakeDraft> = { r1: { to: 'Office <office@etude-valmont.notaires.fr>', subject: 'Certificat', text: 'Анна, добрый день. Спасибо.', messageId: 'm1' } };
  const ctx = gmail(drafts);
  const held = resultJson<{ scheduled: number; reviews: { review: { review_token: string; sensitive: { category: string }[] } }[] }>(await call(ctx, { draft_id: 'r1', send_at: inAnHour() }));
  assert.equal(held.scheduled, 0);
  assert.equal(held.reviews[0]!.review.sensitive[0]!.category, 'notary');
  const token = held.reviews[0]!.review.review_token;
  assert.equal(ctx.schedules!.pending().length, 0);
  const ok = resultJson<{ scheduled: { id: string }[] }>(await call(ctx, { draft_id: 'r1', send_at: inAnHour(), reviewed_by_user: true, review_tokens: [token] }));
  const id = ok.scheduled[0]!.id;
  // Edited after the approval: not sent, and a notice says so in the inbox.
  drafts['r1']!.messageId = 'm2';
  drafts['r1']!.text = 'Анна, срочно!';
  const sender = new ScheduledSender(ctx.schedules!, () => ctx, ctx.log, () => Date.now() + 2 * HOUR);
  assert.deepEqual(await sender.tick(), { sent: 0, failed: 1 });
  assert.equal(ctx.schedules!.get(id)?.status, 'failed');
  assert.ok(!apiCalls(ctx).some((c) => path(c) === '/drafts/send'));
  const notice = notices(ctx)[0]!;
  assert.match(notice, /Subject: Not sent: Certificat/);
  assert.match(notice, /was NOT sent: it goes to a sensitive contact and was edited after the user approved it/);
});

test('scheduling refuses blanks, the past, a date without a time and missing drafts; cancel and list work', async () => {
  const drafts = { r1: { to: 'ann@example.com', subject: 'Devis', text: 'Mon numéro : [téléphone]', messageId: 'm1' }, r2: { to: 'bob@example.com', subject: 'Salut', text: 'Ok', messageId: 'm2' } };
  const ctx = gmail(drafts);
  assert.match(resultText(await call(ctx, { draft_id: 'r1', send_at: inAnHour() })), /Nothing was scheduled: r1 \(Devis\): "\[téléphone\]" still look like unfilled blanks/);
  assert.match(resultText(await call(ctx, { draft_id: 'r2', send_at: '2020-01-01T09:00' })), /not in the future.*gmail_send_draft/);
  assert.match(resultText(await call(ctx, { draft_id: 'r2', send_at: '2030-01-01' })), /needs a time of day/);
  assert.match(resultText(await call(ctx, { draft_id: 'nope', send_at: inAnHour() })), /no draft "nope"/);
  const s = resultJson<{ scheduled: { id: string }[] }>(await call(ctx, { draft_id: 'r2', send_at: inAnHour() }));
  const listed = resultJson<{ scheduled: { id: string; subject: string }[] }>(await call(ctx, {}));
  assert.deepEqual(listed.scheduled.map((x) => [x.id, x.subject]), [[s.scheduled[0]!.id, 'Salut']]);
  // Scheduling it again replaces the earlier time.
  await call(ctx, { draft_id: 'r2', send_at: new Date(Date.now() + 2 * HOUR).toISOString() });
  assert.equal(ctx.schedules!.pending().length, 1);
  const pendingId = ctx.schedules!.pending()[0]!.id;
  const cancelled = resultJson<{ results: { cancelled: boolean }[] }>(await call(ctx, { cancel: [pendingId] }));
  assert.equal(cancelled.results[0]!.cancelled, true);
  assert.equal(ctx.schedules!.pending().length, 0);
});

test('the sender: a deleted draft, a send far too late, Gmail down for a moment, a server stop mid-send', async () => {
  const drafts: Record<string, FakeDraft> = {
    gone: { to: 'a@example.com', subject: 'A', text: 'a', messageId: 'ma' },
    late: { to: 'b@example.com', subject: 'B', text: 'b', messageId: 'mb' },
  };
  const ctx = gmail(drafts);
  const lines: string[] = [];
  ctx.log = createLogger('debug', {}, (l) => lines.push(l));
  const now = Date.now();
  const gone = ctx.schedules!.schedule({ account: 'me', draft_id: 'gone', message_id: 'ma', send_at: now - 60_000, approved_sensitive: false, allow_placeholders: false });
  const late = ctx.schedules!.schedule({ account: 'me', draft_id: 'late', message_id: 'mb', send_at: now - LATE_MS - HOUR, approved_sensitive: false, allow_placeholders: false });
  delete drafts['gone'];
  const sender = new ScheduledSender(ctx.schedules!, () => ctx, ctx.log, () => now);
  assert.deepEqual(await sender.tick(), { sent: 0, failed: 2 });
  assert.equal(ctx.schedules!.get(gone.id)?.error, 'draft gone');
  assert.equal(ctx.schedules!.get(late.id)?.error, 'missed');
  assert.equal(notices(ctx).length, 2);
  for (const l of lines) assert.doesNotMatch(l, /@|Subject|example/);

  // Interrupted mid-send: still in the drafts, so not sent, and the user is told.
  drafts['mid'] = { to: 'c@example.com', subject: 'C', text: 'c', messageId: 'mc' };
  const mid = ctx.schedules!.schedule({ account: 'me', draft_id: 'mid', message_id: 'mc', send_at: now - 60_000, approved_sensitive: false, allow_placeholders: false });
  ctx.schedules!.claim(mid.id);
  const later = new ScheduledSender(ctx.schedules!, () => ctx, ctx.log, () => now + 20 * 60_000);
  await later.tick();
  assert.equal(ctx.schedules!.get(mid.id)?.error, 'interrupted');
  assert.ok(!apiCalls(ctx).some((c) => path(c) === '/drafts/send'), 'never sent twice on a doubt');
});

test('a scheduled draft is not listed among unsent drafts by followups', async () => {
  const { computeFollowups } = await import('../../followups/engine.js');
  const { mailboxes, message } = await import('../../followups/test-mailboxes.js');
  const { createMultiAccountContext } = await import('../../test-support.js');
  const now = Date.now();
  const box = {
    email: 'me@example.com',
    messages: [message(now, 'd1', 'td1', 2 * 24 * HOUR, 'me@example.com', 'ann@example.com', { labels: ['DRAFT'] }), message(now, 'd2', 'td2', 2 * 24 * HOUR, 'me@example.com', 'bob@example.com', { labels: ['DRAFT'] })],
    drafts: [{ id: 'r1', messageId: 'd1' }, { id: 'r2', messageId: 'd2' }],
  };
  const ctx = createMultiAccountContext({ accounts: [{ alias: 'me', email: 'me@example.com', services: ['gmail'] }], google: mailboxes({ me: box }, () => now) });
  ctx.schedules!.schedule({ account: 'me', draft_id: 'r1', message_id: 'd1', send_at: now + HOUR, approved_sensitive: false, allow_placeholders: false });
  const report = await computeFollowups(ctx, { now, sections: ['drafts'] });
  assert.deepEqual(report.drafts.map((d) => d.draft_id), ['r2']);
});

test('review fixes: a send cancelled while being checked does not go out; a draft being sent cannot be rescheduled; batches are all or none; bad offsets refuse; edited blanks are checked again', async () => {
  const drafts: Record<string, FakeDraft> = {
    r1: { to: 'ann@example.com', subject: 'A', text: 'a', messageId: 'm1' },
    r2: { to: 'bob@example.com', subject: 'B', text: 'Tel [téléphone]', messageId: 'm2' },
  };
  const ctx = gmail(drafts);
  const store = ctx.schedules!;
  const now = Date.now();

  // Cancelled while the sender was checking the draft.
  const a = store.schedule({ account: 'me', draft_id: 'r1', message_id: 'm1', send_at: now - 1000, approved_sensitive: false, allow_placeholders: false });
  assert.equal(store.claim(a.id), true);
  assert.match(String((() => { try { store.schedule({ account: 'me', draft_id: 'r1', message_id: 'm1', send_at: now + HOUR, approved_sensitive: false, allow_placeholders: false }); return ''; } catch (e) { return (e as Error).message; } })()), /being sent right now/);
  assert.equal(store.cancel(a.id), true, 'a claimed send can still be cancelled');
  store.release(a.id);
  assert.equal(store.get(a.id)?.status, 'cancelled', 'and is not put back to wait');

  // All or none.
  for (let i = 0; i < 99; i++) store.schedule({ account: 'me', draft_id: `x${i}`, message_id: `mx${i}`, send_at: now + HOUR, approved_sensitive: false, allow_placeholders: false });
  assert.throws(
    () => store.scheduleMany([0, 1].map((i) => ({ account: 'me', draft_id: `y${i}`, message_id: `my${i}`, send_at: now + HOUR, approved_sensitive: false, allow_placeholders: false }))),
    /nothing was scheduled/,
  );
  assert.equal(store.pending().length, 99);
  assert.throws(() => store.schedule({ account: 'me', draft_id: 'x1', message_id: 'mx1', send_at: Number.NaN, approved_sensitive: false, allow_placeholders: false }), /not valid/);
  assert.equal(store.pendingFor('me', 'x1')?.status, 'pending', 'the existing schedule is kept');
  assert.match(resultText(await call(ctx, { draft_id: 'r1', send_at: '2030-01-01T09:00:00+99:99' })), /not a valid time|Cannot parse/);

  // Blanks confirmed for one version are not confirmed for an edited one.
  const fresh = gmail(drafts);
  const b = fresh.schedules!.schedule({ account: 'me', draft_id: 'r2', message_id: 'm2', send_at: now - 1000, approved_sensitive: false, allow_placeholders: true });
  drafts['r2']!.messageId = 'm2b';
  drafts['r2']!.text = 'Dear {{first_name}}';
  const sender = new ScheduledSender(fresh.schedules!, () => fresh, fresh.log, () => now);
  assert.deepEqual(await sender.tick(), { sent: 0, failed: 1 });
  assert.equal(fresh.schedules!.get(b.id)?.error, 'unfilled blanks');
});
