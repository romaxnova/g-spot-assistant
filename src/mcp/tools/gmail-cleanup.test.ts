import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../server.js';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall } from '../../test-support.js';
import { cleanupToken, emailAddress, gmailCleanup, gmailUnsubscribe, isPrivateAddress, protectedQuery, publicHttpsUrl, readToken, unsubscribeDeps, unsubscribeKind } from './gmail-cleanup.js';

const MESSAGES: Record<string, { threadId: string; from: string; subject: string; date: number; unsub?: string; post?: string }> = {
  m1: { threadId: 't1', from: 'Zara <news@zara.com>', subject: '-50% this weekend', date: Date.UTC(2023, 0, 5), unsub: '<https://unsub.zara.com/x?id=1>, <mailto:unsub@zara.com>', post: 'List-Unsubscribe=One-Click' },
  m2: { threadId: 't2', from: 'Zara <news@zara.com>', subject: 'New arrivals', date: Date.UTC(2024, 5, 1), unsub: '<https://unsub.zara.com/x?id=1>', post: 'List-Unsubscribe=One-Click' },
  m3: { threadId: 't3', from: 'DGFiP <newsletter@impots.gouv.fr>', subject: 'Votre avis', date: Date.UTC(2024, 6, 1) },
  m4: { threadId: 't-replied', from: 'Shop <hello@shop.com>', subject: 'Re: my order', date: Date.UTC(2024, 7, 1), unsub: '<mailto:leave@shop.com?subject=stop>' },
};

function gmail(calls: { q: string[] }) {
  return (c: RecordedCall) => {
    const p = c.url.pathname;
    if (p.endsWith('/messages') && c.method === 'GET') {
      const q = c.url.searchParams.get('q') ?? '';
      calls.q.push(q);
      if (q === 'in:sent') return { json: { messages: [{ id: 's1', threadId: 't-replied' }] } };
      if (q.startsWith('from:')) {
        const addr = q.slice(5);
        const hit = Object.entries(MESSAGES).find(([, m]) => emailAddress(m.from) === addr);
        return { json: hit ? { messages: [{ id: hit[0], threadId: hit[1].threadId }] } : {} };
      }
      const ids = Object.entries(MESSAGES)
        .filter(([, m]) => !q.includes(`-from:${emailAddress(m.from)}`))
        .map(([id, m]) => ({ id, threadId: m.threadId }));
      return { json: { messages: ids } };
    }
    const one = /\/messages\/(m\d)$/.exec(p);
    if (one && c.method === 'GET') {
      const m = MESSAGES[one[1]!]!;
      const headers = [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, ...(m.unsub ? [{ name: 'List-Unsubscribe', value: m.unsub }] : []), ...(m.post ? [{ name: 'List-Unsubscribe-Post', value: m.post }] : [])];
      return { json: { id: one[1], internalDate: String(m.date), payload: { headers } } };
    }
    if (p.endsWith('/messages/batchModify')) return { json: {} };
    if (p.endsWith('/messages/send')) return { json: { id: 'sent-1' } };
    return undefined;
  };
}

test('protected query: starred, important, sent, receipts and excluded senders are always left out', () => {
  const q = protectedQuery('category:promotions older_than:30d', true, ['a@b.com']);
  assert.match(q, /^\(category:promotions older_than:30d\) -is:starred -is:important -in:sent/);
  assert.match(q, /-has:attachment -\{invoice receipt .*facture.*счет/);
  assert.match(q, /-from:a@b\.com$/);
  assert.doesNotMatch(protectedQuery('x', false), /has:attachment/);
});

test('cleanup: a preview changes nothing; the confirmed run bins the same messages in one batch', async () => {
  const seen = { q: [] as string[] };
  const ctx = createTestContext({ google: gmail(seen) });
  const prev = await runTool(gmailCleanup, { account: 'me', query: 'category:promotions older_than:30d' }, ctx);
  assert.equal(prev.isError, undefined, resultText(prev));
  const p = resultJson<{ preview: boolean; will_move_to_bin: number; top_senders: { address: string; about: number; unsubscribe?: string }[]; left_alone: string[]; confirm_token: string; from_date: string }>(prev);
  // m3 is from an administration (sensitive): left out and its sender excluded; m4 is in a thread the user replied in.
  assert.equal(p.will_move_to_bin, 2);
  assert.deepEqual(p.top_senders.map((s) => [s.address, s.unsubscribe]), [['news@zara.com', 'one-click']]);
  assert.ok(p.left_alone.some((l) => /replied/.test(l)));
  assert.ok(p.left_alone.some((l) => /impots\.gouv\.fr/.test(l)));
  assert.equal(p.from_date, '2023-01-05');
  assert.ok(!apiCalls(ctx).some((c) => c.method === 'POST'), 'the preview changes nothing');

  const wrong = await runTool(gmailCleanup, { account: 'me', query: 'category:social', confirm_token: p.confirm_token }, ctx);
  assert.equal(wrong.isError, true);

  const done = await runTool(gmailCleanup, { account: 'me', query: 'category:promotions older_than:30d', confirm_token: p.confirm_token }, ctx);
  assert.equal(resultJson<{ moved_to_bin: number }>(done).moved_to_bin, 2);
  const batch = apiCalls(ctx).filter((c) => c.url.pathname.endsWith('/batchModify'));
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0]!.json, { ids: ['m1', 'm2'], addLabelIds: ['TRASH'] });
});

