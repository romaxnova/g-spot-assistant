/**
 * Drafts the user asked to send at a later time (Gmail's API has no scheduled
 * send of its own). A row holds ids and times only: the account, the draft, the
 * version of it that was approved (its message id), when to send, and how it
 * went. Nothing of the mail itself, so nothing to encrypt; the sender reads the
 * draft from Gmail when it is due.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

export type ScheduledStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledSend {
  id: string;
  account: string;
  draft_id: string;
  /** The draft's message id when it was scheduled: an edit changes it. */
  message_id: string;
  /** Epoch ms. */
  send_at: number;
  status: ScheduledStatus;
  /** The user reviewed and approved this version for its sensitive recipients. */
  approved_sensitive: boolean;
  /** The user confirmed blanks such as "[téléphone]" belong in it. */
  allow_placeholders: boolean;
  created_at: number;
  updated_at: number;
  sent_message_id?: string;
  /** Why it was not sent (fixed wording, nothing from the mail). */
  error?: string;
}

/** Pending sends kept at most. */
export const MAX_PENDING_SENDS = 100;

interface Row {
  id: string;
  account: string;
  draft_id: string;
  message_id: string;
  send_at: number;
  status: string;
  approved_sensitive: number;
  allow_placeholders: number;
  created_at: number;
  updated_at: number;
  sent_message_id: string | null;
  error: string | null;
}

function fromRow(r: Row): ScheduledSend {
  return {
    id: r.id,
    account: r.account,
    draft_id: r.draft_id,
    message_id: r.message_id,
    send_at: Number(r.send_at),
    status: r.status as ScheduledStatus,
    approved_sensitive: Number(r.approved_sensitive) === 1,
    allow_placeholders: Number(r.allow_placeholders) === 1,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    sent_message_id: r.sent_message_id ?? undefined,
    error: r.error ?? undefined,
  };
}

export type ScheduleInput = Pick<ScheduledSend, 'account' | 'draft_id' | 'message_id' | 'send_at' | 'approved_sensitive' | 'allow_placeholders'>;

