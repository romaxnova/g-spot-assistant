/**
 * Sharing this server's Google key with friends' servers (SHARE_GOOGLE_KEY=on).
 *
 * Without it, the owner sends the client ID and secret by hand and adds each friend's server to the
 * Google Cloud client. With it:
 *  1. a friend's server asks for the key, proving it answers at the address it gives;
 *  2. the owner approves it on the admin page, after checking the short code the friend reads out;
 *  3. the friend's server fetches the key over HTTPS, and sends its Google sign-ins back through one
 *     address here, /auth/google/relay, which passes them on only to approved servers.
 * Google Cloud then lists a single redirect URI and a single domain, whatever the number of friends,
 * and the set of servers that can receive sign-ins is the approved list here, as it was the list in
 * Google Cloud before. Removing a server stops its new sign-ins at once; rotating the secret in
 * Google Cloud (and here) then reaches every approved server by itself, and no removed one.
 */
import { randomInt } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import express, { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Db } from '../db.js';
import { randomToken, sha256Hex } from '../crypto.js';
import type { Logger } from '../log.js';
import { isPrivateAddress } from '../mcp/tools/gmail-cleanup.js';

export type ShareStatus = 'pending' | 'approved' | 'declined' | 'removed';

export interface KeyShare {
  sid: string;
  origin: string;
  name: string;
  checkCode: string;
  status: ShareStatus;
  createdAt: number;
  decidedAt: number | null;
  lastSeenAt: number | null;
}

interface Row {
  sid: string;
  origin: string;
  name: string;
  check_code: string;
  credential_hash: string;
  status: ShareStatus;
  created_at: number;
  decided_at: number | null;
  last_seen_at: number | null;
}

export class KeyShareError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface HubDeps {
  fetch: typeof fetch;
  resolve: (host: string) => Promise<string[]>;
}

export const hubDeps: HubDeps = {
  fetch: (...a) => fetch(...a),
  resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
};

/** Requests waiting for the owner at most; older ones are dropped first. */
const MAX_PENDING = 30;
/** Requests not decided within this time are forgotten. */
const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{32,64}$/;

export const RELAY_PATH = '/auth/google/relay';

