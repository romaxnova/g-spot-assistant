/**
 * Follow-up tools: followups (what needs attention across the accounts),
 * followup_track (remember something the user waits for, across chats) and
 * followup_dismiss (hide threads, or drafts kept on purpose, from the
 * automatic lists).
 *
 * The work is done by src/followups/engine.ts, shared with the daily digest;
 * these tools add argument checks and clip the lists for claude.ai's context.
 * Nothing here logs titles, notes, addresses or subjects.
 */
import * as z from 'zod';
import { AccountError, GoogleApiError } from '../../google/client.js';
import {
  computeFollowups,
  DEFAULT_THREADS_READ,
  draftsRead,
  FOLLOWUP_SECTIONS,
  latestMessageMs,
  MAX_THREADS_READ,
  OWED_FROM,
  stillDismissed,
  trackedRow,
  type FollowupReport,
} from '../../followups/engine.js';
import { FollowupError, type FollowupPatch, type ThreadRef } from '../../followups/store.js';
import { DIGEST_FREQUENCIES, DIGEST_LANGS, digestInbox, DigestSettingsError, inboxProblem, WEEKDAYS, type DigestSettings } from '../../followups/digest.js';
import { defineTool, errorResult, jsonResult, ToolInputError, type ToolContext, type ToolDefinition } from '../registry.js';
import { todayIn } from './cross.js';
import type { GmailThread } from './gmail-followup.js';
import { parseAddresses } from './gmail-mime.js';
import { encodeId, FETCH_CONCURRENCY, mapLimit, SERVICE, type GmailMessage } from './gmail.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ADDRESS_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
const MAX_WAITING_ON = 10;
const MAX_WATCH_THREADS = 10;

/** True for a real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function today(ctx: ToolContext): string {
  return todayIn(ctx.config.defaultTimezone);
}

/** A linked account's alias (normalised), or a ToolInputError naming the linked ones. */
function knownAccount(ctx: ToolContext, alias: string, field: string): string {
  const wanted = alias.trim().toLowerCase();
  if (ctx.accounts.get(wanted)) return wanted;
  const known = ctx.accounts.list().map((a) => a.alias);
  throw new ToolInputError(`${field}: no linked account "${alias}". Linked aliases: ${known.join(', ') || 'none'} (see list_accounts).`);
}

/** A Gmail read, or undefined when what it asks for does not exist (404). */
async function ifFound<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return undefined;
    throw err;
  }
}

interface Found {
  threadId: string;
  /** Time of the thread's latest message, drafts included. */
  latestMs: number;
  /** The id named an unsent draft: its time. */
  draftMs?: number;
}

/**
 * The thread an id names in the account. A message id is accepted too (it is mapped to its thread; draftMs tells it
 * was a draft's). Undefined when neither exists.
 */
async function findThread(ctx: ToolContext, account: string, id: string): Promise<Found | undefined> {
  const thread = await ifFound(ctx.google.request<GmailThread>(account, SERVICE, { url: `/threads/${encodeId(id)}`, query: { format: 'minimal' } }));
  if (thread) return { threadId: thread.id ?? id, latestMs: latestMessageMs(thread) };
  const message = await ifFound(ctx.google.request<GmailMessage>(account, SERVICE, { url: `/messages/${encodeId(id)}`, query: { format: 'minimal' } }));
  if (!message?.threadId || message.threadId === id) return undefined;
  const found = await findThread(ctx, account, message.threadId);
  return found && ((message.labelIds ?? []).includes('DRAFT') ? { ...found, draftMs: Number(message.internalDate) || found.latestMs } : found);
}

/** The thread of a draft (by draft id) and the draft's time; undefined when it does not exist. */
async function findDraft(ctx: ToolContext, account: string, draftId: string): Promise<Found | undefined> {
  const draft = await ifFound(ctx.google.request<{ message?: GmailMessage }>(account, SERVICE, { url: `/drafts/${encodeId(draftId)}`, query: { format: 'minimal' } }));
  const found = draft?.message?.threadId ? await findThread(ctx, account, draft.message.threadId) : undefined;
  return found && { ...found, draftMs: Number(draft?.message?.internalDate) || found.latestMs };
}

