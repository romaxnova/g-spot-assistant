import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidr, parseCidr } from './app.js';

test('CIDR parsing and matching', () => {
  const c = parseCidr('160.79.104.0/21')!;
  assert.ok(c);
  const ip = (s: string) => {
    const o = s.split('.').map(Number);
    return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
  };
  assert.ok(ipInCidr(ip('160.79.104.1'), c));
  assert.ok(ipInCidr(ip('160.79.111.255'), c));
  assert.ok(!ipInCidr(ip('160.79.112.0'), c));
  assert.ok(!ipInCidr(ip('10.0.0.1'), c));
  assert.equal(parseCidr('nonsense'), undefined);
  assert.equal(parseCidr('1.2.3.4/33'), undefined);
});

test('invite tokens never reach the request log', async () => {
  const { loggablePath } = await import('./app.js');
  assert.equal(loggablePath('/link/AbC123_-xyz'), '/link/:token');
  assert.equal(loggablePath('/link/AbC123_-xyz/start?x=1'), '/link/:token/start');
  assert.equal(loggablePath('/consent?req=secret'), '/consent');
  assert.equal(loggablePath('/mcp'), '/mcp');
  assert.equal(loggablePath('/admin/../mcp?x=1'), '/mcp');
  for (const target of ['/UPLOAD/secret-token', '//upload/secret-token', '/%75pload/secret-token', 'http://host/upload/secret-token?x=1', '/upload//secret-token', '/Link/secret-token', '/./upload/secret-token', '/x/../upload/secret-token', '/x/%2e%2e/upload/secret-token']) {
    assert.ok(!loggablePath(target).includes('secret-token'), target);
  }
  assert.equal(loggablePath('/upload/Zm9vYmFyYmF6_-q?filename=a.pdf'), '/upload/:token');
  const { rpcSummary } = await import('./app.js');
  assert.equal(rpcSummary({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gmail_send', arguments: { body_text: 'secret' } } }), 'tools/call:gmail_send');
  assert.equal(rpcSummary([{ method: 'initialize' }, { jsonrpc: '2.0', id: 2, result: {} }]), 'initialize,response');
  assert.equal(rpcSummary(undefined), 'invalid');
});
