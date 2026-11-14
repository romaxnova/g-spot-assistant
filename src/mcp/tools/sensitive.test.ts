import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { openDatabase } from '../../db.js';
import { createLogger } from '../../log.js';
import { SensitiveContactsStore } from '../../contacts/sensitive-store.js';
import { apiCalls, createTestContext, resultJson, resultText, TEST_KEY, type RecordedCall, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { gmailTools } from './gmail.js';
import { builtInCategory, classify, sensitiveContactsTool, toneMarkers, wordCount } from './sensitive.js';

const BASE = '/gmail/v1/users/me';
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const tool = (name: string) => gmailTools.find((t) => t.name === name)!;
const call = (ctx: TestContext, name: string, args: Record<string, unknown>): Promise<CallToolResult> => runTool(tool(name), { account: 'me', ...args }, ctx);
const path = (c: RecordedCall) => c.url.pathname.replace(BASE, '');

test('built-in categories are recognised from the address', () => {
  const cases: [string, string | undefined][] = [
    ['contact@hdjvalmont.example', 'bailiff'],
    ['secretariat@huissiers-valmont.example', 'bailiff'],
    ['etude@commissaire-justice.example', 'bailiff'],
    ['valmont@huissier-justice.example', 'bailiff'],
    ['contact@martin-avocats.example', 'lawyer'],
    ['Claire.petit@legalvalmont.example', 'lawyer'],
    ['claire.martin@valmont.notaires.fr', 'notary'],
    ['greffe.tj-valmont@justice.fr', 'court'],
    ['courrier@valmont.gouv.fr', 'administration'],
    ['etat-civil@mairie-valmont.fr', 'administration'],
    ['claims@axa.example', 'insurer'],
    ['sinistres.habitation@mutuelle-valmont.example', 'insurer'],
    ['expertise@eurexo-ced.example', 'insurer'],
    ['gestion@syndic-valmont.example', 'property_manager'],
    ['agence@foncia.example', 'property_manager'],
    ['ann@example.com', undefined],
    ['nina.friend@yahoo.fr', undefined],
    ['legalbeagle@gmail.com', undefined],
  ];
  for (const [address, category] of cases) assert.equal(builtInCategory(address), category, address);
});

test('classify: the owner\'s list and open follow-ups count; exemptions and linked accounts never do', () => {
  const ctx = createTestContext({ accounts: [{ alias: 'me', email: 'me@example.com' }, { alias: 'office', email: 'contact@avocats-lambert.example' }] });
  ctx.sensitive!.mark(['yann@yann-expert.example'], 'lawyer for the water damage');
  ctx.sensitive!.mark(['@cabinet-x.fr']);
  ctx.sensitive!.exempt(['ami@notaires.fr']);
  ctx.followups.create({ account: 'me', title: 'Quote', waiting_on: ['translator@example.com'] });
  assert.deepEqual(classify(ctx, 'Yann@Yann-Expert.example'), { address: 'yann@yann-expert.example', category: 'marked', why: 'marked sensitive by the user', note: 'lawyer for the water damage' });
  assert.equal(classify(ctx, 'jean@cabinet-x.fr')?.category, 'marked', 'a whole domain');
  assert.equal(classify(ctx, 'jean@sub.cabinet-x.fr')?.category, 'marked', 'and its subdomains');
  assert.equal(classify(ctx, 'ami@notaires.fr'), undefined, 'exempted');
  assert.equal(classify(ctx, 'contact@avocats-lambert.example'), undefined, 'a linked account');
  assert.equal(classify(ctx, 'translator@example.com')?.category, 'tracked');
  assert.equal(classify(ctx, 'ann@example.com'), undefined);
});

test('the owner\'s list is encrypted at rest and opened with the previous key after a rotation', () => {
  const db = openDatabase(':memory:');
  const store = new SensitiveContactsStore(db, [TEST_KEY]);
  store.mark(['secret.lawyer@example.org'], 'Secret note');
  const raw = Buffer.from((db.prepare('SELECT data_enc FROM sensitive_contacts').get() as { data_enc: Uint8Array }).data_enc).toString('latin1');
  assert.doesNotMatch(raw, /secret|lawyer|example/i);
  const rotated = new SensitiveContactsStore(db, [Buffer.alloc(32, 9), TEST_KEY]);
  assert.equal(rotated.get().marked[0]?.entry, 'secret.lawyer@example.org');
  const lost = new SensitiveContactsStore(openDatabase(':memory:'), [TEST_KEY]);
  assert.throws(() => lost.mark(['not an address']), /neither an email address nor a domain/);
});

test('tone markers, length and word counts', () => {
  const text = "Vous indiquez ne pas souhaiter d'échanges inutiles. Ils le seraient bien moins si votre étude transmettait les documents dus, plutôt que de m'obliger à réitérer chaque demande à plusieurs reprises. Merci de me les faire parvenir sans délai.";
  assert.deepEqual(toneMarkers('Dossier', text), ['sans délai', 'à plusieurs reprises', 'Ils le seraient bien moins']);
  assert.deepEqual(toneMarkers('URGENT – Dossier', 'Bonjour, merci !!'), ['URGENT in the subject', 'several exclamation marks']);
  assert.deepEqual(toneMarkers('Re: devis', 'Bonjour Maître, pourriez-vous me dire où en est le dossier ? Merci.'), []);
  assert.equal(wordCount("Bonjour Maître, l'acte est joint."), 5);
});

/** A fake Gmail: sends and drafts succeed; the account wrote to the bailiff twice this week, he never answered. */
function gmail(sentBefore: number[] = [NOW - 2 * DAY, NOW - DAY]) {
  return createTestContext({
    google: (c) => {
      const p = path(c);
      if (p === '/messages/send') return { json: { id: 'sent-1', threadId: 't1', labelIds: ['SENT'] } };
      if (p === '/drafts' && c.method === 'POST') return { json: { id: 'r-1', message: { id: 'dm-1', threadId: 't9' } } };
      if (p === '/messages' && c.method === 'GET') {
        const q = c.url.searchParams.get('q') ?? '';
        if (q.startsWith('in:sent')) return { json: { messages: sentBefore.map((_, i) => ({ id: `s${i}` })) } };
        return { json: { messages: [] } };
      }
      const m = /^\/messages\/s(\d+)$/.exec(p);
      if (m) return { json: { id: `s${m[1]}`, internalDate: String(sentBefore[Number(m[1])]) } };
      return undefined;
    },
  });
}

test('gmail_send to a bailiff is not sent: it is saved as a draft and the review says why, with cadence, length and tone', async () => {
  const ctx = gmail();
  const lines: string[] = [];
  ctx.log = createLogger('debug', {}, (l) => lines.push(l));
  const long = Array.from({ length: 200 }, () => 'mot').join(' ');
  const res = await call(ctx, 'gmail_send', { to: ['Maître B <contact@hdjvalmont.example>'], subject: 'Dossier EX2026000.00', body_text: `Maître, merci de transmettre sans délai les pièces. ${long}` });
  const out = resultJson<{ sent: boolean; saved_as_draft: boolean; draft_id: string; note: string; review: { sensitive: { category: string }[]; cadence: { sent_last_7_days: number; unanswered_in_a_row: number }[]; words: number; flags: string[]; ask: string } }>(res);
  assert.equal(res.isError, undefined);
  assert.deepEqual([out.sent, out.saved_as_draft, out.draft_id], [false, true, 'r-1']);
  assert.match(out.note, /Not sent: contact@hdjvalmont\.example is a sensitive contact/);
  assert.equal(out.review.sensitive[0]!.category, 'bailiff');
  assert.deepEqual([out.review.cadence[0]!.sent_last_7_days, out.review.cadence[0]!.unanswered_in_a_row], [2, 2]);
  assert.ok(out.review.words > 180);
  assert.equal(out.review.flags.length, 3);
  assert.match(out.review.flags[0]!, /^long: .*put long emails aside/);
  assert.match(out.review.flags[1]!, /^frequent: .*disengage/);
  assert.match(out.review.flags[2]!, /^tone: "sans délai"/);
  assert.match(out.review.ask, /reviewed_by_user: true.*Never from a scheduled task/);
  assert.ok(!apiCalls(ctx).some((c) => path(c) === '/messages/send'), 'nothing sent');
  for (const l of lines) assert.doesNotMatch(l, /@|hdjvalmont|délai/);
  assert.ok(lines.some((l) => l.includes('"msg":"send held for review"') && l.includes('"categories":"bailiff"')));
});

test('gmail_send to ordinary recipients goes out as before', async () => {
  const ctx = gmail();
  const out = resultJson<{ id: string }>(await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'b' }));
  assert.equal(out.id, 'sent-1');
});