// ---------------------------------------------------------------------------
// followups

/** What was read of the listings cut short, and whether max_threads_per_account can read more; undefined when none was. */
function cutNote(report: FollowupReport, maxThreads: number): string | undefined {
  const where = (drafts: boolean) => (report.truncated ?? []).filter((t) => t.sections.some((x) => (x === 'drafts') === drafts)).map((t) => t.account);
  const lists = where(false);
  const drafts = where(true);
  if (!lists.length && !drafts.length) return undefined;
  const read = [
    lists.length ? `the ${maxThreads} most recently active threads per list in ${lists.join(', ')}` : '',
    drafts.length ? `the ${draftsRead(maxThreads)} most recent drafts in ${drafts.join(', ')}` : '',
  ].filter(Boolean);
  const more = maxThreads < MAX_THREADS_READ ? ` max_threads_per_account (up to ${MAX_THREADS_READ}) reads more.` : '';
  return `Only ${read.join(' and ')} were read (see truncated): older ones were not looked at.${more}`;
}

/**
 * What to tell Claude about the report beside its rows. Accounts that failed are unknown, not quiet, and listings cut
 * short say nothing of older mail: "nothing needs attention" is said only of what was actually read in full.
 */
function reportNote(report: FollowupReport, empty: boolean, maxThreads: number): string | undefined {
  if (!report.accounts.length) return empty ? 'No linked account has Gmail: link one on the admin page (see list_accounts).' : undefined;
  const failed = new Set(report.errors?.map((e) => e.account));
  const read = report.accounts.filter((a) => !failed.has(a));
  if (!read.length) return 'No account could be checked (see errors): owed mail, drafts, waiting mail and batches are unknown, not empty. Tell the user, do not say nothing is pending.';
  const cut = cutNote(report, maxThreads);
  if (!empty) return cut;
  const unread = report.accounts.filter((a) => failed.has(a));
  const quiet = cut
    ? `Nothing found in the threads read in ${read.join(', ')}`
    : unread.length
      ? `Nothing needs attention in ${read.join(', ')}`
      : 'Nothing needs attention: no tracked item, no unanswered mail, unsent draft or pending batch in the period';
  return [`${quiet}${unread.length ? `; ${unread.join(', ')} could not be checked (see errors)` : ''}.`, cut].filter(Boolean).join(' ');
}

