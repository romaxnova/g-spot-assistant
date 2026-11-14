import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from './session.js';

const O = 'https://connector.test';

test('CSRF check accepts our origin and same-origin fetch metadata, refuses everything else', () => {
  assert.ok(isSameOriginRequest({ origin: O }, O));
  assert.ok(isSameOriginRequest({ origin: 'null', 'sec-fetch-site': 'same-origin' }, O));
  assert.ok(isSameOriginRequest({ 'sec-fetch-site': 'same-origin' }, O));
  assert.ok(!isSameOriginRequest({ origin: 'https://evil.com', 'sec-fetch-site': 'same-origin' }, O), 'a real foreign origin always loses');
  assert.ok(!isSameOriginRequest({ origin: 'null', 'sec-fetch-site': 'cross-site' }, O));
  assert.ok(!isSameOriginRequest({ origin: 'null', 'sec-fetch-site': 'same-site' }, O), 'sibling *.up.railway.app apps are not us');
  assert.ok(!isSameOriginRequest({ origin: 'null' }, O));
  assert.ok(!isSameOriginRequest({}, O));
});
