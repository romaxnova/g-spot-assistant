/**
 * Thin Google REST client with account routing.
 *
 * Every call names an alias and a service. The client checks the account exists,
 * is healthy and was granted that service, attaches a fresh access token, and
 * maps Google's error shapes to messages that say what to do next.
 */
import type { AccountStore, Account } from '../accounts.js';
import { SERVICE_LABELS, type Service } from '../config.js';
import type { Logger } from '../log.js';
import { GoogleAuth, GoogleAuthError, type FetchLike } from './oauth.js';

export const API_BASE: Record<Service, string> = {
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3',
  sheets: 'https://sheets.googleapis.com/v4',
  drive: 'https://www.googleapis.com/drive/v3',
};

export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/** An error whose message is meant to be shown to Claude and the user as-is. */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | undefined,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export type QueryValue = string | number | boolean | undefined | null | Array<string | number | boolean>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute URL, or a path relative to the service base (e.g. "/messages"). */
  url: string;
  query?: Record<string, QueryValue>;
  /** Plain objects are sent as JSON; strings/Buffers are sent as-is (set contentType). */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  /** 'headers' returns the response headers (lower-case names), e.g. the Location of a resumable upload session. */
  responseType?: 'json' | 'text' | 'buffer' | 'headers';
  /** Milliseconds; defaults to 30 s. */
  timeoutMs?: number;
  /**
   * Whether the request may safely be repeated. Defaults to true for GET, PUT,
   * PATCH and DELETE and false for POST. After a timeout or a 5xx the outcome is
   * unknown, so non-idempotent requests are never retried (a retried
   * messages.send would deliver the email twice). 401 (refresh) and 429 are
   * retried regardless: Google rejected those before doing anything.
   */
  idempotent?: boolean;
  /**
   * The URL is a Google content host (e.g. a Drive thumbnail on
   * googleusercontent.com), not an API. A 401 or 403 there says nothing about
   * the account's credentials, so it neither refreshes the token nor marks the
   * account for re-linking: it is a plain GoogleApiError.
   */
  contentHost?: boolean;
  /** Whether a success counts as using the account (its "last used" time). False for background reads such as the account's own Gmail settings. Default true. */
  touch?: boolean;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface GoogleClientOptions {
  fetchImpl?: FetchLike;
  adminUrl: string;
  /** Sleep function, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [500, 1500];
/** A per-minute quota refills over the minute: waiting a few seconds gives the retry a chance. */
const RATE_LIMIT_DELAYS_MS = [2000, 6000];
/** 403 reasons that mean "too many requests right now", which Google asks clients to retry with backoff like a 429. */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);

