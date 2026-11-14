import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, GoogleApiError, buildUrl } from './client.js';
import { GOOGLE_TOKEN_URL } from './oauth.js';
import { createTestContext, apiCalls } from '../test-support.js';

test('buildUrl resolves relative paths and encodes query values', () => {
  const u = buildUrl('gmail', { url: '/messages', query: { q: 'from:a b', maxResults: 5, skip: undefined, labelIds: ['A', 'B'] } });
  assert.equal(u, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Aa+b&maxResults=5&labelIds=A&labelIds=B');
  assert.equal(buildUrl('drive', { url: 'https://www.googleapis.com/upload/drive/v3/files' }), 'https://www.googleapis.com/upload/drive/v3/files');
});

test('routes calls with a bearer token, caches it, and touches the account', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: { ok: true, path: c.url.pathname } }) });
  const r1 = await ctx.google.request<{ path: string }>('me', 'gmail', { url: '/labels' });
  const r2 = await ctx.google.request<{ path: string }>('me', 'gmail', { url: '/labels' });
  assert.equal(r1.path, '/gmail/v1/users/me/labels');
  assert.equal(r2.path, '/gmail/v1/users/me/labels');
  const refreshes = ctx.calls.filter((c) => c.url.href === GOOGLE_TOKEN_URL);
  assert.equal(refreshes.length, 1, 'access token cached between calls');
  assert.match(refreshes[0]!.body!, /grant_type=refresh_token/);
  assert.match(refreshes[0]!.body!, /refresh_token=refresh-me/);
  assert.equal(apiCalls(ctx)[0]!.headers['authorization'], 'Bearer test-access-token');
  assert.ok(ctx.accounts.get('me')!.lastUsedAt);
});

test('unknown alias, wrong service and needs_relink give actionable AccountErrors', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'work', services: ['gmail'] }, { alias: 'broken', services: ['gmail'], status: 'needs_relink' }] });
  await assert.rejects(ctx.google.request('nope', 'gmail', { url: '/x' }), (e: Error) => e instanceof AccountError && /Unknown account alias "nope"/.test(e.message) && /work/.test(e.message));
  await assert.rejects(ctx.google.request('work', 'drive', { url: '/x' }), (e: Error) => e instanceof AccountError && /was not granted Google Drive/.test(e.message) && /connector.test\/admin/.test(e.message));
  await assert.rejects(ctx.google.request('broken', 'gmail', { url: '/x' }), (e: Error) => e instanceof AccountError && /needs to be re-linked/.test(e.message));
  assert.equal(apiCalls(ctx).length, 0);
});

test('a 401 triggers one refresh and retry; a second 401 marks the account for re-link', async () => {
  let n = 0;
  const ctx = createTestContext({ google: () => (++n <= 2 ? { status: 401, json: { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } } : { json: { ok: 1 } }) });
  await assert.rejects(ctx.google.request('me', 'gmail', { url: '/x' }), (e: Error) => e instanceof AccountError && /keeps rejecting/.test(e.message));
  assert.equal(ctx.accounts.get('me')!.status, 'needs_relink');
  assert.equal(ctx.calls.filter((c) => c.url.href === GOOGLE_TOKEN_URL).length, 2);
});

test('invalid_grant on refresh marks the account and explains why', async () => {
  const ctx = createTestContext({ google: () => ({ json: {} }) });
  // Replace the token endpoint answer by making the account's refresh token unusable: fake fetch always succeeds,
  // so exercise the path through a client whose fetch rejects the refresh.
  const { GoogleClient } = await import('./client.js');
  const { GoogleAuth } = await import('./oauth.js');
  const { silentLogger } = await import('../log.js');
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const auth = new GoogleAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }, fetchImpl);
  const client = new GoogleClient(ctx.accounts, auth, silentLogger, { adminUrl: 'https://connector.test/admin', fetchImpl });
  await assert.rejects(client.request('me', 'gmail', { url: '/x' }), (e: Error) => e instanceof AccountError && /refresh token revoked or expired/.test(e.message) && /Testing/.test(e.message));
  assert.equal(ctx.accounts.get('me')!.status, 'needs_relink');
});

