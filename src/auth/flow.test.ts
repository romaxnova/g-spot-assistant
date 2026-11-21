/**
 * End-to-end test of the Claude → server OAuth flow and the account-link flow
 * through the real Express app, with a fake Google and a fake CIMD document.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { openDatabase } from '../db.js';
import { AccountStore } from '../accounts.js';
import { AuthStore } from './store.js';
import { ClientRegistry } from './clients.js';
import { ConnectorOAuthProvider } from './provider.js';
import { GoogleAuth, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from '../google/oauth.js';
import { GoogleClient } from '../google/client.js';
import { createApp } from '../app.js';
import { silentLogger } from '../log.js';
import { SERVICE_SCOPES } from '../config.js';
import { fakeFetch, testConfig, type RecordedCall } from '../test-support.js';
import { allTools } from '../mcp/tools/index.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const CIMD = 'https://claude.ai/oauth/test-client';
/** A draft as Gmail's composer stores it: text and HTML, no attachment yet. */
const MONUMENT_DRAFT = [
  'MIME-Version: 1.0',
  'Date: Tue, 23 Sep 2026 23:15:13 +0200',
  'Message-ID: <CAmonument@mail.gmail.com>',
  'Subject: =?UTF-8?Q?Monument_fun=C3=A9raire?=',
  'From: me@gmail.com',
  'To: contact@example.fr',
  'Content-Type: multipart/alternative; boundary="000000000000c0ffee"',
  '',
  '--000000000000c0ffee',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Bonjour, voici le projet.',
  '',
  '--000000000000c0ffee',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<div dir=3D"ltr">Bonjour, voici le projet.</div>',
  '',
  '--000000000000c0ffee--',
  '',
].join('\r\n');
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function idToken(email: string, aud = 'test-client-id'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ iss: 'https://accounts.google.com', aud, sub: 'sub-' + email, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

let server: Server;
let base: string;
let calls: RecordedCall[];
let nextGoogleEmail = 'owner@example.com';
let nextRefreshToken: string | undefined;
let nextScope = 'openid email';
let db: ReturnType<typeof openDatabase>;
let accounts: AccountStore;
let store: AuthStore;

before(async () => {
  const config = testConfig({ BASE_URL: 'http://localhost', DCR_ENABLED: 'true' });
  calls = [];
  const fetchImpl = fakeFetch(async (c) => {
    if (c.url.href === CIMD) return { json: { client_id: CIMD, client_name: 'Claude Test', redirect_uris: [CALLBACK, 'http://localhost/callback'], token_endpoint_auth_method: 'none' } };
    if (c.url.href === GOOGLE_REVOKE_URL) return { json: {} };
    if (c.url.pathname === '/gmail/v1/users/me/labels') return { json: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] } };
    const draft = /^\/(?:upload\/)?gmail\/v1\/users\/me\/drafts\/(D[12])$/.exec(c.url.pathname);
    if (draft && c.method === 'GET') return { json: { id: draft[1], message: { id: `m-${draft[1]}`, threadId: `t-${draft[1]}`, raw: Buffer.from(MONUMENT_DRAFT, 'latin1').toString('base64url') } } };
    if (draft && c.method === 'PUT') return { json: { id: draft[1], message: { id: `m2-${draft[1]}`, threadId: `t-${draft[1]}` } } };
    return undefined;
  }, calls);
  // The fake token endpoint inside fakeFetch does not know about id tokens; wrap it.
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href === GOOGLE_TOKEN_URL) {
      const body = String(init?.body ?? '');
      calls.push({ method: 'POST', url: new URL(href), headers: {}, body });
      if (body.includes('grant_type=authorization_code')) {
        if (body.includes('code=bad')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        return new Response(JSON.stringify({ access_token: 'g-at', expires_in: 3600, id_token: idToken(nextGoogleEmail), refresh_token: nextRefreshToken, scope: nextScope }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ access_token: 'g-at', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;

  db = openDatabase(':memory:');
  accounts = new AccountStore(db, config.encryptionKey);
  store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: true, fetchImpl: wrapped }, silentLogger);
  const provider = new ConnectorOAuthProvider(store, clients, { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 }, silentLogger);
  const googleAuth = new GoogleAuth({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: `${config.baseUrl.origin}/auth/google/callback` }, wrapped);
  const googleClient = new GoogleClient(accounts, googleAuth, silentLogger, { adminUrl: `${config.baseUrl.origin}/admin`, fetchImpl: wrapped });
  const app = createApp({ config, log: silentLogger, accounts, store, clients, provider, googleAuth, googleClient, tools: allTools });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  db.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { redirect: 'manual', headers });
const postForm = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

let sessionCookie = '';

test('discovery documents advertise CIMD, PKCE S256 and the exact resource URL', async () => {
  const as = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
  assert.equal(as['client_id_metadata_document_supported'], true);
  assert.deepEqual(as['code_challenge_methods_supported'], ['S256']);
  assert.ok((as['token_endpoint_auth_methods_supported'] as string[]).includes('none'));
  assert.equal(as['registration_endpoint'], `http://localhost/register`);
  const prm = (await (await get('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
  assert.equal(prm['resource'], 'http://localhost/mcp');
  assert.deepEqual(prm['authorization_servers'], ['http://localhost/']);
});

test('privacy policy and terms are public pages', async () => {
  for (const path of ['/privacy', '/terms']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /myaccount\.google\.com\/permissions/);
    assert.match(html, /owner@example\.com/);
  }
  assert.match(await (await get('/privacy')).text(), /Limited Use/);
  assert.match(await (await get('/')).text(), /href="\/privacy"/);
});

test('unauthenticated MCP requests get 401 with a resource_metadata pointer', async () => {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer .*resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
  const bad = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer gc_at_nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(bad.status, 401);
});

test('owner sign-in: unknown emails are refused, allow-listed emails get a session', async () => {
  const start = await postForm('/admin/login/start', { next: '/admin' }, { origin: 'http://localhost' });
  assert.equal(start.status, 302);
  const g = new URL(start.headers.get('location')!);
  assert.equal(g.origin, 'https://accounts.google.com');
  assert.equal(g.searchParams.get('scope'), 'openid email');
  assert.equal(g.searchParams.get('access_type'), null);
  const state = g.searchParams.get('state')!;

  nextGoogleEmail = 'intruder@example.com';
  const refused = await get(`/auth/google/callback?state=${state}&code=abc`);
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /is not an owner of this server/);
  const replay = await get(`/auth/google/callback?state=${state}&code=abc`);
  assert.equal(replay.status, 400, 'state is single use');

  const start2 = await postForm('/admin/login/start', { next: '/admin' }, { origin: 'http://localhost' });
  const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
  nextGoogleEmail = 'owner@example.com';
  const ok = await get(`/auth/google/callback?state=${state2}&code=abc`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin');
  sessionCookie = cookieOf(ok);
  assert.match(sessionCookie, /^gc_session=/);
  assert.match(ok.headers.get('set-cookie')!, /HttpOnly/);
  const admin = await get('/admin', { cookie: sessionCookie });
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /No accounts linked yet/);
});

test('same-origin POSTs are accepted even when the browser sends Origin: null', async () => {
  const res = await postForm('/admin/login/start', { next: '/admin' }, { origin: 'null', 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /^https:\/\/accounts\.google\.com\//);
  const noOrigin = await postForm('/admin/login/start', { next: '/admin' }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(noOrigin.status, 302);
  const crossNull = await postForm('/admin/login/start', { next: '/admin' }, { origin: 'null', 'sec-fetch-site': 'cross-site' });
  assert.equal(crossNull.status, 403);
  const page = await get('/admin/login');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
});

test('POSTs without a same-origin Origin header are refused (CSRF)', async () => {
  const res = await postForm('/admin/link', { alias: 'x', services: 'gmail', mode: 'now' }, { cookie: sessionCookie });
  assert.equal(res.status, 403);
  const res2 = await postForm('/admin/link', { alias: 'x', services: 'gmail', mode: 'now' }, { cookie: sessionCookie, origin: 'https://evil.com' });
  assert.equal(res2.status, 403);
});

let refreshToken = '';
let accessToken = '';

test('full authorization code + PKCE flow with a CIMD client, then refresh rotation and reuse detection', async () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authz = await get(`/authorize?client_id=${encodeURIComponent(CIMD)}&redirect_uri=${encodeURIComponent(CALLBACK)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=st4te&resource=${encodeURIComponent('http://localhost/mcp')}`);
  assert.equal(authz.status, 302);
  const consentUrl = authz.headers.get('location')!;
  assert.match(consentUrl, /^\/consent\?req=/);

  // Without a session the consent page bounces to login and back.
  const anon = await get(consentUrl);
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location')!, /^\/admin\/login\?next=%2Fconsent/);

  const consent = await get(consentUrl, { cookie: sessionCookie });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /Claude Test/);
  assert.match(html, /claude\.ai/);
  const req = new URL(consentUrl, base).searchParams.get('req')!;

  const approved = await postForm('/consent', { req, decision: 'approve' }, { cookie: sessionCookie, origin: 'http://localhost' });
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get('location')!);
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(back.searchParams.get('state'), 'st4te');
  const code = back.searchParams.get('code')!;
  assert.ok(code);

  // Wrong verifier is refused and does not burn the code.
  const wrong = await postForm('/token', { grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: CIMD, redirect_uri: CALLBACK });
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_grant');

  const tok = await postForm('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CIMD, redirect_uri: CALLBACK, resource: 'http://localhost/mcp' });
  assert.equal(tok.status, 200);
  const tokens = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.match(tokens.access_token, /^gc_at_/);
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;

  // Code replay is refused.
  const replay = await postForm('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CIMD });
  assert.equal(replay.status, 400);

  // Refresh rotates the token.
  const r1 = await postForm('/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CIMD });
  assert.equal(r1.status, 200);
  const rotated = (await r1.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, refreshToken);
  // Reusing the old one is a leak signal: the whole family dies, including the new token.
  const reuse = await postForm('/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CIMD });
  assert.equal(reuse.status, 400);
  assert.equal(((await reuse.json()) as { error: string }).error, 'invalid_grant');
  const dead = await postForm('/token', { grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: CIMD });
  assert.equal(dead.status, 400);
  const mcpDead = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${rotated.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(mcpDead.status, 401, 'access tokens of a revoked family stop working');
  // The first access token belongs to the same family and is revoked as well; get a fresh grant for the MCP test.
  const authz2 = await get(`/authorize?client_id=${encodeURIComponent(CIMD)}&redirect_uri=${encodeURIComponent(CALLBACK)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`);
  const req2 = new URL(authz2.headers.get('location')!, base).searchParams.get('req')!;
  const approved2 = await postForm('/consent', { req: req2, decision: 'approve' }, { cookie: sessionCookie, origin: 'http://localhost' });
  const code2 = new URL(approved2.headers.get('location')!).searchParams.get('code')!;
  const tok2 = await postForm('/token', { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: CIMD });
  accessToken = ((await tok2.json()) as { access_token: string }).access_token;
});

test('denying consent redirects with access_denied; wrong resource is refused', async () => {
  const authz = await get(`/authorize?client_id=${encodeURIComponent(CIMD)}&redirect_uri=${encodeURIComponent(CALLBACK)}&response_type=code&code_challenge=abc&code_challenge_method=S256&state=s`);
  const req = new URL(authz.headers.get('location')!, base).searchParams.get('req')!;
  const denied = await postForm('/consent', { req, decision: 'deny' }, { cookie: sessionCookie, origin: 'http://localhost' });
  const u = new URL(denied.headers.get('location')!);
  assert.equal(u.searchParams.get('error'), 'access_denied');
  assert.equal(u.searchParams.get('state'), 's');
  const badResource = await get(`/authorize?client_id=${encodeURIComponent(CIMD)}&redirect_uri=${encodeURIComponent(CALLBACK)}&response_type=code&code_challenge=abc&code_challenge_method=S256&resource=${encodeURIComponent('https://other.example/mcp')}`);
  assert.equal(badResource.status, 302);
  assert.match(badResource.headers.get('location')!, /error=invalid_target/);
  const evil = await get(`/authorize?client_id=${encodeURIComponent('https://evil.example/cimd')}&redirect_uri=${encodeURIComponent(CALLBACK)}&response_type=code&code_challenge=abc&code_challenge_method=S256`);
  assert.equal(evil.status, 400);
});

test('dynamic client registration only accepts allow-listed redirect URIs', async () => {
  const bad = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.com/cb'], token_endpoint_auth_method: 'none' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', client_name: 'DCR client' }) });
  assert.equal(ok.status, 201);
  const info = (await ok.json()) as { client_id: string };
  assert.ok(info.client_id);
  assert.equal(store.getClient(info.client_id)?.client_name, 'DCR client');
});

async function mcpCall(body: unknown): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return { status: res.status, json: data.length ? (JSON.parse(data[data.length - 1]!) as Record<string, unknown>) : undefined };
  }
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

test('MCP 2026-07-28: server/discover, tools/list and tools/call over the per-request envelope', async () => {
  // claude.ai probes with server/discover first; a server that cannot answer it risks being dropped from the chat.
  for (const mode of [{ pin: '2026-07-28' }, 'auto'] as const) {
    const client = new Client({ name: 'modern-test', version: '0' }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } });
    await client.connect(transport);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
      assert.equal(client.getServerVersion()?.name, 'g-spot-assistant');
      assert.match(client.getInstructions() ?? '', /list_accounts/);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 53);
      const call = await client.callTool({ name: 'list_accounts', arguments: {} });
      assert.ok(Array.isArray(call.content) && call.content.length > 0);
      const bad = await client.callTool({ name: 'gmail_search', arguments: {} });
      assert.equal(bad.isError, true, 'invalid arguments come back as a tool error');
    } finally {
      await client.close();
    }
  }
  // A 2025-era client that never probes still gets the initialize handshake.
  const legacy = new Client({ name: 'legacy-test', version: '0' });
  await legacy.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  try {
    assert.equal(legacy.getNegotiatedProtocolVersion(), '2025-11-25');
    assert.equal((await legacy.listTools()).tools.length, 53);
  } finally {
    await legacy.close();
  }
});