test('cleanup tokens: signed, bound to their inputs, and valid one hour', () => {
  const ctx = createTestContext();
  const body = { a: 'me', q: 'x', r: true, n: 3, x: [], t: Date.now() };
  const token = cleanupToken(ctx, body);
  assert.deepEqual(readToken(ctx, token), body);
  assert.throws(() => readToken(ctx, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), /not valid/);
  assert.throws(() => readToken(ctx, token, Date.now() + 61 * 60_000), /more than an hour/);
});

test('unsubscribe: one-click by POST to a public host, email by sending from the account, a web link handed back', async () => {
  const ctx = createTestContext({ google: gmail({ q: [] }) });
  const posted: { url: string; body: unknown }[] = [];
  const saved = { ...unsubscribeDeps };
  unsubscribeDeps.resolve = async (h) => (h === 'unsub.zara.com' ? ['93.184.216.34'] : ['10.0.0.5']);
  unsubscribeDeps.fetch = async (url, init) => (posted.push({ url: String(url), body: init?.body }), new Response('', { status: 200 }));
  try {
    const one = resultJson<{ unsubscribed: boolean; method: string }>(await runTool(gmailUnsubscribe, { account: 'me', sender: 'Zara <news@zara.com>' }, ctx));
    assert.deepEqual(one, { sender: 'news@zara.com', unsubscribed: true, method: 'one-click', note: 'Senders may take a few days to stop.' });
    assert.deepEqual(posted, [{ url: 'https://unsub.zara.com/x?id=1', body: 'List-Unsubscribe=One-Click' }]);

    const mail = resultJson<{ method: string; sent_to: string }>(await runTool(gmailUnsubscribe, { account: 'me', sender: 'hello@shop.com' }, ctx));
    assert.equal(mail.sent_to, 'leave@shop.com');
    const sent = apiCalls(ctx).find((c) => c.url.pathname.endsWith('/messages/send'))!;
    assert.match(Buffer.from((sent.json as { raw: string }).raw, 'base64url').toString(), /^To: leave@shop\.com\r\nSubject: stop\r\n/);

    assert.match(resultText(await runTool(gmailUnsubscribe, { account: 'me', sender: 'newsletter@impots.gouv.fr' }, ctx)), /no unsubscribe link/);
  } finally {
    Object.assign(unsubscribeDeps, saved);
  }
});

test('unsubscribe links: only public https hosts are followed', async () => {
  assert.equal(unsubscribeKind('<https://a.com/u>', 'List-Unsubscribe=One-Click'), 'one-click');
  assert.equal(unsubscribeKind('<https://a.com/u>, <mailto:u@a.com>', undefined), 'email');
  assert.equal(unsubscribeKind('<https://a.com/u>', undefined), 'link');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress('93.184.216.34'));
  await assert.rejects(publicHttpsUrl('http://a.com/u', async () => ['93.184.216.34']), /https/);
  await assert.rejects(publicHttpsUrl('https://internal.example/u', async () => ['10.0.0.5']), /private/);
  await assert.rejects(publicHttpsUrl('https://169.254.169.254/latest'), /private/);
  assert.equal((await publicHttpsUrl('https://a.com/u', async () => ['93.184.216.34'])).host, 'a.com');
});
