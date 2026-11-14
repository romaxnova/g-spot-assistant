import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Service } from '../config.js';
import { openDatabase } from '../db.js';
import { createLogger } from '../log.js';
import { decodeBase64Url } from '../mcp/tools/gmail-mime.js';
import { apiCalls, createMultiAccountContext, createTestContext, TEST_KEY, type FakeResponse, type RecordedCall, type TestContext } from '../test-support.js';
import { CATCH_UP_MINUTES, DigestScheduler, DigestSettingsError, DigestSettingsStore, deliverDigest, dueDay, MAX_RETRIES, renderDigest, weekdayOf, type DigestSettings } from './digest.js';
import { computeFollowups, type DraftRow, type FollowupReport, type OwedRow, type TrackedRow, type WaitingRow } from './engine.js';
import { FollowupStore } from './store.js';
import { DAY, HOUR, mailboxes, message, serveMailbox, type FakeMailbox } from './test-mailboxes.js';

const GMAIL = '/gmail/v1/users/me';
const ME = 'me@example.com';
const PARTNER = 'partner@example.com';
const COUNSEL = 'Ivan Kovačić <counsel@example.com>';
const XSS = '<img src=x onerror=alert(1)>';
/** Friday 2 October 2026, 12:00 in Paris. */
const NOW = Date.parse('2026-10-02T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const threadUrl = (email: string, id: string) => `https://mail.google.com/mail/u/${email}/#all/${id}`;

// ---------------------------------------------------------------------------
// Settings

test('settings: defaults, saved choices survive a restart, the default zone applies until one is chosen', () => {
  const db = openDatabase(':memory:');
  const store = new DigestSettingsStore(db, 'Europe/Paris');
  assert.deepEqual(JSON.parse(JSON.stringify(store.get())), { enabled: false, frequency: 'daily', weekday: 'monday', time: '08:00', timezone: 'Europe/Paris', accounts: [], lang: 'en' });
  store.update({ enabled: true, time: '07:30', lang: 'fr', accounts: ['Me', 'partner', 'me'], deliver_to: 'partner', timezone: 'America/New_York' });
  const again = new DigestSettingsStore(db, 'Europe/Paris').get();
  assert.equal(again.enabled, true);
  assert.equal(again.time, '07:30');
  assert.equal(again.lang, 'fr');
  assert.deepEqual(again.accounts, ['me', 'partner']);
  assert.equal(again.deliver_to, 'partner');
  assert.equal(again.timezone, 'America/New_York');
  // Fields left out keep their value; an empty zone and a null deliver_to go back to the defaults.
  store.update({ enabled: false });
  assert.equal(store.get().time, '07:30');
  store.update({ timezone: '', deliver_to: null, accounts: [] });
  const cleared = store.get();
  assert.equal(cleared.timezone, 'Europe/Paris');
  assert.equal(cleared.deliver_to, undefined);
  assert.deepEqual(cleared.accounts, []);
  assert.equal(new DigestSettingsStore(db, 'Asia/Tokyo').get().timezone, 'Asia/Tokyo');
});

test('settings: invalid input is refused and changes nothing', () => {
  const store = new DigestSettingsStore(openDatabase(':memory:'), 'Europe/Paris');
  store.update({ time: '09:15' });
  for (const input of [
    { time: '8:00' },
    { time: '24:00' },
    { time: '12:60' },
    { time: 'noon' },
    { time: '' },
    { lang: 'de' },
    { lang: '' },
    { timezone: 'Mars/Olympus' },
    { accounts: ['Bad alias!'] },
    { deliver_to: 'not an alias' },
  ]) {
    assert.throws(() => store.update({ enabled: true, ...input }), DigestSettingsError, JSON.stringify(input));
  }
  assert.equal(store.get().enabled, false);
  assert.equal(store.get().time, '09:15');
});

test('settings: a damaged row reads as the defaults', () => {
  const db = openDatabase(':memory:');
  const store = new DigestSettingsStore(db, 'Europe/Paris');
  db.prepare('INSERT INTO followup_digest_settings (id, settings_json, updated_at) VALUES (1, ?, 0)').run('{"enabled":"yes","time":"99:99","lang":"xx","accounts":[1,"ok"]');
  assert.deepEqual(JSON.parse(JSON.stringify(store.get())), { enabled: false, frequency: 'daily', weekday: 'monday', time: '08:00', timezone: 'Europe/Paris', accounts: [], lang: 'en' });
  db.prepare("UPDATE followup_digest_settings SET settings_json = ? WHERE id = 1").run('{"enabled":true,"time":"99:99","lang":"xx","accounts":[1,"ok","Bad!"]}');
  const s = store.get();
  assert.equal(s.enabled, true);
  assert.equal(s.time, '08:00');
  assert.equal(s.lang, 'en');
  assert.deepEqual(s.accounts, ['ok']);
  // The last digest's message id survives a restart; a malformed one is dropped.
  store.record({ last_digest: { alias: 'me', message_id: '19a2b3c4d5e6f708' } });
  assert.deepEqual(new DigestSettingsStore(db, 'Europe/Paris').get().last_digest, { alias: 'me', message_id: '19a2b3c4d5e6f708' });
  for (const bad of [{ alias: 'me', message_id: '../drafts' }, { alias: 'Bad!', message_id: 'abc' }, { alias: 'me' }, 'abc']) {
    db.prepare('UPDATE followup_digest_settings SET settings_json = ? WHERE id = 1').run(JSON.stringify({ last_digest: bad }));
    assert.equal(store.get().last_digest, undefined, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Rendering

function tracked(over: Partial<TrackedRow>): TrackedRow {
  return { id: 'fu_1', account: 'me', title: 'Item', status: 'waiting', created_at: iso(NOW - 3 * DAY), age_days: 3, ...over };
}

function owedRow(i: number, over: Partial<OwedRow> = {}): OwedRow {
  return {
    account: 'me',
    thread_id: `to${i}`,
    message_id: `mo${i}`,
    from: `Person ${i} <p${i}@example.com>`,
    subject: `Question ${i}`,
    received_at: iso(NOW - 2 * DAY),
    days: 2,
    snippet: `Snippet ${i}`,
    web_url: threadUrl(ME, `to${i}`),
    ...over,
  };
}

function waitingRow(i: number): WaitingRow {
  return { account: 'me', thread_id: `tw${i}`, message_id: `mw${i}`, to: `Translator ${i} <t${i}@example.fr>`, subject: `Devis ${i}`, sent_at: iso(NOW - 5 * DAY), days_waiting: 5, web_url: threadUrl(ME, `tw${i}`) };
}

/** The user's case: the lawyer's document arrived, nine people wait, a draft is unsent, a quote request half answered. */
function sampleReport(): FollowupReport {
  const owed = [owedRow(0, { from: `"<script>alert(2)</script>" <evil@example.com>`, subject: XSS, snippet: '<b>bold</b> & co' }), ...Array.from({ length: 8 }, (_, i) => owedRow(i + 1))];
  return {
    generated_at: iso(NOW),
    accounts: ['me'],
    counts: { ready: 1, handled: 0, overdue: 1, due: 0, owed: 9, drafts: 1, waiting: 20, batches: 1 },
    tracked: [
      tracked({
        id: 'fu_ready',
        title: 'Power of attorney from the lawyer',
        next_step: 'send it to the translators who quoted',
        status: 'ready',
        arrived: { account: 'me', thread_id: 't9', message_id: 'm9', from: COUNSEL, subject: 'Punomoćje', date: iso(NOW - DAY), has_attachments: true, web_url: threadUrl(ME, 't9') },
      }),
      tracked({ id: 'fu_late', title: 'Notary appointment', status: 'overdue', due: '2026-09-29', watch_threads: [{ account: 'partner', thread_id: 'tn1' }] }),
      tracked({ id: 'fu_wait', title: 'Not due yet', status: 'waiting', due: '2026-10-20' }),
    ],
    owed,
    drafts: [{ account: 'me', draft_id: 'r1', message_id: 'dm1', thread_id: 'td1', to: 'Ann Lee <ann@example.com>', subject: 'Devis toiture', saved_at: iso(NOW - 2 * DAY), days: 2, web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1' }],
    waiting: Array.from({ length: 20 }, (_, i) => waitingRow(i)),
    batches: [
      {
        account: 'me',
        subject: 'Traduction certifiée',
        sent_at: iso(NOW - 6 * DAY),
        sent: 3,
        replied_count: 2,
        no_reply_count: 1,
        replied: [
          { who: 'Ana Petrović <ana@translations.example>', thread_id: 'tb1', last_reply_at: iso(NOW - 4 * DAY), answered: false, web_url: threadUrl(ME, 'tb1') },
          { who: 'Marko <marko@translations.example>', thread_id: 'tb2', last_reply_at: iso(NOW - 3 * DAY), answered: true, web_url: threadUrl(ME, 'tb2') },
        ],
        no_reply: [{ who: 'Jelena <jelena@translations.example>', thread_id: 'tb3', sent_at: iso(NOW - 6 * DAY), web_url: threadUrl(ME, 'tb3') }],
      },
    ],
  };
}

const RENDER = { timezone: 'Europe/Paris', now: NOW, adminUrl: 'https://connector.test/admin', emailOf: (a: string) => `${a}@example.com` };

test('renderDigest: English subject counts what asks for action, sections in order, every row linked', () => {
  const d = renderDigest(sampleReport(), { lang: 'en', ...RENDER });
  assert.equal(d.subject, 'Follow-ups — 1 ready, 1 due, 9 waiting for you, 1 unsent draft (Fri 2 Oct)');
  const order = ['Ready to act (1)', 'Overdue or due today (1)', 'People waiting for your reply (9)', 'Unsent drafts (1)', 'Still waiting on (1)', 'Batches (1)', 'No answer yet (20)'];
  const positions = order.map((title) => d.text.indexOf(title));
  assert.ok(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1]!)), `sections in order: ${positions.join(',')}`);
  assert.match(d.text, /- Power of attorney from the lawyer — from Ivan Kovačić: Punomoćje \(attachment\)\n {2}Next: send it to the translators who quoted\n {2}https:\/\/mail\.google\.com\/mail\/u\/me@example\.com\/#all\/t9/);
  assert.match(d.text, /- Notary appointment — due Tue 29 Sept?, 3 days late\n {2}https:\/\/mail\.google\.com\/mail\/u\/partner@example\.com\/#all\/tn1/);
  // Still awaited: shown as a reminder of what is outstanding, after what asks for action.
  assert.match(d.text, /- Not due yet — (?:from [^·]+ · )?(?:since today|since yesterday|for \d+ days) · due Tue 20 Oct/);
  assert.match(d.text, /- Devis toiture — to Ann Lee · saved 2 days ago/);
  assert.match(d.text, /- Traduction certifiée — 3 sent · 2 replied \(1 to answer\) · 1 no reply\n {2}Replied: Ana Petrović, Marko\n {2}No reply: Jelena\n {2}https:\/\/mail\.google\.com\/mail\/u\/me@example\.com\/#all\/tb1/);
  assert.match(d.text, /- Devis 0 — to Translator 0 · 5 days/);
  assert.match(d.text, /Ask Claude: go through my follow-ups\nChange the daily digest: https:\/\/connector\.test\/admin\n$/);
  for (const url of [threadUrl(ME, 't9'), threadUrl(ME, 'to1'), threadUrl(ME, 'tb3'), 'https://connector.test/admin']) assert.ok(d.html.includes(`href="${url}"`), url);
  assert.ok(d.html.includes('href="https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1"'));
  assert.ok(d.html.includes('Ask Claude: go through my follow-ups'));
});

test('renderDigest: French subject and wording', () => {
  const d = renderDigest(sampleReport(), { lang: 'fr', ...RENDER });
  assert.equal(d.subject, 'Suivi — 1 prêt, 1 à échéance, 9 attendent votre réponse, 1 brouillon non envoyé (ven. 2 oct.)');
  const report = sampleReport();
  report.tracked = report.tracked.filter((r) => r.status !== 'overdue');
  report.drafts.push({ ...report.drafts[0]!, draft_id: 'r2' });
  assert.equal(renderDigest(report, { lang: 'fr', ...RENDER }).subject, 'Suivi — 1 prêt, 9 attendent votre réponse, 2 brouillons non envoyés (ven. 2 oct.)');
  assert.match(d.text, /Prêt à traiter \(1\)\n- Power of attorney from the lawyer — de Ivan Kovačić : Punomoćje \(pièce jointe\)\n {2}Ensuite : send it to the translators who quoted/);
  assert.match(d.text, /Ils attendent votre réponse \(9\)/);
  assert.match(d.text, /échéance mar\. 29 sept\., 3 jours de retard/);
  assert.match(d.text, /Ont répondu : Ana Petrović, Marko/);
  assert.match(d.text, /\+5 autres/);
  assert.ok(d.text.includes('Demandez à Claude : « passe en revue mes suivis »'));
  assert.ok(d.text.includes('Modifier le récapitulatif quotidien : https://connector.test/admin'));
  assert.match(d.html, /^<!doctype html><html lang="fr">/);
});

test('renderDigest: everything that came from mail is escaped in the HTML', () => {
  const report = sampleReport();
  report.drafts[0]!.web_url = 'javascript:alert(3)';
  report.tracked[0]!.title = 'A "quoted" <title> & more';
  const { html, text } = renderDigest(report, { lang: 'en', ...RENDER });
  assert.ok(!html.includes(XSS));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; &amp; co'));
  assert.ok(html.includes('A &quot;quoted&quot; &lt;title&gt; &amp; more'));
  // Only https links: a strange URL is neither a link nor printed.
  assert.ok(!html.includes('javascript:') && !text.includes('javascript:'));
  // The only tags are the template's own.
  const template = new Set(['a', 'body', 'br', 'div', 'h3', 'head', 'html', 'li', 'meta', 'p', 'span', 'strong', 'ul']);
  for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi)) assert.ok(template.has(m[1]!.toLowerCase()), m[0]);
});

test('renderDigest: sections are clipped to 15 rows with a count of the rest', () => {
  const { text, html } = renderDigest(sampleReport(), { lang: 'en', ...RENDER });
  const waiting = text.slice(text.indexOf('No answer yet (20)'), text.indexOf('\n--\n'));
  assert.equal((waiting.match(/^- /gm) ?? []).length, 15);
  assert.match(waiting, /Devis 14 /);
  assert.doesNotMatch(waiting, /Devis 15 /);
  assert.match(waiting, / {2}\+5 more\n/);
  assert.ok(html.includes('+5 more'));
});

test('renderDigest: an empty report is all clear; accounts not checked are reported; several accounts are named', () => {
  const empty: FollowupReport = { generated_at: iso(NOW), accounts: ['me'], counts: { ready: 0, handled: 0, overdue: 0, due: 0, owed: 0, drafts: 0, waiting: 0, batches: 0 }, tracked: [], owed: [], drafts: [], waiting: [], batches: [] };
  const clear = renderDigest(empty, { lang: 'en', ...RENDER });
  assert.equal(clear.subject, 'Follow-ups — all clear (Fri 2 Oct)');
  assert.match(clear.text, /Nothing needs following up today\./);
  assert.equal(renderDigest(empty, { lang: 'fr', ...RENDER }).subject, 'Suivi — rien à signaler (ven. 2 oct.)');

  const failing = { ...empty, accounts: ['me', 'partner'], errors: [{ account: 'partner', error: 'Account "partner" needs to be re-linked.' }], waiting: [waitingRow(1)] };
  const d = renderDigest(failing, { lang: 'en', ...RENDER });
  assert.equal(d.subject, 'Follow-ups — 1 unanswered (Fri 2 Oct)');
  assert.match(d.text, /Not checked \(1\)\n- partner — Account "partner" needs to be re-linked\.\n {2}https:\/\/connector\.test\/admin/);
  assert.match(d.text, /- \[me\] Devis 1 — to Translator 1 · 5 days/);
  const onlyErrors = renderDigest({ ...failing, waiting: [] }, { lang: 'en', ...RENDER });
  assert.equal(onlyErrors.subject, 'Follow-ups — 1 account not checked (Fri 2 Oct)');

  // Listings cut short: nothing is said to be clear, only that nothing was found in the recent mail.
  const cut = { ...empty, truncated: [{ account: 'me', sections: ['owed' as const] }] };
  const partial = renderDigest(cut, { lang: 'en', ...RENDER });
  assert.equal(partial.subject, 'Follow-ups — nothing found in recent mail (Fri 2 Oct)');
  assert.match(partial.text, /Nothing found in the recent mail read\.\n\nOnly the most recent mail of me was read: older mail may need following up too\./);
  assert.doesNotMatch(partial.text, /all clear|Nothing needs following up/);
  assert.match(partial.html, /Only the most recent mail of me was read/);
  const fr = renderDigest(cut, { lang: 'fr', ...RENDER });
  assert.equal(fr.subject, 'Suivi — rien dans le courrier récent (ven. 2 oct.)');
  assert.match(fr.text, /Rien à suivre dans le courrier récent lu\.\n\nSeul le courrier le plus récent de me a été lu/);
  // With rows, the subject counts them as usual and the line says the rest is partial.
  const rows = renderDigest({ ...cut, waiting: [waitingRow(1)] }, { lang: 'en', ...RENDER });
  assert.equal(rows.subject, 'Follow-ups — 1 unanswered (Fri 2 Oct)');
  assert.match(rows.text, /Only the most recent mail of me was read/);
});

test('renderDigest: what could not be checked comes first, and a very full digest stays under Gmail\'s clipping size', () => {
  const long = (i: number, what: string) => `${what} ${i} — ${'Traduction certifiée conforme, procuration, réponse attendue '.repeat(3)}`.slice(0, 200);
  const person = (i: number, domain: string) => `Élisabeth-Éléonore de Saint-Exupéry ${i} <person${i}@${domain}.example.fr>`;
  const accounts = ['me', 'partner', 'office', 'shop'];
  const report: FollowupReport = {
    generated_at: iso(NOW),
    accounts,
    counts: { ready: 15, handled: 0, overdue: 15, due: 0, owed: 15, drafts: 15, waiting: 15, batches: 15 },
    tracked: (['ready', 'overdue', 'waiting'] as const).flatMap((status) =>
      Array.from({ length: 15 }, (_, i) =>
        tracked({
          id: `fu_${status}${i}`,
          account: accounts[i % 4]!,
          status,
          title: long(i, status),
          due: status === 'overdue' ? '2026-09-29' : undefined,
          next_step: long(i, 'Ensuite').repeat(2),
          waiting_on: [`p${i}@example.fr`, `q${i}@example.fr`],
          arrived: status === 'ready' ? { account: 'me', thread_id: `t${i}`, message_id: `m${i}`, from: person(i, 'a'), subject: long(i, 'Objet'), date: iso(NOW - DAY), web_url: threadUrl(ME, `t${i}`) } : undefined,
          watch_threads: [{ account: 'partner', thread_id: `tw${i}` }],
        }),
      ),
    ),
    owed: Array.from({ length: 15 }, (_, i) => owedRow(i, { account: accounts[i % 4]!, from: person(i, 'b'), subject: long(i, 'Question'), snippet: long(i, 'Extrait') })),
    drafts: Array.from({ length: 15 }, (_, i) => ({ account: 'me', draft_id: `r${i}`, message_id: `dm${i}`, thread_id: `td${i}`, to: person(i, 'c'), subject: long(i, 'Brouillon'), saved_at: iso(NOW - 2 * DAY), days: 2, web_url: `https://mail.google.com/mail/u/${ME}/#drafts?compose=dm${i}` })),
    waiting: Array.from({ length: 15 }, (_, i) => ({ ...waitingRow(i), to: person(i, 'd'), subject: long(i, 'Devis') })),
    batches: Array.from({ length: 15 }, (_, b) => ({
      account: accounts[b % 4]!,
      subject: long(b, 'Demande de devis'),
      sent_at: iso(NOW - 6 * DAY),
      sent: 30,
      replied_count: 20,
      no_reply_count: 10,
      replied: Array.from({ length: 20 }, (_, i) => ({ who: person(i, `r${b}`), thread_id: `tb${b}r${i}`, last_reply_at: iso(NOW - DAY), answered: false, web_url: threadUrl(ME, `tb${b}r${i}-${'x'.repeat(16)}`) })),
      no_reply: Array.from({ length: 10 }, (_, i) => ({ who: person(i, `n${b}`), thread_id: `tb${b}n${i}`, sent_at: iso(NOW - 6 * DAY), web_url: threadUrl(ME, `tb${b}n${i}-${'x'.repeat(16)}`) })),
    })),
    errors: [{ account: 'shop', error: 'Account "shop" needs to be re-linked.' }],
  };
  report.accounts.push('shop');
  for (const lang of ['en', 'fr'] as const) {
    const { html, text } = renderDigest(report, { lang, ...RENDER });
    assert.ok(Buffer.byteLength(html) < 100_000, `${lang}: ${Buffer.byteLength(html)} bytes`);
    const notChecked = lang === 'en' ? 'Not checked (1)' : 'Non vérifié (1)';
    assert.ok(text.indexOf(notChecked) > 0 && text.indexOf(notChecked) < text.indexOf(lang === 'en' ? 'Ready to act' : 'Prêt à traiter'), 'first');
    assert.ok(html.includes('shop'));
    // Rows past the size are counted, and the footer is still there.
    assert.match(text, lang === 'en' ? /\+\d+ more/ : /\+\d+ autres?/);
    assert.ok(html.includes('href="https://connector.test/admin"'));
    assert.equal((html.match(/<h3 /g) ?? []).length, 8, 'every section keeps its heading and count');
  }
  // An ordinary digest is not clipped at all.
  assert.doesNotMatch(renderDigest(sampleReport(), { lang: 'en', ...RENDER }).text, /Ready to act[^]*\+\d+ more[^]*Batches/);
});

// ---------------------------------------------------------------------------
// Delivery

/** Header lines of a MIME message, unfolded, encoded words decoded. */
function headersOf(mime: string): Record<string, string> {
  const head = mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' ');
  const out: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const value = line.slice(i + 1).trim().replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
    out[line.slice(0, i).toLowerCase()] = value;
  }
  return out;
}

function insertCalls(ctx: TestContext): RecordedCall[] {
  return apiCalls(ctx).filter((c) => c.method === 'POST' && c.url.pathname === `${GMAIL}/messages`);
}

test('deliverDigest inserts the email into the inbox, unread and important, From "Follow-ups" to the account itself', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'me', email: ME, services: ['gmail'] }], google: (c) => (c.method === 'POST' ? { json: { id: 'ins1', threadId: 'tins1' } } : undefined) });
  const digest = renderDigest(sampleReport(), { lang: 'en', ...RENDER });
  const result = await deliverDigest(ctx, 'me', digest, new Date(NOW));
  assert.deepEqual(result, { id: 'ins1', threadId: 'tins1' });
  const [call, ...rest] = insertCalls(ctx);
  assert.ok(call);
  assert.equal(rest.length, 0);
  assert.equal(call.url.searchParams.get('internalDateSource'), 'receivedTime');
  const body = call.json as { raw: string; labelIds: string[] };
  assert.deepEqual(body.labelIds, ['INBOX', 'UNREAD', 'IMPORTANT']);
  const mime = decodeBase64Url(body.raw).toString('utf8');
  const h = headersOf(mime);
  assert.equal(h['from'], `Follow-ups <${ME}>`);
  assert.equal(h['to'], ME);
  assert.equal(h['subject'], digest.subject);
  assert.equal(h['date'], 'Fri, 02 Oct 2026 10:00:00 +0000');
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
  // Nothing goes through messages.send: the digest is inserted, never sent.
  assert.ok(!apiCalls(ctx).some((c) => c.url.pathname.endsWith('/send')));
});