export class KeyShareHub {
  constructor(
    private readonly db: Db,
    private readonly origin: string,
    private readonly google: { clientId: string; clientSecret: string },
    private readonly log: Logger,
    private readonly deps: HubDeps = hubDeps,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS key_shares (
      sid TEXT PRIMARY KEY,
      origin TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      check_code TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      last_seen_at INTEGER
    )`);
  }

  /** The redirect URI the owner adds once to the Google Cloud client. */
  get relayUri(): string {
    return `${this.origin}${RELAY_PATH}`;
  }

  private open(r: Row): KeyShare {
    return { sid: r.sid, origin: r.origin, name: r.name, checkCode: r.check_code, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, lastSeenAt: r.last_seen_at };
  }

  /** A friend's server asks for the key. Returns the code its owner reads out to the key's owner. */
  async request(input: { origin: unknown; name: unknown; requestId: unknown }): Promise<{ checkCode: string }> {
    const origin = await this.checkedOrigin(input.origin);
    const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) : '';
    if (!name) throw new KeyShareError('Say who is asking (a name).');
    const requestId = typeof input.requestId === 'string' ? input.requestId : '';
    if (!REQUEST_ID_RE.test(requestId)) throw new KeyShareError('The request id is malformed.');
    await this.prove(origin, requestId);

    this.db.prepare("DELETE FROM key_shares WHERE status = 'pending' AND created_at < ?").run(this.now() - PENDING_TTL_MS);
    const pending = this.db.prepare("SELECT sid FROM key_shares WHERE status = 'pending' AND origin != ? ORDER BY created_at").all(origin) as { sid: string }[];
    for (const p of pending.slice(0, Math.max(0, pending.length - MAX_PENDING + 1))) this.db.prepare('DELETE FROM key_shares WHERE sid = ?').run(p.sid);

    // A new request for a known server starts again from pending: it may be a new install at that address.
    this.db.prepare('DELETE FROM key_shares WHERE origin = ?').run(origin);
    const checkCode = String(randomInt(100000, 1000000));
    this.db
      .prepare("INSERT INTO key_shares (sid, origin, name, check_code, credential_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .run(randomToken(9), origin, name, checkCode, sha256Hex(requestId), this.now());
    this.log.info('google key requested', { origin });
    return { checkCode };
  }

  /** What a friend's server learns about its request; the key itself once approved. */
  status(requestId: string): { status: ShareStatus | 'unknown'; client_id?: string; client_secret?: string; redirect_uri?: string; state_prefix?: string } {
    if (!REQUEST_ID_RE.test(requestId)) return { status: 'unknown' };
    const r = this.db.prepare('SELECT * FROM key_shares WHERE credential_hash = ?').get(sha256Hex(requestId)) as unknown as Row | undefined;
    if (!r) return { status: 'unknown' };
    this.db.prepare('UPDATE key_shares SET last_seen_at = ? WHERE sid = ?').run(this.now(), r.sid);
    if (r.status !== 'approved') return { status: r.status };
    return { status: 'approved', client_id: this.google.clientId, client_secret: this.google.clientSecret, redirect_uri: this.relayUri, state_prefix: r.sid };
  }

  list(): KeyShare[] {
    return (this.db.prepare("SELECT * FROM key_shares WHERE status IN ('pending', 'approved') ORDER BY status DESC, created_at").all() as unknown as Row[]).map((r) => this.open(r));
  }

  decide(sid: string, action: 'approve' | 'decline' | 'remove'): KeyShare | undefined {
    const status: ShareStatus = action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'removed';
    const from = action === 'remove' ? 'approved' : 'pending';
    const changed = this.db.prepare('UPDATE key_shares SET status = ?, decided_at = ? WHERE sid = ? AND status = ?').run(status, this.now(), sid, from).changes;
    if (!changed) return undefined;
    const r = this.db.prepare('SELECT * FROM key_shares WHERE sid = ?').get(sid) as unknown as Row;
    this.log.info(`google key ${status}`, { origin: r.origin });
    return this.open(r);
  }

  /** Where a sign-in coming back from Google goes: an approved server, or nowhere. */
  relayTarget(state: string): string | undefined {
    const sid = state.split('.')[0] ?? '';
    if (!sid || sid === state) return undefined;
    const r = this.db.prepare("SELECT origin FROM key_shares WHERE sid = ? AND status = 'approved'").get(sid) as { origin: string } | undefined;
    return r?.origin;
  }

  /** An https origin on a public host, not this server. */
  private async checkedOrigin(raw: unknown): Promise<string> {
    let url: URL;
    try {
      url = new URL(typeof raw === 'string' ? raw : '');
    } catch {
      throw new KeyShareError('The server address is not a URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw new KeyShareError('The server address must be a plain https origin, such as https://name.up.railway.app.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) || !host.includes('.') || url.origin === this.origin) throw new KeyShareError('The server address must be a public host name.');
    let addresses: string[] = [];
    try {
      addresses = await this.deps.resolve(host);
    } catch {
      /* checked below */
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new KeyShareError('The server address does not lead to a public server.');
    return url.origin;
  }

  /** The server at that address must confirm the request: nobody can ask for the key in another server's name. */
  private async prove(origin: string, requestId: string): Promise<void> {
    let ok = false;
    try {
      const res = await this.deps.fetch(`${origin}/key-share/proof/${requestId}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      ok = res.status === 200 && (await res.text()).trim() === 'ok';
    } catch {
      ok = false;
    }
    if (!ok) throw new KeyShareError('The server at that address did not confirm the request.', 403);
  }
}

/** The routes friends' servers call, and the relay Google sends their sign-ins to. */
export function hubRouter(hub: KeyShareHub, log: Logger): Router {
  const r = Router();
  const asking = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const polling = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

  r.post('/key-share/requests', asking, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.status(202).json(await hub.request({ origin: b['origin'], name: b['name'], requestId: b['request_id'] }));
    } catch (err) {
      if (err instanceof KeyShareError) return res.status(err.status).json({ error: err.message });
      log.warn('google key request failed', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  r.get('/key-share/status', polling, (req: Request, res: Response) => {
    const auth = req.headers.authorization ?? '';
    const id = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    res.setHeader('Cache-Control', 'no-store');
    res.json(hub.status(id));
  });

  // Google sends approved servers' sign-ins here: passed on to that server's own callback, query and all.
  r.get(RELAY_PATH, polling, (req: Request, res: Response) => {
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const target = hub.relayTarget(state);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!target) {
      log.warn('google relay refused', { reason: 'unknown_or_unapproved_server' });
      return res.status(400).type('text/plain').send('This sign-in is for a server that is not, or no longer, allowed to use this Google key.');
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, `${target}/auth/google/callback${query}`);
  });
  return r;
}