test('scope-insufficient and API-disabled 403s are explained; other errors carry Google’s message; 5xx retried', async () => {
  const ctx1 = createTestContext({ google: () => ({ status: 403, json: { error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } }) });
  await assert.rejects(ctx1.google.request('me', 'drive', { url: '/files' }), (e: Error) => e instanceof AccountError && /lacks permission/.test(e.message));
  const ctx2 = createTestContext({ google: () => ({ status: 403, json: { error: { message: 'Gmail API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } } }) });
  await assert.rejects(ctx2.google.request('me', 'gmail', { url: '/x' }), (e: Error) => e instanceof AccountError && /not enabled in the Google Cloud project/.test(e.message));
  const ctx3 = createTestContext({ google: () => ({ status: 404, json: { error: { message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] } } }) });
  await assert.rejects(ctx3.google.request('me', 'gmail', { url: '/messages/x' }), (e: Error) => e instanceof GoogleApiError && e.status === 404 && /not found/i.test(e.message));
  let n = 0;
  const ctx4 = createTestContext({ google: () => (++n < 3 ? { status: 503, json: { error: { message: 'backend' } } } : { json: { fine: true } }) });
  assert.deepEqual(await ctx4.google.request('me', 'gmail', { url: '/x' }), { fine: true });
  assert.equal(apiCalls(ctx4).length, 3);
});

test('sends JSON bodies and raw bodies with the right content types and parses text/buffer responses', async () => {
  const ctx = createTestContext({
    google: (c) => (c.url.pathname.endsWith('/text') ? { text: 'hello' } : c.url.pathname.endsWith('/bin') ? { body: Buffer.from([1, 2, 3]) } : { json: { echoed: c.json, ct: c.headers['content-type'] } }),
  });
  const r = await ctx.google.request<{ echoed: unknown; ct: string }>('me', 'sheets', { method: 'POST', url: '/spreadsheets', body: { a: 1 } });
  assert.deepEqual(r.echoed, { a: 1 });
  assert.equal(r.ct, 'application/json');
  const raw = await ctx.google.request<{ ct: string }>('me', 'drive', { method: 'POST', url: '/x', body: Buffer.from('abc'), contentType: 'multipart/related; boundary=b' });
  assert.equal(raw.ct, 'multipart/related; boundary=b');
  assert.equal(await ctx.google.request('me', 'drive', { url: '/text', responseType: 'text' }), 'hello');
  const buf = await ctx.google.request<Buffer>('me', 'drive', { url: '/bin', responseType: 'buffer' });
  assert.deepEqual([...buf], [1, 2, 3]);
});

test('non-idempotent requests are not retried after a timeout or 5xx, but 429 and reads are', async () => {
  let n = 0;
  const flakyOnce = () => (++n === 1 ? { status: 503, json: { error: { message: 'backend' } } } : { json: { ok: true } });
  const post503 = createTestContext({ google: flakyOnce });
  await assert.rejects(post503.google.request('me', 'gmail', { method: 'POST', url: '/messages/send', body: { raw: 'x' } }), (e: Error) => e instanceof GoogleApiError && /Not retried automatically/.test(e.message));
  assert.equal(apiCalls(post503).length, 1);

  n = 0;
  const postTimeout = createTestContext({ google: () => { if (++n === 1) throw new Error('aborted due to timeout'); return { json: { ok: true } }; } });
  await assert.rejects(postTimeout.google.request('me', 'gmail', { method: 'POST', url: '/messages/send', body: { raw: 'x' } }), (e: Error) => e instanceof GoogleApiError && /not retried/.test(e.message));
  assert.equal(apiCalls(postTimeout).length, 1);

  n = 0;
  const post429 = createTestContext({ google: () => (++n === 1 ? { status: 429, json: { error: { message: 'rate' } } } : { json: { ok: true } }) });
  assert.deepEqual(await post429.google.request('me', 'gmail', { method: 'POST', url: '/messages/send', body: { raw: 'x' } }), { ok: true });
  assert.equal(apiCalls(post429).length, 2);

  n = 0;
  const flagged = createTestContext({ google: flakyOnce });
  assert.deepEqual(await flagged.google.request('me', 'gmail', { method: 'POST', url: '/messages/batchModify', body: { ids: [] }, idempotent: true }), { ok: true });
  assert.equal(apiCalls(flagged).length, 2);

  n = 0;
  const patch = createTestContext({ google: flakyOnce });
  assert.deepEqual(await patch.google.request('me', 'drive', { method: 'PATCH', url: '/files/x', body: { name: 'n' } }), { ok: true });
  assert.equal(apiCalls(patch).length, 2);
});

test('responseType headers returns lower-cased response headers (resumable upload sessions)', async () => {
  const ctx = createTestContext({ google: () => ({ json: {}, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=u1' } }) });
  const headers = await ctx.google.request<Record<string, string>>('me', 'drive', { method: 'POST', url: '/x', body: { name: 'n' }, responseType: 'headers' });
  assert.equal(headers['location'], 'https://www.googleapis.com/upload/drive/v3/files?upload_id=u1');
});

test('a refusal from a content host is a plain error: no token refresh, no re-link flag', async () => {
  for (const status of [401, 403]) {
    const ctx = createTestContext({ google: () => ({ status, text: 'denied' }) });
    await assert.rejects(
      ctx.google.request('me', 'drive', { url: 'https://lh3.googleusercontent.com/x=s1600', responseType: 'buffer', contentHost: true }),
      (e: Error) => e instanceof GoogleApiError && e.status === status && e.reason === 'content_refused',
    );
    assert.equal(apiCalls(ctx).length, 1, `${status}: not retried`);
    assert.equal(ctx.calls.length, 2, `${status}: one token fetch, no refresh`);
    assert.equal(ctx.accounts.get('me')?.status, 'ok');
  }
});

test('a long transfer that times out is not retried; a short request that times out is', async () => {
  const timeout = () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const long = createTestContext({ google: timeout });
  await assert.rejects(long.google.request('me', 'drive', { url: '/files/x', query: { alt: 'media' }, responseType: 'buffer', timeoutMs: 150_000 }), /Network error calling Google Drive/);
  assert.equal(apiCalls(long).length, 1, 'another 150 s attempt would outlast the tool call');

  const short = createTestContext({ google: timeout });
  await assert.rejects(short.google.request('me', 'drive', { url: '/files/x' }), /Network error/);
  assert.equal(apiCalls(short).length, 3, 'a 30 s request is retried twice');
});

test('Gmail\'s per-minute quota (403 rateLimitExceeded) is retried like a 429, even for a send; if it persists the error says to wait', async () => {
  const quota = { status: 403, json: { error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost'", errors: [{ reason: 'rateLimitExceeded' }] } } };
  let n = 0;
  const recovers = createTestContext({ google: () => (++n <= 2 ? quota : { json: { id: 'sent' } }) });
  assert.deepEqual(await recovers.google.request('me', 'gmail', { method: 'POST', url: '/messages/send', body: { raw: 'x' } }), { id: 'sent' });
  assert.equal(apiCalls(recovers).length, 3);

  const persists = createTestContext({ google: () => quota });
  await assert.rejects(
    persists.google.request('me', 'gmail', { method: 'POST', url: '/messages/send', body: { raw: 'x' } }),
    (e: Error) => e instanceof GoogleApiError && e.status === 403 && /per-minute quota is used up.*Nothing was done; wait about a minute/.test(e.message),
  );
  assert.equal(apiCalls(persists).length, 3);
  assert.equal(persists.accounts.get('me')?.status, 'ok', 'a rate limit is not a permission problem: no re-link');

  const denied = createTestContext({ google: () => ({ status: 403, json: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } } }) });
  await assert.rejects(denied.google.request('me', 'gmail', { url: '/messages' }), (e: Error) => e instanceof GoogleApiError && !/quota/.test(e.message));
  assert.equal(apiCalls(denied).length, 1, 'other 403s are not retried');
});