test('MCP initialize and tools/list work with a valid bearer token; list_accounts reflects the database', async () => {
  const init = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assert.equal(init.status, 200);
  const result = init.json!['result'] as { serverInfo: { name: string }; instructions?: string };
  assert.equal(result.serverInfo.name, 'g-spot-assistant');
  assert.match(result.instructions ?? '', /list_accounts/);
  const list = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = (list.json!['result'] as { tools: { name: string; description?: string; inputSchema: { properties?: Record<string, { description?: string }> }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] }).tools;
  const la = tools.find((t) => t.name === 'list_accounts');
  assert.ok(la);
  assert.equal(la.annotations?.readOnlyHint, true);
  assert.equal(tools.length, 53, 'list_accounts + 47 service and follow-up tools + 4 upload tools + send_to_link');
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} has a description`);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} has readOnlyHint`);
    assert.equal(typeof t.annotations?.destructiveHint, 'boolean', `${t.name} has destructiveHint`);
  }
  const search = tools.find((t) => t.name === 'gmail_search')!;
  // claude.ai caches this for a whole conversation, so it is worded as a snapshot that points to list_accounts.
  assert.match(search.inputSchema.properties!['account']!.description ?? '', /when this tool list was loaded: none\. Call list_accounts for the current list\./);
  const gets = await fetch(base + '/mcp', { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'text/event-stream' } });
  assert.equal(gets.status, 405, 'no standalone SSE stream on a stateless server');
  const malformed = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as { error: { code: number } }).error.code, -32700);
  const call = await mcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
  const content = (call.json!['result'] as { content: { text: string }[] }).content[0]!.text;
  assert.match(content, /No Google accounts are linked yet/);
});

