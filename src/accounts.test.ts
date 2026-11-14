import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.js';
import { AccountStore, ALIAS_RE, scopesForServices, servicesFromScopes } from './accounts.js';
import { SERVICE_SCOPES } from './config.js';
import { ciphertextKeyId, keyId } from './crypto.js';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

test('alias rules and scope mapping', () => {
  assert.ok(ALIAS_RE.test('me'));
  assert.ok(ALIAS_RE.test('team_2'));
  assert.ok(!ALIAS_RE.test('Me'));
  assert.ok(!ALIAS_RE.test('-x'));
  assert.deepEqual(scopesForServices(['gmail', 'drive']), [SERVICE_SCOPES.gmail, SERVICE_SCOPES.drive]);
  assert.deepEqual(servicesFromScopes(['openid', SERVICE_SCOPES.drive, 'x']), ['drive']);
});

test('link, status changes, decrypt and remove', () => {
  const db = openDatabase(':memory:');
  const store = new AccountStore(db, k1);
  const a = store.upsertLinked({
    alias: 'me',
    email: 'Me@Example.com',
    googleSub: 's1',
    label: 'main',
    refreshToken: 'rt-1',
    grantedScopes: ['openid', 'email', SERVICE_SCOPES.gmail],
    requestedServices: ['gmail', 'drive'],
  });
  assert.equal(a.email, 'me@example.com');
  assert.deepEqual(a.services, ['gmail']);
  assert.deepEqual(a.requestedServices, ['gmail', 'drive']);
  assert.equal(store.getRefreshToken('me'), 'rt-1');
  store.markNeedsRelink('me', 'invalid_grant');
  assert.equal(store.get('me')!.status, 'needs_relink');
  // Re-linking resets the status, replaces the token, keeps the label when none is given.
  store.upsertLinked({ alias: 'me', email: 'me@example.com', googleSub: 's1', refreshToken: 'rt-2', grantedScopes: [SERVICE_SCOPES.gmail, SERVICE_SCOPES.drive], requestedServices: ['gmail', 'drive'] });
  const b = store.get('me')!;
  assert.equal(b.status, 'ok');
  assert.equal(b.label, 'main');
  assert.deepEqual(b.services, ['gmail', 'drive']);
  assert.equal(store.getRefreshToken('me'), 'rt-2');
  assert.ok(store.remove('me'));
  assert.equal(store.get('me'), undefined);
  assert.throws(() => store.getRefreshToken('me'));
});

test('key rotation re-encrypts rows written with the previous key', () => {
  const db = openDatabase(':memory:');
  const old = new AccountStore(db, k1);
  old.upsertLinked({ alias: 'a', email: 'a@x', googleSub: null, refreshToken: 'rt-a', grantedScopes: [], requestedServices: [] });
  const rotated = new AccountStore(db, k2, k1);
  assert.equal(rotated.getRefreshToken('a'), 'rt-a');
  assert.equal(rotated.reencryptWithCurrentKey(), 1);
  assert.equal(rotated.reencryptWithCurrentKey(), 0);
  const row = db.prepare('SELECT refresh_token_enc FROM accounts WHERE alias = ?').get('a') as { refresh_token_enc: string };
  assert.equal(ciphertextKeyId(row.refresh_token_enc), keyId(k2));
  const withoutOld = new AccountStore(db, k2);
  assert.equal(withoutOld.getRefreshToken('a'), 'rt-a');
});