export const followups: ToolDefinition = defineTool({
  name: 'followups',
  title: 'What needs following up',
  description:
    'What needs attention across the linked accounts, in one call. Call it when the user asks what is pending or what to follow up, at the start of a working session, and from scheduled tasks. ' +
    'tracked: items recorded with followup_track, ready first (what they waited for arrived, see arrived: do their next_step now, as a draft the user confirms), then overdue, due today, waiting; ' +
    'handled: true on a ready item means the user already wrote back to whoever sent what arrived: probably done, ask whether to close it (followup_track status "done"). ' +
    'other_mail on a waiting item is mail from its people that did not make it ready (reason other_conversation: outside its watched threads; no_attachment: it expects a document): read it and, if it is the awaited one, act on it. ' +
    'owed: mail people sent the user that is still unanswered (they wait on the user), from people the user has written to (owed_from "anyone" lists first-time senders too); one-time codes, security alerts, circulars and mail from other linked accounts (include_internal) are left out, and so is mail the user answered another way (wrote to them since, in another thread or from another linked account); what a ready tracked item awaited, and its threads up to that arrival, are listed under the item only (and not again once it is closed). ' +
    'drafts: unsent drafts older than 12 hours, saved within lookback_days: ask whether to send, update or delete them (one kept on purpose: followup_dismiss with its draft_id); superseded: true means a reply went out in its thread since: offer to delete it. ' +
    'waiting: sent mail nobody answered for waiting_min_days or more, newest first (forwards nobody answered, and requests every recipient answered another way, are left out): for rows older than about 7 days, offer a polite reminder draft (mind sensitive contacts: one short reminder, not a series). ' +
    'batches: one request sent separately to 3 or more people (quote requests): who replied (answered: whether the user wrote back since; unread) and who never did; replies the user answered also wait under waiting. ' +
    'Mail only between linked accounts is left out of waiting unless include_internal. Ages (days, days_waiting, age_days) are calendar days in the default time zone. Rows carry web_url; thread_id and message_id work with the gmail_* tools; followup_dismiss hides rows that need nothing. ' +
    'counts are totals before clipping (*_more: rows cut). Accounts that fail are listed in errors; truncated names the sections of accounts with more threads (or drafts) than were read, whose older mail was not read. Read-only.',
  inputSchema: {
    accounts: z.array(z.string().min(1)).max(20).optional().describe('Account aliases to look at (see list_accounts). Default: every linked account with Gmail.'),
    sections: z.array(z.enum(FOLLOWUP_SECTIONS)).min(1).optional().describe('Sections to compute (default all): tracked, owed, drafts, waiting, batches.'),
    lookback_days: z.number().int().min(1).max(90).optional().describe('How far back mail is read, in days (1-90, default 30).'),
    waiting_min_days: z.number().int().min(0).max(60).optional().describe('Sent mail counts as waiting once unanswered this many days (default 3).'),
    owed_min_hours: z.number().int().min(0).max(720).optional().describe('Received mail counts as owed once unanswered this many hours (default 12).'),
    include_internal: z.boolean().optional().describe('Also list mail between linked accounts: sent only to them (waiting) or from them (owed). Default false.'),
    owed_from: z
      .enum(OWED_FROM)
      .optional()
      .describe('owed: "correspondents" (default) lists mail from people the account has written to, or in conversations it took part in; "anyone" adds first-time senders.'),
    include_forwards: z.boolean().optional().describe('waiting: also list forwards nobody answered (default false: usually sent for information).'),
    waiting_max_days: z.number().int().min(0).max(90).optional().describe('waiting: leave out sent mail unanswered for longer than this many days (default: lookback_days).'),
    owed_max_days: z.number().int().min(0).max(90).optional().describe('owed: leave out mail unanswered for longer than this many days (default: lookback_days).'),
    max_per_section: z.number().int().min(1).max(50).optional().describe('Rows per section, 1-50 (default 15).'),
    max_threads_per_account: z
      .number()
      .int()
      .min(1)
      .max(MAX_THREADS_READ)
      .optional()
      .describe(`Threads read per listing and account, newest activity first (1-${MAX_THREADS_READ}, default ${DEFAULT_THREADS_READ}; drafts: at least 50); raise it when truncated names an account.`),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const report = await computeFollowups(ctx, {
      accounts: args.accounts,
      sections: args.sections,
      lookback_days: args.lookback_days,
      waiting_min_days: args.waiting_min_days,
      owed_min_hours: args.owed_min_hours,
      include_internal: args.include_internal,
      owed_from: args.owed_from,
      include_forwards: args.include_forwards,
      waiting_max_days: args.waiting_max_days,
      owed_max_days: args.owed_max_days,
      max_threads_per_account: args.max_threads_per_account,
    });
    const max = args.max_per_section ?? 15;
    const more = (rows: unknown[]) => Math.max(0, rows.length - max) || undefined;
    const empty = !report.tracked.length && !report.owed.length && !report.drafts.length && !report.waiting.length && !report.batches.length;
    // Counts and errors first: if a very long result is cut, it is cut from the end.
    return jsonResult({
      generated_at: report.generated_at,
      accounts: report.accounts,
      counts: report.counts,
      errors: report.errors,
      truncated: report.truncated,
      tracked: report.tracked.slice(0, max),
      tracked_more: more(report.tracked),
      owed: report.owed.slice(0, max),
      owed_more: more(report.owed),
      drafts: report.drafts.slice(0, max),
      drafts_more: more(report.drafts),
      waiting: report.waiting.slice(0, max),
      waiting_more: more(report.waiting),
      batches: report.batches.slice(0, max),
      batches_more: more(report.batches),
      note: reportNote(report, empty, args.max_threads_per_account ?? DEFAULT_THREADS_READ),
    });
  },
});