test('account link flow (owner signs in now): offline consent, scopes, refresh token stored encrypted', async () => {
  const start = await postForm('/admin/link', { alias: 'me', label: 'Main', services: 'gmail', mode: 'now' }, { cookie: sessionCookie, origin: 'http://localhost' });
  assert.equal(start.status, 302);
  const g = new URL(start.headers.get('location')!);
  assert.equal(g.searchParams.get('access_type'), 'offline');
  assert.equal(g.searchParams.get('prompt'), 'consent');
  assert.equal(g.searchParams.get('include_granted_scopes'), 'true');
  assert.ok(g.searchParams.get('scope')!.includes(SERVICE_SCOPES.gmail));
  assert.ok(!g.searchParams.get('scope')!.includes(SERVICE_SCOPES.drive));
  nextGoogleEmail = 'me@gmail.com';
  nextRefreshToken = '1//google-refresh';
  nextScope = `openid email ${SERVICE_SCOPES.gmail}`;
  const done = await get(`/auth/google/callback?state=${g.searchParams.get('state')}&code=xyz`, { cookie: sessionCookie });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Linked <strong>me<\/strong> \(me@gmail.com\) with: Gmail/);
  const a = accounts.get('me')!;
  assert.deepEqual(a.services, ['gmail']);
  assert.equal(a.label, 'Main');
  assert.equal(accounts.getRefreshToken('me'), '1//google-refresh');
  const row = db.prepare('SELECT refresh_token_enc FROM accounts WHERE alias = ?').get('me') as { refresh_token_enc: string };
  assert.ok(!row.refresh_token_enc.includes('google-refresh'), 'stored encrypted');
  const call = await mcpCall({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
  const content = (call.json!['result'] as { content: { text: string }[] }).content[0]!.text;
  assert.match(content, /"alias": "me"/);
  assert.match(content, /me@gmail.com/);
  // The account parameter description now names the eligible alias, and a real tool call reaches the fake Google.
  const list = await mcpCall({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  const search = (list.json!['result'] as { tools: { name: string; inputSchema: { properties?: Record<string, { description?: string }> } }[] }).tools.find((t) => t.name === 'gmail_search')!;
  assert.match(search.inputSchema.properties!['account']!.description ?? '', /me \(me@gmail.com\)/);
  const labels = await mcpCall({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gmail_list_labels', arguments: { account: 'me' } } });
  const labelsResult = labels.json!['result'] as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(labelsResult.isError, true, labelsResult.content[0]?.text);
  assert.match(labelsResult.content[0]!.text, /Receipts/);
  const denied = await mcpCall({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'drive_search', arguments: { account: 'me', query: 'x' } } });
  const deniedResult = denied.json!['result'] as { isError?: boolean; content: { text: string }[] };
  assert.equal(deniedResult.isError, true);
  assert.match(deniedResult.content[0]!.text, /was not granted Google Drive/);
});

test('end to end: files uploaded from a browser through an upload link go into two drafts byte for byte', async () => {
  const client = new Client({ name: 'e2e', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  const text = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content[0]!.text);
  try {
    // 1. Claude asks for a link; the user opens it (the page) on their phone.
    const link = JSON.parse(text(await client.callTool({ name: 'create_upload_link', arguments: {} }))) as { upload_url: string; link_id: string; for_the_user: string };
    const pageUrl = new URL(new URL(link.upload_url).pathname, base).href;
    assert.ok(link.for_the_user.includes(link.upload_url));
    const pageRes = await fetch(pageUrl, { headers: { accept: 'text/html' } });
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, /<form class="card" method="post" enctype="multipart\/form-data">/);
    assert.match(html, /<input type="file" name="file" multiple required>/);
    const none = JSON.parse(text(await client.callTool({ name: 'list_uploads', arguments: { link_id: link.link_id } }))) as { count: number; note: string };
    assert.equal(none.count, 0);
    assert.match(none.note, /Nothing has come through this link yet/);

    // 2. They pick two photos and a PDF and submit, as Safari does (Origin, Accept: text/html, multipart form).
    const photo1 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(300 * 1024)]);
    const photo2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(700 * 1024)]);
    const plan = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(70 * 1024)]);
    // As on an iPhone: the PDF from Files first, then the two photos from the Photo Library, in two uploads.
    const pdfForm = new FormData();
    pdfForm.append('file', new Blob([plan], { type: 'application/pdf' }), 'Monument_schémas.pdf');
    const posted = await fetch(pageUrl, { method: 'POST', body: pdfForm, headers: { accept: 'text/html', origin: base }, redirect: 'manual' });
    assert.equal(posted.status, 303, 'post/redirect/get');
    assert.match(await (await fetch(pageUrl, { headers: { accept: 'text/html' } })).text(), /File received[^]*More files\?/);
    const photoForm = new FormData();
    photoForm.append('file', new Blob([photo1], { type: 'image/jpeg' }), 'IMG_4012.jpg');
    photoForm.append('file', new Blob([photo2], { type: 'image/jpeg' }), 'IMG_4013.jpg');
    const done = await (await fetch(pageUrl, { method: 'POST', body: photoForm, headers: { accept: 'text/html', origin: base } })).text();
    assert.match(done, /3 files received/);
    assert.match(done, /Monument_schémas\.pdf/);

    // 3. Claude finds the files by link and attaches all three to two drafts, reusing the same uploads.
    const listed = JSON.parse(text(await client.callTool({ name: 'list_uploads', arguments: { link_id: link.link_id } }))) as { uploads: { upload_id: string; filename: string; size: number }[] };
    assert.deepEqual(listed.uploads.map((u) => [u.filename, u.size]).sort(), [['IMG_4012.jpg', photo1.length], ['IMG_4013.jpg', photo2.length], ['Monument_schémas.pdf', plan.length]]);
    // The link id stands for everything that came through it: no need to look up each upload_id.
    const add = [{ upload_id: link.link_id }];
    for (const draftId of ['D1', 'D2']) {
      const res = await client.callTool({ name: 'gmail_update_draft', arguments: { account: 'me', draft_id: draftId, add_attachments: add } });
      assert.ok(!(res as { isError?: boolean }).isError, text(res));
      const out = JSON.parse(text(res)) as { thread_id: string; attachments: { filename: string; size: number }[] };
      assert.equal(out.thread_id, `t-${draftId}`);
      assert.equal(out.attachments.length, 3);

      // What Gmail received: the original text untouched, and each file byte for byte.
      const put = calls.filter((c) => c.method === 'PUT' && c.url.pathname.endsWith(`/drafts/${draftId}`)).at(-1)!;
      const body = put.json as { message?: { raw: string; threadId: string } } | undefined;
      const raw = body?.message ? Buffer.from(body.message.raw, 'base64url').toString('latin1') : put.body ?? '';
      assert.ok(raw.includes('<div dir=3D"ltr">Bonjour, voici le projet.</div>'), 'the text is kept');
      assert.ok(raw.includes('From: me@gmail.com\r\n') && raw.includes('Message-ID: <CAmonument@mail.gmail.com>\r\n'));
      for (const [name, bytes] of [['IMG_4012.jpg', photo1], ['IMG_4013.jpg', photo2], ['Monument_sch', plan]] as const) {
        const part = new RegExp(`filename[^\\r]*${name}[^]*?\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`).exec(raw);
        assert.ok(part, `${name} is attached`);
        assert.ok(Buffer.from(part[1]!.replace(/\r\n/g, ''), 'base64').equals(bytes), `${name} arrives byte for byte`);
      }
    }
  } finally {
    await client.close();
  }
});

