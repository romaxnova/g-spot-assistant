/**
 * What the connector remembers about follow-ups across chats: tracked items
 * ("waiting for the lawyer's power of attorney, then send it to the
 * translators") and threads the user dismissed from the automatic lists.
 *
 * Items are personal: everything but ids, dates and statuses (title, next
 * step, notes, addresses, watched threads, the message that arrived) sits in
 * one AES-256-GCM blob under a key derived for this purpose only and bound to
 * the item's id (associated data). The previous TOKEN_ENCRYPTION_KEY still
 * opens items after a rotation, and they are re-encrypted with the current key
 * at start. An item no configured key opens (a deploy with a wrong key) is
 * kept, unseen, until a key that opens it is configured again. Dismissals hold
 * ids, dates and whether they hide only the thread's draft.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { bytesKeyId, decryptBytes, DecryptError, deriveKey, encryptBytes, keyId } from '../crypto.js';

export type FollowupStatus = 'open' | 'done';

/** A Gmail thread in one of the linked accounts. */
export interface ThreadRef {
  account: string;
  thread_id: string;
}

/** The message an item was waiting for, once it came. */
export interface ArrivedMessage {
  account: string;
  thread_id: string;
  message_id: string;
  from?: string;
  subject?: string;
  /** ISO 8601. */
  date: string;
  has_attachments?: boolean;
}

export interface Followup {
  id: string;
  /** Home account alias. */
  account: string;
  status: FollowupStatus;
  /** YYYY-MM-DD. */
  due?: string;
  title: string;
  next_step?: string;
  notes?: string;
  /** Lower-case addresses whose next message makes the item ready. */
  waiting_on?: string[];
  watch_threads?: ThreadRef[];
  /** What is awaited is a document: only a message with an attachment makes the item ready. */
  expects_attachment?: boolean;
  arrived?: ArrivedMessage;
  /** Epoch ms: only mail after this counts as arrived (created_at unless the item was told to keep waiting). */
  since?: number;
  /** Epoch ms. */
  created_at: number;
  updated_at: number;
  closed_at?: number;
}

export interface FollowupInput {
  account: string;
  title: string;
  next_step?: string;
  notes?: string;
  waiting_on?: string[];
  watch_threads?: ThreadRef[];
  expects_attachment?: boolean;
  due?: string;
  status?: FollowupStatus;
}

/** Fields to change; null clears an optional field. */
export interface FollowupPatch {
  account?: string;
  title?: string;
  status?: FollowupStatus;
  due?: string | null;
  next_step?: string | null;
  notes?: string | null;
  waiting_on?: string[] | null;
  watch_threads?: ThreadRef[] | null;
  expects_attachment?: boolean | null;
  arrived?: ArrivedMessage | null;
  since?: number | null;
}

export interface Dismissal {
  dismissedAt: number;
  /** internalDate of the thread's latest message when it was dismissed: a newer message brings the thread back. */
  lastMessageMs: number;
  /** YYYY-MM-DD: the day the thread comes back even without new mail. */
  untilDate?: string;
  /** Hides only the thread's unsent draft (from drafts); its other rows stay. */
  draftOnly?: boolean;
}

/** A request the store refuses, with a message meant for Claude. */
export class FollowupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FollowupError';
  }
}

export const MAX_OPEN_FOLLOWUPS = 200;

/** The encrypted part of a row. */
type Data = Pick<Followup, 'title' | 'next_step' | 'notes' | 'waiting_on' | 'watch_threads' | 'expects_attachment' | 'arrived' | 'since'>;

