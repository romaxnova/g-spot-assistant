/**
 * The admin page's daily-digest card and forms, through the real Express app:
 * owner-only, same-origin POSTs, validated settings, and "Send now".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { AuthStore } from '../auth/store.js';
import { ClientRegistry } from '../auth/clients.js';
import { ConnectorOAuthProvider } from '../auth/provider.js';
import { GoogleAuth } from '../google/oauth.js';
import { silentLogger } from '../log.js';
import { DigestScheduler, DigestSettingsStore } from '../followups/digest.js';
import { mailboxes } from '../followups/test-mailboxes.js';
import { apiCalls, createMultiAccountContext, type TestContext } from '../test-support.js';

const GMAIL = '/gmail/v1/users/me';
const ORIGIN = 'http://localhost';

let server: Server;
let base: string;
let ctx: TestContext;
let settings: DigestSettingsStore;
let cookie: string;
let runs = 0;

before(async () => {
  ctx = createMultiAccountContext({
    config: { BASE_URL: ORIGIN },
    accounts: [
      { alias: 'me', email: 'me@example.com', services: ['gmail', 'drive'] },
      { alias: 'partner', email: 'partner@example.com', services: ['gmail'] },
      { alias: 'work', email: 'work@example.com', services: ['calendar'] },
    ],
    google: (alias, call) => {
      if (call.method === 'POST' && call.url.pathname === `${GMAIL}/messages`) return { json: { id: `ins-${alias}` } };
      return mailboxes({ me: { email: 'me@example.com', messages: [] }, partner: { email: 'partner@example.com', messages: [] } }, Date.now)(alias, call);
    },
  });
  const config = ctx.config;
  const store = new AuthStore(ctx.db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: config.dcrEnabled }, silentLogger);
  const provider = new ConnectorOAuthProvider(store, clients, { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 }, silentLogger);
  const googleAuth = new GoogleAuth({ clientId: 'id', clientSecret: 'secret', redirectUri: `${ORIGIN}/auth/google/callback` }, async () => new Response('{}'));
  settings = new DigestSettingsStore(ctx.db, config.defaultTimezone);
  const digest = new DigestScheduler(settings, () => ctx, silentLogger);
  const runNow = digest.runNow.bind(digest);
  digest.runNow = () => {
    runs++;
    return runNow();
  };
  const app = createApp({ config, log: silentLogger, accounts: ctx.accounts, store, clients, provider, googleAuth, googleClient: ctx.google, tools: [], followups: ctx.followups, digest });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
  cookie = `gc_session=${encodeURIComponent(store.createSession('owner@example.com'))}`;
});

after(() => {
  server.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { redirect: 'manual', headers });
const post = (path: string, form: [string, string][], headers: Record<string, string> = { cookie: '', origin: ORIGIN }) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
const owner = () => ({ cookie, origin: ORIGIN });
const valid: [string, string][] = [
  ['enabled', 'on'],
  ['time', '07:30'],
  ['timezone', 'Europe/Paris'],
  ['lang', 'fr'],
  ['accounts', 'me'],
  ['accounts', 'partner'],
  ['deliver_to', 'partner'],
];

test('the digest card is on the admin page, for the owner only, listing the accounts with Gmail', async () => {
  const anon = await get('/admin');
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location')!, /^\/admin\/login/);
  const res = await get('/admin', { cookie });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h2>Follow-up digest<\/h2>/);
  assert.match(html, /<span class="badge warn">off<\/span>/);
  assert.match(html, /Every day at <strong>08:00<\/strong> \(Europe\/Paris\)/);
  assert.match(html, /Last run: never/);
  assert.match(html, /<input type="checkbox" name="accounts" value="me">/);
  assert.match(html, /<input type="checkbox" name="accounts" value="partner">/);
  assert.doesNotMatch(html, /name="accounts" value="work"/, 'an account without Gmail is not offered');
  assert.match(html, /<select name="deliver_to"><option value="me" selected>me<\/option><option value="partner">partner<\/option><\/select>/);
  assert.match(html, /<option value="fr">Français<\/option>/);
  assert.match(html, /action="\/admin\/digest\/send"/);
});

test('the admin page shows the server\'s memory and uptime to the owner', async () => {
  const html = await (await get('/admin', { cookie })).text();
  assert.match(html, /<h2>Server<\/h2>/);
  assert.match(html, /Process: \d+(\.\d)? MB resident, of which \d+(\.\d)? MB live objects/);
  assert.match(html, /Running for \d+ (min|h|days)\./);
});

test('saving and sending need the owner and a same-origin form', async () => {
  const noSession = await post('/admin/digest', valid, { origin: ORIGIN });
  assert.equal(noSession.status, 403);
  assert.match(await noSession.text(), /session has expired/);
  const noOrigin = await post('/admin/digest', valid, { cookie });
  assert.equal(noOrigin.status, 403);
  const crossSite = await post('/admin/digest', valid, { cookie, origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const sendCrossSite = await post('/admin/digest/send', [], { cookie, origin: 'https://evil.example' });
  assert.equal(sendCrossSite.status, 403);
  const sendNoSession = await post('/admin/digest/send', [], { origin: ORIGIN });
  assert.equal(sendNoSession.status, 403);
  assert.equal(runs, 0);
  assert.equal(settings.get().enabled, false);
});

test('invalid settings are refused with a message and change nothing', async () => {
  const cases: [string, [string, string][]][] = [
    ['Time must be written HH:MM', valid.map(([k, v]): [string, string] => [k, k === 'time' ? '25:00' : v])],
    ['Time must be written HH:MM', valid.filter(([k]) => k !== 'time')],
    ['Language must be one of', valid.map(([k, v]): [string, string] => [k, k === 'lang' ? 'de' : v])],
    ['Unknown time zone', valid.map(([k, v]): [string, string] => [k, k === 'timezone' ? 'Mars/Olympus' : v])],
    ['&quot;work&quot; is not a linked account with Gmail', [...valid, ['accounts', 'work']]],
    ['&quot;nobody&quot; is not a linked account with Gmail', valid.map(([k, v]): [string, string] => [k, k === 'deliver_to' ? 'nobody' : v])],
  ];
  for (const [message, form] of cases) {
    const res = await post('/admin/digest', form, owner());
    assert.equal(res.status, 400, message);
    assert.ok((await res.text()).includes(message), message);
  }
  assert.equal(settings.get().enabled, false);
  assert.equal(settings.get().time, '08:00');
});

test('valid settings are saved and shown', async () => {
  const res = await post('/admin/digest', valid, owner());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/admin?msg=${encodeURIComponent('Digest on: every day at 07:30 (Europe/Paris)')}`);
  const s = settings.get();
  assert.deepEqual({ enabled: s.enabled, time: s.time, timezone: s.timezone, lang: s.lang, accounts: s.accounts, deliver_to: s.deliver_to }, {
    enabled: true,
    time: '07:30',
    timezone: 'Europe/Paris',
    lang: 'fr',
    accounts: ['me', 'partner'],
    deliver_to: 'partner',
  });
  const html = await (await get('/admin', { cookie })).text();
  assert.match(html, /<span class="badge">on<\/span>/);
  assert.match(html, /<input type="checkbox" name="enabled" value="on" checked>/);
  assert.match(html, /<input type="time" name="time" value="07:30" required>/);
  assert.match(html, /name="accounts" value="partner" checked>/);
  assert.match(html, /<option value="partner" selected>partner<\/option>/);
  assert.match(html, /<option value="fr" selected>Français<\/option>/);
  assert.match(html, /Reads me, partner\./);

  // Unticking everything: off, every account, default zone.
  const off = await post('/admin/digest', [['time', '07:30'], ['lang', 'en'], ['timezone', ''], ['deliver_to', 'me']], owner());
  assert.equal(off.status, 302);
  assert.equal(off.headers.get('location'), `/admin?msg=${encodeURIComponent('Digest off')}`);
  assert.deepEqual([settings.get().enabled, settings.get().accounts, settings.get().timezone], [false, [], 'Europe/Paris']);
});

test('Send now runs the digest and says where it went', async () => {
  await post('/admin/digest', valid, owner());
  const before = runs;
  const res = await post('/admin/digest/send', [], owner());
  assert.equal(res.status, 302);
  assert.equal(runs, before + 1);
  assert.equal(res.headers.get('location'), `/admin?msg=${encodeURIComponent('Digest put in the partner inbox (0 items)')}`);
  const inserts = apiCalls(ctx).filter((c) => c.method === 'POST' && c.url.pathname === `${GMAIL}/messages`);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]!.headers['authorization'], 'Bearer token-partner');
  const html = await (await get('/admin', { cookie })).text();
  assert.match(html, /Last run: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · delivered 0 items\./);
});

test('without a chosen inbox the card names the first account with Gmail, and warns when it needs re-linking', async () => {
  settings.update({ deliver_to: null });
  ctx.accounts.markNeedsRelink('me', 'test');
  const html = await (await get('/admin', { cookie })).text();
  assert.match(html, /into the inbox of <strong>me<\/strong>/, 'not moved to partner');
  assert.match(html, /<strong>me<\/strong> needs to be re-linked: no digest is delivered until it is/);
  assert.match(html, /<option value="me" selected>me<\/option>/);
});
