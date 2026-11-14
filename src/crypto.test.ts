import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciphertextKeyId, constantTimeEqual, decrypt, DecryptError, encrypt, keyId, randomToken, sha256Hex } from './crypto.js';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

test('encrypt/decrypt round trip with random iv', () => {
  const a = encrypt('1//refresh-token-ünïcode', k1);
  const b = encrypt('1//refresh-token-ünïcode', k1);
  assert.notEqual(a, b, 'iv must differ');
  assert.equal(decrypt(a, [k1]), '1//refresh-token-ünïcode');
  assert.equal(ciphertextKeyId(a), keyId(k1));
});

test('decrypt picks the right key by id and refuses unknown keys', () => {
  const c = encrypt('secret', k2);
  assert.equal(decrypt(c, [k1, k2]), 'secret');
  assert.throws(() => decrypt(c, [k1]), DecryptError);
});

test('tampered ciphertext fails authentication', () => {
  const c = encrypt('secret', k1);
  const parts = c.split('.');
  const ct = Buffer.from(parts[3]!, 'base64url');
  ct[0] = ct[0]! ^ 0xff;
  parts[3] = ct.toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), [k1]), DecryptError);
  assert.throws(() => decrypt('garbage', [k1]), DecryptError);
});

test('random tokens are url-safe and unique; hashes are stable', () => {
  const t = randomToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, randomToken());
  assert.equal(sha256Hex('a'), sha256Hex('a'));
  assert.ok(constantTimeEqual('abc', 'abc'));
  assert.ok(!constantTimeEqual('abc', 'abd'));
  assert.ok(!constantTimeEqual('abc', 'ab'));
});
