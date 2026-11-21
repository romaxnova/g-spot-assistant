import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../test-support.js';
import { page, setSourceLink } from './html.js';
import { setupSteps, sharedKeyNote } from './routes.js';

test('a fresh install shows the remaining setup steps with its own addresses', () => {
  const html = setupSteps(testConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }));
  assert.match(html, /redirect URI <code class="pick">https:\/\/connector\.test\/auth\/google\/callback<\/code>/, 'the redirect URI to paste into Google Cloud');
  assert.match(html, /privacy policy <code class="pick">https:\/\/connector\.test\/privacy<\/code>/);
  assert.match(html, /authorized domain <code class="pick">connector\.test<\/code>/);
  assert.match(html, /<code>GOOGLE_CLIENT_ID<\/code> and <code>GOOGLE_CLIENT_SECRET<\/code>/);
  assert.match(html, /paste <code class="pick">https:\/\/connector\.test\/mcp<\/code>/);
  assert.match(html, /flows\/enableapi\?apiid=gmail\.googleapis\.com,calendar-json\.googleapis\.com,sheets\.googleapis\.com,drive\.googleapis\.com/, 'the four APIs in one link');
  assert.match(html, /shared Google key/, 'the shortcut for a key someone shared');
  assert.match(html, /href="https:\/\/github\.com\/romaxnova\/g-spot-assistant\/blob\/main\/docs\/SETUP\.md"/);
  assert.match(setupSteps(testConfig({ SOURCE_URL: 'https://example.org/fork' })), /href="https:\/\/example\.org\/fork">setup guide/, 'a source elsewhere is linked as it is');
});

test('every page links to the source code, as the AGPL asks of modified copies', () => {
  try {
    setSourceLink('https://example.org/fork?a=1&b="2"');
    const html = page({ title: 'T', body: '<p>x</p>' });
    assert.match(html, /<footer class="muted">G-Spot Assistant [\d.]+ · free software under the GNU AGPL v3 · <a href="https:\/\/example\.org\/fork\?a=1&amp;b=&quot;2&quot;">source code<\/a><\/footer><\/body>/);
  } finally {
    setSourceLink(testConfig().sourceUrl);
  }
});

test('a configured server tells how to use a Google key someone shared', () => {
  const html = sharedKeyNote(testConfig());
  assert.match(html, /redirect URI <code class="pick">https:\/\/connector\.test\/auth\/google\/callback<\/code>/);
  assert.match(html, /authorized domain <code class="pick">connector\.test<\/code>/);
});