test('gmail_send_draft to a sensitive contact needs reviewed_by_user; a batch sends nothing until then', async () => {
  const draft = (id: string, to: string) => ({
    id,
    message: { id: `m-${id}`, threadId: `t-${id}`, payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: to }, { name: 'Subject', value: 'Dossier' }], body: { data: Buffer.from('Maître, voici les pièces.').toString('base64url') } } },
  });
  const ctx = createTestContext({
    google: (c) => {
      const p = path(c);
      if (p === '/drafts/r1') return { json: draft('r1', 'ann@example.com') };
      if (p === '/drafts/r2') return { json: draft('r2', 'Me X <contact@martin-avocats.example>') };
      if (p === '/drafts/send') return { json: { id: 'sent', threadId: 't' } };
      if (p === '/messages') return { json: { messages: [] } };
      return undefined;
    },
  });
  const held = resultJson<{ sent: number; note: string; reviews: { draft_id: string; review: { sensitive: { category: string }[]; words: number; review_token: string } }[] }>(
    await call(ctx, 'gmail_send_draft', { draft_ids: ['r1', 'r2'] }),
  );
  assert.equal(held.sent, 0);
  assert.match(held.note, /1 of these drafts go to sensitive contacts/);
  assert.deepEqual(held.reviews.map((r) => [r.draft_id, r.review.sensitive[0]!.category, r.review.words]), [['r2', 'lawyer', 4]]);
  const token = held.reviews[0]!.review.review_token;
  assert.match(token, /^rv_[\w-]{22}$/);
  // A bare "reviewed" is not enough: the review of this exact version must have been produced.
  const bare = resultJson<{ sent: number }>(await call(ctx, 'gmail_send_draft', { draft_ids: ['r1', 'r2'], reviewed_by_user: true }));
  assert.equal(bare.sent, 0);
  const wrong = resultJson<{ sent: number }>(await call(ctx, 'gmail_send_draft', { draft_ids: ['r1', 'r2'], reviewed_by_user: true, review_tokens: ['rv_xxxxxxxxxxxxxxxxxxxxxx'] }));
  assert.equal(wrong.sent, 0);
  assert.ok(!apiCalls(ctx).some((c) => path(c) === '/drafts/send'));
  const tokenOnly = resultJson<{ sent: number }>(await call(ctx, 'gmail_send_draft', { draft_ids: ['r1', 'r2'], review_tokens: [token] }));
  assert.equal(tokenOnly.sent, 0, 'and the token alone is not the user\'s confirmation');
  const sent = resultJson<{ sent: number }>(await call(ctx, 'gmail_send_draft', { draft_ids: ['r1', 'r2'], reviewed_by_user: true, review_tokens: [token] }));
  assert.equal(sent.sent, 2);
});

