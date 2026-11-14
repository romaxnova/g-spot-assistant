/**
 * The follow-up engine: what needs attention across the linked accounts, so
 * nothing falls through the cracks between chats.
 *
 * - tracked: items recorded with followup_track. One becomes ready when what
 *   it waits for arrives: a new message in a watched thread, or mail from one
 *   of its waiting_on addresses in ANY linked mailbox (a lawyer may write to
 *   another linked account). The arrival is stored with the item, so
 *   it stays ready until closed.
 *   With watched threads, mail from those addresses elsewhere is only reported
 *   (other_mail): the council answering another matter is not the answer. An
 *   item expecting an attachment is ready only when one comes.
 * - owed: inbox threads whose latest message a person wrote is someone else's,
 *   addressed to the account (or in a conversation it took part in), from
 *   someone the account has written to (owed_from "anyone": from anyone).
 *   One-time codes, security alerts and broadcasts are left out.
 * - drafts: unsent drafts older than a few hours, saved within the look-back.
 * - waiting: sent threads nobody answered (see gmail_awaiting_reply), newest
 *   first; forwards nobody answered are FYI and left out unless asked for.
 * - batches: one request sent separately to several people (quote requests):
 *   who replied, whether the account answered them since, who never replied.
 *   Its threads still pending (a reply to answer, silence) are listed there
 *   only; the ones the account answered wait like any sent mail.
 *
 * Mail in the threads a ready tracked item covers, up to its arrival, is left
 * to that item, and stays settled once the item is closed. Threads the user
 * dismissed stay hidden until new mail arrives in them (a draft dismissed
 * alone, until it is edited). Each section lists its own age window (sent
 * mail old enough to wait on, mail received long enough ago to be owed), at
 * most max_threads_per_account threads per listing (drafts: at least 50); a
 * listing cut short is reported in `truncated`. Only headers are read
 * (format=metadata), each thread once per run, at most FETCH_CONCURRENCY
 * requests at a time per account (or `concurrency`), accounts in parallel; an
 * account that fails is asked nothing more.
 * Ages are calendar days in the default time zone. Used by the followups tool
 * and by the daily digest, so it returns plain data and leaves presentation to
 * them. Logs carry counts only.
 */
import { AccountError, GoogleApiError } from '../google/client.js';
import type { ToolContext } from '../mcp/registry.js';
import { oneLine } from '../mcp/text.js';
import { decodeSnippet, todayIn } from '../mcp/tools/cross.js';
import { AUTOMATED_SENDER } from '../mcp/tools/gmail-contacts.js';
import {
  addressLine,
  automatic,
  awaitingRow,
  conversation,
  IGNORED_LABELS,
  readThread,
  senderOf,
  THREAD_HEADERS,
  type Conversation,
  type GmailThread,
  type ThreadList,
} from '../mcp/tools/gmail-followup.js';
import { gmailIdentity, gmailWebUrl, mailbox } from '../mcp/tools/gmail-identity.js';
import { headerValue, parseAddresses, type Address, type GmailPart } from '../mcp/tools/gmail-mime.js';
import { encodeId, FETCH_CONCURRENCY, hasAttachments, SERVICE, type GmailMessage } from '../mcp/tools/gmail.js';
import type { ArrivedMessage, Dismissal, Followup, ThreadRef } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const FOLLOWUP_SECTIONS = ['tracked', 'owed', 'drafts', 'waiting', 'batches'] as const;
export type FollowupSection = (typeof FOLLOWUP_SECTIONS)[number];

/** Pages followed per listing at most: Gmail may answer with pages shorter than asked. */
const MAX_PAGES = 5;
/** Thread headers: gmail_awaiting_reply's, plus the mailing-list headers that keep newsletters out of owed. */
const HEADERS = [...THREAD_HEADERS, 'List-Id', 'List-Unsubscribe'];
const INBOX_FILTER = '-category:promotions -category:social -category:updates -category:forums';
const SNIPPET_CHARS = 140;
/** Threads of one request to make a batch, sent to as many different recipients. */
const BATCH_MIN_THREADS = 3;
/** Entries listed per batch for replied and for no_reply. */
const BATCH_LIST = 20;
/** Threads read per listing and account by default, and at most. */
export const DEFAULT_THREADS_READ = 40;
export const MAX_THREADS_READ = 100;
/** Drafts read per account at least: there may be many, kept on purpose. */
const DRAFTS_LISTED = 50;
/** Messages examined per account when looking for mail from a tracked item's addresses. */
const ARRIVAL_SEARCH = 5;
/** Messages of a watched thread read for their attachments when an item expects one. */
const ATTACHMENT_CANDIDATES = 3;
/** Recipients beyond which mail to a crowd (a circular) is no question to the account, unless it took part. */
const BROADCAST_RECIPIENTS = 8;
/** Forward prefixes: Fwd, Fw, TR (French), WG (German), ENC (Portuguese), RV (Spanish). */
const FORWARD_SUBJECT = /^\s*(?:fwd?|tr|wg|enc|rv)\s*:/i;
/** One-time codes ("Votre code de vérification", "Your security code is 123456"): nothing to answer. */
const ONE_TIME_CODE =
  /\b(?:one[- ]time|otp|2fa|verification|v[ée]rification|security|s[ée]curit[ée]|confirmation|login|connexion|sign[- ]?in|authenti[a-z]*|validation|activation|access|acc[eè]s|passcode)[^\n]{0,30}\bcode\b|\bcode\b[^\n]{0,30}(?:v[ée]rification|verification|s[ée]curit|security|confirmation|connexion|login|validation|activation|usage unique|acc[eè]s)/i;
/** Security notices ("Nouvelle connexion", "New sign-in", password resets): nothing to answer. */
const SECURITY_NOTICE =
  /(?:new (?:sign-?in|login|device)|nouvelle connexion|alerte de (?:s[ée]curit|connexion)|security alert|login alert|sign-?in (?:alert|attempt)|unusual (?:sign-?in|activity)|connexion inhabituelle|password (?:reset|changed)|r[ée]initialis[a-z]* (?:de |du )?(?:votre )?mot de passe|mot de passe (?:oubli|modifi))/i;