export class GoogleClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly auth: GoogleAuth,
    private readonly log: Logger,
    private readonly opts: GoogleClientOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves an alias for a service, or throws an AccountError that explains what to do. */
  resolve(alias: string, service: Service): Account {
    const wanted = alias.trim().toLowerCase();
    const account = this.accounts.get(wanted);
    if (!account) {
      const known = this.accounts.list().map((a) => a.alias);
      throw new AccountError(
        known.length
          ? `Unknown account alias "${alias}". Linked aliases: ${known.join(', ')}. Call list_accounts to see what each one grants.`
          : `No Google accounts are linked yet. Link one at ${this.opts.adminUrl}.`,
      );
    }
    if (account.status === 'needs_relink') {
      throw new AccountError(
        `Account "${account.alias}" (${account.email}) needs to be re-linked: Google rejected its stored credential${
          account.statusDetail ? ` (${account.statusDetail})` : ''
        }. Re-link it at ${this.opts.adminUrl}.`,
      );
    }
    if (!account.services.includes(service)) {
      throw new AccountError(
        `Account "${account.alias}" (${account.email}) was not granted ${SERVICE_LABELS[service]}. It currently grants: ${
          account.services.join(', ') || 'nothing'
        }. Re-link it with ${SERVICE_LABELS[service]} enabled at ${this.opts.adminUrl}.`,
      );
    }
    return account;
  }

  /** Accounts that can be used for a service right now. */
  accountsFor(service: Service): Account[] {
    return this.accounts.list().filter((a) => a.status === 'ok' && a.services.includes(service));
  }

  /** Drops the cached access token so the next call refreshes (used after a re-link). */
  forget(alias: string): void {
    this.tokens.delete(alias);
  }

  async request<T = unknown>(alias: string, service: Service, options: RequestOptions): Promise<T> {
    const account = this.resolve(alias, service);
    const url = buildUrl(service, options);
    const method = options.method ?? 'GET';
    const idempotent = options.idempotent ?? method !== 'POST';
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      const token = await this.accessToken(account);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...options.headers };
      let body: RequestInit["body"] | undefined;
      if (options.body !== undefined) {
        if (typeof options.body === 'string' || Buffer.isBuffer(options.body) || options.body instanceof Uint8Array) {
          body = options.body as RequestInit["body"];
          headers['content-type'] = options.contentType ?? 'application/octet-stream';
        } else {
          body = JSON.stringify(options.body);
          headers['content-type'] = options.contentType ?? 'application/json';
        }
      }
      const started = Date.now();
      let res: Response;
      const timeoutMs = options.timeoutMs ?? 30_000;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        // A long transfer that timed out is not retried: another full timeout would outlast claude.ai's 240 s per tool call.
        const longTimeout = err instanceof Error && err.name === 'TimeoutError' && timeoutMs > 30_000;
        if (idempotent && !longTimeout && attempt < RETRY_DELAYS_MS.length) {
          await this.sleep(RETRY_DELAYS_MS[attempt++]!);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new GoogleApiError(
          `Network error calling ${SERVICE_LABELS[service]}: ${reason}${
            idempotent ? '' : '. The request was not retried because repeating it could duplicate its effect; check whether it went through before trying again'
          }`,
          0,
          // A timeout may mean Google is still at work (a long conversion): callers can look for the result.
          err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network',
        );
      }
      this.log.debug('google api call', { alias: account.alias, service, method, status: res.status, ms: Date.now() - started });

      if (res.ok) {
        if (options.touch !== false) this.accounts.touchUsed(account.alias);
        return (await parseResponse(res, options.responseType ?? 'json')) as T;
      }

      const err = await readError(res);
      if (options.contentHost && (res.status === 401 || res.status === 403)) {
        throw new GoogleApiError(`Google refused the content request (HTTP ${res.status})`, res.status, 'content_refused');
      }
      if (res.status === 401 && !refreshed) {
        // Access token rejected: refresh once and retry.
        refreshed = true;
        this.tokens.delete(account.alias);
        continue;
      }
      if (res.status === 401) {
        this.accounts.markNeedsRelink(account.alias, 'Google rejected the access token even after refresh');
        throw new AccountError(`Account "${account.alias}" (${account.email}) needs to be re-linked at ${this.opts.adminUrl}: Google keeps rejecting its credentials.`);
      }
      if (res.status === 403 && (err.reason === 'insufficientPermissions' || err.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || err.reason === 'forbidden' && /scope/i.test(err.message))) {
        throw new AccountError(
          `Account "${account.alias}" (${account.email}) lacks permission for this ${SERVICE_LABELS[service]} operation (Google said: ${err.message}). Re-link it with ${SERVICE_LABELS[service]} enabled at ${this.opts.adminUrl}.`,
        );
      }
      if (res.status === 403 && (err.reason === 'accessNotConfigured' || err.reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(err.message))) {
        throw new AccountError(`The ${SERVICE_LABELS[service]} API is not enabled in the Google Cloud project behind this connector. Enable it in the Google Cloud console (APIs & Services → Library) and try again.`);
      }
      // Google refused these before doing anything, so even a send is safe to repeat.
      const rateLimited = res.status === 429 || (res.status === 403 && RATE_LIMIT_REASONS.has(err.reason ?? ''));
      if (rateLimited && attempt < RATE_LIMIT_DELAYS_MS.length) {
        await this.sleep(RATE_LIMIT_DELAYS_MS[attempt++]!);
        continue;
      }
      if (rateLimited) {
        throw new GoogleApiError(
          `${SERVICE_LABELS[service]} is limiting how fast this account can make requests (${err.reason ?? `HTTP ${res.status}`}): its per-minute quota is used up, typically by a large batch such as trashing or labelling many messages. Nothing was done; wait about a minute and try again, in smaller batches if it was one.`,
          res.status,
          err.reason,
        );
      }
      if (idempotent && res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
        await this.sleep(RETRY_DELAYS_MS[attempt++]!);
        continue;
      }
      throw new GoogleApiError(
        `${SERVICE_LABELS[service]} API error ${res.status}${err.reason ? ` (${err.reason})` : ''}: ${err.message}${
          !idempotent && res.status >= 500 ? '. Not retried automatically: check whether the action went through before repeating it' : ''
        }`,
        res.status,
        err.reason,
      );
    }
  }

  /** Returns a valid access token for the account, refreshing through Google when needed. */
  async accessToken(account: Account): Promise<string> {
    const cached = this.tokens.get(account.alias);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const pending = this.inflight.get(account.alias);
    if (pending) return pending;
    const p = this.refreshToken(account).finally(() => this.inflight.delete(account.alias));
    this.inflight.set(account.alias, p);
    return p;
  }

  private async refreshToken(account: Account): Promise<string> {
    const refreshToken = this.accounts.getRefreshToken(account.alias);
    try {
      const t = await this.auth.refresh(refreshToken);
      this.tokens.set(account.alias, { token: t.access_token, expiresAt: Date.now() + Math.max(60, t.expires_in ?? 3600) * 1000 });
      this.accounts.markRefreshed(account.alias);
      return t.access_token;
    } catch (err) {
      if (err instanceof GoogleAuthError && (err.code === 'invalid_grant' || err.code === 'unauthorized_client' || err.code === 'invalid_client')) {
        const detail = err.code === 'invalid_grant' ? 'refresh token revoked or expired' : err.code;
        this.accounts.markNeedsRelink(account.alias, detail);
        this.log.warn('google refresh failed; account needs re-link', { alias: account.alias, code: err.code });
        throw new AccountError(
          `Account "${account.alias}" (${account.email}) needs to be re-linked: Google rejected its refresh token (${detail}). This happens after a password change, revoked access, or an OAuth consent screen still in "Testing" mode. Re-link it at ${this.opts.adminUrl}.`,
        );
      }
      this.log.warn('google refresh failed', { alias: account.alias, code: err instanceof GoogleAuthError ? err.code : 'unknown' });
      throw new GoogleApiError(`Could not refresh Google credentials for "${account.alias}": ${err instanceof Error ? err.message : String(err)}`, 0, 'refresh');
    }
  }
}