test('deliverDigest is not retried after a server error (a repeat could insert it twice)', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'me', email: ME, services: ['gmail'] }], google: () => ({ status: 503, json: { error: { code: 503, message: 'backend' } } }) });
  await assert.rejects(deliverDigest(ctx, 'me', { subject: 's', text: 't', html: '<p>t</p>' }), { name: 'GoogleApiError' });
  assert.equal(insertCalls(ctx).length, 1);
});

// ---------------------------------------------------------------------------
// Scheduling

/** Paris is UTC+2 in October: 08:00 there is 06:00Z. */
const at = (utc: string) => Date.parse(utc);

interface Harness {
  ctx: TestContext;
  settings: DigestSettingsStore;
  scheduler: DigestScheduler;
  lines: string[];
  setClock(ms: number): void;
  /**
   * Answer inserts with this (an outage, or an Error thrown as a network failure) until cleared; `stored`: Gmail keeps
   * the message all the same (a timeout after it accepted it).
   */
  failInsert(r: FakeResponse | Error | undefined, stored?: boolean): void;
  /** Answer archiving (messages.modify) with this until cleared. */
  failArchive(r: FakeResponse | undefined): void;
  inserts(): { alias: string; subject: string }[];
  /** The plain text of each digest inserted. */
  texts(): string[];
  /** Messages archived: alias and message id. */
  archived(): string[];
}

