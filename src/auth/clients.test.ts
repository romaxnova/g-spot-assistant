import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { AuthStore } from './store.js';
import { ClientRegistry, redirectUriAllowed } from './clients.js';
import { silentLogger } from '../log.js';
import { loadConfig } from '../config.js';
import { testEnv } from '../test-support.js';

const ALLOWED = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback', 'http://127.0.0.1/callback'];

test('redirect allow-list ignores ports only for loopback hosts', () => {
  assert.ok(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', ALLOWED));
  assert.ok(redirectUriAllowed('http://localhost:3118/callback', ALLOWED));
  assert.ok(redirectUriAllowed('http://127.0.0.1:60000/callback', ALLOWED));
  assert.ok(!redirectUriAllowed('http://localhost:3118/other', ALLOWED));
  assert.ok(!redirectUriAllowed('https://claude.ai.evil.com/api/mcp/auth_callback', ALLOWED));
  assert.ok(!redirectUriAllowed('https://evil.com/api/mcp/auth_callback', ALLOWED));
});

function registry(fetchImpl: typeof fetch, dcr = true) {
  const store = new AuthStore(openDatabase(':memory:'));
  return { store, reg: new ClientRegistry(store, { allowedRedirectUris: ALLOWED, cimdAllowedHosts: ['claude.ai'], dcrEnabled: dcr, fetchImpl, cimdCacheMs: 60_000 }, silentLogger) };
}

const doc = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    client_id: 'https://claude.ai/oauth/test-client',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  });

test('fetches, validates and caches CIMD documents from allow-listed hosts only', async () => {
  let fetches = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    fetches++;
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (href === 'https://claude.ai/oauth/test-client') return new Response(doc(), { headers: { 'content-type': 'application/json' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const { reg } = registry(fetchImpl);
  const c = await reg.getClient('https://claude.ai/oauth/test-client');
  assert.equal(c?.client_name, 'Claude');
  assert.equal(c?.token_endpoint_auth_method, 'none');
  await reg.getClient('https://claude.ai/oauth/test-client');
  assert.equal(fetches, 1, 'second lookup served from cache');
  assert.equal(await reg.getClient('https://evil.example/oauth/test-client'), undefined);
  assert.equal(await reg.getClient('http://claude.ai/oauth/test-client'), undefined);
  assert.equal(await reg.getClient('https://claude.ai:8443/oauth/test-client'), undefined);
  assert.equal(fetches, 1, 'non-allow-listed ids are never fetched');
});

test('keeps only allow-listed redirect uris from a CIMD document', async () => {
  const fetchImpl = (async () => new Response(doc({ redirect_uris: ['https://evil.com/cb', 'https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback'] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const { reg } = registry(fetchImpl);
  const c = await reg.getClient('https://claude.ai/oauth/test-client');
  assert.deepEqual(c?.redirect_uris, ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback']);
});

test('rejects CIMD documents whose id, auth method or redirect uris are wrong', async () => {
  const cases = [doc({ client_id: 'https://claude.ai/oauth/other' }), doc({ token_endpoint_auth_method: 'client_secret_post' }), doc({ redirect_uris: ['https://evil.com/cb'] }), doc({ client_secret: 'x' }), '{not json'];
  for (const body of cases) {
    const fetchImpl = (async () => new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const { reg } = registry(fetchImpl);
    assert.equal(await reg.getClient('https://claude.ai/oauth/test-client'), undefined, `should reject: ${body.slice(0, 60)}`);
  }
});

test('dynamic registration enforces the redirect allow-list and can be disabled', () => {
  const { reg, store } = registry(fetch);
  assert.ok(reg.registerClient);
  const c = reg.registerClient!({ redirect_uris: ['http://localhost:1234/callback'], client_name: 'Inspector', token_endpoint_auth_method: 'none' } as never);
  assert.ok(c.client_id);
  assert.equal(store.getClient(c.client_id)?.client_name, 'Inspector');
  assert.throws(() => reg.registerClient!({ redirect_uris: ['https://evil.com/cb'] } as never), /not allowed/);
  const { reg: noDcr } = registry(fetch, false);
  assert.equal(noDcr.registerClient, undefined);
});

test('the default allow-list takes claude.ai, claude.com and ChatGPT callbacks, and nothing beside them', () => {
  const allowed = loadConfig(testEnv()).allowedRedirectUris;
  for (const ok of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'http://localhost:33418/callback',
    'https://chatgpt.com/connector/oauth/abc_123-XYZ',
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]) {
    assert.ok(redirectUriAllowed(ok, allowed), ok);
  }
  for (const bad of [
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/a/b',
    'https://chatgpt.com/connector/oauth/..',
    'https://chatgpt.com/connector/oauth/a?next=https://evil.example',
    'https://chatgpt.com/connector/oauth/a#x',
    'https://chatgpt.com/connector/oauth/%2e%2e',
    'https://chatgpt.com.evil.example/connector/oauth/a',
    'https://evil.example/connector/oauth/a',
    'http://chatgpt.com/connector/oauth/a',
  ]) {
    assert.ok(!redirectUriAllowed(bad, allowed), bad);
  }
});
