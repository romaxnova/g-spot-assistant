/**
 * Using a Google key someone shares from their own server (SHARED_KEY_SERVER), instead of copying
 * the client ID and secret by hand. The friend presses one button on the setup page; this server asks
 * the key's server, shows a short code to read out to its owner, and once approved fetches the key,
 * keeps it encrypted, and uses it right away (no restart). It checks again every few hours, so a new
 * secret arrives by itself and a removed server stops using the key.
 * Variables set by hand (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) always win: then this stays off.
 */
import { Router, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { constantTimeEqual, decrypt, encrypt, randomToken } from '../crypto.js';
import type { GoogleOAuthConfig } from '../google/oauth.js';
import type { Logger } from '../log.js';

export type MemberStatus = 'none' | 'pending' | 'approved' | 'declined' | 'removed' | 'error';

export interface MemberView {
  status: MemberStatus;
  /** Who shares the key, as named in SHARED_KEY_OWNER. */
  owner: string;
  name?: string;
  checkCode?: string;
  error?: string;
}

interface Row {
  hub: string;
  request_enc: string;
  name: string;
  check_code: string | null;
  status: MemberStatus;
  key_enc: string | null;
  last_error: string | null;
  asked_at: number;
  checked_at: number | null;
}

interface SharedKey {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  statePrefix: string;
}

/** Waiting for approval: checked every minute for a day, then every 10 minutes. */
const PENDING_FAST_MS = 24 * 3600 * 1000;
/** Approved: checked every 6 hours (a new secret, or the server removed). */
const APPROVED_EVERY_MS = 6 * 3600 * 1000;

export class KeyShareMember {
  private readonly hub: string;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    /** The live Google settings: filled in place when the key arrives. */
    private readonly googleCfg: GoogleOAuthConfig,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {
    this.hub = config.sharedKeyServer!.origin;
    db.exec(`CREATE TABLE IF NOT EXISTS key_share_member (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hub TEXT NOT NULL,
      request_enc TEXT NOT NULL,
      name TEXT NOT NULL,
      check_code TEXT,
      status TEXT NOT NULL,
      key_enc TEXT,
      last_error TEXT,
      asked_at INTEGER NOT NULL,
      checked_at INTEGER
    )`);
  }

  private get keys(): Buffer[] {
    return [this.config.encryptionKey, this.config.encryptionKeyPrevious].filter((k): k is Buffer => Boolean(k));
  }

  private row(): Row | undefined {
    const r = this.db.prepare('SELECT * FROM key_share_member WHERE id = 1').get() as unknown as Row | undefined;
    // A request made to another key server is not this one's.
    return r && r.hub === this.hub ? r : undefined;
  }

  private requestId(r: Row): string | undefined {
    try {
      return decrypt(r.request_enc, this.keys);
    } catch {
      return undefined;
    }
  }

  view(): MemberView {
    const r = this.row();
    const owner = this.config.sharedKeyOwner;
    if (!r) return { status: 'none', owner };
    return { status: r.status, owner, name: r.name, ...(r.check_code ? { checkCode: r.check_code } : {}), ...(r.last_error ? { error: r.last_error } : {}) };
  }

  /** Uses the key kept from an earlier approval, at start-up. */
  applyStored(): void {
    const r = this.row();
    if (r?.status !== 'approved' || !r.key_enc) return;
    try {
      this.apply(JSON.parse(decrypt(r.key_enc, this.keys)) as SharedKey);
      this.log.info('using the shared google key', { from: this.hub });
    } catch {
      this.log.warn('the shared google key kept here cannot be read (the encryption key changed?): ask for it again');
    }
  }

  /** Whether `id` is the request this server is making (the key's server checks it). */
  proves(id: string): boolean {
    const r = this.row();
    const mine = r && (r.status === 'pending' || r.status === 'error') ? this.requestId(r) : undefined;
    return Boolean(mine && constantTimeEqual(mine, id));
  }

  /** Asks the key's server; returns what to show. */
  async ask(name: string): Promise<MemberView> {
    const clean = name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
    if (!clean) return { ...this.view(), status: 'error', error: 'Write your name, so the key owner knows who is asking.' };
    const prev = this.row();
    if (prev?.status === 'pending' && this.now() - prev.asked_at < 60_000) return this.view();
    const requestId = randomToken(32);
    this.db
      .prepare("INSERT OR REPLACE INTO key_share_member (id, hub, request_enc, name, check_code, status, key_enc, last_error, asked_at, checked_at) VALUES (1, ?, ?, ?, NULL, 'error', NULL, NULL, ?, NULL)")
      .run(this.hub, encrypt(requestId, this.config.encryptionKey), clean, this.now());
    try {
      const res = await this.fetchImpl(`${this.hub}/key-share/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ origin: this.config.baseUrl.origin, name: clean, request_id: requestId }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { checkCode?: string; error?: string };
      if (!res.ok || !body.checkCode) throw new Error(body.error ?? `the key server answered HTTP ${res.status}`);
      this.db.prepare("UPDATE key_share_member SET status = 'pending', check_code = ? WHERE id = 1").run(String(body.checkCode).slice(0, 12));
      this.log.info('asked for the shared google key', { from: this.hub });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.db.prepare('UPDATE key_share_member SET last_error = ? WHERE id = 1').run(`Could not reach ${this.config.sharedKeyOwner}'s server (${new URL(this.hub).hostname}): ${why.slice(0, 200)}. Try again in a moment.`);
      this.log.warn('could not ask for the shared google key', { error: why.slice(0, 200) });
    }
    return this.view();
  }

  /** Checks the request (or the approved key) when it is due; `force` checks now. */
  async check(force = false): Promise<void> {
    const r = this.row();
    if (!r || this.busy || (r.status !== 'pending' && r.status !== 'approved')) return;
    const since = this.now() - (r.checked_at ?? 0);
    const every = r.status === 'approved' ? APPROVED_EVERY_MS : this.now() - r.asked_at < PENDING_FAST_MS ? 55_000 : 10 * 60_000;
    if (!force && since < every) return;
    const id = this.requestId(r);
    if (!id) return;
    this.busy = true;
    try {
      const res = await this.fetchImpl(`${this.hub}/key-share/status`, { headers: { authorization: `Bearer ${id}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = (await res.json()) as { status?: string; client_id?: string; client_secret?: string; redirect_uri?: string; state_prefix?: string };
      this.db.prepare('UPDATE key_share_member SET checked_at = ?, last_error = NULL WHERE id = 1').run(this.now());
      if (s.status === 'approved' && s.client_id && s.client_secret && s.redirect_uri && s.state_prefix) {
        const key: SharedKey = { clientId: s.client_id, clientSecret: s.client_secret, redirectUri: s.redirect_uri, statePrefix: s.state_prefix };
        if (!new URL(key.redirectUri).href.startsWith(`${this.hub}/`)) throw new Error('the key server sent a redirect URI elsewhere');
        this.db.prepare("UPDATE key_share_member SET status = 'approved', key_enc = ? WHERE id = 1").run(encrypt(JSON.stringify(key), this.config.encryptionKey));
        if (r.status !== 'approved') this.log.info('the shared google key was approved', { from: this.hub });
        this.apply(key);
      } else if (s.status === 'declined' || s.status === 'removed' || s.status === 'unknown') {
        const status: MemberStatus = s.status === 'declined' ? 'declined' : 'removed';
        this.db.prepare('UPDATE key_share_member SET status = ?, key_enc = NULL WHERE id = 1').run(status);
        this.log.warn(`the shared google key was ${status === 'declined' ? 'declined' : 'withdrawn'}`, { from: this.hub });
        this.unapply();
      }
    } catch (err) {
      // The key server being away changes nothing: an approved key keeps working.
      this.db.prepare('UPDATE key_share_member SET checked_at = ?, last_error = ? WHERE id = 1').run(this.now(), `Could not reach the key server: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.check(), 30_000);
    this.timer.unref();
    void this.check(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private apply(key: SharedKey): void {
    this.config.google.clientId = key.clientId;
    this.config.google.clientSecret = key.clientSecret;
    this.config.googleConfigured = true;
    this.config.googleFromKeyServer = true;
    Object.assign(this.googleCfg, { clientId: key.clientId, clientSecret: key.clientSecret, redirectUri: key.redirectUri, statePrefix: `${key.statePrefix}.` });
  }

  private unapply(): void {
    this.config.google.clientId = '';
    this.config.google.clientSecret = '';
    this.config.googleConfigured = false;
    this.config.googleFromKeyServer = false;
    Object.assign(this.googleCfg, { clientId: '', clientSecret: '', redirectUri: `${this.config.baseUrl.origin}/auth/google/callback`, statePrefix: '' });
  }
}

/** The address the key's server calls to check that a request really comes from this server. */
export function memberRouter(member: KeyShareMember): Router {
  const r = Router();
  r.get('/key-share/proof/:id', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (member.proves(String(req.params['id'] ?? ''))) return res.type('text/plain').send('ok');
    res.status(404).type('text/plain').send('no such request');
  });
  return r;
}