test('gmail_create_draft to a sensitive contact carries the review; to anyone else, none', async () => {
  const ctx = gmail([]);
  const out = resultJson<{ draft_id: string; review?: { sensitive: { address: string }[] } }>(await call(ctx, 'gmail_create_draft', { to: ['gestion@syndic-valmont.example'], subject: 'Porte', body_text: 'Bonjour' }));
  assert.equal(out.review?.sensitive[0]!.address, 'gestion@syndic-valmont.example');
  const plain = resultJson<{ review?: unknown }>(await call(ctx, 'gmail_create_draft', { to: ['ann@example.com'], subject: 'x', body_text: 'y' }));
  assert.equal(plain.review, undefined);
});

test('sensitive_contacts marks, exempts, forgets and checks; bad entries are refused', async () => {
  const ctx = gmail([]);
  const run = (args: Record<string, unknown>) => runTool(sensitiveContactsTool, args, ctx);
  const marked = resultJson<{ marked: { entry: string; note?: string }[] }>(await run({ mark: ['Yann <Contact@Yann-Expert.example>', 'cabinet-x.fr'], note: 'water damage' }));
  assert.deepEqual(marked.marked, [{ entry: 'contact@yann-expert.example', note: 'water damage' }, { entry: '@cabinet-x.fr', note: 'water damage' }]);
  const checked = resultJson<{ checked: { address: string; sensitive: boolean; category?: string }[] }>(await run({ check: ['contact@yann-expert.example', 'etude@commissaire-justice.example', 'ann@example.com'] }));
  assert.deepEqual(checked.checked.map((c) => [c.address, c.sensitive, c.category]), [['contact@yann-expert.example', true, 'marked'], ['etude@commissaire-justice.example', true, 'bailiff'], ['ann@example.com', false, undefined]]);
  const exempt = resultJson<{ marked: unknown[]; exempt: string[] }>(await run({ exempt: ['contact@yann-expert.example'] }));
  assert.deepEqual([exempt.marked.length, exempt.exempt], [1, ['contact@yann-expert.example']]);
  const forgot = resultJson<{ marked?: unknown[]; exempt?: string[] }>(await run({ forget: ['contact@yann-expert.example', '@cabinet-x.fr'] }));
  assert.deepEqual([forgot.marked ?? [], forgot.exempt ?? []], [[], []]);
  assert.match(resultText(await run({ mark: ['nope'] })), /neither an email address nor a domain/);
});