test('invite link flow enforces the expected email and warns about missing scopes', async () => {
  const created = await postForm('/admin/link', { alias: 'partner', services: ['gmail', 'drive'].join(','), mode: 'invite', expected_email: 'Partner@Example.com' }, { cookie: sessionCookie, origin: 'http://localhost' });
  // services arrive as repeated fields in a real form; emulate that properly
  assert.equal(created.status, 400, 'a comma-joined single value is not a valid service');
  const created2 = await fetch(base + '/admin/link', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sessionCookie, origin: 'http://localhost' },
    body: 'alias=partner&services=gmail&services=drive&mode=invite&expected_email=Partner%40Example.com',
  });
  assert.equal(created2.status, 200);
  const html = await created2.text();
  const m = /http:\/\/localhost\/link\/([A-Za-z0-9_-]+)/.exec(html)!;
  const linkPath = `/link/${m[1]}`;
  const pageRes = await get(linkPath);
  assert.equal(pageRes.status, 200);
  assert.match(await pageRes.text(), /partner@example.com/);
  const start = await postForm(`${linkPath}/start`, {}, { origin: 'http://localhost' });
  assert.equal(start.status, 302);
  const g = new URL(start.headers.get('location')!);
  assert.equal(g.searchParams.get('login_hint'), 'partner@example.com');

  nextGoogleEmail = 'someone-else@gmail.com';
  nextRefreshToken = '1//wrong-person';
  const wrong = await get(`/auth/google/callback?state=${g.searchParams.get('state')}&code=xyz`);
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /this link is for partner@example.com/);
  assert.ok(calls.some((c) => c.url.href === GOOGLE_REVOKE_URL && c.body?.includes('wrong-person')), 'unexpected grant is revoked at Google');
  assert.equal(accounts.get('partner'), undefined);

  // The invite is still usable after a failed attempt (state was consumed, link was not).
  const start2 = await postForm(`${linkPath}/start`, {}, { origin: 'http://localhost' });
  const g2 = new URL(start2.headers.get('location')!);
  nextGoogleEmail = 'partner@example.com';
  nextRefreshToken = '1//partner';
  nextScope = `openid email ${SERVICE_SCOPES.gmail}`; // drive unticked on the consent screen
  const ok = await get(`/auth/google/callback?state=${g2.searchParams.get('state')}&code=xyz`);
  assert.equal(ok.status, 200);
  const okHtml = await ok.text();
  assert.match(okHtml, /Google did not grant: Google Drive/);
  const partner = accounts.get('partner')!;
  assert.deepEqual(partner.services, ['gmail']);
  assert.deepEqual(partner.requestedServices, ['gmail', 'drive']);
  const used = await get(linkPath);
  assert.equal(used.status, 404, 'invite links are single use');
});