/** An address safe to put in a Gmail search as one term (no spaces, parentheses, braces or quotes). */
const SEARCHABLE_ADDRESS = /^[^\s@(){}"]+@[^\s@(){}"]+\.[^\s@(){}"]+$/;
/** Inline pictures (signature logos) that are no document. */
const INLINE_PICTURE = /^(?:image\d{3}|outlook-[\w-]+|logo[\w-]*)\.(?:png|jpe?g|gif)$/i;
/** A message's headers and its parts' names (for attachments), never its bodies. */
const ARRIVAL_FIELDS = 'id,threadId,labelIds,internalDate,payload(mimeType,filename,headers,parts(mimeType,filename,parts(mimeType,filename,parts(mimeType,filename))))';

export interface FollowupOptions {
  /** Default: every linked account with Gmail (one that needs re-linking is reported in errors). */
  accounts?: string[];
  /** Default: all. */
  sections?: FollowupSection[];
  /** How far back threads are read, in days (default 30, at most 90). */
  lookback_days?: number;
  /** Sent mail is waiting once unanswered this many days (default 3). */
  waiting_min_days?: number;
  /** Mail received is owed once unanswered this many hours (default 12). */
  owed_min_hours?: number;
  /** Drafts are listed once untouched this many hours (default 12). */
  drafts_min_hours?: number;
  /** Also list mail between linked accounts: sent only to them (waiting), or from them (owed). Default false. */
  include_internal?: boolean;
  /** Owed mail from people the account has written to (default), or from anyone. */
  owed_from?: OwedFrom;
  /** Also list forwards nobody answered under waiting (default false: they are usually FYI). */
  include_forwards?: boolean;
  /** Sent mail waiting longer than this many days is left out (default: the look-back). */
  waiting_max_days?: number;
  /** Mail owed for longer than this many days is left out (default: the look-back). */
  owed_max_days?: number;
  /** Threads read per listing and account, newest activity first (default 40, at most 100); drafts read: at least 50. */
  max_threads_per_account?: number;
  /** Gmail requests at a time per account (default FETCH_CONCURRENCY): the digest, unattended and reading more, asks fewer. */
  concurrency?: number;
  /** Epoch ms standing for now (tests). */
  now?: number;
}

export type TrackedStatus = 'ready' | 'overdue' | 'due' | 'waiting' | 'done';
export const OWED_FROM = ['correspondents', 'anyone'] as const;
export type OwedFrom = (typeof OWED_FROM)[number];

/**
 * Mail from an item's people that did not make it ready: in another conversation than its watched threads, or
 * without the attachment it expects. Shown so Claude can look, never stored.
 */
export interface OtherMail extends ArrivedMessage {
  reason: 'other_conversation' | 'no_attachment';
  web_url?: string;
}

export interface TrackedRow {
  id: string;
  account: string;
  title: string;
  next_step?: string;
  waiting_on?: string[];
  watch_threads?: ThreadRef[];
  expects_attachment?: boolean;
  due?: string;
  status: TrackedStatus;
  arrived?: ArrivedMessage & { web_url?: string };
  /** Ready, but the user wrote to the sender of what arrived since: probably done, to close. */
  handled?: boolean;
  other_mail?: OtherMail;
  notes?: string;
  created_at: string;
  age_days: number;
}

/** Someone is waiting on the user. */
export interface OwedRow {
  account: string;
  thread_id: string;
  message_id: string;
  from?: string;
  subject?: string;
  received_at: string;
  days: number;
  unread?: boolean;
  /** The sender is another linked account. */
  internal?: boolean;
  snippet?: string;
  web_url: string;
}

export interface DraftRow {
  account: string;
  draft_id: string;
  message_id: string;
  thread_id?: string;
  to?: string;
  subject?: string;
  saved_at: string;
  days: number;
  /** The thread got a message sent after this draft was saved: the reply went out another way, the draft is likely obsolete. */
  superseded?: boolean;
  web_url: string;
}

/** The user is waiting on someone. */
export interface WaitingRow {
  account: string;
  thread_id: string;
  message_id: string;
  to?: string;
  subject?: string;
  sent_at: string;
  days_waiting: number;
  replies_received?: number;
  bounced?: boolean;
  auto_reply?: boolean;
  web_url: string;
}

export interface BatchReply {
  who?: string;
  thread_id: string;
  last_reply_at: string;
  /** The account wrote back after this reply. */
  answered: boolean;
  /** The reply is still unread. */
  unread?: boolean;
  web_url: string;
}

export interface BatchSilence {
  who?: string;
  thread_id: string;
  sent_at: string;
  web_url: string;
}

export interface BatchRow {
  account: string;
  subject?: string;
  /** When the first request went out. */
  sent_at: string;
  /** Threads of the batch. */
  sent: number;
  replied_count: number;
  no_reply_count: number;
  replied: BatchReply[];
  no_reply: BatchSilence[];
}

export interface FollowupReport {
  generated_at: string;
  accounts: string[];
  counts: { ready: number; handled: number; overdue: number; due: number; owed: number; drafts: number; waiting: number; batches: number };
  tracked: TrackedRow[];
  owed: OwedRow[];
  drafts: DraftRow[];
  waiting: WaitingRow[];
  batches: BatchRow[];
  errors?: { account: string; error: string }[];
  /** Accounts whose listings for these sections were cut (at max_threads_per_account; drafts, see draftsRead): older mail was not read. */
  truncated?: { account: string; sections: FollowupSection[] }[];
}

interface Settings {
  sections: Set<FollowupSection>;
  lookbackDays: number;
  waitingMinDays: number;
  owedMinHours: number;
  draftsMinHours: number;
  includeInternal: boolean;
  owedFrom: OwedFrom;
  includeForwards: boolean;
  waitingMaxDays: number;
  owedMaxDays: number;
  maxThreads: number;
  concurrency: number;
  now: number;
  /** The default time zone, and its day at `now`: ages are counted in its calendar days. */
  tz: string;
  today: string;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const v = value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
  return Math.min(max, Math.max(min, v));
}

/** Days from one YYYY-MM-DD to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** How long ago a time was in calendar days of the zone, as people count: at 08:00, last night's 23:00 was 1 day ago. */
export function daysAgo(time: number, tz: string, today: string): number {
  return Number.isFinite(time) ? Math.max(0, daysBetween(todayIn(tz, new Date(time)), today)) : 0;
}

/** A function that runs at most `max` of the calls given to it at once, the others waiting their turn. */
type Gate = <T>(fn: () => Promise<T>) => Promise<T>;

function gate(max: number): Gate {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A finishing call hands its slot straight to the next in line, so a newcomer cannot slip in between.
    if (active < max) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

/** One run's shared state: per-account gates, identities and threads read once, failures by account. */
class Scan {
  readonly errors = new Map<string, string>();
  /** The first failure of each account. */
  private readonly failures = new Map<string, AccountError | GoogleApiError>();
  private readonly gates = new Map<string, Gate>();
  private readonly owns = new Map<string, Promise<Set<string>>>();
  private readonly threads = new Map<string, Promise<GmailThread | undefined>>();
  /** Per account, mailboxes it wrote to, as found in the mail read or by asking Gmail. */
  private readonly written = new Map<string, Map<string, Promise<boolean>>>();

  constructor(
    readonly ctx: ToolContext,
    readonly s: Settings,
  ) {}

  /**
   * A Google call of the account, through its gate. Once the account has failed, the calls still queued are refused
   * with that failure instead of being sent: their results would be dropped, and a quota used up stays used up.
   */
  call<T>(alias: string, fn: () => Promise<T>): Promise<T> {
    let g = this.gates.get(alias);
    if (!g) this.gates.set(alias, (g = gate(this.s.concurrency)));
    return g(() => {
      const failed = this.failures.get(alias);
      return failed ? Promise.reject(failed) : fn();
    });
  }

  /** The account's own addresses, in mailbox form. */
  own(alias: string): Promise<Set<string>> {
    let p = this.owns.get(alias);
    if (!p) this.owns.set(alias, (p = gmailIdentity(this.ctx, alias).then((i) => new Set(i.addresses.map(mailbox)))));
    return p;
  }

  /**
   * The addresses of a linked account that may have no Gmail (a tracked item's home account): its Gmail identity, or
   * its linked address alone when that cannot be read.
   */
  async self(alias: string): Promise<Set<string>> {
    try {
      return await this.own(alias);
    } catch (err) {
      if (!(err instanceof AccountError || err instanceof GoogleApiError)) throw err;
      const email = this.ctx.accounts.get(alias)?.email;
      return new Set(email ? [mailbox(email)] : []);
    }
  }

  /** A thread's headers, read once per run; undefined when it is gone. */
  thread(alias: string, id: string): Promise<GmailThread | undefined> {
    const key = `${alias}\n${id}`;
    let p = this.threads.get(key);
    if (!p) this.threads.set(key, (p = this.call(alias, () => readThread(this.ctx, alias, id, HEADERS))));
    return p;
  }

  /** Records mailboxes the account wrote to, seen in the mail read. */
  wroteTo(alias: string, addresses: Iterable<string>): void {
    const known = this.written.get(alias) ?? new Map<string, Promise<boolean>>();
    this.written.set(alias, known);
    for (const a of addresses) known.set(a, Promise.resolve(true));
  }

  /** Whether the account ever sent mail to the address (To, Cc or Bcc): the mail read first, then one Gmail search. */
  correspondent(alias: string, address: string): Promise<boolean> {
    const known = this.written.get(alias) ?? new Map<string, Promise<boolean>>();
    this.written.set(alias, known);
    const key = mailbox(address);
    let p = known.get(key);
    if (!p) {
      const a = address.trim().toLowerCase();
      const q = `in:sent {to:${a} cc:${a} bcc:${a}}`;
      known.set(
        key,
        (p = this.call(alias, () => this.ctx.google.request<{ messages?: { id: string }[] }>(alias, SERVICE, { url: '/messages', query: { q, maxResults: 1 } })).then(
          (r) => (r.messages?.length ?? 0) > 0,
        )),
      );
    }
    return p;
  }

  private readonly afterChecks = new Map<string, Promise<boolean>>();

  /** Gmail's after: in seconds, past the message itself. */
  private static after(ms: number): number {
    return Math.floor(ms / 1000) + 1;
  }

  /** Whether the account wrote the address mail after `afterMs` (To, Cc or Bcc, any thread; not an auto-reply). A failure counts as no. */
  wroteToAfter(alias: string, address: string, afterMs: number): Promise<boolean> {
    const a = address.trim().toLowerCase();
    if (!SEARCHABLE_ADDRESS.test(a) || !Number.isFinite(afterMs)) return Promise.resolve(false);
    const q = `in:sent {to:${a} cc:${a} bcc:${a}} after:${Scan.after(afterMs)}`;
    return this.check(alias, `w\n${alias}\n${q}`, () => this.someByAPerson(alias, q));
  }

  /** Whether the address wrote to the account after `afterMs`: a person, not an auto-reply or a bounce. A failure counts as no. */
  heardFromAfter(alias: string, address: string, afterMs: number): Promise<boolean> {
    const a = address.trim().toLowerCase();
    if (!SEARCHABLE_ADDRESS.test(a) || !Number.isFinite(afterMs)) return Promise.resolve(false);
    const q = `from:${a} after:${Scan.after(afterMs)}`;
    return this.check(alias, `h\n${alias}\n${q}`, () => this.someByAPerson(alias, q));
  }

  /** Whether a search finds, among its three newest messages, one a person wrote (no draft, auto-reply or bounce). */
  private async someByAPerson(alias: string, q: string): Promise<boolean> {
    const r = await this.call(alias, () => this.ctx.google.request<{ messages?: { id: string }[] }>(alias, SERVICE, { url: '/messages', query: { q, maxResults: 3 } }));
    const read = await Promise.all((r.messages ?? []).map((m) => fetchMessage(this, alias, m.id, { format: 'metadata', metadataHeaders: THREAD_HEADERS })));
    return read.some((m) => m && !(m.labelIds ?? []).some((l) => IGNORED_LABELS.has(l)) && automatic(m) === undefined);
  }

  /**
   * A check run once per run. It only decides whether a row is shown: a failure (an account that failed, a quota hit,
   * a timeout) keeps the row and fails nothing, so one search cannot take an account's rows away.
   */
  private check(alias: string, key: string, fn: () => Promise<boolean>): Promise<boolean> {
    let p = this.afterChecks.get(key);
    if (!p) {
      p = fn().catch((err: unknown) => {
        if (!(err instanceof AccountError || err instanceof GoogleApiError)) throw err;
        this.softFailures++;
        return false;
      });
      this.afterChecks.set(key, p);
    }
    return p;
  }

  /** Checks that could not be made (their rows were kept), for the log. */
  softFailures = 0;

  /** The first of the accounts (in order) for which the check holds, or undefined; each asked only if the previous ones said no. */
  async anyOf(aliases: string[], fn: (alias: string) => Promise<boolean>): Promise<string | undefined> {
    for (const alias of aliases) if (!this.failures.has(alias) && (await fn(alias))) return alias;
    return undefined;
  }

  /** Records an account or Google failure against the account (the first one says enough); anything else is a bug. */
  fail(alias: string, err: unknown): void {
    if (!(err instanceof AccountError || err instanceof GoogleApiError)) throw err;
    if (this.failures.has(alias)) return;
    this.failures.set(alias, err);
    this.errors.set(alias, err.message);
    // An alias the caller gave may be an address that is not linked: never logged as such.
    this.ctx.log.info('followups account failed', { alias: alias.includes('@') ? 'unknown address' : alias, error: err.name });
  }
}

/** A message's time (internalDate), or NaN. */
function ms(m: GmailMessage | undefined): number {
  return m?.internalDate ? Number(m.internalDate) : Number.NaN;
}

/** ISO 8601; empty (left out of results) for a message Gmail gave no date. */
function iso(time: number): string {
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

/** The thread's latest message, drafts included, spam and trash not: what a dismissal is measured against. */
function latestMessage(thread: GmailThread): GmailMessage | undefined {
  let latest: GmailMessage | undefined;
  for (const m of thread.messages ?? []) {
    if ((m.labelIds ?? []).some((l) => l === 'SPAM' || l === 'TRASH')) continue;
    if (ms(m) > (latest ? ms(latest) : 0)) latest = m;
  }
  return latest;
}

/** The time of the thread's latest message (see latestMessage), or 0. */
export function latestMessageMs(thread: GmailThread): number {
  const latest = latestMessage(thread);
  return latest ? ms(latest) : 0;
}

/** Whether a dismissal still hides a thread: nothing newer arrived and its until date (the day it comes back) is not reached. */
export function stillDismissed(d: Dismissal | undefined, latestMs: number, today: string): boolean {
  if (!d || latestMs > d.lastMessageMs) return false;
  return !d.untilDate || today < d.untilDate;
}

/** Subject as a batch key: reply/forward prefixes and [tags] dropped, spaces collapsed, lower-case, NFC. */
export function normalizeSubject(subject: string): string {
  return subject
    .normalize('NFC')
    .replace(/^(?:\s*(?:(?:re|fwd?|tr|aw|wg)\s*:|\[[^\]]*\]))+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function headerLine(m: GmailMessage, name: string): string | undefined {
  const v = headerValue(m.payload?.headers, name);
  return v ? oneLine(v) || undefined : undefined;
}

/** Everyone a message went to (To, Cc, Bcc); group syntax such as "undisclosed-recipients:;" is no one. */
function recipients(m: GmailMessage): Address[] {
  const h = m.payload?.headers;
  return [headerValue(h, 'To'), headerValue(h, 'Cc'), headerValue(h, 'Bcc')].flatMap(parseAddresses).filter((a) => a.email.includes('@'));
}

function others(m: GmailMessage, own: Set<string>): Address[] {
  return recipients(m).filter((a) => !own.has(mailbox(a.email)));
}

interface ListedThread {
  id: string;
  thread: GmailThread;
  conv: Conversation;
  latestMs: number;
}

interface Listing {
  threads: ListedThread[];
  /** More threads matched than were read: the ones with the oldest activity were left out. */
  truncated: boolean;
}

const NO_LISTING: Listing = { threads: [], truncated: false };

/** Up to `max` entries of a Gmail listing (threads or drafts), pages followed; truncated when more were left. */
async function listing<T extends { id: string }>(scan: Scan, alias: string, key: 'threads' | 'drafts', max: number, q?: string): Promise<{ items: T[]; truncated: boolean }> {
  const items = new Map<string, T>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES && items.size < max; page++) {
    const query = { q, maxResults: max - items.size, pageToken };
    const list = await scan.call(alias, () => scan.ctx.google.request<{ [k in typeof key]?: T[] } & { nextPageToken?: string }>(alias, SERVICE, { url: `/${key}`, query }));
    for (const item of list[key] ?? []) if (items.size < max) items.set(item.id, item);
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  return { items: [...items.values()], truncated: pageToken !== undefined };
}

/** The threads a search lists, newest activity first, up to maxThreads (pages followed), each read once. */
async function listThreads(scan: Scan, alias: string, q: string): Promise<Listing> {
  const { items, truncated } = await listing<NonNullable<ThreadList['threads']>[number]>(scan, alias, 'threads', scan.s.maxThreads, q);
  const read = await Promise.all(items.map(async ({ id }) => ({ id, thread: await scan.thread(alias, id) })));
  return {
    threads: read.flatMap(({ id, thread }) => (thread ? [{ id, thread, conv: conversation(thread), latestMs: latestMessageMs(thread) }] : [])),
    truncated,
  };
}

/** A message by id; undefined when it is gone. */
async function fetchMessage(scan: Scan, alias: string, id: string, query: Record<string, string | string[]>): Promise<GmailMessage | undefined> {
  try {
    return await scan.call(alias, () => scan.ctx.google.request<GmailMessage>(alias, SERVICE, { url: `/messages/${encodeId(id)}`, query }));
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Automatic sections, one account

/** A waiting row, with whom it waits on outside the linked accounts (mailbox form), for the ready items' cover. */
interface Waiting {
  row: WaitingRow;
  awaited: string[];
  /** The awaited addresses as written, for Gmail searches. */
  awaitedRaw: string[];
}

interface AccountRows {
  account: string;
  owed: OwedRow[];
  drafts: DraftRow[];
  waiting: Waiting[];
  batches: BatchRow[];
  /** Sections whose listing was cut. */
  truncated: FollowupSection[];
}

async function scanAccount(scan: Scan, alias: string, linked: Set<string>, mailboxes: string[]): Promise<AccountRows> {
  const { ctx, s } = scan;
  const email = ctx.google.resolve(alias, SERVICE).email;
  const own = await scan.own(alias);
  const dismissals = ctx.followups.dismissals(alias);
  // The dismissal of a draft kept on purpose hides that draft only: the thread's other rows stay.
  const visible = (threadId: string, latestMs: number) => {
    const d = dismissals.get(threadId);
    return !d || d.draftOnly === true || !stillDismissed(d, latestMs, s.today);
  };
  const wants = (section: FollowupSection) => s.sections.has(section);
  // Each listing covers its own age window, so mail too recent to count does not take the places of what has waited
  // longest (threads come newest activity first): sent mail old enough to wait on, the rest of the sent mail for
  // batches only, and mail received long enough ago to be owed.
  const sent = `in:sent newer_than:${s.lookbackDays}d`;
  const minDays = s.waitingMinDays;
  const owedBefore = s.owedMinHours > 0 ? ` before:${Math.floor((s.now - s.owedMinHours * HOUR_MS) / 1000)}` : '';
  const [drafts, older, recent, inbox] = await Promise.all([
    wants('drafts') ? draftRows(scan, alias, email, dismissals) : { rows: [], truncated: false },
    wants('waiting') || wants('batches') ? listThreads(scan, alias, minDays > 0 ? `${sent} older_than:${minDays}d` : sent) : NO_LISTING,
    wants('batches') && minDays > 0 ? listThreads(scan, alias, `in:sent newer_than:${minDays}d`) : NO_LISTING,
    wants('owed') ? listThreads(scan, alias, `in:inbox newer_than:${s.lookbackDays}d${owedBefore} ${INBOX_FILTER}`) : NO_LISTING,
  ]);
  const sentThreads = [...new Map([...older.threads, ...recent.threads].map((t) => [t.id, t])).values()];
  // What a batch reports as pending (replies to answer, requests nobody answered) is listed with it only. Replies the
  // account answered follow the usual rules (the user may now wait on those people), as do all the threads of a
  // settled batch (every reply answered, nobody silent), which is no longer one.
  const batches = (wants('batches') ? batchGroups(sentThreads, own) : []).flatMap((g) => batchRow(alias, email, g, own, visible) ?? []);
  const batched = new Set<string>();
  const rest = (threads: ListedThread[]) => threads.filter((t) => !batched.has(t.id) && visible(t.id, t.latestMs));
  const cut = new Set<FollowupSection>([
    ...(drafts.truncated ? (['drafts'] as const) : []),
    ...(older.truncated ? (['waiting', 'batches'] as const) : []),
    ...(recent.truncated ? (['batches'] as const) : []),
    ...(inbox.truncated ? (['owed'] as const) : []),
  ]);
  // Whom the account wrote to in the mail read: owed mail from them needs no search.
  scan.wroteTo(
    alias,
    [...sentThreads, ...inbox.threads].flatMap((t) => t.conv.messages.filter((m) => own.has(senderOf(m) ?? '')).flatMap((m) => others(m, own).map((a) => mailbox(a.email)))),
  );
  // This account first: the others only for what it did not settle.
  const accountsFrom = (first: string) => [first, ...mailboxes.filter((m) => m !== first)];
  await Promise.all(
    batches.map(async (b) => {
      await Promise.all(
        b.row.replied.map(async (r) => {
          const address = r.answered ? undefined : parseAddresses(r.who ?? '')[0]?.email;
          if (address && (await scan.wroteToAfter(alias, address, Date.parse(r.last_reply_at)))) {
            r.answered = true;
            b.pending = b.pending.filter((id) => id !== r.thread_id);
          }
        }),
      );
      b.row.replied.sort((x, y) => Number(x.answered) - Number(y.answered) || x.last_reply_at.localeCompare(y.last_reply_at));
      b.row.replied = b.row.replied.slice(0, BATCH_LIST);
    }),
  );
  // A batch whose replies were all answered another way and where nobody is silent is settled.
  const openBatches = batches.filter((b) => b.pending.length);
  for (const b of openBatches) for (const id of b.pending) batched.add(id);
  const candidates = rest(inbox.threads).flatMap((t) => owedRow(alias, email, t, own, linked, s) ?? []);
  const owed = await Promise.all(
    candidates.map(async (c) => {
      if (c.ask && !(await scan.correspondent(alias, c.ask))) return undefined;
      // Answered another way: the user wrote to them since, in another thread or from another linked account.
      const answered = c.address && (await scan.anyOf(accountsFrom(alias), (a) => scan.wroteToAfter(a, c.address!, Date.parse(c.row.received_at))));
      return answered ? undefined : c.row;
    }),
  );
  const waiting = wants('waiting') ? rest(older.threads).flatMap((t) => waitingRow(alias, email, t, own, linked, s) ?? []) : [];
  const stillWaiting = await Promise.all(
    waiting.map(async (w) => {
      // They answered another way (in another thread, or to another linked account): every one awaited wrote since.
      const sent = Date.parse(w.row.sent_at);
      if (!w.awaitedRaw.length) return w;
      for (const address of w.awaitedRaw) if (!(await scan.anyOf(accountsFrom(alias), (a) => scan.heardFromAfter(a, address, sent)))) return w;
      return undefined;
    }),
  );

  return {
    account: alias,
    drafts: drafts.rows,
    waiting: stillWaiting.filter((w): w is Waiting => w !== undefined),
    owed: owed.filter((o): o is OwedRow => o !== undefined),
    batches: openBatches.map((b) => b.row),
    truncated: FOLLOWUP_SECTIONS.filter((x) => cut.has(x) && wants(x)),
  };
}

interface ListedDraft {
  id: string;
  message?: { id: string; threadId?: string };
}

/** Drafts read per account: the DRAFTS_LISTED most recent, or as many as a listing reads threads when that is more. */
export function draftsRead(maxThreads: number): number {
  return Math.max(DRAFTS_LISTED, maxThreads);
}

/** Drafts old enough to list and saved within the look-back, among the draftsRead most recent; truncated when the account has more. */
async function draftRows(scan: Scan, alias: string, email: string, dismissals: Map<string, Dismissal>): Promise<{ rows: DraftRow[]; truncated: boolean }> {
  const { s } = scan;
  // Drafts abandoned years ago are not news: the look-back applies to them too.
  const list = await listing<ListedDraft>(scan, alias, 'drafts', draftsRead(s.maxThreads), `newer_than:${s.lookbackDays}d`);
  // A draft scheduled to go out later is taken care of.
  const scheduled = new Set((scan.ctx.schedules?.pending(alias) ?? []).map((x) => x.draft_id));
  const rows = await Promise.all(
    list.items.map(async (d): Promise<DraftRow | undefined> => {
      if (!d.message?.id || scheduled.has(d.id)) return undefined;
      const m = await fetchMessage(scan, alias, d.message.id, { format: 'metadata', metadataHeaders: ['To', 'Subject'] });
      const saved = ms(m);
      if (!m || !Number.isFinite(saved) || s.now - saved < s.draftsMinHours * HOUR_MS || s.now - saved > s.lookbackDays * DAY_MS) return undefined;
      const threadId = m.threadId || d.message.threadId;
      if (threadId && stillDismissed(dismissals.get(threadId), saved, s.today)) return undefined;
      // A reply already went out in its thread after it was saved: the draft is most likely a leftover.
      const thread = threadId && threadId !== m.id ? await scan.thread(alias, threadId) : undefined;
      const own = thread ? await scan.own(alias) : undefined;
      const conv = thread && conversation(thread);
      const superseded = !!conv && conv.messages.some((x, i) => conv.kinds[i] === undefined && ms(x) > saved && own!.has(senderOf(x) ?? ''));
      return {
        account: alias,
        draft_id: d.id,
        message_id: m.id,
        thread_id: threadId,
        to: addressLine(parseAddresses(headerValue(m.payload?.headers, 'To'))),
        subject: headerLine(m, 'Subject'),
        saved_at: iso(saved),
        days: daysAgo(saved, s.tz, s.today),
        superseded: superseded || undefined,
        web_url: gmailWebUrl(email, 'draft', m.id),
      };
    }),
  );
  return { rows: rows.filter((r): r is DraftRow => r !== undefined), truncated: list.truncated };
}

function waitingRow(alias: string, email: string, t: ListedThread, own: Set<string>, linked: Set<string>, s: Settings): Waiting | undefined {
  const row = awaitingRow(t.id, t.thread, own, email, s.waitingMinDays, s.now);
  const last = row && t.conv.messages.find((m) => m.id === row.message_id);
  if (!row || !last) return undefined;
  const to = others(last, own);
  // Mail among the linked accounts themselves is not something to chase.
  if (!s.includeInternal && to.every((a) => linked.has(mailbox(a.email)))) return undefined;
  // A forward its recipients never wrote back to was for information; one that drew their reply is a conversation like
  // any other. (The forwarded message itself may sit in the thread: its sender is no reply.)
  if (!s.includeForwards && FORWARD_SUBJECT.test(row.subject ?? '')) {
    const forwardedTo = new Set(to.map((a) => mailbox(a.email)));
    const answered = t.conv.messages.some((m, i) => t.conv.kinds[i] === undefined && forwardedTo.has(senderOf(m) ?? ''));
    if (!answered) return undefined;
  }
  const days = daysAgo(Date.parse(row.sent_at), s.tz, s.today);
  if (days > s.waitingMaxDays) return undefined;
  return {
    row: {
      account: alias,
      thread_id: t.id,
      message_id: row.message_id,
      to: addressLine(to),
      subject: row.subject,
      sent_at: row.sent_at,
      days_waiting: days,
      replies_received: row.replies_received,
      bounced: row.bounced,
      auto_reply: row.auto_reply,
      web_url: row.web_url,
    },
    awaited: to.map((a) => mailbox(a.email)).filter((a) => !linked.has(a)),
    awaitedRaw: to.filter((a) => !linked.has(mailbox(a.email))).map((a) => a.email.trim().toLowerCase()),
  };
}

/** A reply or forward: part of a conversation, never an automatic notice. */
const REPLY_SUBJECT = /^\s*(?:re|fwd?|tr|aw|wg|sv|vs|enc|rv)\s*:/i;
/** The code itself, soon after the word ("code : 482913", "code is 4821"); a year is no code. */
const CODE_DIGITS = /\bcode\b\D{0,30}\b(?!(?:19|20)\d\d\b)\d{4,8}\b/i;

/**
 * Whether a message is a one-time code or a security notice, which ask nothing of anyone. A reply ("Re: code review")
 * never is; in the text, only with the code itself next to the word: a person may well ask for "the access code" of a
 * building, and a postal code or a year is no code.
 */
export function codeOrSecurityNotice(subject: string | undefined, snippet: string | undefined): boolean {
  const s = subject ?? '';
  if (REPLY_SUBJECT.test(s)) return false;
  return ONE_TIME_CODE.test(s) || SECURITY_NOTICE.test(s) || (ONE_TIME_CODE.test(snippet ?? '') && CODE_DIGITS.test(snippet ?? ''));
}

/**
 * An owed row for the thread, or undefined; `ask` is the sender's address when it still has to be checked that the
 * account ever wrote to them (owed_from "correspondents").
 */
function owedRow(alias: string, email: string, t: ListedThread, own: Set<string>, linked: Set<string>, s: Settings): { row: OwedRow; ask?: string; address?: string } | undefined {
  const { messages, kinds } = t.conv;
  const index = kinds.findLastIndex((k) => k === undefined);
  const last = messages[index];
  const sender = last && senderOf(last);
  if (!last || !sender || own.has(sender)) return undefined;
  const h = last.payload?.headers;
  // Notifications and mailing lists expect no answer.
  const bulk = /^(?:bulk|junk)$/i.test(headerValue(h, 'Precedence')?.trim() ?? '');
  if (AUTOMATED_SENDER.test(sender.split('@')[0]!) || bulk || headerValue(h, 'List-Id') !== undefined || headerValue(h, 'List-Unsubscribe') !== undefined) return undefined;
  const received = ms(last);
  if (!Number.isFinite(received) || s.now - received < s.owedMinHours * HOUR_MS) return undefined;
  // Mail the account was only copied on in Bcc, or that reached it through a list or a forward, asks nothing of it,
  // unless it is part of a conversation the account took part in.
  const addressed = [headerValue(h, 'To'), headerValue(h, 'Cc')].flatMap(parseAddresses).some((a) => own.has(mailbox(a.email)));
  const wroteBefore = messages.slice(0, index).some((m, i) => kinds[i] === undefined && own.has(senderOf(m) ?? ''));
  if (!addressed && !wroteBefore) return undefined;
  const snippet = decodeSnippet(last.snippet ?? '');
  if (!wroteBefore && codeOrSecurityNotice(headerValue(h, 'Subject'), snippet)) return undefined;
  // A circular to a crowd asks nothing of the account, unless it took part in the conversation.
  if (!wroteBefore && recipients(last).length > BROADCAST_RECIPIENTS) return undefined;
  const address = parseAddresses(headerValue(h, 'From'))[0]?.email;
  // Mail from another linked account is internal: not something the user owes unless asked for.
  if (linked.has(sender) && !s.includeInternal) return undefined;
  if (daysAgo(received, s.tz, s.today) > s.owedMaxDays) return undefined;
  const ask = s.owedFrom === 'correspondents' && !wroteBefore && !linked.has(sender) ? address : undefined;
  const row: OwedRow = {
    account: alias,
    thread_id: t.id,
    message_id: last.id,
    from: headerLine(last, 'From'),
    subject: headerLine(last, 'Subject'),
    received_at: iso(received),
    days: daysAgo(received, s.tz, s.today),
    unread: (last.labelIds ?? []).includes('UNREAD') || undefined,
    internal: linked.has(sender) || undefined,
    snippet: snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS - 1)}…` : snippet,
    web_url: gmailWebUrl(email, 'thread', t.id),
  };
  return { row, ask, address: address?.trim().toLowerCase() };
}

interface BatchGroup {
  subject?: string;
  threads: ListedThread[];
}

/** Threads the account started with one subject, to at least BATCH_MIN_THREADS different recipients. */
function batchGroups(sent: ListedThread[], own: Set<string>): BatchGroup[] {
  const groups = new Map<string, { threads: ListedThread[]; to: Set<string>; subjects: Map<string, number> }>();
  for (const t of sent) {
    const first = t.conv.messages[0];
    if (!first || !own.has(senderOf(first) ?? '')) continue;
    const subject = headerLine(first, 'Subject');
    const key = normalizeSubject(subject ?? '');
    if (!subject || !key) continue;
    const group = groups.get(key) ?? { threads: [], to: new Set<string>(), subjects: new Map<string, number>() };
    group.threads.push(t);
    group.to.add(others(first, own).map((a) => mailbox(a.email)).sort().join(','));
    group.subjects.set(subject, (group.subjects.get(subject) ?? 0) + 1);
    groups.set(key, group);
  }
  // The same subject to the same person every week ("Weekly report") is a habit, not a batch.
  return [...groups.values()]
    .filter((g) => g.threads.length >= BATCH_MIN_THREADS && g.to.size >= BATCH_MIN_THREADS)
    .map((g) => ({ threads: g.threads, subject: [...g.subjects].sort((a, b) => b[1] - a[1])[0]![0] }));
}

/**
 * A batch's state, and the threads it reports as pending (replies to answer, requests nobody answered); undefined when
 * it is settled (every reply answered, nobody silent) or all of it was dismissed.
 */
function batchRow(
  alias: string,
  email: string,
  g: BatchGroup,
  own: Set<string>,
  visible: (threadId: string, latestMs: number) => boolean,
): { row: BatchRow; pending: string[] } | undefined {
  const replied: BatchReply[] = [];
  const silent: BatchSilence[] = [];
  const pending: string[] = [];
  let sentAt = Number.POSITIVE_INFINITY;
  for (const t of g.threads) {
    if (!visible(t.id, t.latestMs)) continue;
    const { messages, kinds } = t.conv;
    const human = messages.filter((_, i) => kinds[i] === undefined);
    const mine = (m: GmailMessage) => own.has(senderOf(m) ?? '');
    const lastTheirs = human.filter((m) => !mine(m)).at(-1);
    const first = messages[0]!;
    sentAt = Math.min(sentAt, ms(first));
    const web_url = gmailWebUrl(email, 'thread', t.id);
    if (!lastTheirs) {
      silent.push({ who: addressLine(others(first, own)), thread_id: t.id, sent_at: iso(ms(first)), web_url });
      pending.push(t.id);
      continue;
    }
    const answered = ms(human.filter(mine).at(-1)) > ms(lastTheirs);
    if (!answered) pending.push(t.id);
    const unread = (lastTheirs.labelIds ?? []).includes('UNREAD') || undefined;
    replied.push({ who: headerLine(lastTheirs, 'From'), thread_id: t.id, last_reply_at: iso(ms(lastTheirs)), answered, unread, web_url });
  }
  if (!pending.length) return undefined;
  // Replies still to answer first, oldest first; then the answered ones.
  replied.sort((a, b) => Number(a.answered) - Number(b.answered) || a.last_reply_at.localeCompare(b.last_reply_at));
  silent.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  return {
    row: {
      account: alias,
      subject: g.subject,
      sent_at: iso(sentAt),
      sent: replied.length + silent.length,
      replied_count: replied.length,
      no_reply_count: silent.length,
      // All of them: the ones answered another way are found before the list is cut to BATCH_LIST.
      replied,
      no_reply: silent.slice(0, BATCH_LIST),
    },
    pending,
  };
}

// ---------------------------------------------------------------------------
// Tracked items

const STATUS_ORDER: Record<TrackedStatus, number> = { ready: 0, overdue: 1, due: 2, waiting: 3, done: 4 };

export function trackedStatus(item: Followup, today: string): TrackedStatus {
  if (item.status === 'done') return 'done';
  if (item.arrived) return 'ready';
  if (item.due && item.due < today) return 'overdue';
  return item.due === today ? 'due' : 'waiting';
}

/** An item as followups and followup_track show it; `today` is in the default time zone. */
export function trackedRow(ctx: ToolContext, item: Followup, today: string, other?: Omit<OtherMail, 'web_url'>): TrackedRow {
  const arrivedIn = item.arrived && ctx.accounts.get(item.arrived.account)?.email;
  const otherIn = other && ctx.accounts.get(other.account)?.email;
  return {
    id: item.id,
    account: item.account,
    title: item.title,
    next_step: item.next_step,
    waiting_on: item.waiting_on,
    watch_threads: item.watch_threads,
    expects_attachment: item.expects_attachment,
    due: item.due,
    status: trackedStatus(item, today),
    arrived: item.arrived && { ...item.arrived, web_url: arrivedIn ? gmailWebUrl(arrivedIn, 'thread', item.arrived.thread_id) : undefined },
    other_mail: item.arrived || !other ? undefined : { ...other, web_url: otherIn ? gmailWebUrl(otherIn, 'thread', other.thread_id) : undefined },
    notes: item.notes,
    created_at: iso(item.created_at),
    age_days: daysAgo(item.created_at, ctx.config.defaultTimezone, today),
  };
}

function compareTracked(a: TrackedRow, b: TrackedRow): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.created_at.localeCompare(b.created_at);
}

function arrivalOf(alias: string, m: GmailMessage): ArrivedMessage {
  return {
    account: alias,
    thread_id: m.threadId,
    message_id: m.id,
    from: headerLine(m, 'From'),
    subject: headerLine(m, 'Subject'),
    date: iso(ms(m)),
    // Parts read: a document, not a signature's logo. Headers only: Gmail's sign of an attachment.
    has_attachments: (m.payload?.parts ? hasDocument(m.payload) : hasAttachments(m.payload)) || undefined,
  };
}

/**
 * Whether a message's parts include a file that is not an inline picture: pictures inside multipart/related are shown
 * in the text (signature logos and icons, pasted images), and Outlook's image001.png names give them away elsewhere.
 */
export function hasDocument(part: GmailPart | undefined, inRelated = false): boolean {
  if (!part) return false;
  const picture = (part.mimeType ?? '').toLowerCase().startsWith('image/');
  if (part.filename && !INLINE_PICTURE.test(part.filename) && !(inRelated && picture)) return true;
  const related = (part.mimeType ?? '').toLowerCase() === 'multipart/related';
  return (part.parts ?? []).some((p) => hasDocument(p, related));
}

/** What a look for an item's awaited message found: the arrival, or mail from its people that did not count. */
interface Detection {
  arrived?: ArrivedMessage;
  other?: Omit<OtherMail, 'web_url'>;
}

const newestFirst = <T extends { date: string }>(xs: (T | undefined)[]): T | undefined => xs.filter((x): x is T => x !== undefined).sort((a, b) => b.date.localeCompare(a.date))[0];

/** A message that counts as the awaited one: newer than `since`, written by a person, not by the user (`own`). */
function arrives(m: GmailMessage | undefined, since: number, own: Set<string>): m is GmailMessage {
  return !!m && ms(m) > since && !(m.labelIds ?? []).some((l) => IGNORED_LABELS.has(l)) && automatic(m) === undefined && !own.has(senderOf(m) ?? '');
}

/** The newest message someone else wrote in a watched thread after `since` (with a document, when the item expects one). */
async function fromWatchedThread(scan: Scan, item: Followup, w: ThreadRef, since: number): Promise<Detection> {
  try {
    const thread = await scan.thread(w.account, w.thread_id);
    if (!thread) return {};
    // Neither the mailbox holding the thread nor the item's home account: when the lawyer writes to a partner's account, the
    // user's own answer from theirs lands in that thread too, and is not what the item waits for.
    const [held, home] = await Promise.all([scan.own(w.account), scan.self(item.account)]);
    const user = new Set([...held, ...home]);
    const candidates = conversation(thread)
      .messages.filter((m) => arrives(m, since, user))
      .reverse();
    if (!candidates.length) return {};
    // Read again for its parts' names: thread metadata says nothing of attachments.
    const read = (m: GmailMessage) => fetchMessage(scan, w.account, m.id, { format: 'full', fields: ARRIVAL_FIELDS }).then((full) => full ?? m);
    const newest = await read(candidates[0]!);
    if (!item.expects_attachment || hasDocument(newest.payload)) return { arrived: arrivalOf(w.account, newest) };
    for (const m of candidates.slice(1, ATTACHMENT_CANDIDATES)) {
      const full = await read(m);
      if (hasDocument(full.payload)) return { arrived: arrivalOf(w.account, full) };
    }
    return { other: { ...arrivalOf(w.account, newest), reason: 'no_attachment' } };
  } catch (err) {
    scan.fail(w.account, err);
    return {};
  }
}

/**
 * The newest message from one of the item's addresses in the account's mailbox after `since`. With watched threads,
 * only mail in them counts (the rest is other mail from them); with expects_attachment, only mail with a document.
 */
async function fromAddresses(scan: Scan, alias: string, item: Followup, since: number): Promise<Detection> {
  try {
    const own = await scan.own(alias);
    const q = `from:(${item.waiting_on!.join(' OR ')}) after:${Math.floor(since / 1000)}`;
    const search = (query: string) =>
      scan.call(alias, () => scan.ctx.google.request<{ messages?: { id: string }[] }>(alias, SERVICE, { url: '/messages', query: { q: query, maxResults: ARRIVAL_SEARCH } }));
    // A document expected: also its own search, so a few short messages after it do not push it out of the newest five.
    const lists = await Promise.all([search(q), ...(item.expects_attachment ? [search(`${q} has:attachment`)] : [])]);
    const ids = [...new Set(lists.flatMap((l) => (l.messages ?? []).map((m) => m.id)))];
    const found = await Promise.all(ids.map((id) => fetchMessage(scan, alias, id, { format: 'full', fields: ARRIVAL_FIELDS })));
    const sorted = found.filter((m) => arrives(m, since, own)).sort((a, b) => ms(b) - ms(a));
    const watched = item.watch_threads?.length ? new Set(item.watch_threads.filter((w) => w.account === alias).map((w) => w.thread_id)) : undefined;
    const inWatched = (m: GmailMessage) => !watched || watched.has(m.threadId);
    const counts = sorted.find((m) => inWatched(m) && (!item.expects_attachment || hasDocument(m.payload)));
    if (counts) return { arrived: arrivalOf(alias, counts) };
    const newest = sorted[0];
    return newest ? { other: { ...arrivalOf(alias, newest), reason: inWatched(newest) ? 'no_attachment' : 'other_conversation' } } : {};
  } catch (err) {
    scan.fail(alias, err);
    return {};
  }
}

/** What arrived for an item, newest first: in its watched threads, or from its addresses in every linked Gmail account. */
async function detectArrival(scan: Scan, item: Followup, mailboxes: string[]): Promise<Detection> {
  const since = item.since ?? item.created_at;
  const found = await Promise.all([
    ...(item.watch_threads ?? []).map((w) => fromWatchedThread(scan, item, w, since)),
    ...(item.waiting_on?.length ? mailboxes.map((alias) => fromAddresses(scan, alias, item, since)) : []),
  ]);
  const arrived = newestFirst(found.map((d) => d.arrived));
  return arrived ? { arrived } : { other: newestFirst(found.map((d) => d.other)) };
}

/** Whether a stored arrival is what the item waits for under the current rules. */
function arrivalCounts(item: Followup, arrived: ArrivedMessage): boolean {
  const watched = item.watch_threads ?? [];
  if (watched.length && !watched.some((w) => w.account === arrived.account && w.thread_id === arrived.thread_id)) return false;
  return !item.expects_attachment || arrived.has_attachments === true;
}

async function trackedRows(scan: Scan, selected: string[] | undefined): Promise<TrackedRow[]> {
  const { ctx, s } = scan;
  const items = ctx.followups.list({ status: 'open', accounts: selected });
  // Every Gmail account is searched for arrivals (one that needs re-linking is reported in errors, not skipped).
  const mailboxes = gmailAccounts(ctx);
  const working = mailboxes.filter((a) => ctx.accounts.get(a)?.status !== 'needs_relink');
  const current = await Promise.all(
    items.map(async (item): Promise<[Followup, Detection['other']]> => {
      if (item.arrived && arrivalCounts(item, item.arrived)) return [item, undefined];
      // Recorded under earlier rules (mail in another conversation, no document): looked at again.
      if (item.arrived) item = ctx.followups.update(item.id, { arrived: null }) ?? item;
      const { arrived, other } = await detectArrival(scan, item, mailboxes);
      // Stored, so the item stays ready until it is closed, whatever happens to the message.
      return arrived ? [ctx.followups.update(item.id, { arrived }) ?? item, undefined] : [item, other];
    }),
  );
  const rows = await Promise.all(
    current.map(async ([item, other]) => {
      const row = trackedRow(ctx, item, s.today, other);
      // Ready, but the user already wrote back to whoever sent what arrived (from the item's account or the one it
      // arrived in): most likely done, waiting only to be closed.
      const arrived = item.arrived;
      const sender = arrived && parseAddresses(arrived.from ?? '')[0]?.email;
      if (row.status === 'ready' && arrived && sender) {
        const at = Date.parse(arrived.date);
        const homes = [...new Set([arrived.account, item.account])].filter((a) => working.includes(a));
        if (Number.isFinite(at) && (await scan.anyOf(homes, (a) => scan.wroteToAfter(a, sender, at)))) row.handled = true;
      }
      return row;
    }),
  );
  return rows.sort(compareTracked);
}

/**
 * What items whose awaited message arrived (ready, or closed since) cover, each up to its arrival: that message and the
 * threads it came in or they watch (owed and waiting there), and for an item waiting on addresses alone, what the user
 * sent only to those people.
 */
function coverage(items: Pick<Followup, 'arrived' | 'watch_threads' | 'waiting_on'>[]): { owed: (o: OwedRow) => boolean; waiting: (w: Waiting) => boolean } {
  const key = (account: string, id: string) => `${account}\n${id}`;
  const arrivals = new Set<string>();
  const threads = new Map<string, number>();
  const people: { addresses: Set<string>; until: number }[] = [];
  for (const t of items) {
    if (!t.arrived) continue;
    // A message Gmail gave no date covers only itself.
    const until = Date.parse(t.arrived.date) || Number.NEGATIVE_INFINITY;
    arrivals.add(key(t.arrived.account, t.arrived.message_id));
    for (const x of [t.arrived, ...(t.watch_threads ?? [])]) {
      const k = key(x.account, x.thread_id);
      threads.set(k, Math.max(threads.get(k) ?? until, until));
    }
    if (t.waiting_on?.length && !t.watch_threads?.length) people.push({ addresses: new Set(t.waiting_on.map(mailbox)), until });
  }
  const upTo = (at: string, until: number | undefined) => until !== undefined && Date.parse(at) <= until;
  return {
    owed: (o) => arrivals.has(key(o.account, o.message_id)) || upTo(o.received_at, threads.get(key(o.account, o.thread_id))),
    waiting: ({ row, awaited }) =>
      upTo(row.sent_at, threads.get(key(row.account, row.thread_id))) ||
      people.some((p) => awaited.length > 0 && awaited.every((a) => p.addresses.has(a)) && upTo(row.sent_at, p.until)),
  };
}

// ---------------------------------------------------------------------------

/** Every linked account granting Gmail, working or not: one that needs re-linking is reported in errors, not skipped. */
function gmailAccounts(ctx: ToolContext): string[] {
  return ctx.accounts.list().flatMap((a) => (a.services.includes(SERVICE) ? [a.alias] : []));
}

/** Explicit aliases (normalised, deduplicated), or undefined for the default. */
function explicitAliases(requested: string[] | undefined): string[] | undefined {
  const aliases = [...new Set((requested ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))];
  return aliases.length ? aliases : undefined;
}

/** What needs attention across the accounts. Per-account failures are reported in errors; the rest of the report stands. */
export async function computeFollowups(ctx: ToolContext, opts: FollowupOptions = {}): Promise<FollowupReport> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const lookbackDays = bounded(opts.lookback_days, 30, 1, 90);
  const s: Settings = {
    sections: new Set(opts.sections?.length ? opts.sections : FOLLOWUP_SECTIONS),
    lookbackDays,
    waitingMinDays: bounded(opts.waiting_min_days, 3, 0, lookbackDays),
    owedMinHours: bounded(opts.owed_min_hours, 12, 0, lookbackDays * 24),
    draftsMinHours: bounded(opts.drafts_min_hours, 12, 0, 24 * 365),
    includeInternal: opts.include_internal ?? false,
    owedFrom: opts.owed_from ?? 'correspondents',
    includeForwards: opts.include_forwards ?? false,
    waitingMaxDays: bounded(opts.waiting_max_days, lookbackDays, 0, lookbackDays),
    owedMaxDays: bounded(opts.owed_max_days, lookbackDays, 0, lookbackDays),
    maxThreads: bounded(opts.max_threads_per_account, DEFAULT_THREADS_READ, 1, MAX_THREADS_READ),
    concurrency: bounded(opts.concurrency, FETCH_CONCURRENCY, 1, FETCH_CONCURRENCY),
    now,
    tz: ctx.config.defaultTimezone,
    today: todayIn(ctx.config.defaultTimezone, new Date(now)),
  };
  const scan = new Scan(ctx, s);
  const explicit = explicitAliases(opts.accounts);
  const aliases = explicit ?? gmailAccounts(ctx);
  const linked = new Set(ctx.accounts.list().map((a) => mailbox(a.email)));
  const automaticSections = (['owed', 'drafts', 'waiting', 'batches'] as const).some((x) => s.sections.has(x));

  // Accounts asked whether a matter was answered another way: the ones being read (as chosen), working ones only.
  const mailboxes = aliases.filter((a) => ctx.accounts.get(a)?.services.includes(SERVICE) && ctx.accounts.get(a)?.status !== 'needs_relink');
  const scanned = async (alias: string): Promise<AccountRows[]> => {
    try {
      return [await scanAccount(scan, alias, linked, mailboxes)];
    } catch (err) {
      scan.fail(alias, err);
      return [];
    }
  };
  const [perAccount, tracked] = await Promise.all([
    automaticSections ? Promise.all(aliases.map(scanned)) : [],
    s.sections.has('tracked') ? trackedRows(scan, explicit) : [],
  ]);
  const rows: AccountRows[] = perAccount.flat();
  // What a ready item covers is that item's next step, not a second thing to do: the lawyer's reply is listed once,
  // under tracked, and the request it answers waits no more. Only up to its arrival: what comes after is news again.
  // Once the item is closed, that step was taken: what it covered stays settled, whatever sections were asked for
  // (closed items are kept 30 days, past any default look-back).
  const closed = automaticSections ? ctx.followups.list({ status: 'done' }).filter((i) => i.arrived) : [];
  const covered = coverage([...tracked.filter((t) => t.status === 'ready'), ...closed]);
  // Oldest first: what has waited longest comes first.
  const owed = rows
    .flatMap((r) => r.owed)
    .filter((o) => !covered.owed(o))
    .sort((a, b) => a.received_at.localeCompare(b.received_at));
  const drafts = rows.flatMap((r) => r.drafts).sort((a, b) => a.saved_at.localeCompare(b.saved_at));
  // Newest first: a request sent last week is worth a reminder, one from a month ago has mostly been dealt with otherwise.
  const waiting = rows
    .flatMap((r) => r.waiting)
    .filter((w) => !covered.waiting(w))
    .map((w) => w.row)
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const batches = rows.flatMap((r) => r.batches).sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const truncated = rows.flatMap((r) => (r.truncated.length ? [{ account: r.account, sections: r.truncated }] : []));
  const count = (status: TrackedStatus) => tracked.filter((t) => t.status === status && !t.handled).length;
  const report: FollowupReport = {
    generated_at: iso(now),
    accounts: aliases,
    counts: { ready: count('ready'), handled: tracked.filter((t) => t.handled).length, overdue: count('overdue'), due: count('due'), owed: owed.length, drafts: drafts.length, waiting: waiting.length, batches: batches.length },
    tracked,
    owed,
    drafts,
    waiting,
    batches,
    errors: scan.errors.size ? [...scan.errors].map(([account, error]) => ({ account, error })) : undefined,
    truncated: truncated.length ? truncated : undefined,
  };
  ctx.log.debug('followups', {
    accounts: aliases.length,
    tracked: tracked.length,
    ready: report.counts.ready,
    owed: owed.length,
    drafts: drafts.length,
    waiting: waiting.length,
    batches: batches.length,
    errors: scan.errors.size,
    truncated: truncated.length,
    unchecked_rows: scan.softFailures || undefined,
    ms: Date.now() - started,
  });
  return report;
}