test('a list of sensitive contacts that cannot be read fails closed: every outside recipient is reviewed', async () => {
  const ctx = gmail([]);
  ctx.sensitive!.mark(['friend@gmail.com']);
  // The blob no longer decrypts (a damaged row, or a key rotation without the previous key).
  ctx.db.prepare('UPDATE sensitive_contacts SET data_enc = ?').run(Buffer.from([1, 0, 0, 0, 0, ...Array(40).fill(7)]));
  const out = resultJson<{ sent: boolean; review: { sensitive: { address: string; why: string }[] } }>(await call(ctx, 'gmail_send', { to: ['ann@example.com'], subject: 's', body_text: 'b' }));
  assert.equal(out.sent, false);
  assert.match(out.review.sensitive[0]!.why, /cannot be read/);
  assert.throws(() => ctx.sensitive!.mark(['x@example.com']), /cannot be opened/);
});

test('Drive sharing and Calendar invitations that would email a sensitive contact wait for the review', async () => {
  const { driveTools } = await import('./drive.js');
  const { calendarTools } = await import('./calendar.js');
  const share = driveTools.find((t) => t.name === 'drive_share')!;
  const create = calendarTools.find((t) => t.name === 'calendar_create_event')!;
  const ctx = createTestContext({
    google: (c) => {
      if (c.url.pathname.endsWith('/permissions')) return { json: { id: 'p1', type: 'user', role: 'reader', emailAddress: 'contact@hdjvalmont.example' } };
      if (c.url.pathname.startsWith('/drive/v3/files/')) return { json: { name: 'PV', webViewLink: 'https://drive' } };
      if (c.url.pathname.includes('/calendar/v3/calendars/')) return { json: { id: 'e1', summary: 'RDV' } };
      return undefined;
    },
  });
  const held = await runTool(share, { account: 'me', file_id: 'f1', email_address: 'contact@hdjvalmont.example', message: 'Voici le PV' }, ctx);
  assert.equal(held.isError, true);
  assert.match(resultText(held), /Not done: Google's sharing notification \(with your message\) would email contact@hdjvalmont\.example \(a bailiff/);
  assert.equal((await runTool(share, { account: 'me', file_id: 'f1', email_address: 'contact@hdjvalmont.example', notify: false }, ctx)).isError, undefined, 'no email: no review');
  assert.equal((await runTool(share, { account: 'me', file_id: 'f1', email_address: 'contact@hdjvalmont.example', reviewed_by_user: true }, ctx)).isError, undefined);
  const invite = await runTool(create, { account: 'me', summary: 'RDV', start: '2026-11-02T10:00', attendees: ['gestion@syndic-valmont.example'], send_updates: 'all' }, ctx);
  assert.match(resultText(invite), /Google's invitation would email gestion@syndic-valmont\.example/);
  assert.equal((await runTool(create, { account: 'me', summary: 'RDV', start: '2026-11-02T10:00', attendees: ['gestion@syndic-valmont.example'] }, ctx)).isError, undefined, 'send_updates none: nobody is emailed');
});
