/**
 * Test helper: several fake Gmail mailboxes behind one fake Google, enough of
 * Gmail's API for the follow-up engine and tools (threads.list with the
 * in:sent / in:inbox / newer_than / older_than / before: / -category: terms
 * they use and page tokens, threads.get, drafts.list (newer_than) and drafts.get, messages.list
 * with from:(a OR b) or from:a, after:N, in:sent {to:a cc:a bcc:a}, messages.get in the metadata, minimal
 * and full formats). Used by unit tests only.
 */
import type { FakeResponse, RecordedCall } from '../test-support.js';
import type { GmailPart } from '../mcp/tools/gmail-mime.js';
import { parseAddresses } from '../mcp/tools/gmail-mime.js';

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
const BASE = '/gmail/v1/users/me';

export interface FakeMessage {
  id: string;
  threadId: string;
  /** Epoch ms. */
  at: number;
  from: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  snippet?: string;
  /** Default: SENT when the sender is the mailbox's own address, else INBOX. */
  labels?: string[];
  headers?: Record<string, string>;
  mimeType?: string;
  /** Parts, returned in the full format only (like Gmail, whose metadata format has none). */
  parts?: GmailPart[];
}

export interface FakeMailbox {
  email: string;
  sendAs?: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; verificationStatus?: string }[];
  messages: FakeMessage[];
  drafts?: { id: string; messageId: string }[];
  /** Answer every API call of this mailbox with this (an outage). */
  failWith?: FakeResponse;
}

const CATEGORIES: Record<string, string> = { promotions: 'CATEGORY_PROMOTIONS', social: 'CATEGORY_SOCIAL', updates: 'CATEGORY_UPDATES', forums: 'CATEGORY_FORUMS' };

function labelsOf(box: FakeMailbox, m: FakeMessage): string[] {
  if (m.labels) return m.labels;
  const from = parseAddresses(m.from)[0]?.email.toLowerCase();
  const own = [box.email, ...(box.sendAs ?? []).map((s) => s.sendAsEmail)].map((a) => a.toLowerCase());
  return own.includes(from ?? '') ? ['SENT'] : ['INBOX'];
}

function headersOf(m: FakeMessage): { name: string; value: string }[] {
  const h = [{ name: 'From', value: m.from }];
  if (m.to !== undefined) h.push({ name: 'To', value: m.to });
  if (m.cc) h.push({ name: 'Cc', value: m.cc });
  if (m.bcc) h.push({ name: 'Bcc', value: m.bcc });
  if (m.subject !== undefined) h.push({ name: 'Subject', value: m.subject });
  for (const [name, value] of Object.entries(m.headers ?? {})) h.push({ name, value });
  return h;
}

/** A message as Gmail returns it in a format; metadataHeaders filter the headers like Gmail does. */
export function gmailJson(box: FakeMailbox, m: FakeMessage, format = 'full', metadataHeaders: string[] = []) {
  const base = { id: m.id, threadId: m.threadId, labelIds: labelsOf(box, m), snippet: m.snippet ?? '', internalDate: String(m.at) };
  if (format === 'minimal') return base;
  const wanted = new Set(metadataHeaders.map((h) => h.toLowerCase()));
  const headers = format === 'metadata' && wanted.size ? headersOf(m).filter((h) => wanted.has(h.name.toLowerCase())) : headersOf(m);
  return { ...base, payload: { mimeType: m.mimeType ?? 'text/plain', headers, parts: format === 'full' ? m.parts : undefined } };
}

/** Every thread of the mailbox, newest activity first. */
function threads(box: FakeMailbox): { id: string; messages: FakeMessage[]; latest: number }[] {
  const byId = new Map<string, FakeMessage[]>();
  for (const m of box.messages) byId.set(m.threadId, [...(byId.get(m.threadId) ?? []), m]);
  return [...byId].map(([id, messages]) => ({ id, messages, latest: Math.max(...messages.map((m) => m.at)) })).sort((a, b) => b.latest - a.latest);
}

/** One page of a listing, as `key`, with a nextPageToken when more follow. */
function page<T>(all: T[], call: RecordedCall, max: number, key: string): Record<string, unknown> {
  const start = Number(call.url.searchParams.get('pageToken') ?? 0);
  const end = start + max;
  return { [key]: all.slice(start, end), nextPageToken: end < all.length ? String(end) : undefined };
}