// ---------------------------------------------------------------------------
// followup_track

const threadRefParam = z.object({
  account: z.string().min(1).optional().describe("Alias of the mailbox holding the thread (default: the item's account)."),
  thread_id: z.string().min(1).describe('Gmail thread id (a message id is accepted too).'),
});

/** Lower-case addresses from "a@b.c" or "Name <a@b.c>" entries, deduplicated; a ToolInputError for anything else. */
function waitingOnAddresses(entries: string[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    const address = (parseAddresses(entry)[0]?.email ?? '').trim().toLowerCase();
    if (!ADDRESS_RE.test(address)) throw new ToolInputError(`waiting_on: "${entry}" is not an email address (e.g. jean@cabinet.fr).`);
    out.add(address);
  }
  if (out.size > MAX_WAITING_ON) throw new ToolInputError(`waiting_on: at most ${MAX_WAITING_ON} addresses.`);
  return [...out];
}

/** Watched threads, checked to exist (a message id is replaced by its thread's id). */
async function watchedThreads(ctx: ToolContext, refs: { account?: string; thread_id: string }[], home: string): Promise<ThreadRef[]> {
  const resolved = await mapLimit(refs, FETCH_CONCURRENCY, async (ref) => {
    const account = ref.account ? knownAccount(ctx, ref.account, 'watch_threads.account') : home;
    const found = await findThread(ctx, account, ref.thread_id.trim());
    if (!found) throw new ToolInputError(`watch_threads: no thread "${ref.thread_id}" in account "${account}". Pass a thread_id from gmail_search or gmail_get_message, with the account holding it.`);
    return { account, thread_id: found.threadId };
  });
  const seen = new Set<string>();
  return resolved.filter((r) => !seen.has(`${r.account}\n${r.thread_id}`) && seen.add(`${r.account}\n${r.thread_id}`));
}

function dueDate(value: string, field = 'due'): string {
  const v = value.trim();
  if (!isCalendarDate(v)) throw new ToolInputError(`${field}: "${value}" is not a date written YYYY-MM-DD.`);
  return v;
}

