import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDatabase } from '../db.js';
import { silentLogger } from '../log.js';
import { testConfig } from '../test-support.js';
import { GoogleAuth, pkcePair, type GoogleOAuthConfig } from '../google/oauth.js';
import { loggablePath } from '../app.js';
import { keyRequestCard, setupSteps } from '../web/routes.js';
import { hubRouter, KeyShareHub, type HubDeps } from './hub.js';
import { KeyShareMember } from './member.js';

const HUB = 'https://hub.test';
const FRIEND = 'https://connector.test';

/** A key-owner's server and a friend's server talking through fake fetches (no network). */
function pair() {
  let member!: KeyShareMember;
  const proofCalls: string[] = [];
  const deps: HubDeps = {
    resolve: async () => ['93.184.216.34'],
    fetch: (async (url: string | URL) => {
      const u = String(url);
      proofCalls.push(u);
      const id = u.startsWith(`${FRIEND}/key-share/proof/`) ? u.slice(`${FRIEND}/key-share/proof/`.length) : '';
      return member.proves(id) ? new Response('ok') : new Response('no such request', { status: 404 });
    }) as typeof fetch,
  };
  const hub = new KeyShareHub(openDatabase(':memory:'), HUB, { clientId: 'shared-id.apps.googleusercontent.com', clientSecret: 'shared-secret' }, silentLogger, deps);
  const friendFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== HUB) throw new Error('unexpected host');
    if (u.pathname === '/key-share/requests' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      try {
        return Response.json(await hub.request({ origin: b['origin'], name: b['name'], requestId: b['request_id'] }), { status: 202 });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }
    }
    if (u.pathname === '/key-share/status') return Response.json(hub.status(String(new Headers(init?.headers).get('authorization')).slice(7)));
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const db = openDatabase(':memory:');
  const env = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SHARED_KEY_SERVER: HUB, SHARED_KEY_OWNER: 'Roman' };
  const config = testConfig(env);
  const googleCfg: GoogleOAuthConfig = { clientId: '', clientSecret: '', redirectUri: `${FRIEND}/auth/google/callback` };
  member = new KeyShareMember(db, config, googleCfg, silentLogger, friendFetch);
  return { hub, member, config, googleCfg, db, env, friendFetch, proofCalls };
}

test('a friend asks for the key, the owner approves, and the key works at once, through one relay address', async () => {
  const { hub, member, config, googleCfg, db, env, friendFetch, proofCalls } = pair();
  assert.equal(config.googleConfigured, false);

  const asked = await member.ask('Arsu');
  assert.equal(asked.status, 'pending', asked.error);
  assert.match(asked.checkCode!, /^\d{6}$/);
  assert.equal(proofCalls.length, 1, 'the key server checked the request with the friend server');
  const [share] = hub.list();
  assert.deepEqual([share!.name, share!.origin, share!.checkCode, share!.status], ['Arsu', FRIEND, asked.checkCode, 'pending']);

  await member.check(true);
  assert.equal(config.googleConfigured, false, 'nothing before approval');
  assert.equal(hub.relayTarget(`${share!.sid}.x`), undefined, 'no sign-in relayed before approval');

  hub.decide(share!.sid, 'approve');
  await member.check(true);
  assert.equal(config.googleConfigured, true);
  assert.equal(config.googleFromKeyServer, true);
  assert.equal(config.google.clientId, 'shared-id.apps.googleusercontent.com');
  assert.equal(googleCfg.redirectUri, `${HUB}/auth/google/relay`);
  const url = new URL(new GoogleAuth(googleCfg).buildAuthUrl({ scopes: ['openid'], state: 'abc', offline: false }));
  assert.equal(url.searchParams.get('redirect_uri'), `${HUB}/auth/google/relay`);
  assert.equal(url.searchParams.get('state'), `${share!.sid}.abc`);
  assert.equal(hub.relayTarget(url.searchParams.get('state')!), FRIEND);

  const raw = db.prepare('SELECT key_enc, request_enc FROM key_share_member').get() as { key_enc: string; request_enc: string };
  assert.ok(!raw.key_enc.includes('shared-secret'), 'the key is kept encrypted');

  // After a restart the kept key is used straight away.
  const again = testConfig(env);
  const cfg2: GoogleOAuthConfig = { clientId: '', clientSecret: '', redirectUri: `${FRIEND}/auth/google/callback` };
  new KeyShareMember(db, again, cfg2, silentLogger, friendFetch).applyStored();
  assert.equal(again.googleConfigured, true);
  assert.equal(cfg2.statePrefix, `${share!.sid}.`);

  // Removed: sign-ins stop at the relay, and the friend server stops using the key at its next check.
  hub.decide(share!.sid, 'remove');
  assert.equal(hub.relayTarget(`${share!.sid}.abc`), undefined);
  await member.check(true);
  assert.equal(config.googleConfigured, false);
  assert.equal(googleCfg.redirectUri, `${FRIEND}/auth/google/callback`);
  assert.equal(member.view().status, 'removed');
});