export function buildUrl(service: Service, options: RequestOptions): string {
  const base = options.url.startsWith('https://') ? options.url : API_BASE[service] + (options.url.startsWith('/') ? '' : '/') + options.url;
  const u = new URL(base);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
    else u.searchParams.set(k, String(v));
  }
  return u.href;
}

async function parseResponse(res: Response, type: 'json' | 'text' | 'buffer' | 'headers'): Promise<unknown> {
  if (type === 'headers') {
    await res.arrayBuffer().catch(() => undefined); // drain the body so the connection can be reused
    return Object.fromEntries(res.headers.entries());
  }
  if (res.status === 204) return type === 'json' ? {} : type === 'text' ? '' : Buffer.alloc(0);
  if (type === 'buffer') return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  if (type === 'text') return text;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleApiError('Google returned a non-JSON response', res.status, 'invalid_response');
  }
}

async function readError(res: Response): Promise<{ message: string; reason?: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; status?: string; errors?: { reason?: string; message?: string }[]; details?: { reason?: string }[] } | string;
      error_description?: string;
    };
    if (typeof parsed.error === 'string') return { message: parsed.error_description ?? parsed.error, reason: parsed.error };
    const e = parsed.error ?? {};
    const reason = e.errors?.[0]?.reason ?? e.details?.find((d) => d.reason)?.reason ?? e.status;
    return { message: (e.message ?? text ?? `HTTP ${res.status}`).slice(0, 500), reason };
  } catch {
    return { message: (text || `HTTP ${res.status}`).slice(0, 300) };
  }
}
