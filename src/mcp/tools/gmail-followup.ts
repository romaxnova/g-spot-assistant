/**
 * gmail_awaiting_reply: mail the account sent that nobody has answered yet
 * (quote requests, questions, reminders to chase up). Gmail search cannot say
 * "the thread's last message is mine", so the threads with sent mail in the
 * period are listed and each is read (headers only) to see whose message came
 * last. The listing is of threads, not messages, so paging never returns a
 * thread twice. Send-as aliases and +tag variants count as the account; drafts,
 * spam and trash are not part of the conversation; auto-replies and bounces are
 * no answer. Nothing here logs message content.
 *
 * The thread helpers are shared with the follow-up engine (src/followups).
 */
import * as z from 'zod';
import { GoogleApiError } from '../../google/client.js';
import { accountParam, defineTool, jsonResult, pageTokenParam, ToolInputError, type ToolContext, type ToolDefinition } from '../registry.js';
import { oneLine } from '../text.js';
import { gmailIdentity, gmailWebUrl, mailbox } from './gmail-identity.js';

export { mailbox };
import { headerValue, parseAddresses, type Address } from './gmail-mime.js';
import { encodeId, FETCH_CONCURRENCY, mapLimit, SERVICE, type GmailMessage } from './gmail.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const THREAD_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Content-Type', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence'];
/** Messages that are not part of the conversation: unsent drafts, spam, trashed mail. */
export const IGNORED_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH']);
/** Subject prefixes of out-of-office replies sent without RFC 3834 headers (Outlook, English and French). */
const AUTO_SUBJECT = /^\s*(?:automatic reply|auto-?reply|out of office|réponse automatique)\s*:/i;

export interface ThreadList {
  threads?: { id: string }[];
  nextPageToken?: string;
}

export interface GmailThread {
  id?: string;
  messages?: GmailMessage[];
}