/** The decoded body of the MIME part of a type, with \n line ends. */
function partText(mime: string, type: string): string {
  const start = mime.indexOf(`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
  assert.ok(start >= 0, type);
  const body = mime.slice(mime.indexOf('\r\n\r\n', start) + 4);
  return Buffer.from(body.slice(0, body.indexOf('\r\n--')).replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
}

const MODIFY_RE = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/;

function harness(boxes: Record<string, FakeMailbox>, start = at('2026-10-02T05:00:00Z')): Harness {
  let clock = start;
  let insertFailure: FakeResponse | Error | undefined;
  let storedOnFailure = false;
  let archiveFailure: FakeResponse | undefined;
  let inserted = 0;
  /** Digests Gmail keeps, by mailbox: id and Message-ID header. */
  const kept: { alias: string; id: string; rfc822: string }[] = [];
  const serve = mailboxes(boxes, () => clock);
  const specs = Object.entries(boxes).map(([alias, b]) => ({ alias, email: b.email, services: ['gmail'] as Service[] }));
  const ctx = createMultiAccountContext({
    accounts: specs,
    google: (alias, call) => {
      if (call.method === 'POST' && call.url.pathname === `${GMAIL}/messages`) {
        if (!insertFailure || storedOnFailure) {
          const rfc822 = headersOf(decodeBase64Url((call.json as { raw: string }).raw).toString('utf8'))['message-id'] ?? '';
          kept.push({ alias, id: `ins${++inserted}`, rfc822 });
        }
        if (insertFailure instanceof Error) throw insertFailure;
        return insertFailure ?? { json: { id: `ins${inserted}`, threadId: `tins${inserted}` } };
      }
      // Gmail's rfc822msgid: search, over the digests kept.
      const wanted = /^rfc822msgid:(\S+)$/.exec(call.url.searchParams.get('q') ?? '')?.[1];
      if (call.method === 'GET' && call.url.pathname === `${GMAIL}/messages` && wanted) {
        const found = kept.filter((k) => k.alias === alias && k.rfc822.replace(/^<|>$/g, '') === wanted.replace(/^<|>$/g, ''));
        return { json: found.length ? { messages: found.map((k) => ({ id: k.id, threadId: `t${k.id}` })), resultSizeEstimate: found.length } : { resultSizeEstimate: 0 } };
      }
      const modified = MODIFY_RE.exec(call.url.pathname)?.[1];
      if (call.method === 'POST' && modified) return archiveFailure ?? { json: { id: modified, labelIds: ['UNREAD'] } };
      return serve(alias, call);
    },
  });
  ctx.followups = new FollowupStore(ctx.db, [TEST_KEY], () => clock);
  const lines: string[] = [];
  const log = createLogger('debug', {}, (l) => lines.push(l));
  ctx.log = log;
  const settings = new DigestSettingsStore(ctx.db, 'Europe/Paris');
  return {
    ctx,
    settings,
    scheduler: new DigestScheduler(settings, () => ctx, log, () => clock),
    lines,
    setClock: (ms) => (clock = ms),
    failInsert: (r, stored = false) => {
      insertFailure = r;
      storedOnFailure = stored;
    },
    failArchive: (r) => (archiveFailure = r),
    inserts: () =>
      insertCalls(ctx).map((c) => ({
        alias: c.headers['authorization']!.replace('Bearer token-', ''),
        subject: headersOf(decodeBase64Url((c.json as { raw: string }).raw).toString('utf8'))['subject']!,
      })),
    texts: () => insertCalls(ctx).map((c) => partText(decodeBase64Url((c.json as { raw: string }).raw).toString('utf8'), 'text/plain')),
    archived: () =>
      apiCalls(ctx)
        .filter((c) => c.method === 'POST' && MODIFY_RE.test(c.url.pathname))
        .map((c) => `${c.headers['authorization']!.replace('Bearer token-', '')}:${MODIFY_RE.exec(c.url.pathname)![1]}`),
  };
}

/** A mailbox where the lawyer answered two days ago and is still unanswered. */
function busyMailbox(): FakeMailbox {
  const base = at('2026-10-02T06:00:00Z');
  return {
    email: ME,
    messages: [message(base, 'o0', 'to1', 3 * DAY, ME, COUNSEL, { subject: XSS }), message(base, 'o1', 'to1', 2 * DAY, COUNSEL, ME, { subject: XSS, snippet: 'Secret details' })],
  };
}

const state = (s: DigestSettings) => ({ last_run_date: s.last_run_date, last_status: s.last_status, attempts: s.attempts });

test('scheduler: off by default, then once a day after the chosen time, not again after a restart, again the next day', async () => {
  const h = harness({ me: busyMailbox() });
  h.setClock(at('2026-10-02T09:00:00Z'));
  assert.equal(await h.scheduler.tick(), undefined, 'disabled');
  assert.equal(h.inserts().length, 0);

  h.settings.update({ enabled: true, time: '08:00' });
  h.setClock(at('2026-10-02T05:59:00Z')); // 07:59 in Paris
  assert.equal(await h.scheduler.tick(), undefined, 'before the time');
  assert.equal(apiCalls(h.ctx).length, 0, 'nothing read before the time');

  h.setClock(at('2026-10-02T06:00:00Z')); // 08:00 in Paris
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 1 });
  assert.deepEqual(h.inserts(), [{ alias: 'me', subject: 'Follow-ups — 1 waiting for you (Fri 2 Oct)' }]);
  assert.deepEqual(state(h.settings.get()), { last_run_date: '2026-10-02', last_status: 'delivered 1 item', attempts: undefined });

  h.setClock(at('2026-10-02T15:00:00Z'));
  assert.equal(await h.scheduler.tick(), undefined, 'same day');
  const restarted = new DigestScheduler(new DigestSettingsStore(h.ctx.db, 'Europe/Paris'), () => h.ctx, h.ctx.log, () => at('2026-10-02T21:55:00Z'));
  assert.equal(await restarted.tick(), undefined, 'after a restart the same day (23:55 in Paris)');
  assert.equal(h.inserts().length, 1);

  h.setClock(at('2026-10-02T22:30:00Z')); // 00:30 on Saturday in Paris: a new day, but before the time
  assert.equal(await h.scheduler.tick(), undefined);
  h.setClock(at('2026-10-03T07:10:00Z')); // a deploy at 08:00: caught up at 09:10
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.deepEqual(h.inserts().map((i) => i.subject), ['Follow-ups — 1 waiting for you (Fri 2 Oct)', 'Follow-ups — 1 waiting for you (Sat 3 Oct)']);
  assert.equal(h.settings.get().last_run_date, '2026-10-03');
});

test('scheduler: the time and the day are read in the chosen zone', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T13:00:00Z'));
  h.settings.update({ enabled: true, time: '08:00', timezone: 'America/New_York' }); // 09:00 there
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.equal(h.settings.get().last_run_date, '2026-10-02');
  h.setClock(at('2026-10-03T03:00:00Z')); // Saturday in Paris, still Friday 23:00 in New York
  assert.equal(await h.scheduler.tick(), undefined);
});

test('scheduler: a failed run is retried on the next ticks, at most 3 times that day', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:05:00Z'));
  h.settings.update({ enabled: true });
  h.failInsert({ status: 500, json: { error: { code: 500, message: 'backend error' } } });
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    assert.deepEqual(await h.scheduler.tick(), { status: 'failed', error: 'GoogleApiError' });
    assert.deepEqual(state(h.settings.get()), { last_run_date: undefined, last_status: 'failed: GoogleApiError', attempts: attempt });
  }
  assert.equal(MAX_RETRIES, 3);
  assert.equal(await h.scheduler.tick(), undefined, 'no fifth try');
  assert.equal(h.inserts().length, 4);

  h.failInsert(undefined);
  h.setClock(at('2026-10-03T06:05:00Z'));
  assert.equal((await h.scheduler.tick())?.status, 'delivered', 'the next day starts afresh');
  assert.deepEqual(state(h.settings.get()), { last_run_date: '2026-10-03', last_status: 'delivered 1 item', attempts: undefined });
});

test('scheduler: a run that failed once succeeds on the next tick', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:05:00Z'));
  h.settings.update({ enabled: true });
  h.failInsert({ status: 500, json: {} });
  assert.equal((await h.scheduler.tick())?.status, 'failed');
  h.failInsert(undefined);
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.equal(await h.scheduler.tick(), undefined);
  assert.equal(h.inserts().length, 2);
});

test('scheduler: a retry finds the digest an earlier try put in the inbox before failing, and inserts no second copy', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:05:00Z'));
  h.settings.update({ enabled: true });
  // Gmail keeps the digest, but its answer is lost (the client timed out after Gmail accepted it).
  h.failInsert(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), true);
  assert.deepEqual(await h.scheduler.tick(), { status: 'failed', error: 'GoogleApiError' });
  assert.equal(h.inserts().length, 1);
  const rfc822 = headersOf(decodeBase64Url((insertCalls(h.ctx)[0]!.json as { raw: string }).raw).toString('utf8'))['message-id'];
  assert.equal(rfc822, '<followups-digest.2026-10-02.me@connector.test>', "the day's digest has a Message-ID of its own");

  h.failInsert(undefined);
  h.setClock(at('2026-10-02T06:10:00Z'));
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 1 });
  assert.equal(h.inserts().length, 1, 'not inserted again');
  const lookup = apiCalls(h.ctx).filter((c) => c.method === 'GET' && c.url.pathname === `${GMAIL}/messages` && c.url.searchParams.get('q')?.startsWith('rfc822msgid:'));
  assert.equal(lookup.length, 1);
  assert.equal(lookup[0]!.url.searchParams.get('q'), 'rfc822msgid:followups-digest.2026-10-02.me@connector.test');
  assert.deepEqual(state(h.settings.get()), { last_run_date: '2026-10-02', last_status: 'delivered 1 item', attempts: undefined });
  assert.deepEqual(h.settings.get().last_digest, { alias: 'me', message_id: 'ins1' }, 'recorded, so the next digest archives it');

  h.setClock(at('2026-10-03T06:05:00Z'));
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.deepEqual(h.archived(), ['me:ins1']);
  assert.equal(h.inserts().length, 2);
  // The first try of a day looks nothing up; Send now is not the day's digest and has no such Message-ID.
  assert.equal(apiCalls(h.ctx).filter((c) => c.url.searchParams.get('q')?.startsWith('rfc822msgid:')).length, 1);
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  const manual = headersOf(decodeBase64Url((insertCalls(h.ctx)[2]!.json as { raw: string }).raw).toString('utf8'))['message-id'];
  assert.doesNotMatch(manual ?? '', /2026-10-03/);
});

test('scheduler: a retry after a failure that kept nothing looks the digest up, finds none, and inserts it', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:05:00Z'));
  h.settings.update({ enabled: true });
  h.failInsert({ status: 503, json: { error: { code: 503, message: 'backend' } } });
  assert.equal((await h.scheduler.tick())?.status, 'failed');
  h.failInsert(undefined);
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 1 });
  assert.equal(h.inserts().length, 2);
  assert.deepEqual(h.settings.get().last_digest, { alias: 'me', message_id: 'ins1' });
});

test('scheduler: an account that needs re-linking is listed under Not checked, never skipped', async () => {
  const base = at('2026-10-02T06:00:00Z');
  const shop: FakeMailbox = { email: 'shop@example.com', messages: [message(base, 'op1', 'tp1', 2 * DAY, COUNSEL, 'shop@example.com', { subject: 'Ugovor' })] };
  const h = harness({ me: { email: ME, messages: [] }, shop }, at('2026-10-02T06:30:00Z'));
  h.ctx.accounts.markNeedsRelink('shop', 'test');
  h.settings.update({ enabled: true });
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 0 });
  assert.equal(h.settings.get().last_status, 'delivered 0 items, 1 account not checked');
  assert.match(h.texts()[0]!, /Not checked \(1\)\n- shop — Account "shop" .*re-linked/);
  assert.ok(!apiCalls(h.ctx).some((c) => c.headers['authorization'] === 'Bearer token-shop'), 'nothing asked of Google for it');
});

test('scheduler: with no inbox chosen, the digest goes to the first account with Gmail, and fails rather than go to another one', async () => {
  const partner: FakeMailbox = { email: PARTNER, messages: [] };
  const h = harness({ me: busyMailbox(), partner }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true });
  assert.deepEqual(await h.scheduler.runNow(), { status: 'delivered', alias: 'me', items: 1 });
  h.ctx.accounts.markNeedsRelink('me', 'test');
  h.setClock(at('2026-10-03T06:30:00Z'));
  assert.deepEqual(await h.scheduler.tick(), { status: 'failed', error: 'me needs to be re-linked on the admin page' });
  assert.equal(h.settings.get().last_status, 'failed: me needs to be re-linked on the admin page');
  assert.deepEqual(h.inserts().map((i) => i.alias), ['me'], "nothing put into partner's inbox");
});

test('scheduler: Gmail refusing the inbox\'s credential is said in fixed words; send_now gets the full message', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true });
  h.failInsert({ status: 403, json: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } });
  const refused = await h.scheduler.runNow();
  assert.equal(refused.status, 'failed');
  assert.equal(refused.status === 'failed' && refused.error, 'AccountError');
  assert.match(refused.status === 'failed' ? refused.detail! : '', /lacks permission/);
  assert.equal(h.settings.get().last_status, 'failed: AccountError');
  // Rejected even after a refresh: the account is marked, and the status says what to do.
  h.failInsert({ status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } });
  assert.deepEqual(await h.scheduler.tick(), { status: 'failed', error: 'me needs to be re-linked on the admin page' });
  assert.equal(h.ctx.accounts.get('me')?.status, 'needs_relink');
  for (const l of [h.settings.get().last_status!, ...h.lines]) assert.doesNotMatch(l, /@/);
});

test('scheduler: the digest reads 100 threads per list: a question unanswered for weeks in a busy mailbox is found', async () => {
  const base = at('2026-10-02T06:00:00Z');
  const messages = [message(base, 'n1', 'notary', 20 * DAY, ME, 'Etude <etude@notaire.fr>', { subject: 'Succession - question' })];
  // Three conversations a day since, each answered (their last word a notification-like reply, kept out of owed).
  for (let d = 0; d < 19; d++) {
    for (let j = 0; j < 3; j++) {
      const ago = (19 - d) * DAY - j * 3 * HOUR;
      const p = `p${d}_${j}@example.fr`;
      messages.push(message(base, `a${d}_${j}`, `t${d}_${j}`, ago, ME, p, { subject: `Sujet ${d} ${j}` }));
      messages.push(message(base, `b${d}_${j}`, `t${d}_${j}`, ago - 2 * HOUR, p, ME, { subject: `Re: Sujet ${d} ${j}`, labels: ['INBOX', 'CATEGORY_UPDATES'] }));
    }
  }
  const h = harness({ me: { email: ME, messages } }, at('2026-10-02T06:05:00Z'));
  assert.deepEqual((await computeFollowups(h.ctx, { now: base })).waiting, [], 'the 40 threads read by default are all answered');
  h.ctx.calls.length = 0;
  h.settings.update({ enabled: true });
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 1 });
  assert.match(h.texts()[0]!, /No answer yet \(1\)\n- Succession - question — to Etude · 20 days/);
  assert.doesNotMatch(h.texts()[0]!, /Only the most recent mail/);
  const lists = apiCalls(h.ctx).filter((c) => c.url.pathname === `${GMAIL}/threads` || c.url.pathname === `${GMAIL}/drafts`);
  assert.ok(lists.length >= 3 && lists.every((c) => c.url.searchParams.get('maxResults') === '100'), 'every list read 100 at a time');
});

test('scheduler: the digest asks Gmail at most three things at a time per mailbox', async () => {
  const messages = Array.from({ length: 30 }, (_, i) => message(NOW, `s${i}`, `ts${i}`, 5 * DAY + i * HOUR, ME, `p${i}@example.com`, { subject: `Question ${i}` }));
  const box: FakeMailbox = { email: ME, messages };
  let active = 0;
  let peak = 0;
  const ctx = createMultiAccountContext({
    accounts: [{ alias: 'me', email: ME, services: ['gmail'] }],
    google: async (_a, call) => {
      if (call.method === 'POST') return { json: { id: 'ins1', threadId: 'tins1' } };
      if (call.url.pathname.endsWith('/settings/sendAs')) return undefined;
      peak = Math.max(peak, ++active);
      await delay(2);
      active--;
      return serveMailbox(box, call, NOW);
    },
  });
  ctx.followups = new FollowupStore(ctx.db, [TEST_KEY], () => NOW);
  const scheduler = new DigestScheduler(new DigestSettingsStore(ctx.db, 'Europe/Paris'), () => ctx, ctx.log, () => NOW);
  assert.deepEqual(await scheduler.runNow(), { status: 'delivered', alias: 'me', items: 30 });
  assert.equal(peak, 3);
});

test('scheduler: a day with nothing found in mail read only in part sends nothing, and its status says the older mail was not read', async () => {
  // 105 requests sent last week, each answered: more than the 100 threads a list reads.
  const base = at('2026-10-02T06:00:00Z');
  const messages = Array.from({ length: 105 }, (_, i) => [
    message(base, `a${i}`, `t${i}`, 6 * DAY + i * 60_000, ME, `p${i}@example.fr`, { subject: `Sujet ${i}` }),
    message(base, `b${i}`, `t${i}`, 5 * DAY + i * 60_000, `p${i}@example.fr`, ME, { subject: `Re: Sujet ${i}`, labels: ['INBOX', 'CATEGORY_UPDATES'] }),
  ]).flat();
  const h = harness({ me: { email: ME, messages } }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true });
  assert.deepEqual(await h.scheduler.tick(), { status: 'nothing' });
  assert.equal(h.inserts().length, 0);
  assert.deepEqual(state(h.settings.get()), { last_run_date: '2026-10-02', last_status: 'nothing found in recent mail (older mail not read)', attempts: undefined });
});

test('scheduler: nothing to report records the day without delivering anything', async () => {
  const h = harness({ me: { email: ME, messages: [] } }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true });
  assert.deepEqual(await h.scheduler.tick(), { status: 'nothing' });
  assert.equal(h.inserts().length, 0);
  assert.deepEqual(state(h.settings.get()), { last_run_date: '2026-10-02', last_status: 'nothing to report', attempts: undefined });
  assert.equal(await h.scheduler.tick(), undefined);
});

test('scheduler: every account failing is retried, and the last try reports the accounts not checked', async () => {
  const outage = { status: 503, json: { error: { code: 503, message: 'backend' } } };
  const h = harness({ me: { ...busyMailbox(), failWith: outage } }, at('2026-10-02T06:05:00Z'));
  h.settings.update({ enabled: true });
  for (let i = 0; i < MAX_RETRIES; i++) assert.deepEqual(await h.scheduler.tick(), { status: 'failed', error: 'no account could be checked' });
  assert.equal(h.inserts().length, 0);
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 0 });
  assert.deepEqual(h.inserts().map((i) => i.subject), ['Follow-ups — 1 account not checked (Fri 2 Oct)']);
  assert.equal(h.settings.get().last_status, 'delivered 0 items, 1 account not checked');
});

test('scheduler: reads the chosen accounts and delivers to the chosen inbox', async () => {
  const base = at('2026-10-02T06:00:00Z');
  const partner: FakeMailbox = {
    email: PARTNER,
    messages: [message(base, 'om0', 'tm1', 3 * DAY, PARTNER, COUNSEL, { subject: 'Ugovor' }), message(base, 'om1', 'tm1', 2 * DAY, COUNSEL, PARTNER, { subject: 'Re: Ugovor' })],
  };
  const h = harness({ me: busyMailbox(), partner }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true, accounts: ['partner'], deliver_to: 'partner', lang: 'fr' });
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'partner', items: 1 });
  assert.deepEqual(h.inserts(), [{ alias: 'partner', subject: 'Suivi — 1 attend votre réponse (ven. 2 oct.)' }]);
  const readFrom = new Set(apiCalls(h.ctx).filter((c) => c.method === 'GET' && c.url.pathname === `${GMAIL}/threads`).map((c) => c.headers['authorization']));
  assert.deepEqual([...readFrom], ['Bearer token-partner']);
});

test('scheduler: a deliver_to account that is gone or has no Gmail fails with a fixed status naming it, nothing delivered elsewhere', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true, deliver_to: 'gone' });
  assert.deepEqual(await h.scheduler.tick(), { status: 'failed', error: 'gone is no longer linked' });
  assert.equal(h.settings.get().last_status, 'failed: gone is no longer linked');
  h.ctx.accounts.upsertLinked({ alias: 'cal', email: 'cal@example.com', googleSub: 'sub-cal', refreshToken: 'refresh-cal', grantedScopes: ['openid', 'email'], requestedServices: ['calendar'] });
  h.settings.update({ deliver_to: 'cal' });
  const failed = await h.scheduler.runNow();
  assert.deepEqual(failed, { status: 'failed', error: 'cal has no Gmail' });
  assert.equal(h.inserts().length, 0);
  assert.equal(apiCalls(h.ctx).length, 0, 'nothing read either');
  for (const s of [h.settings.get().last_status!, ...h.lines]) assert.doesNotMatch(s, /@/);
});

test('runNow: delivers whatever the switch and the time, even all clear, without spending the day', async () => {
  const h = harness({ me: { email: ME, messages: [] } }, at('2026-10-02T04:00:00Z'));
  assert.equal(h.settings.get().enabled, false);
  assert.deepEqual(await h.scheduler.runNow(), { status: 'delivered', alias: 'me', items: 0 });
  assert.deepEqual(h.inserts().map((i) => i.subject), ['Follow-ups — all clear (Fri 2 Oct)']);
  assert.equal(h.settings.get().last_status, 'delivered 0 items');
  assert.equal(h.settings.get().last_run_date, undefined, 'not the day\'s digest');
  // A manual failure does not count against the scheduled retries.
  h.failInsert({ status: 500, json: {} });
  assert.deepEqual(await h.scheduler.runNow(), { status: 'failed', error: 'GoogleApiError' });
  assert.equal(h.settings.get().attempts, undefined);
});

test('runNow: a preview in the morning does not cancel the scheduled digest that evening', async () => {
  const me: FakeMailbox = { email: ME, messages: [message(at('2026-10-02T07:00:00Z'), 'l1', 'tl', 3 * DAY, ME, COUNSEL, { subject: 'Punomoćje' })] };
  const h = harness({ me }, at('2026-09-29T07:00:00Z'));
  h.ctx.followups.create({ account: 'me', title: 'Power of attorney', watch_threads: [{ account: 'me', thread_id: 'tl' }] });
  h.settings.update({ enabled: true, time: '18:00' });
  h.setClock(at('2026-10-02T07:00:00Z')); // 09:00 in Paris: the owner looks at what the digest is like
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  assert.equal(await h.scheduler.tick(), undefined, 'before 18:00');
  // The lawyer answers at 14:00; the 18:00 digest still comes, with his answer.
  me.messages.push(message(at('2026-10-02T12:00:00Z'), 'l2', 'tl', 0, COUNSEL, ME, { subject: 'Re: Punomoćje' }));
  h.setClock(at('2026-10-02T16:00:00Z'));
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 1 });
  assert.equal(h.inserts()[1]!.subject, 'Follow-ups — 1 ready (Fri 2 Oct)');
  assert.equal(h.settings.get().last_run_date, '2026-10-02');
  assert.equal(await h.scheduler.tick(), undefined);
  // Send now after the scheduled run still delivers, and leaves the day as it was.
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  assert.equal(h.settings.get().last_run_date, '2026-10-02');
  assert.equal(await h.scheduler.tick(), undefined);
  assert.equal(h.inserts().length, 3);
});

test('scheduler: the lawyer\'s reply to a tracked item is listed once, under Ready to act, not again as owed', async () => {
  // The lawyer answers in the watched thread at 13:00 in Paris on Thursday; Ana's question came at the same time.
  const reply = at('2026-10-01T11:00:00Z');
  const me: FakeMailbox = {
    email: ME,
    messages: [
      message(reply, 'p1', 'tp', 2 * DAY, ME, COUNSEL, { subject: 'Punomocje' }),
      message(reply, 'p2', 'tp', 0, COUNSEL, ME, { subject: 'Re: Punomocje' }),
      // Ana answers the user's quote request.
      message(reply, 'a0', 'ta', 3 * DAY, ME, 'ana@translations.example', { subject: 'Devis' }),
      message(reply, 'a1', 'ta', 0, 'Ana <ana@translations.example>', ME, { subject: 'Devis' }),
    ],
  };
  const h = harness({ me }, at('2026-09-29T06:00:00Z'));
  h.ctx.followups.create({ account: 'me', title: 'Power of attorney', waiting_on: ['counsel@example.com'], watch_threads: [{ account: 'me', thread_id: 'tp' }] });
  h.settings.update({ enabled: true });
  h.setClock(at('2026-10-02T06:00:00Z')); // 08:00 in Paris on Friday
  assert.deepEqual(await h.scheduler.tick(), { status: 'delivered', alias: 'me', items: 2 });
  assert.deepEqual(h.inserts().map((i) => i.subject), ['Follow-ups — 1 ready, 1 waiting for you (Fri 2 Oct)']);
  assert.equal(h.settings.get().last_status, 'delivered 2 items');
  const text = h.texts()[0]!;
  assert.match(text, /Ready to act \(1\)\n- Power of attorney — from Ivan Kovačić: Re: Punomocje/);
  assert.match(text, /People waiting for your reply \(1\)\n- Devis — Ana · yesterday\n/);
  assert.equal(text.split(threadUrl(ME, 'tp')).length - 1, 1, 'the thread is linked once');
});

test('renderDigest: ages are calendar days in the digest\'s zone (yesterday afternoon is "yesterday" in a morning digest)', () => {
  const morning = at('2026-10-02T06:00:00Z'); // 08:00 in Paris
  const empty: FollowupReport = { generated_at: iso(morning), accounts: ['me'], counts: { ready: 0, handled: 0, overdue: 0, due: 0, owed: 0, drafts: 0, waiting: 0, batches: 0 }, tracked: [], owed: [], drafts: [], waiting: [], batches: [] };
  const report: FollowupReport = {
    ...empty,
    owed: [
      // 19 hours old: 0 elapsed days, but received yesterday at 13:00.
      owedRow(1, { received_at: '2026-10-01T11:00:00Z', days: 0 }),
      // 01:30 on Friday in Paris (still Thursday in UTC).
      owedRow(2, { received_at: '2026-10-01T23:30:00Z', days: 0 }),
      owedRow(3, { received_at: '2026-09-29T07:00:00Z', days: 2 }),
    ],
    drafts: [{ account: 'me', draft_id: 'r1', message_id: 'dm1', subject: 'Devis toiture', saved_at: '2026-10-01T13:00:00Z', days: 0, web_url: 'https://mail.google.com/mail/u/me@example.com/#drafts?compose=dm1' }],
  };
  const en = renderDigest(report, { ...RENDER, lang: 'en', now: morning }).text;
  assert.match(en, /- Question 1 — Person 1 · yesterday\n/);
  assert.match(en, /- Question 2 — Person 2 · today\n/);
  assert.match(en, /- Question 3 — Person 3 · 3 days\n/);
  assert.match(en, /- Devis toiture — no recipient · saved yesterday\n/);
  const fr = renderDigest(report, { ...RENDER, lang: 'fr', now: morning }).text;
  assert.match(fr, /- Question 1 — Person 1 · hier\n/);
  assert.match(fr, /- Question 2 — Person 2 · aujourd'hui\n/);
  assert.match(fr, /- Question 3 — Person 3 · 3 jours\n/);
  assert.match(fr, /enregistré hier/);
  // Read in UTC, the 23:30 message was yesterday.
  assert.match(renderDigest(report, { ...RENDER, lang: 'en', now: morning, timezone: 'UTC' }).text, /- Question 2 — Person 2 · yesterday\n/);
});

test('scheduler: each new digest archives the previous one, so at most one sits in the inbox', async () => {
  const h = harness({ me: busyMailbox(), partner: { email: PARTNER, messages: [] } }, at('2026-10-02T06:05:00Z'));
  h.settings.update({ enabled: true });
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.deepEqual(h.archived(), [], 'nothing before the first one');
  assert.deepEqual(h.settings.get().last_digest, { alias: 'me', message_id: 'ins1' });

  h.setClock(at('2026-10-03T06:05:00Z'));
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.deepEqual(h.archived(), ['me:ins1']);
  const modify = apiCalls(h.ctx).find((c) => MODIFY_RE.test(c.url.pathname))!;
  assert.deepEqual(modify.json, { removeLabelIds: ['INBOX'] }, 'archived, not deleted nor marked read');
  assert.deepEqual(h.settings.get().last_digest, { alias: 'me', message_id: 'ins2' });

  // Send now replaces it too; delivered elsewhere, the previous one is archived in its own account.
  h.settings.update({ deliver_to: 'partner' });
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  assert.deepEqual(h.archived(), ['me:ins1', 'me:ins2']);
  assert.deepEqual(h.settings.get().last_digest, { alias: 'partner', message_id: 'ins3' });

  // An archive that fails (or a digest already deleted) does not fail the delivery, and is logged by error name.
  h.failArchive({ status: 500, json: { error: { code: 500, message: 'backend' } } });
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  assert.deepEqual(h.settings.get().last_digest, { alias: 'partner', message_id: 'ins4' });
  assert.ok(h.lines.some((l) => l.includes('"msg":"followup digest: previous one not archived"') && l.includes('"error":"GoogleApiError"') && l.includes('"alias":"partner"')));
  h.failArchive({ status: 404, json: { error: { code: 404, message: 'Not Found' } } });
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  assert.equal(h.lines.filter((l) => l.includes('previous one not archived')).length, 1);
  assert.equal(h.inserts().length, 5);
});

test('scheduler: a time late in the evening missed between two ticks is caught up just after midnight', async () => {
  // Ticks every 5 minutes at :02, :07, ... in Paris: 23:57, then 00:02 the next day.
  const h = harness({ me: busyMailbox() }, at('2026-10-02T21:57:00Z'));
  h.settings.update({ enabled: true, time: '23:58' });
  assert.equal(await h.scheduler.tick(), undefined, '23:57');
  h.setClock(at('2026-10-02T22:02:00Z')); // 00:02 on Saturday
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.equal(h.settings.get().last_run_date, '2026-10-02', 'Friday\'s digest');
  h.setClock(at('2026-10-02T22:07:00Z'));
  assert.equal(await h.scheduler.tick(), undefined);
  h.setClock(at('2026-10-03T21:57:00Z'));
  assert.equal(await h.scheduler.tick(), undefined, 'Saturday 23:57');
  h.setClock(at('2026-10-03T22:02:00Z'));
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  assert.equal(h.settings.get().last_run_date, '2026-10-03');
  assert.equal(h.inserts().length, 2);

  // Long after the time (the server was down over midnight), the missed day is let go: the next digest covers it.
  h.setClock(at('2026-10-04T22:30:00Z')); // 00:30 on Monday
  assert.equal(await h.scheduler.tick(), undefined);
  assert.equal(h.inserts().length, 2);
});

test('dueDay: today once the time has passed, yesterday only for a few minutes after midnight', () => {
  const paris = (utc: string) => dueDay('08:00', 'Europe/Paris', at(utc));
  assert.equal(paris('2026-10-02T05:59:00Z'), undefined);
  assert.equal(paris('2026-10-02T06:00:00Z'), '2026-10-02');
  assert.equal(paris('2026-10-02T21:59:00Z'), '2026-10-02');
  assert.equal(paris('2026-10-02T22:00:00Z'), undefined, 'midnight in Paris, before 08:00');
  assert.equal(dueDay('00:00', 'Europe/Paris', at('2026-10-02T22:00:00Z')), '2026-10-03');
  assert.equal(dueDay('23:50', 'Europe/Paris', at('2026-10-02T22:05:00Z')), '2026-10-02', `within ${CATCH_UP_MINUTES} minutes`);
  assert.equal(dueDay('23:50', 'Europe/Paris', at('2026-10-02T22:06:00Z')), undefined);
  assert.equal(dueDay('23:59', 'Europe/Paris', at('2026-10-31T23:00:00Z')), '2026-10-31', 'across the end of a month');
});

test('scheduler: a missed evening digest whose retries are spent is not caught up after midnight', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T21:50:00Z'));
  h.settings.update({ enabled: true, time: '23:45' });
  h.failInsert({ status: 500, json: {} });
  for (let i = 0; i <= MAX_RETRIES; i++) assert.equal((await h.scheduler.tick())?.status, 'failed');
  h.failInsert(undefined);
  h.setClock(at('2026-10-02T21:55:00Z'));
  assert.equal(await h.scheduler.tick(), undefined);
  h.setClock(at('2026-10-02T22:00:00Z')); // 00:00 on Saturday, 15 minutes after the time
  assert.equal(await h.scheduler.tick(), undefined);
  assert.equal(h.inserts().length, MAX_RETRIES + 1);
});

test('scheduler: one run at a time; Send now during a run says so', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true });
  const first = h.scheduler.tick();
  assert.deepEqual(await h.scheduler.runNow(), { status: 'busy' });
  assert.equal(await h.scheduler.tick(), undefined);
  assert.equal((await first)?.status, 'delivered');
  assert.equal(h.inserts().length, 1);
});

test('scheduler: logs carry counts, aliases and error names, nothing from the mail', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T06:30:00Z'));
  h.settings.update({ enabled: true });
  await h.scheduler.tick();
  h.failInsert({ status: 500, json: { error: { code: 500, message: 'backend error for me@example.com' } } });
  await h.scheduler.runNow();
  assert.ok(h.lines.some((l) => l.includes('"msg":"followup digest delivered"') && l.includes('"items":1') && l.includes('"alias":"me"')));
  assert.ok(h.lines.some((l) => l.includes('"msg":"followup digest failed"') && l.includes('"error":"GoogleApiError"')));
  for (const l of h.lines) assert.doesNotMatch(l, /@|Kovač|img|onerror|Secret|Follow-ups —/i);
});

test('a digest with only items still awaited is a reminder of them, not "all clear"', () => {
  const report: FollowupReport = {
    generated_at: iso(NOW),
    accounts: ['me'],
    counts: { ready: 0, handled: 0, overdue: 0, due: 0, owed: 0, drafts: 0, waiting: 0, batches: 0 },
    tracked: [tracked({ title: "Power of attorney from Kovačić", waiting_on: ['counsel@example.com'], next_step: 'send it to the translators who quoted' })],
    owed: [],
    drafts: [],
    waiting: [],
    batches: [],
  } as FollowupReport;
  const en = renderDigest(report, { lang: 'en', ...RENDER });
  assert.equal(en.subject, 'Follow-ups — 1 still awaited (Fri 2 Oct)');
  assert.match(en.text, /Still waiting on \(1\)\n- Power of attorney from Kovačić — from counsel@example\.com · for 3 days\n {2}Next: send it to the translators who quoted/);
  const fr = renderDigest(report, { lang: 'fr', ...RENDER });
  assert.match(fr.subject, /^Suivi — 1 en attente \(/);
  assert.match(fr.text, /En attente de \(1\)\n- Power of attorney from Kovačić — de counsel@example\.com · depuis 3 jours/);
});

test('renderDigest: mail from an awaited person that did not count is pointed out on the item, linked', () => {
  const other = { account: 'me', thread_id: 'tinfo', message_id: 'mi', from: COUNSEL, subject: 'Infostan', date: iso(NOW - DAY), web_url: threadUrl(ME, 'tinfo') };
  const report = {
    generated_at: iso(NOW),
    accounts: ['me'],
    counts: { ready: 0, handled: 0, overdue: 0, due: 0, owed: 0, drafts: 0, waiting: 0, batches: 0 },
    tracked: [
      tracked({ id: 'fu_a', title: 'Procuration', waiting_on: ['counsel@example.com'], expects_attachment: true, other_mail: { ...other, reason: 'no_attachment' } }),
      tracked({ id: 'fu_b', title: 'Porte', next_step: 'relancer le syndic', other_mail: { ...other, reason: 'other_conversation' } }),
    ],
    owed: [],
    drafts: [],
    waiting: [],
    batches: [],
  } as FollowupReport;
  const en = renderDigest(report, { lang: 'en', ...RENDER });
  assert.match(en.text, /- Procuration — from counsel@example\.com · for 3 days\n {2}new mail from Ivan Kovačić, without the document: worth a look\n/);
  assert.match(en.text, /- Porte — for 3 days\n {2}new mail in another conversation from Ivan Kovačić: worth a look — Next: relancer le syndic/);
  assert.equal(en.html.split(threadUrl(ME, 'tinfo')).length - 1, 2, 'each item links the mail to look at');
  const fr = renderDigest(report, { lang: 'fr', ...RENDER });
  assert.match(fr.text, /nouveau message de Ivan Kovačić, sans le document : à regarder/);
});

test('scheduler: weekly runs only on its weekday, at its time', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T07:05:00Z')); // Friday 09:05 in Paris
  h.settings.update({ enabled: true, frequency: 'weekly', weekday: 'monday', time: '09:00' });
  assert.equal(await h.scheduler.tick(), undefined, 'not on a Friday');
  h.setClock(at('2026-10-05T06:55:00Z')); // Monday 08:55
  assert.equal(await h.scheduler.tick(), undefined, 'not before the time');
  h.setClock(at('2026-10-05T07:01:00Z'));
  assert.equal((await h.scheduler.tick())?.status, 'delivered');
  h.setClock(at('2026-10-06T07:01:00Z'));
  assert.equal(await h.scheduler.tick(), undefined, 'not on the Tuesday');
  assert.equal(weekdayOf('2026-10-05'), 'monday');
  assert.equal(weekdayOf('2026-10-11'), 'sunday');
  assert.throws(() => h.settings.update({ weekday: 'lundi' }), DigestSettingsError);
});

test('scheduler: Send now after the time on a digest day stands in for that day\'s digest: no second one minutes later', async () => {
  const h = harness({ me: busyMailbox() }, at('2026-10-02T19:25:00Z'));
  h.settings.update({ enabled: true, time: '09:00' });
  assert.equal((await h.scheduler.runNow()).status, 'delivered');
  h.setClock(at('2026-10-02T19:29:00Z'));
  assert.equal(await h.scheduler.tick(), undefined);
  assert.equal(h.inserts().length, 1);
});

test('renderDigest: handled items apart, a mail merge left unsent as one line, superseded drafts summed up', () => {
  const draft = (i: number, over: Partial<DraftRow> = {}): DraftRow => ({ account: 'me', draft_id: `r${i}`, message_id: `d${i}`, thread_id: `d${i}`, to: `T${i} <t${i}@example.fr>`, subject: 'Demande de devis', saved_at: iso(NOW - 3 * DAY), days: 3, web_url: `https://mail.google.com/mail/u/me@example.com/#drafts?compose=d${i}`, ...over });
  const report = {
    generated_at: iso(NOW),
    accounts: ['me'],
    counts: { ready: 1, handled: 1, overdue: 0, due: 0, owed: 0, drafts: 6, waiting: 0, batches: 0 },
    tracked: [
      tracked({ id: 'fu_a', title: 'Door code', status: 'ready', arrived: { account: 'me', thread_id: 't', message_id: 'm', from: 'DURAND Paul <gestion@syndic-valmont.example>', date: iso(NOW - 5 * DAY), web_url: threadUrl(ME, 't') }, handled: true }),
      tracked({ id: 'fu_b', title: 'Procuration', status: 'ready', arrived: { account: 'me', thread_id: 't2', message_id: 'm2', from: COUNSEL, date: iso(NOW - DAY), web_url: threadUrl(ME, 't2') } }),
    ],
    owed: [],
    drafts: [
      draft(1),
      draft(2),
      draft(3),
      draft(4, { subject: 'Seul' }),
      draft(5, { subject: 'Re: Vieux', superseded: true, thread_id: 'tv' }),
      draft(6, { subject: 'Re: Autre', superseded: true, thread_id: 'ta' }),
      // Two replies with one subject in different conversations stay two lines.
      draft(7, { subject: 'Re: Devis', thread_id: 't7' }),
      draft(8, { subject: 'Re: Devis', thread_id: 't8' }),
    ],
    waiting: [],
    batches: [],
  } as FollowupReport;
  const d = renderDigest(report, { lang: 'en', ...RENDER });
  assert.match(d.subject, /^Follow-ups — 1 ready, 8 unsent drafts \(/);
  assert.match(d.text, /Ready to act \(1\)\n- Procuration/);
  assert.equal(d.text.split('- Re: Devis — to').length - 1, 2);
  assert.match(d.text, /Unsent drafts \(8\)\n- Demande de devis — 3 drafts, to T1, T2, T3 · saved 3 days ago\n/);
  assert.match(d.text, /- 2 drafts in threads you already answered — Re: Vieux · Re: Autre\n {2}Probably leftovers: delete them\./);
  assert.match(d.text, /Probably done: close them \(1\)\n- Door code — you wrote back to DURAND Paul since: close it if it is done/);
});