/** Handles one call of the mailbox; `now` is what newer_than and older_than count from. */
export function serveMailbox(box: FakeMailbox, call: RecordedCall, now: number): FakeResponse | undefined {
  if (box.failWith) return box.failWith;
  const path = call.url.pathname.replace(BASE, '');
  const q = call.url.searchParams.get('q') ?? '';
  const max = Number(call.url.searchParams.get('maxResults') ?? 100);
  const format = call.url.searchParams.get('format') ?? 'full';
  const headers = call.url.searchParams.getAll('metadataHeaders');
  if (path === '/settings/sendAs') return box.sendAs ? { json: { sendAs: box.sendAs } } : undefined;

  if (path === '/threads') {
    const newer = /newer_than:(\d+)d/.exec(q);
    const older = /older_than:(\d+)d/.exec(q);
    const before = /before:(\d+)/.exec(q);
    const since = newer ? now - Number(newer[1]) * DAY : 0;
    const until = Math.min(older ? now - Number(older[1]) * DAY : Infinity, before ? Number(before[1]) * 1000 : Infinity);
    const excluded = [...q.matchAll(/-category:(\w+)/g)].map((x) => CATEGORIES[x[1]!]!);
    const wanted = /in:sent/.test(q) ? 'SENT' : /in:inbox/.test(q) ? 'INBOX' : undefined;
    // Like Gmail, a thread matches when one of its messages matches every term.
    const ids = threads(box)
      .filter((t) => t.messages.some((m) => (!wanted || labelsOf(box, m).includes(wanted)) && m.at > since && m.at < until))
      .filter((t) => !t.messages.some((m) => labelsOf(box, m).some((l) => excluded.includes(l))))
      .map((t) => ({ id: t.id }));
    return { json: page(ids, call, max, 'threads') };
  }
  const threadId = /^\/threads\/([^/]+)$/.exec(path)?.[1];
  if (threadId) {
    const t = threads(box).find((x) => x.id === decodeURIComponent(threadId));
    return t ? { json: { id: t.id, messages: [...t.messages].sort((a, b) => a.at - b.at).map((m) => gmailJson(box, m, format, headers)) } } : undefined;
  }
  if (path === '/drafts') {
    const newer = /newer_than:(\d+)d/.exec(q);
    const since = newer ? now - Number(newer[1]) * DAY : 0;
    const drafts = (box.drafts ?? [])
      .filter((d) => (box.messages.find((m) => m.id === d.messageId)?.at ?? now) > since)
      .map((d) => ({ id: d.id, message: { id: d.messageId, threadId: box.messages.find((m) => m.id === d.messageId)?.threadId } }));
    return { json: page(drafts, call, max, 'drafts') };
  }
  const draftId = /^\/drafts\/([^/]+)$/.exec(path)?.[1];
  if (draftId) {
    const d = (box.drafts ?? []).find((x) => x.id === decodeURIComponent(draftId));
    const m = d && box.messages.find((x) => x.id === d.messageId);
    return d && m ? { json: { id: d.id, message: gmailJson(box, m, format, headers) } } : undefined;
  }
  if (path === '/messages') {
    const fromTerm = /from:\(([^)]*)\)/.exec(q)?.[1] ?? /from:([^\s()]+)/.exec(q)?.[1];
    const from = fromTerm?.split(' OR ').map((a) => a.trim().toLowerCase());
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
    const sent = /in:sent/.test(q);
    const to = /\{to:(\S+) cc:\S+ bcc:\S+\}/.exec(q)?.[1];
    const found = box.messages
      .filter((m) => !labelsOf(box, m).some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT'))
      .filter((m) => !sent || labelsOf(box, m).includes('SENT'))
      .filter((m) => !to || [m.to, m.cc, m.bcc].flatMap((h) => parseAddresses(h ?? '')).some((a) => a.email.toLowerCase() === to))
      .filter((m) => !from || from.includes(parseAddresses(m.from)[0]?.email.toLowerCase() ?? ''))
      .filter((m) => m.at > after)
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map((m) => ({ id: m.id, threadId: m.threadId }));
    return { json: { messages: found } };
  }
  const messageId = /^\/messages\/([^/]+)$/.exec(path)?.[1];
  if (messageId) {
    const m = box.messages.find((x) => x.id === decodeURIComponent(messageId));
    return m ? { json: gmailJson(box, m, format, headers) } : undefined;
  }
  return undefined;
}

/** A fake Google serving mailboxes by alias. */
export function mailboxes(boxes: Record<string, FakeMailbox>, now: () => number) {
  return (alias: string, call: RecordedCall): FakeResponse | undefined => {
    const box = boxes[alias];
    return box ? serveMailbox(box, call, now()) : undefined;
  };
}

/** A message from `from` to `to`, `ago` ms before `now`. */
export function message(now: number, id: string, threadId: string, ago: number, from: string, to: string, extra: Partial<FakeMessage> = {}): FakeMessage {
  return { id, threadId, at: now - ago, from, to, subject: 'Devis', ...extra };
}