/** A thread with its headers; undefined when it disappeared between the list and the read. */
export async function readThread(ctx: ToolContext, account: string, id: string, headers: string[] = THREAD_HEADERS): Promise<GmailThread | undefined> {
  try {
    return await ctx.google.request<GmailThread>(account, SERVICE, { url: `/threads/${encodeId(id)}`, query: { format: 'metadata', metadataHeaders: headers } });
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** The sender's mailbox (see mailbox()); undefined when the From header has no address. */
export function senderOf(m: GmailMessage): string | undefined {
  const from = parseAddresses(headerValue(m.payload?.headers, 'From'))[0]?.email;
  return from ? mailbox(from) : undefined;
}

/** 'bounce' for a delivery failure, 'auto' for an auto-reply or receipt, undefined for a message a person wrote. */
export type MessageKind = 'bounce' | 'auto' | undefined;

export function automatic(m: GmailMessage): MessageKind {
  const h = m.payload?.headers;
  const local = senderOf(m)?.split('@')[0];
  if (local === 'mailer-daemon' || local === 'postmaster' || /report-type\s*=\s*"?delivery-status/i.test(headerValue(h, 'Content-Type') ?? '')) return 'bounce';
  const submitted = headerValue(h, 'Auto-Submitted')?.trim().toLowerCase();
  if (
    (submitted && submitted !== 'no') ||
    headerValue(h, 'X-Autoreply') !== undefined ||
    headerValue(h, 'X-Autorespond') !== undefined ||
    /^auto[_-]reply$/i.test(headerValue(h, 'Precedence')?.trim() ?? '') ||
    m.payload?.mimeType?.toLowerCase() === 'multipart/report' ||
    AUTO_SUBJECT.test(headerValue(h, 'Subject') ?? '')
  )
    return 'auto';
  return undefined;
}

/** A thread's conversation: its messages without drafts, spam and trash, oldest first, with the kind of each. */
export interface Conversation {
  messages: GmailMessage[];
  kinds: MessageKind[];
}

export function conversation(thread: GmailThread): Conversation {
  const messages = (thread.messages ?? [])
    .filter((m) => !(m.labelIds ?? []).some((l) => IGNORED_LABELS.has(l)))
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  return { messages, kinds: messages.map(automatic) };
}

/** Most addresses shown per list: a mass mailing in Bcc would otherwise fill the result. */
const MAX_LISTED_ADDRESSES = 5;

/** Addresses as one short line: the first few and how many more. */
export function addressLine(all: Address[]): string | undefined {
  if (!all.length) return undefined;
  const shown = all.slice(0, MAX_LISTED_ADDRESSES).map((a) => (a.name ? `${oneLine(a.name)} <${a.email}>` : a.email));
  return all.length > MAX_LISTED_ADDRESSES ? `${shown.join(', ')} +${all.length - MAX_LISTED_ADDRESSES} more` : shown.join(', ');
}

/** An address header as one short line: the first few addresses and how many more. */
function addressList(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const all = parseAddresses(header);
  return all.length <= MAX_LISTED_ADDRESSES ? oneLine(header) : addressLine(all);
}

/** The row for a thread whose last message a person wrote is the account's own, to someone else, sent at least minDays ago; else undefined. */
export function awaitingRow(threadId: string, thread: GmailThread, own: Set<string>, email: string, minDays: number, now: number) {
  const { messages: kept, kinds } = conversation(thread);
  const lastIndex = kinds.findLastIndex((k) => k === undefined);
  const last = kept[lastIndex];
  const sentMs = Number(last?.internalDate);
  if (!last || !Number.isFinite(sentMs) || !own.has(senderOf(last) ?? '')) return undefined;
  const h = last.payload?.headers;
  const to = headerValue(h, 'To');
  const cc = headerValue(h, 'Cc');
  const bcc = headerValue(h, 'Bcc');
  // A note to self (or to an alias) waits for no one; group syntax such as "undisclosed-recipients:;" is no recipient.
  const toOthers = [to, cc, bcc].flatMap(parseAddresses).some((a) => a.email.includes('@') && !own.has(mailbox(a.email)));
  if (!toOthers || now - sentMs < minDays * DAY_MS) return undefined;
  const after = kinds.slice(lastIndex + 1);
  const subject = headerValue(h, 'Subject');
  return {
    thread_id: threadId,
    message_id: last.id,
    to: addressList(to),
    cc: addressList(cc),
    bcc: addressList(bcc),
    subject: subject ? oneLine(subject) : undefined,
    sent_at: new Date(sentMs).toISOString(),
    days_waiting: Math.floor((now - sentMs) / DAY_MS),
    messages: kept.length,
    replies_received: kept.filter((m, i) => kinds[i] === undefined && !own.has(senderOf(m) ?? '')).length || undefined,
    bounced: after.includes('bounce') || undefined,
    auto_reply: after.includes('auto') || undefined,
    web_url: gmailWebUrl(email, 'thread', threadId),
  };
}

/** The search window. A default gives way to the other bound's explicit value, so the window is never empty. */
function searchWindow(days: number | undefined, minDays: number | undefined): { days: number; minDays: number } {
  if (days !== undefined && minDays !== undefined && minDays >= days) {
    throw new ToolInputError(`min_days (${minDays}) must be less than days (${days}): no mail is both newer than ${days} and older than ${minDays} days. Raise days (e.g. to ${Math.min(180, minDays + 30)}) or lower min_days.`);
  }
  if (days !== undefined) return { days, minDays: minDays ?? Math.min(2, days - 1) };
  return minDays === undefined ? { days: 30, minDays: 2 } : { days: Math.max(30, minDays + 30), minDays };
}

export const gmailAwaitingReply: ToolDefinition = defineTool({
  name: 'gmail_awaiting_reply',
  title: 'Sent mail awaiting a reply',
  description:
    'Lists emails the account sent that nobody has answered yet: threads whose latest message is the account\'s own (e.g. quote requests or questions to follow up), newest first. ' +
    'Covers threads with mail sent between `days` and min_days days ago (days must exceed min_days); send-as aliases and +tag addresses count as the account, drafts are ignored, notes to self skipped, Bcc recipients count, and auto-replies, read receipts and bounces are no answer. ' +
    'query narrows with Gmail search terms ("subject:devis", "to:@example.com"). Rows: thread_id, message_id (the last message, for gmail_reply), to, cc, bcc, subject, sent_at, days_waiting, messages, replies_received, bounced (a delivery failure came back: check the address), auto_reply (only an automatic reply came back) and web_url. ' +
    'Each call examines max_results threads, each once; use next_page_token to look further back. Read-only.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    days: z.number().int().min(1).max(180).optional().describe('How far back the sent mail may go, in days (1-180; default 30, or min_days + 30 when min_days is set). Must exceed min_days.'),
    min_days: z.number().int().min(0).max(60).optional().describe('Only threads whose latest message is at least this many days old (0-60; default 2, or days - 1 when days is smaller).'),
    query: z.string().optional().describe('Extra Gmail search terms to narrow the sent mail, e.g. "subject:devis" or "to:@example.com".'),
    max_results: z.number().int().min(1).max(50).optional().describe('Threads examined per call, 1-50 (default 25).'),
    page_token: pageTokenParam,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const { days, minDays } = searchWindow(args.days, args.min_days);
    const identity = await gmailIdentity(ctx, args.account);
    const own = new Set(identity.addresses.map(mailbox));
    const q = [`in:sent newer_than:${days}d`, minDays > 0 ? `older_than:${minDays}d` : '', args.query?.trim() ?? ''].filter(Boolean).join(' ');
    // threads.list, not messages.list: a thread with several sent messages would otherwise come back on several pages.
    const list = await ctx.google.request<ThreadList>(args.account, SERVICE, { url: '/threads', query: { q, maxResults: args.max_results ?? 25, pageToken: args.page_token } });
    const threads = await mapLimit(list.threads ?? [], FETCH_CONCURRENCY, async ({ id }) => ({ id, thread: await readThread(ctx, args.account, id) }));
    const now = Date.now();
    const rows = threads
      .flatMap(({ id, thread }) => (thread ? [awaitingRow(id, thread, own, identity.email, minDays, now)] : []))
      .filter((r) => r !== undefined)
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    const examined = threads.filter((t) => t.thread).length;
    ctx.log.debug('gmail awaiting reply', { alias: args.account, examined, awaiting: rows.length });
    // The page token and count come first: if a very long result is cut, it is cut from the end.
    return jsonResult({
      examined,
      next_page_token: list.nextPageToken,
      threads: rows,
      note: rows.length
        ? undefined
        : `None of the sent mail examined is waiting for a reply.${list.nextPageToken ? ' Call again with page_token to look further back.' : ''}`,
    });
  },
});