export const followupTrack: ToolDefinition = defineTool({
  name: 'followup_track',
  title: 'Track a follow-up',
  description:
    'Remembers, across chats, something the user is waiting for, so it is not forgotten. Call it whenever the user waits on someone or something, or a sent message needs a reply before something else can happen ' +
    '(e.g. waiting for the lawyer to send the power of attorney, then sending it to the translators who quoted). Include who (waiting_on: their addresses, looked for in every linked mailbox, so mail sent to another linked account counts too; and/or watch_threads), ' +
    'the next_step to take once it arrives, and a due date. followups then shows the item, ready as soon as mail from them, or a new message in a watched thread, arrives. ' +
    'The connector notifies no one by itself: the item reaches the user when followups is called, or in the digest email (followup_digest, off by default), so offer that rather than promising a reminder. ' +
    'Update by id (empty string or [] clears a field); when handled, close it with status "done". If what arrived was not the awaited message, keep_waiting: true forgets it and keeps watching for newer mail. Returns the item.',
  inputSchema: {
    id: z.string().min(1).optional().describe('Item to update (fu_...). Omit to create one.'),
    account: z.string().min(1).optional().describe('Home account alias of the item (default: the first linked account with Gmail).'),
    title: z.string().max(200).optional().describe('What is awaited, in a few words (required to create; at most 200 characters).'),
    next_step: z.string().max(1000).optional().describe('What to do once it arrives, e.g. "send the power of attorney to the 8 translators who replied to the quote request".'),
    waiting_on: z.array(z.string().min(1)).max(MAX_WAITING_ON).optional().describe(`Email addresses whose next message makes the item ready (at most ${MAX_WAITING_ON}).`),
    watch_threads: z
      .array(threadRefParam)
      .max(MAX_WATCH_THREADS)
      .optional()
      .describe(`Threads whose next message from someone else makes the item ready (at most ${MAX_WATCH_THREADS}). With watch_threads, mail from waiting_on elsewhere is only reported (other_mail).`),
    expects_attachment: z
      .boolean()
      .optional()
      .describe('What is awaited is a document (a signed form, a certificate, a scan): only a message with an attachment makes the item ready; others are reported as other_mail.'),
    due: z.string().optional().describe('Date by which it should have come or be done, YYYY-MM-DD (in the default time zone).'),
    notes: z.string().max(2000).optional().describe('Context worth remembering (at most 2,000 characters).'),
    status: z.enum(['open', 'done']).optional().describe('"done" closes the item (closed items are deleted after 30 days); "open" reopens it.'),
    keep_waiting: z.boolean().optional().describe('The message that arrived was not the awaited one: forget it and keep watching for newer mail.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (args, ctx) => {
    const text = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
    const waitingOn = args.waiting_on && waitingOnAddresses(args.waiting_on);
    const due = args.due === undefined ? undefined : args.due.trim() ? dueDate(args.due) : null;
    try {
      if (!args.id) {
        const title = args.title?.trim();
        if (!title) throw new ToolInputError('title: say what is awaited, in a few words (required to create an item).');
        const account = args.account
          ? knownAccount(ctx, args.account, 'account')
          : (ctx.google.accountsFor(SERVICE)[0]?.alias ?? ctx.accounts.list()[0]?.alias);
        if (!account) throw new ToolInputError('No Google account is linked yet: link one on the admin page first.');
        const watch = args.watch_threads?.length ? await watchedThreads(ctx, args.watch_threads, account) : undefined;
        const item = ctx.followups.create({
          account,
          title,
          next_step: text(args.next_step) ?? undefined,
          notes: text(args.notes) ?? undefined,
          waiting_on: waitingOn,
          watch_threads: watch,
          expects_attachment: args.expects_attachment,
          due: due ?? undefined,
          status: args.status,
        });
        ctx.log.debug('followup created', { id: item.id, alias: account, waiting_on: waitingOn?.length ?? 0, watch_threads: watch?.length ?? 0 });
        const quiet = ctx.digest && !ctx.digest.settings.get().enabled;
        const note = quiet ? 'The follow-up digest is off: nothing will remind the user of this item unless followups is called. Offer to turn it on (followup_digest enabled: true).' : undefined;
        return jsonResult({ ...trackedRow(ctx, item, today(ctx)), note });
      }

      const item = ctx.followups.get(args.id.trim());
      if (!item) throw new ToolInputError(`No follow-up "${args.id}" (closed items are deleted 30 days after closing). followups lists the open ones.`);
      const patch: FollowupPatch = { due, next_step: text(args.next_step), notes: text(args.notes), status: args.status };
      if (args.title !== undefined) {
        if (!args.title.trim()) throw new ToolInputError('title cannot be empty.');
        patch.title = args.title.trim();
      }
      if (args.account) patch.account = knownAccount(ctx, args.account, 'account');
      const home = patch.account ?? item.account;
      if (waitingOn) patch.waiting_on = waitingOn;
      if (args.expects_attachment !== undefined) patch.expects_attachment = args.expects_attachment;
      if (args.watch_threads) patch.watch_threads = args.watch_threads.length ? await watchedThreads(ctx, args.watch_threads, home) : null;
      // New people or threads to watch: what arrived before was for the old ones.
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
      const rewatched =
        (patch.waiting_on !== undefined && !same(patch.waiting_on, item.waiting_on)) ||
        (patch.watch_threads !== undefined && !same(patch.watch_threads, item.watch_threads)) ||
        (args.expects_attachment === true && !item.expects_attachment && !item.arrived?.has_attachments);
      if (item.arrived && (rewatched || args.keep_waiting)) {
        patch.arrived = null;
        if (args.keep_waiting) patch.since = Math.max(item.since ?? item.created_at, Date.parse(item.arrived.date) || Date.now());
      }
      const updated = ctx.followups.update(item.id, patch);
      if (!updated) throw new ToolInputError(`No follow-up "${args.id}".`);
      ctx.log.debug('followup updated', { id: updated.id, status: updated.status });
      return jsonResult(trackedRow(ctx, updated, today(ctx)));
    } catch (err) {
      if (err instanceof FollowupError) throw new ToolInputError(err.message);
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// followup_dismiss

/** A thread to hide from every list, or a draft (draft_id, or a draft's message id) to hide from drafts only. */
type DismissRef = { account: string; thread_id: string; draft_id?: undefined } | { account: string; draft_id: string; thread_id?: undefined };

function lookUp(ctx: ToolContext, ref: DismissRef): Promise<Found | undefined> {
  return ref.draft_id !== undefined ? findDraft(ctx, ref.account, ref.draft_id) : findThread(ctx, ref.account, ref.thread_id);
}

export const followupDismiss: ToolDefinition = defineTool({
  name: 'followup_dismiss',
  title: 'Dismiss threads from follow-ups',
  description:
    "Hides what needs no follow-up from followups' lists. A thread_id hides the thread from owed, drafts, waiting and batches (newsletters that slipped through, notes to self, finished matters, no answer needed), " +
    "until a new message arrives in it. A drafts row's draft_id hides only that draft (kept on purpose), until it is edited: its thread's owed, waiting and batch rows stay. " +
    'With `until`, they also come back on that date. undo: true shows them again. Changes nothing in Gmail.',
  inputSchema: {
    threads: z
      .array(
        z.object({
          account: z.string().min(1).describe('Alias of the mailbox holding it.'),
          thread_id: z.string().min(1).optional().describe('Gmail thread id, as followups gives it (a message id is accepted too): hides the whole thread.'),
          draft_id: z.string().min(1).optional().describe("A drafts row's draft_id: hides only that draft (used instead of thread_id when both are given)."),
        }),
      )
      .min(1)
      .max(50)
      .describe('Threads (thread_id) or drafts (draft_id) to hide, 1-50.'),
    until: z.string().optional().describe('Day they come back even without new mail, YYYY-MM-DD, after today. Default: only when a new message arrives.'),
    undo: z.boolean().optional().describe('Show them again (default false).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const until = args.until?.trim() ? dueDate(args.until, 'until') : undefined;
    if (until && until <= today(ctx)) throw new ToolInputError(`until: ${until} is not after today (${today(ctx)}); give a later day, or leave it out to hide the threads until new mail arrives.`);
    const refs = args.threads.map((t): DismissRef => {
      const account = knownAccount(ctx, t.account, 'threads.account');
      const draftId = t.draft_id?.trim();
      const threadId = t.thread_id?.trim();
      if (draftId) return { account, draft_id: draftId };
      if (threadId) return { account, thread_id: threadId };
      throw new ToolInputError('threads: give each entry a thread_id or a draft_id, as followups gives them.');
    });

    if (args.undo) {
      const results = await mapLimit(refs, FETCH_CONCURRENCY, async (ref) => {
        if (ref.thread_id !== undefined && ctx.followups.undismiss(ref.account, ref.thread_id)) return { ref, restored: true };
        // A message or draft id was dismissed under its thread's id: look the thread up.
        try {
          const found = await lookUp(ctx, ref);
          return { ref, restored: !!found && found.threadId !== ref.thread_id && ctx.followups.undismiss(ref.account, found.threadId) };
        } catch (err) {
          if (err instanceof GoogleApiError || err instanceof AccountError) return { ref, restored: false, error: err.message };
          throw err;
        }
      });
      const restored = results.filter((r) => r.restored).length;
      ctx.log.debug('followups undismissed', { threads: refs.length, restored });
      return jsonResult({
        restored,
        not_dismissed: results.filter((r) => !r.restored && !r.error).map((r) => r.ref),
        failed: results.flatMap((r) => (r.error ? [{ ...r.ref, error: r.error }] : [])),
      });
    }

    const results = await mapLimit(refs, FETCH_CONCURRENCY, async (ref) => {
      try {
        const found = await lookUp(ctx, ref);
        if (!found) return { ...ref, error: 'not found in this account' };
        // What Claude points at says what to hide. A draft kept on purpose says nothing of its thread: a batch reply it
        // answers still counts as one, and it stays hidden until edited, whatever arrives in the thread after.
        if (found.draftMs === undefined) {
          ctx.followups.dismiss(ref.account, found.threadId, found.latestMs, until);
          return { account: ref.account, thread_id: found.threadId, draftOnly: false };
        }
        // A thread hidden whole hides its draft already: hiding the draft alone would bring the thread's rows back.
        const whole = ctx.followups.dismissals(ref.account).get(found.threadId);
        if (whole && !whole.draftOnly && stillDismissed(whole, found.draftMs, today(ctx))) return { account: ref.account, thread_id: found.threadId, draftOnly: false };
        ctx.followups.dismiss(ref.account, found.threadId, found.draftMs, until, true);
        return { account: ref.account, thread_id: found.threadId, draftOnly: true };
      } catch (err) {
        // One account failing (re-link needed) does not undo the others.
        if (err instanceof GoogleApiError || err instanceof AccountError) return { ...ref, error: err.message };
        throw err;
      }
    });
    const failed = results.filter((r): r is typeof r & { error: string } => 'error' in r);
    const draftsOnly = results.filter((r) => 'draftOnly' in r && r.draftOnly).length;
    const threads = results.length - failed.length - draftsOnly;
    ctx.log.debug('followups dismissed', { threads: refs.length, failed: failed.length, drafts_only: draftsOnly });
    const by = until ? `until ${until} or ` : 'until ';
    const note = [
      threads ? `Hidden from followups ${by}a new message arrives in the thread.` : '',
      draftsOnly
        ? `${draftsOnly} ${draftsOnly === 1 ? 'draft is' : 'drafts are'} hidden from drafts only, ${by}${draftsOnly === 1 ? 'it is' : 'they are'} edited: their threads' owed, waiting and batch rows stay.`
        : '',
    ].filter(Boolean);
    return jsonResult({
      dismissed: results.length - failed.length,
      drafts_only: draftsOnly || undefined,
      until,
      failed,
      note: note.join(' ') || undefined,
    });
  },
});

/** The settings as Claude reads them: the owner's choices and how the last run went, no internal bookkeeping. */
function digestView(ctx: ToolContext, s: DigestSettings) {
  const inbox = digestInbox(ctx.accounts, s);
  const problem = inbox && inboxProblem(ctx.accounts, inbox);
  return {
    enabled: s.enabled,
    schedule: s.frequency === 'weekly' ? `every ${s.weekday} at ${s.time}` : `every day at ${s.time}`,
    frequency: s.frequency,
    weekday: s.frequency === 'weekly' ? s.weekday : undefined,
    time: s.time,
    timezone: s.timezone,
    lang: s.lang,
    accounts: s.accounts.length ? s.accounts : 'all linked Gmail accounts',
    deliver_to: inbox ?? 'none: no linked account has Gmail',
    last_run_date: s.last_run_date,
    last_status: s.last_status,
    note: problem ? `${problem}, so no digest can be delivered (none goes to another inbox; deliver_to changes it).` : undefined,
  };
}

/** Why an alias cannot be read or receive the digest (it must be linked, with Gmail), whatever its case; undefined when it can. */
function digestAliasProblem(ctx: ToolContext, alias: string): string | undefined {
  const account = ctx.accounts.get(alias.trim().toLowerCase());
  if (!account) return `No linked account "${alias}" (list_accounts shows the aliases).`;
  if (account.services.includes(SERVICE)) return undefined;
  const gmail = ctx.accounts.list().flatMap((a) => (a.services.includes(SERVICE) ? [a.alias] : []));
  return `"${alias}" is not linked with Gmail: the digest reads mail and is delivered through Gmail. Aliases with Gmail: ${gmail.join(', ') || 'none'}.`;
}

export const followupDigest: ToolDefinition = defineTool({
  name: 'followup_digest',
  title: 'Follow-up digest',
  description:
    'Shows or changes the follow-up digest: every day (frequency "daily") or once a week on `weekday` ("weekly"), at `time`, the connector puts an email into one inbox listing what followups would show ' +
    '(ready and due tracked items, what is still awaited, people waiting for a reply, unsent drafts, batches, unanswered mail), each with a Gmail link. ' +
    'It is put into the inbox (not sent to anyone) and works without Claude, so nothing is forgotten when no chat is open. With no arguments it returns the current settings. ' +
    'enabled turns it on or off; send_now: true delivers one right away (whatever the time) so the user can see it. The admin page offers the same settings.',
  inputSchema: {
    enabled: z.boolean().optional().describe('Turn the digest on (true) or off (false).'),
    frequency: z.enum(DIGEST_FREQUENCIES).optional().describe('daily, or weekly (on weekday).'),
    weekday: z.enum(WEEKDAYS).optional().describe('With frequency weekly: the day, e.g. "monday".'),
    time: z.string().optional().describe('Local time of day, HH:MM (24 h), e.g. "08:00".'),
    timezone: z.string().optional().describe('IANA time zone for the time, e.g. "Europe/Paris" (default: the server default).'),
    lang: z.enum(DIGEST_LANGS).optional().describe('Language of the digest: en or fr.'),
    accounts: z.array(z.string().min(1)).optional().describe('Aliases whose mail it covers; [] for every linked Gmail account.'),
    deliver_to: z.string().min(1).optional().describe('Alias whose inbox receives it (default: the first linked account with Gmail, kept once turned on).'),
    send_now: z.boolean().optional().describe('Deliver a digest right away, after saving any change.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (args, ctx) => {
    if (!ctx.digest) return errorResult('This server runs no follow-up digest.');
    for (const alias of [...(args.accounts ?? []), ...(args.deliver_to ? [args.deliver_to] : [])]) {
      const problem = digestAliasProblem(ctx, alias);
      if (problem) return errorResult(problem);
    }
    let deliverTo = args.deliver_to?.trim().toLowerCase();
    // Turned on without an inbox: the default one is kept, so the digest stays there whatever happens to the accounts.
    if (args.enabled && !deliverTo && !ctx.digest.settings.get().deliver_to) {
      deliverTo = digestInbox(ctx.accounts, {});
      if (!deliverTo) return errorResult('No linked account has Gmail: the digest is read from and delivered to Gmail. Link one on the admin page first.');
    }
    const changes = { enabled: args.enabled, frequency: args.frequency, weekday: args.weekday, time: args.time, timezone: args.timezone, lang: args.lang, accounts: args.accounts, deliver_to: deliverTo };
    let settings: DigestSettings;
    try {
      settings = Object.values(changes).some((v) => v !== undefined) ? ctx.digest.settings.update(changes) : ctx.digest.settings.get();
    } catch (err) {
      if (err instanceof DigestSettingsError) return errorResult(err.message);
      throw err;
    }
    if (!args.send_now) return jsonResult(digestView(ctx, settings));
    const outcome = await ctx.digest.runNow();
    const sent =
      outcome.status === 'delivered'
        ? `Delivered to ${outcome.alias}'s inbox with ${outcome.items} item(s).`
        : outcome.status === 'busy'
          ? 'A digest is being prepared right now; try again in a minute.'
          : outcome.status === 'failed'
            ? `Could not deliver it: ${(outcome.detail ?? outcome.error).replace(/\.$/, '')}.`
            : 'Nothing to report.';
    return jsonResult({ ...digestView(ctx, ctx.digest.settings.get()), send_now: sent });
  },
});

export const followupTools: ToolDefinition[] = [followups, followupTrack, followupDismiss, followupDigest];
