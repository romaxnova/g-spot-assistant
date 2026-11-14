/**
 * Test helpers: in-memory database, a fake Google that records every call, and
 * a ready-made ToolContext. Used by unit tests only (compiled into dist like the rest).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { openDatabase, type Db } from './db.js';
import { AccountStore, scopesForServices } from './accounts.js';
import { loadConfig, SERVICES, type Config, type Service } from './config.js';
import { GoogleAuth, GOOGLE_TOKEN_URL } from './google/oauth.js';
import { GoogleClient } from './google/client.js';
import { silentLogger } from './log.js';
import type { ToolContext } from './mcp/registry.js';
import { UploadStore } from './uploads.js';
import { FollowupStore } from './followups/store.js';
import { SensitiveContactsStore } from './contacts/sensitive-store.js';
import { ScheduledSendStore } from './mail/scheduled-store.js';

export const TEST_KEY = Buffer.alloc(32, 7);

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    BASE_URL: 'https://connector.test',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    OWNER_EMAILS: 'owner@example.com',
    TOKEN_ENCRYPTION_KEY: TEST_KEY.toString('base64'),
    DB_PATH: ':memory:',
    DEFAULT_TIMEZONE: 'Europe/Paris',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(testEnv(overrides));
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Request body as UTF-8 text, when there was one. */
  body?: string;
  /** Parsed body when the content type was JSON. */
  json?: unknown;
  /**
   * The random tag a Drive create carries (appProperties.connectorCreate), taken out of body and json so tests can
   * compare a create's metadata as written; tests of the tag itself read it here.
   */
  createTag?: string;
}

const CREATE_TAG_RE = /,?"appProperties":\{"connectorCreate":"([A-Za-z0-9_-]+)"\}/;

/** Takes the per-create tag out of a recorded body (see RecordedCall.createTag). */
function untagged(body: string | undefined): { body: string | undefined; tag?: string } {
  const m = body ? CREATE_TAG_RE.exec(body) : null;
  return m ? { body: body!.replace(CREATE_TAG_RE, '').replace('{,', '{'), tag: m[1] } : { body };
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  body?: Buffer;
  headers?: Record<string, string>;
}

export type FakeGoogle = (call: RecordedCall) => FakeResponse | Response | undefined | Promise<FakeResponse | Response | undefined>;

export function toResponse(r: FakeResponse | Response | undefined): Response {
  if (r instanceof Response) return r;
  if (!r) {
    return new Response(JSON.stringify({ error: { code: 404, message: 'No fake route matched', errors: [{ reason: 'notFound' }] } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  const status = r.status ?? 200;
  if (r.body) return new Response(new Uint8Array(r.body), { status, headers: r.headers });
  if (r.text !== undefined) return new Response(r.text, { status, headers: { 'content-type': 'text/plain', ...r.headers } });
  return new Response(JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json', ...r.headers } });
}

function normalizeHeaders(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

/** A fetch() that answers Google's token endpoint itself and routes everything else to `handler`. */
export function fakeFetch(handler: FakeGoogle, calls: RecordedCall[] = []): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = normalizeHeaders(init?.headers);
    const raw = init?.body;
    let body: string | undefined;
    if (typeof raw === 'string') body = raw;
    else if (raw instanceof Uint8Array) body = Buffer.from(raw).toString('utf8');
    else if (raw instanceof URLSearchParams) body = raw.toString();
    const { body: plainBody, tag: createTag } = untagged(body);
    body = plainBody;
    let json: unknown;
    if (body && (headers['content-type'] ?? '').includes('application/json')) {
      try {
        json = JSON.parse(body);
      } catch {
        /* not JSON */
      }
    }
    const call: RecordedCall = { method: (init?.method ?? 'GET').toUpperCase(), url, headers, body, json, createTag };
    calls.push(call);
    if (url.href === GOOGLE_TOKEN_URL) {
      return toResponse({ json: { access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer', scope: 'openid email' } });
    }
    return toResponse(await handler(call));
  };
  return impl as typeof fetch;
}

export interface TestAccountSpec {
  alias: string;
  email?: string;
  services?: Service[];
  status?: 'ok' | 'needs_relink';
}

export interface TestContext extends ToolContext {
  db: Db;
  /** Every fetch made, including token refreshes. See apiCalls() for API calls only. */
  calls: RecordedCall[];
}

export function createTestContext(opts: { accounts?: TestAccountSpec[]; google?: FakeGoogle; config?: Record<string, string> } = {}): TestContext {
  const config = testConfig(opts.config);
  const db = openDatabase(':memory:');
  const accounts = new AccountStore(db, config.encryptionKey);
  for (const a of opts.accounts ?? [{ alias: 'me', services: [...SERVICES] }]) {
    const services = a.services ?? [...SERVICES];
    accounts.upsertLinked({
      alias: a.alias,
      email: a.email ?? `${a.alias}@example.com`,
      googleSub: `sub-${a.alias}`,
      refreshToken: `refresh-${a.alias}`,
      grantedScopes: ['openid', 'email', ...scopesForServices(services)],
      requestedServices: services,
    });
    if (a.status === 'needs_relink') accounts.markNeedsRelink(a.alias, 'test');
  }
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(opts.google ?? (() => undefined), calls);
  const auth = new GoogleAuth({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: 'https://connector.test/auth/google/callback' }, fetchImpl);
  const google = new GoogleClient(accounts, auth, silentLogger, { adminUrl: 'https://connector.test/admin', fetchImpl, sleep: async () => {} });
  return { config, accounts, google, log: silentLogger, db, calls, uploads: new UploadStore(), followups: new FollowupStore(db, [config.encryptionKey]), sensitive: new SensitiveContactsStore(db, [config.encryptionKey]), schedules: new ScheduledSendStore(db) };
}

/**
 * A context whose fake Google knows which account calls: each account's access token is `token-<alias>`, and
 * `handler` gets the alias back with the call. For tools that hit the same URLs in several accounts.
 */
export function createMultiAccountContext(opts: {
  accounts: TestAccountSpec[];
  google: (alias: string, call: RecordedCall) => FakeResponse | Response | undefined | Promise<FakeResponse | Response | undefined>;
  config?: Record<string, string>;
}): TestContext {
  const ctx = createTestContext({ accounts: opts.accounts, config: opts.config });
  const api = fakeFetch((call) => opts.google((call.headers['authorization'] ?? '').replace('Bearer token-', ''), call), ctx.calls);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) return api(input, init);
    const alias = new URLSearchParams(String(init?.body)).get('refresh_token')!.replace('refresh-', '');
    return new Response(JSON.stringify({ access_token: `token-${alias}`, expires_in: 3600, token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const auth = new GoogleAuth({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://connector.test/auth/google/callback' }, fetchImpl);
  ctx.google = new GoogleClient(ctx.accounts, auth, silentLogger, { adminUrl: 'https://connector.test/admin', fetchImpl, sleep: async () => {} });
  return ctx;
}

/**
 * Calls made to Google APIs. Token refreshes and reads of Gmail's send-as settings (the account's name and
 * signature, read once and cached) are filtered out; tests of those look at ctx.calls.
 */
export function apiCalls(ctx: TestContext): RecordedCall[] {
  return ctx.calls.filter((c) => c.url.href !== GOOGLE_TOKEN_URL && !c.url.pathname.endsWith('/settings/sendAs'));
}

export function resultText(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('tool result has no text content');
  return first.text;
}

export function resultJson<T = Record<string, unknown>>(result: CallToolResult): T {
  return JSON.parse(resultText(result)) as T;
}