test('nobody can ask in another server\'s name, nor point the key server at a private address', async () => {
  const { hub } = pair();
  const id = 'x'.repeat(40);
  await assert.rejects(hub.request({ origin: FRIEND, name: 'Mallory', requestId: id }), /did not confirm the request/);
  await assert.rejects(hub.request({ origin: 'http://friend.test', name: 'M', requestId: id }), /https origin/);
  await assert.rejects(hub.request({ origin: 'https://10.0.0.5', name: 'M', requestId: id }), /public host name/);
  await assert.rejects(hub.request({ origin: `${FRIEND}/path`, name: 'M', requestId: id }), /https origin/);
  await assert.rejects(hub.request({ origin: HUB, name: 'M', requestId: id }), /public host name/, 'not itself');
  const internal = new KeyShareHub(openDatabase(':memory:'), HUB, { clientId: 'a', clientSecret: 'b' }, silentLogger, { resolve: async () => ['169.254.169.254'], fetch: (async () => new Response('ok')) as typeof fetch });
  await assert.rejects(internal.request({ origin: 'https://metadata.example', name: 'M', requestId: id }), /public server/);
  assert.deepEqual(hub.list(), []);
  assert.deepEqual(hub.status(id), { status: 'unknown' });
});

test('once a server has a key, a visitor cannot reset its request', async () => {
  const { hub, member, config } = pair();
  await member.ask('Arsu');
  hub.decide(hub.list()[0]!.sid, 'approve');
  await member.check(true);
  assert.equal(config.googleConfigured, true);
  assert.equal(member.proves('y'.repeat(43)), false);
});

test('the relay passes sign-ins on to approved servers only, query and all', async () => {
  const { hub, member } = pair();
  await member.ask('Arsu');
  const sid = hub.list()[0]!.sid;
  const app = express().use(hubRouter(hub, silentLogger));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  try {
    const before = await fetch(`http://127.0.0.1:${port}/auth/google/relay?state=${sid}.abc&code=4/xyz`, { redirect: 'manual' });
    assert.equal(before.status, 400);
    hub.decide(sid, 'approve');
    const ok = await fetch(`http://127.0.0.1:${port}/auth/google/relay?state=${sid}.abc&code=4/xyz&scope=openid`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), `${FRIEND}/auth/google/callback?state=${sid}.abc&code=4/xyz&scope=openid`);
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
    const noPrefix = await fetch(`http://127.0.0.1:${port}/auth/google/relay?state=abc&code=1`, { redirect: 'manual' });
    assert.equal(noPrefix.status, 400);
  } finally {
    server.close();
  }
});

test('PKCE: the code is exchanged with the verifier this server kept', async () => {
  let body = '';
  const auth = new GoogleAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x.test/cb' }, (async (_u: string | URL, init?: RequestInit) => {
    body = String(init?.body);
    return Response.json({ access_token: 'a', expires_in: 3600 });
  }) as typeof fetch);
  const p = pkcePair();
  const url = new URL(auth.buildAuthUrl({ scopes: ['openid'], state: 's1', offline: false, codeChallenge: p.challenge }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), p.challenge);
  await auth.exchangeCode('code', p.verifier);
  assert.equal(new URLSearchParams(body).get('code_verifier'), p.verifier);
});

test('the setup page offers the button, then shows the code to send; proof ids stay out of the log', () => {
  const owner = 'Roman';
  assert.match(setupSteps(testConfig({ GOOGLE_CLIENT_ID: '' }), { status: 'none', owner }), /Ask Roman for the key/);
  assert.match(keyRequestCard({ status: 'pending', owner, checkCode: '482913', name: 'Arsu' }), /Send Roman this code[\s\S]*482913/);
  assert.match(keyRequestCard({ status: 'declined', owner }), /declined/);
  assert.equal(loggablePath('/key-share/proof/secret-id-123'), '/key-share/proof/:id');
});
