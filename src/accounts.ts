/**
 * Linked Google accounts: one row per alias, refresh token encrypted at rest.
 */
import type { Db } from './db.js';
import { now } from './db.js';
import { decrypt, encrypt, ciphertextKeyId, keyId } from './crypto.js';
import { SERVICES, SERVICE_SCOPES, type Service } from './config.js';

export type AccountStatus = 'ok' | 'needs_relink';

export interface Account {
  alias: string;
  email: string;
  googleSub: string | null;
  label: string | null;
  /** Scopes Google actually granted (may be fewer than requested if boxes were unticked). */
  grantedScopes: string[];
  /** Services chosen on the link form. */
  requestedServices: Service[];
  /** Services usable right now, derived from grantedScopes. */
  services: Service[];
  status: AccountStatus;
  statusDetail: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastRefreshAt: number | null;
}

export const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isService(value: string): value is Service {
  return (SERVICES as readonly string[]).includes(value);
}

export function scopesForServices(services: readonly Service[]): string[] {
  return services.map((s) => SERVICE_SCOPES[s]);
}

export function servicesFromScopes(scopes: readonly string[]): Service[] {
  return SERVICES.filter((s) => scopes.includes(SERVICE_SCOPES[s]));
}

interface AccountRow {
  alias: string;
  email: string;
  google_sub: string | null;
  label: string | null;
  refresh_token_enc: string;
  granted_scopes: string;
  requested_services: string;
  status: string;
  status_detail: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  last_refresh_at: number | null;
}

function rowToAccount(r: AccountRow): Account {
  const grantedScopes = r.granted_scopes.split(' ').filter(Boolean);
  return {
    alias: r.alias,
    email: r.email,
    googleSub: r.google_sub,
    label: r.label,
    grantedScopes,
    requestedServices: r.requested_services.split(',').filter(isService),
    services: servicesFromScopes(grantedScopes),
    status: r.status === 'needs_relink' ? 'needs_relink' : 'ok',
    statusDetail: r.status_detail,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    lastRefreshAt: r.last_refresh_at === null ? null : Number(r.last_refresh_at),
  };
}

export interface LinkInput {
  alias: string;
  email: string;
  googleSub: string | null;
  label?: string | null;
  refreshToken: string;
  grantedScopes: string[];
  requestedServices: Service[];
}

export class AccountStore {
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    private readonly currentKey: Buffer,
    previousKey?: Buffer,
  ) {
    this.keys = previousKey ? [currentKey, previousKey] : [currentKey];
  }

  list(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as unknown as AccountRow[];
    return rows.map(rowToAccount);
  }

  get(alias: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE alias = ?').get(alias) as unknown as AccountRow | undefined;
    return row ? rowToAccount(row) : undefined;
  }

  /** Decrypts and returns the Google refresh token for an alias. Never log the result. */
  getRefreshToken(alias: string): string {
    const row = this.db.prepare('SELECT refresh_token_enc FROM accounts WHERE alias = ?').get(alias) as
      | { refresh_token_enc: string }
      | undefined;
    if (!row) throw new Error(`No account with alias ${alias}`);
    return decrypt(row.refresh_token_enc, this.keys);
  }

  /** Creates or replaces the link for an alias (linking and re-linking use the same path). */
  upsertLinked(input: LinkInput): Account {
    const t = now();
    const enc = encrypt(input.refreshToken, this.currentKey);
    this.db
      .prepare(
        `INSERT INTO accounts (alias, email, google_sub, label, refresh_token_enc, granted_scopes, requested_services, status, status_detail, created_at, updated_at, last_refresh_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET
           email = excluded.email,
           google_sub = excluded.google_sub,
           label = COALESCE(excluded.label, accounts.label),
           refresh_token_enc = excluded.refresh_token_enc,
           granted_scopes = excluded.granted_scopes,
           requested_services = excluded.requested_services,
           status = 'ok',
           status_detail = NULL,
           updated_at = excluded.updated_at,
           last_refresh_at = excluded.last_refresh_at`,
      )
      .run(
        input.alias,
        input.email.toLowerCase(),
        input.googleSub,
        input.label ?? null,
        enc,
        input.grantedScopes.join(' '),
        input.requestedServices.join(','),
        t,
        t,
        t,
      );
    return this.get(input.alias)!;
  }

  markNeedsRelink(alias: string, detail: string): void {
    this.db
      .prepare(`UPDATE accounts SET status = 'needs_relink', status_detail = ?, updated_at = ? WHERE alias = ?`)
      .run(detail.slice(0, 200), now(), alias);
  }

  markRefreshed(alias: string): void {
    this.db.prepare(`UPDATE accounts SET status = 'ok', status_detail = NULL, last_refresh_at = ? WHERE alias = ?`).run(now(), alias);
  }

  touchUsed(alias: string): void {
    this.db.prepare('UPDATE accounts SET last_used_at = ? WHERE alias = ?').run(now(), alias);
  }

  setLabel(alias: string, label: string | null): void {
    this.db.prepare('UPDATE accounts SET label = ?, updated_at = ? WHERE alias = ?').run(label, now(), alias);
  }

  remove(alias: string): boolean {
    return Number(this.db.prepare('DELETE FROM accounts WHERE alias = ?').run(alias).changes) > 0;
  }

  /**
   * Re-encrypts every refresh token that was encrypted with a key other than the
   * current one (used after rotating TOKEN_ENCRYPTION_KEY). Returns how many rows changed.
   */
  reencryptWithCurrentKey(): number {
    const rows = this.db.prepare('SELECT alias, refresh_token_enc FROM accounts').all() as unknown as {
      alias: string;
      refresh_token_enc: string;
    }[];
    const current = keyId(this.currentKey);
    let changed = 0;
    for (const row of rows) {
      if (ciphertextKeyId(row.refresh_token_enc) === current) continue;
      const plain = decrypt(row.refresh_token_enc, this.keys);
      this.db.prepare('UPDATE accounts SET refresh_token_enc = ? WHERE alias = ?').run(encrypt(plain, this.currentKey), row.alias);
      changed++;
    }
    return changed;
  }
}