test('unlink asks for confirmation, revokes at Google and removes the row; revoke-all kills Claude tokens', async () => {
  const ask = await postForm('/admin/unlink', { alias: 'partner' }, { cookie: sessionCookie, origin: 'http://localhost' });
  assert.equal(ask.status, 200);
  assert.match(await ask.text(), /Yes, unlink/);
  assert.ok(accounts.get('partner'));
  const done = await postForm('/admin/unlink', { alias: 'partner', confirm: 'yes' }, { cookie: sessionCookie, origin: 'http://localhost' });
  assert.equal(done.status, 302);
  assert.equal(accounts.get('partner'), undefined);
  assert.ok(calls.some((c) => c.url.href === GOOGLE_REVOKE_URL && c.body?.includes('1%2F%2Fpartner')));

  const revoke = await postForm('/admin/revoke-claude', {}, { cookie: sessionCookie, origin: 'http://localhost' });
  assert.equal(revoke.status, 302);
  const after = await mcpCall({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  assert.equal(after.status, 401);

  const logout = await postForm('/admin/logout', {}, { cookie: sessionCookie, origin: 'http://localhost' });
  assert.equal(logout.status, 302);
  const admin = await get('/admin', { cookie: sessionCookie });
  assert.equal(admin.status, 302, 'session revoked server-side');
});