interface Row {
  id: string;
  account: string;
  status: string;
  due_date: string | null;
  data_enc: Uint8Array;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export class FollowupStore {
  private readonly keys: Buffer[];
  /** Items no configured key opened at start: kept, but not shown (counted for the startup log). */
  readonly unreadable: number = 0;

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => k !== undefined).map((k) => deriveKey(k, 'followups v1'));
    if (this.keys.length === 0) throw new Error('FollowupStore needs an encryption key');
    db.exec(`CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      status TEXT NOT NULL,
      due_date TEXT,
      data_enc BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS followups_status ON followups(status)');
    db.exec(`CREATE TABLE IF NOT EXISTS followup_dismissals (
      account TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL,
      last_message_ms INTEGER NOT NULL,
      until_date TEXT,
      draft_only INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, thread_id)
    )`);
    const columns = (db.prepare('PRAGMA table_info(followup_dismissals)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('draft_only')) db.exec('ALTER TABLE followup_dismissals ADD COLUMN draft_only INTEGER NOT NULL DEFAULT 0');
    // Items under the previous key move to the current one, so the previous key can be removed once the server has
    // started. Items no configured key opens (rotated without TOKEN_ENCRYPTION_KEY_PREVIOUS, a typo) are left as they
    // are: they come back when the variable is fixed.
    const current = keyId(this.keys[0]!);
    const known = new Set(this.keys.map(keyId));
    const rows = db.prepare('SELECT * FROM followups').all() as unknown as Row[];
    for (const row of rows) {
      const kid = bytesKeyId(row.data_enc) ?? '';
      if (!known.has(kid)) this.unreadable++;
      else if (kid !== current) {
        const item = this.read(row);
        if (item) this.write(item);
      }
    }
  }

  /** Records a new item. Refused when MAX_OPEN_FOLLOWUPS items are already open. */
  create(input: FollowupInput): Followup {
    const status = input.status ?? 'open';
    if (status === 'open') this.ensureRoom();
    const at = this.now();
    const item: Followup = {
      id: `fu_${randomBytes(9).toString('base64url')}`,
      account: input.account,
      status,
      due: input.due,
      title: input.title,
      next_step: input.next_step,
      notes: input.notes,
      waiting_on: input.waiting_on?.length ? input.waiting_on : undefined,
      watch_threads: input.watch_threads?.length ? input.watch_threads : undefined,
      expects_attachment: input.expects_attachment || undefined,
      created_at: at,
      updated_at: at,
      closed_at: status === 'done' ? at : undefined,
    };
    this.write(item);
    return item;
  }

  /** Changes the fields given; undefined when no such item exists. */
  update(id: string, patch: FollowupPatch): Followup | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    if (patch.status === 'open' && item.status !== 'open') this.ensureRoom();
    const at = this.now();
    const next: Followup = { ...item, updated_at: at };
    if (patch.account !== undefined) next.account = patch.account;
    if (patch.title !== undefined) next.title = patch.title;
    for (const key of ['due', 'next_step', 'notes', 'waiting_on', 'watch_threads', 'expects_attachment', 'arrived', 'since'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null || value === false || (Array.isArray(value) && value.length === 0)) delete next[key];
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    if (patch.status !== undefined && patch.status !== item.status) {
      next.status = patch.status;
      next.closed_at = patch.status === 'done' ? at : undefined;
    }
    this.write(next);
    return next;
  }

  get(id: string): Followup | undefined {
    const row = this.db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? this.read(row) : undefined;
  }

  /** Items, oldest first; with `accounts`, those whose home account or a watched thread is in one of them. */
  list(filter: { status?: FollowupStatus; accounts?: string[] } = {}): Followup[] {
    const rows = (
      filter.status
        ? this.db.prepare('SELECT * FROM followups WHERE status = ? ORDER BY created_at, rowid').all(filter.status)
        : this.db.prepare('SELECT * FROM followups ORDER BY created_at, rowid').all()
    ) as unknown as Row[];
    const accounts = filter.accounts ? new Set(filter.accounts) : undefined;
    return rows
      .map((r) => this.read(r))
      .filter((i): i is Followup => i !== undefined && (!accounts || accounts.has(i.account) || (i.watch_threads ?? []).some((w) => accounts.has(w.account))));
  }

  close(id: string): Followup | undefined {
    return this.update(id, { status: 'done' });
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM followups WHERE id = ?').run(id).changes) > 0;
  }

  /** Deletes items closed before `ms`. Returns how many. */
  purgeClosedBefore(ms: number): number {
    return Number(this.db.prepare("DELETE FROM followups WHERE status = 'done' AND closed_at < ?").run(ms).changes);
  }

  /**
   * Hides a thread from the automatic lists (with draftOnly, only its draft from drafts) until a message newer than
   * lastMessageMs arrives, or until untilDate.
   */
  dismiss(account: string, threadId: string, lastMessageMs: number, untilDate?: string, draftOnly = false): void {
    this.db
      .prepare(
        `INSERT INTO followup_dismissals (account, thread_id, dismissed_at, last_message_ms, until_date, draft_only) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account, thread_id) DO UPDATE SET dismissed_at = excluded.dismissed_at, last_message_ms = excluded.last_message_ms,
           until_date = excluded.until_date, draft_only = excluded.draft_only`,
      )
      .run(account, threadId, this.now(), Math.round(lastMessageMs), untilDate ?? null, draftOnly ? 1 : 0);
  }

  undismiss(account: string, threadId: string): boolean {
    return Number(this.db.prepare('DELETE FROM followup_dismissals WHERE account = ? AND thread_id = ?').run(account, threadId).changes) > 0;
  }

  /** The account's dismissals by thread id. */
  dismissals(account: string): Map<string, Dismissal> {
    const rows = this.db.prepare('SELECT thread_id, dismissed_at, last_message_ms, until_date, draft_only FROM followup_dismissals WHERE account = ?').all(account) as {
      thread_id: string;
      dismissed_at: number;
      last_message_ms: number;
      until_date: string | null;
      draft_only: number;
    }[];
    return new Map(
      rows.map((r) => [
        r.thread_id,
        { dismissedAt: Number(r.dismissed_at), lastMessageMs: Number(r.last_message_ms), untilDate: r.until_date ?? undefined, draftOnly: Number(r.draft_only) === 1 || undefined },
      ]),
    );
  }

  /**
   * Deletes dismissals of threads quiet since before `ms`, dismissed before it too. Pass a time older than the longest
   * look-back: such a thread (or draft) is no longer listed, or a newer message already brought it back.
   */
  purgeDismissalsBefore(ms: number): number {
    return Number(this.db.prepare('DELETE FROM followup_dismissals WHERE last_message_ms < ? AND dismissed_at < ?').run(ms, ms).changes);
  }

  /** Open items right now. */
  openCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM followups WHERE status = 'open'").get() as { n: number | bigint };
    return Number(row.n);
  }

  private ensureRoom(): void {
    if (this.openCount() >= MAX_OPEN_FOLLOWUPS) {
      throw new FollowupError(
        `${MAX_OPEN_FOLLOWUPS} follow-ups are already open, the most kept. Close the ones that are handled (followup_track with id and status "done") before tracking more.`,
      );
    }
  }

  private write(item: Followup): void {
    const data: Data = {
      title: item.title,
      next_step: item.next_step,
      notes: item.notes,
      waiting_on: item.waiting_on,
      watch_threads: item.watch_threads,
      expects_attachment: item.expects_attachment,
      arrived: item.arrived,
      since: item.since,
    };
    const blob = encryptBytes(Buffer.from(JSON.stringify(data), 'utf8'), this.keys[0]!, `followup:${item.id}`);
    this.db
      .prepare(
        `INSERT INTO followups (id, account, status, due_date, data_enc, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account = excluded.account, status = excluded.status, due_date = excluded.due_date, data_enc = excluded.data_enc,
           updated_at = excluded.updated_at, closed_at = excluded.closed_at`,
      )
      .run(item.id, item.account, item.status, item.due ?? null, blob, item.created_at, item.updated_at, item.closed_at ?? null);
  }

  /** The item, or undefined when no configured key opens it (the row is kept: the right key may come back). */
  private read(row: Row): Followup | undefined {
    let data: Data;
    try {
      data = JSON.parse(decryptBytes(row.data_enc, this.keys, `followup:${row.id}`).toString('utf8')) as Data;
    } catch (err) {
      if (!(err instanceof DecryptError || err instanceof SyntaxError)) throw err;
      return undefined;
    }
    return {
      id: row.id,
      account: row.account,
      status: row.status === 'done' ? 'done' : 'open',
      due: row.due_date ?? undefined,
      title: data.title,
      next_step: data.next_step,
      notes: data.notes,
      waiting_on: data.waiting_on,
      watch_threads: data.watch_threads,
      expects_attachment: data.expects_attachment === true || undefined,
      arrived: data.arrived,
      since: data.since,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      closed_at: row.closed_at === null ? undefined : Number(row.closed_at),
    };
  }
}