/** A schedule the store refuses, with a message meant for Claude. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export class ScheduledSendStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_sends (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      send_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      approved_sensitive INTEGER NOT NULL DEFAULT 0,
      allow_placeholders INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_message_id TEXT,
      error TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS scheduled_sends_status ON scheduled_sends(status, send_at)');
  }

  /** Schedules one draft (see scheduleMany). */
  schedule(input: ScheduleInput): ScheduledSend {
    return this.scheduleMany([input])[0]!;
  }

  /**
   * Schedules drafts, all or none: one already pending for the same draft is replaced (new time, version, approvals).
   * Refused, with nothing changed, when a draft is being sent right now or the pending sends would exceed the cap.
   */
  scheduleMany(inputs: ScheduleInput[]): ScheduledSend[] {
    for (const i of inputs) {
      if (!Number.isFinite(i.send_at)) throw new ScheduleError('The time to send is not valid.');
      if (this.sendingFor(i.account, i.draft_id)) throw new ScheduleError(`Draft ${i.draft_id} is being sent right now.`);
    }
    const fresh = inputs.filter((i) => !this.pendingFor(i.account, i.draft_id)).length;
    if (this.pending().length + fresh > MAX_PENDING_SENDS) throw new ScheduleError(`At most ${MAX_PENDING_SENDS} sends can wait at once; nothing was scheduled.`);
    this.db.exec('BEGIN');
    try {
      const out = inputs.map((i) => this.insert(i));
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insert(input: ScheduleInput): ScheduledSend {
    const existing = this.pendingFor(input.account, input.draft_id);
    if (existing) this.update(existing.id, { status: 'cancelled', error: 'replaced by a new schedule' });
    const at = this.now();
    const item: ScheduledSend = { id: `ss_${randomBytes(9).toString('base64url')}`, status: 'pending', created_at: at, updated_at: at, ...input };
    this.db
      .prepare(
        `INSERT INTO scheduled_sends (id, account, draft_id, message_id, send_at, status, approved_sensitive, allow_placeholders, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(item.id, item.account, item.draft_id, item.message_id, item.send_at, item.approved_sensitive ? 1 : 0, item.allow_placeholders ? 1 : 0, at, at);
    return item;
  }

  get(id: string): ScheduledSend | undefined {
    const r = this.db.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  private sendingFor(account: string, draftId: string): boolean {
    return this.db.prepare("SELECT 1 FROM scheduled_sends WHERE account = ? AND draft_id = ? AND status = 'sending'").get(account, draftId) !== undefined;
  }

  pendingFor(account: string, draftId: string): ScheduledSend | undefined {
    const r = this.db.prepare("SELECT * FROM scheduled_sends WHERE account = ? AND draft_id = ? AND status = 'pending'").get(account, draftId) as unknown as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  /** Pending sends, soonest first; of one account when given. */
  pending(account?: string): ScheduledSend[] {
    const rows = (
      account
        ? this.db.prepare("SELECT * FROM scheduled_sends WHERE status = 'pending' AND account = ? ORDER BY send_at").all(account)
        : this.db.prepare("SELECT * FROM scheduled_sends WHERE status = 'pending' ORDER BY send_at").all()
    ) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** The latest finished ones (sent, failed, cancelled), newest first. */
  recent(limit = 10, account?: string): ScheduledSend[] {
    const rows = (
      account
        ? this.db.prepare("SELECT * FROM scheduled_sends WHERE status IN ('sent','failed','cancelled') AND account = ? ORDER BY updated_at DESC LIMIT ?").all(account, limit)
        : this.db.prepare("SELECT * FROM scheduled_sends WHERE status IN ('sent','failed','cancelled') ORDER BY updated_at DESC LIMIT ?").all(limit)
    ) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** Pending sends whose time has come, and sends left half-done (status sending) since before `staleBefore`. */
  due(now: number, staleBefore: number): { due: ScheduledSend[]; stale: ScheduledSend[] } {
    const due = (this.db.prepare("SELECT * FROM scheduled_sends WHERE status = 'pending' AND send_at <= ? ORDER BY send_at").all(now) as unknown as Row[]).map(fromRow);
    const stale = (this.db.prepare("SELECT * FROM scheduled_sends WHERE status = 'sending' AND updated_at < ?").all(staleBefore) as unknown as Row[]).map(fromRow);
    return { due, stale };
  }

  /** Moves a pending send to `sending`; false when it was no longer pending (cancelled meanwhile, or taken). */
  claim(id: string): boolean {
    return Number(this.db.prepare("UPDATE scheduled_sends SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'").run(this.now(), id).changes) === 1;
  }

  /** Puts a claimed send back to wait (Gmail was unavailable), unless it was cancelled meanwhile. */
  release(id: string): void {
    this.db.prepare("UPDATE scheduled_sends SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'").run(this.now(), id);
  }

  /** Whether the send is still claimed by the sender: false once cancelled. */
  stillSending(id: string): boolean {
    return this.get(id)?.status === 'sending';
  }

  update(id: string, patch: Partial<Pick<ScheduledSend, 'status' | 'sent_message_id' | 'error'>>): void {
    const s = this.get(id);
    if (!s) return;
    this.db
      .prepare('UPDATE scheduled_sends SET status = ?, sent_message_id = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(patch.status ?? s.status, patch.sent_message_id ?? s.sent_message_id ?? null, patch.error ?? s.error ?? null, this.now(), id);
  }

  /** Cancels a pending send, or one the sender has claimed but not yet handed to Gmail; false when there was none. */
  cancel(id: string): boolean {
    return Number(this.db.prepare("UPDATE scheduled_sends SET status = 'cancelled', error = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'sending')").run(this.now(), id).changes) === 1;
  }

  /** Deletes finished rows older than `ms`. */
  purgeBefore(ms: number): number {
    return Number(this.db.prepare("DELETE FROM scheduled_sends WHERE status IN ('sent','failed','cancelled') AND updated_at < ?").run(ms).changes);
  }
}
