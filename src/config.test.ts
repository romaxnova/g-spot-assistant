import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, parseKey } from './config.js';
import { testEnv } from './test-support.js';

test('loads a valid configuration with defaults', () => {
  const c = loadConfig(testEnv());
  assert.equal(c.baseUrl.href, 'https://connector.test/');
  assert.equal(c.mcpUrl.href, 'https://connector.test/mcp');
  assert.deepEqual(c.ownerEmails, ['owner@example.com']);
  assert.equal(c.dcrEnabled, true);
  assert.equal(c.trustProxy, 1);
  assert.deepEqual(c.cimdAllowedHosts, ['claude.ai']);
  assert.ok(c.allowedRedirectUris.includes('https://claude.ai/api/mcp/auth_callback'));
  assert.equal(c.refreshTokenTtlSeconds, 90 * 86400);
});

test('rejects missing and malformed values', () => {
  assert.throws(() => loadConfig(testEnv({ BASE_URL: '' })), ConfigError);
  assert.throws(() => loadConfig(testEnv({ BASE_URL: 'http://example.com' })), /https/);
  assert.throws(() => loadConfig(testEnv({ BASE_URL: 'https://example.com/path' })), /origin only/);
  assert.throws(() => loadConfig(testEnv({ TOKEN_ENCRYPTION_KEY: 'short' })), /32 bytes/);
  assert.throws(() => loadConfig(testEnv({ OWNER_EMAILS: 'nope' })), /email/);
  assert.throws(() => loadConfig(testEnv({ MCP_PATH: '/' })), /MCP_PATH/);
  assert.throws(() => loadConfig(testEnv({ DCR_ENABLED: 'maybe' })), /true or false/);
});

test('parses keys in hex and base64 and normalizes lists', () => {
  assert.equal(parseKey('K', '00'.repeat(32)).length, 32);
  assert.equal(parseKey('K', Buffer.alloc(32, 3).toString('base64')).length, 32);
  const c = loadConfig(testEnv({ OWNER_EMAILS: 'A@x.com, b@y.com', EXTRA_REDIRECT_URIS: 'http://localhost:6274/oauth/callback', ANTHROPIC_IP_LOCK: 'true' }));
  assert.deepEqual(c.ownerEmails, ['a@x.com', 'b@y.com']);
  assert.ok(c.allowedRedirectUris.includes('http://localhost:6274/oauth/callback'));
  assert.equal(c.anthropicIpLock, true);
  assert.deepEqual(c.anthropicIpRanges, ['160.79.104.0/21']);
});

test('starts without Google credentials but flags them as missing', () => {
  const c = loadConfig(testEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }));
  assert.equal(c.googleConfigured, false);
  assert.equal(loadConfig(testEnv()).googleConfigured, true);
});

test('the public address comes from the host when BASE_URL is not set', () => {
  const railway = loadConfig(testEnv({ BASE_URL: '', RAILWAY_PUBLIC_DOMAIN: 'assistant-production.up.railway.app' }));
  assert.equal(railway.baseUrl.origin, 'https://assistant-production.up.railway.app');
  assert.equal(railway.mcpUrl.href, 'https://assistant-production.up.railway.app/mcp');
  assert.equal(loadConfig(testEnv({ BASE_URL: '', RENDER_EXTERNAL_URL: 'https://assistant.onrender.com' })).baseUrl.origin, 'https://assistant.onrender.com');
  assert.equal(loadConfig(testEnv({ RAILWAY_PUBLIC_DOMAIN: 'other.up.railway.app' })).baseUrl.origin, 'https://connector.test', 'BASE_URL wins');
  assert.throws(() => loadConfig(testEnv({ BASE_URL: '' })), /Missing BASE_URL/);
});

test('on Railway, data goes to the volume, and a missing volume is pointed out', () => {
  const railway = { RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e' };
  const withVolume = loadConfig(testEnv({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data', DB_PATH: '' }));
  assert.equal(withVolume.dataDir, '/data');
  assert.equal(withVolume.dbPath, '/data/connector.sqlite');
  assert.equal(withVolume.storageWarning, undefined);
  assert.equal(loadConfig(testEnv({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/var/lib/assistant/' })).dataDir, '/var/lib/assistant/');
  assert.equal(loadConfig(testEnv({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/data/db' })).storageWarning, undefined);
  assert.match(loadConfig(testEnv(railway)).storageWarning ?? '', /No volume is attached/);
  assert.match(loadConfig(testEnv({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/app/data' })).storageWarning ?? '', /not on the volume mounted at \/data/);
  assert.match(loadConfig(testEnv({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/database' })).storageWarning ?? '', /not on the volume/);
  assert.equal(loadConfig(testEnv({ DATA_DIR: '' })).dataDir, '/data', 'elsewhere: /data, as in the Docker image');
  assert.equal(loadConfig(testEnv()).storageWarning, undefined, 'not on Railway: nothing to say');
});

test('the default time zone is UTC, checked and spelled canonically; the source link is an https URL', () => {
  assert.equal(loadConfig(testEnv({ DEFAULT_TIMEZONE: '' })).defaultTimezone, 'UTC');
  assert.equal(loadConfig(testEnv({ DEFAULT_TIMEZONE: 'europe/paris' })).defaultTimezone, 'Europe/Paris');
  assert.throws(() => loadConfig(testEnv({ DEFAULT_TIMEZONE: 'Europe/Pariss' })), /not an IANA time zone/);
  assert.equal(loadConfig(testEnv()).sourceUrl, 'https://github.com/romaxnova/g-spot-assistant');
  assert.equal(loadConfig(testEnv({ SOURCE_URL: 'https://example.org/fork' })).sourceUrl, 'https://example.org/fork');
  assert.throws(() => loadConfig(testEnv({ SOURCE_URL: 'javascript:alert(1)' })), /SOURCE_URL/);
  assert.equal(loadConfig(testEnv()).serverName, 'G-Spot Assistant');
});
