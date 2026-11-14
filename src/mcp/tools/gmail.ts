/**
 * Gmail tools: search, read, send, reply, forward, drafts, labels, trash.
 *
 * Every Google call goes through ctx.google.request(alias, 'gmail', ...), whose
 * relative URLs resolve against https://gmail.googleapis.com/gmail/v1/users/me.
 * Outputs are flattened, snake_cased and clipped so they stay small in
 * claude.ai's context. Nothing here logs message content.
 */
import { randomBytes } from 'node:crypto';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  accountParam,
  clip,
  defineTool,
  errorResult,
  jsonResult,
  maxCharsParam,
  offsetParam,
  pageTokenParam,
  ToolInputError,
  withImage,
  type Clipped,
  type ToolContext,
  type ToolDefinition,
} from '../registry.js';
import {
  buildMimeMessage,
  charsetOfContentType,
  decodeBase64Url,
  decodeEntities,
  encodeBase64Url,
  extractBody,
  formatAddress,
  headerValue,
  htmlToText,
  parseAddresses,
  replyRecipients,
  stripQuotedHtml,
  stripQuotedText,
  type ExtractedAttachment,
  type ExtractedBody,
  type GmailPart,
  type MimeAttachment,
} from './gmail-mime.js';
import { cleanText, normalizeNewlines, oneLine, stripTrackingParams } from '../text.js';
import { readFileContent } from '../extract/readable.js';
import { convertibleKind } from './drive-files.js';
import { ocrText, ocrType } from './drive.js';
import { baseMime, mimeFromFilename, sniffMime } from '../file-types.js';
import { attachmentsParam, expandUploadLinks, mb, resolveFile, transferTimeoutMs, type FileSpec } from './file-sources.js';
import { allowPlaceholdersParam, findPlaceholders, placeholderRefusal, placeholderWarning, quoteList } from './placeholders.js';
import { GoogleApiError } from '../../google/client.js';
import { fromHeader, gmailIdentity, gmailWebUrl, readableFrom, withSignature } from './gmail-identity.js';
import { reviewedByUserParam, reviewFor, reviewToken, reviewTokensParam, sensitiveRecipients, type CadenceCache, type SensitiveContact } from './sensitive.js';

export const SERVICE = 'gmail' as const;
/** Parallel per-message fetches after a list call. */
export const FETCH_CONCURRENCY = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_FORWARD_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Gmail's limit for the files attached to one message. */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/**
 * messages.send and drafts accept the message as a JSON {raw} field only up to a
 * few MB (Google documents the JSON request body limit loosely, around 5 MB);
 * bigger messages go through the upload endpoints, which take up to 35 MB.
 */
const MAX_JSON_SEND_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 35 * 1024 * 1024;
const UPLOAD_BASE = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
/** Drafts are listed 100 at a time; 5 pages bound the work when matching draft ids to messages. */
const MAX_DRAFT_PAGES = 5;
const SUMMARY_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];
const REPLY_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Message-ID', 'References', 'In-Reply-To'];
/** Labels Gmail predefines; their ids equal their upper-case names and they never appear as user labels. */
const SYSTEM_LABELS = new Set([
  'INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SPAM', 'TRASH', 'SENT', 'DRAFT', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

// ---------------------------------------------------------------------------
// Google response shapes (the subset we read)
// ---------------------------------------------------------------------------

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  payload?: GmailPart;
}

interface MessageList {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface DraftList {
  drafts?: { id: string; message?: { id: string } }[];
  nextPageToken?: string;
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

interface AttachmentBody {
  size?: number;
  data?: string;
}

interface SentMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

export interface Draft {
  id: string;
  message?: { id: string; threadId?: string };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A problem with the arguments that Claude can fix; surfaced as an error result instead of a crash. */
export class InputError extends Error {}

type Handler<A> = (args: A, ctx: ToolContext) => Promise<CallToolResult>;

export function guarded<A>(fn: Handler<A>): Handler<A> {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx);
    } catch (err) {
      if (err instanceof InputError) return errorResult(err.message);
      throw err;
    }
  };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

function isoDate(internalDate: string | undefined): string | undefined {
  const ms = Number(internalDate);
  return internalDate && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function encodeId(id: string): string {
  return encodeURIComponent(id);
}

export function getMessage(ctx: ToolContext, account: string, id: string, format: 'full' | 'metadata', metadataHeaders?: string[]): Promise<GmailMessage> {
  return ctx.google.request<GmailMessage>(account, SERVICE, { url: `/messages/${encodeId(id)}`, query: { format, metadataHeaders } });
}

function fetchAttachment(ctx: ToolContext, account: string, messageId: string, attachmentId: string): Promise<AttachmentBody> {
  return ctx.google.request<AttachmentBody>(account, SERVICE, { url: `/messages/${encodeId(messageId)}/attachments/${encodeId(attachmentId)}` });
}

/** Where a built message goes: messages.send, drafts.create or drafts.update. */
export interface RawMessageTarget {
  method: 'POST' | 'PUT';
  /** Path under both the API base (JSON form) and the upload base. */
  path: string;
  /** The resource around the message, e.g. {threadId} or {message: {threadId}}; undefined when it has nothing but the message. */
  metadata?: Record<string, unknown>;
  /** The JSON request body carrying the base64url message. */
  withRaw(raw: string): Record<string, unknown>;
}

function sendTarget(threadId?: string): RawMessageTarget {
  return { method: 'POST', path: '/messages/send', metadata: threadId ? { threadId } : undefined, withRaw: (raw) => ({ raw, threadId }) };
}

export function draftTarget(draftId: string | undefined, threadId?: string): RawMessageTarget {
  return {
    method: draftId ? 'PUT' : 'POST',
    path: draftId ? `/drafts/${encodeId(draftId)}` : '/drafts',
    metadata: threadId ? { message: { threadId } } : undefined,
    withRaw: (raw) => ({ message: { raw, threadId } }),
  };
}

/**
 * Sends or saves a built RFC 5322 message. Small messages go as JSON {raw};
 * large ones (attachments) through the upload endpoint as message/rfc822,
 * wrapped in multipart/related with a JSON metadata part when a threadId must
 * travel along. Sends are never retried: a repeat after a timeout could deliver twice.
 */
export function uploadRawMessage<T>(ctx: ToolContext, account: string, target: RawMessageTarget, mime: string | Buffer): Promise<T> {
  // Built messages are pure ASCII (RFC 2047 headers, base64 bodies); an edited draft is passed as its own bytes.
  const bytes = Buffer.isBuffer(mime) ? mime : Buffer.from(mime, 'utf8');
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new InputError(
      `The message is ${mb(bytes.length)} MB once encoded, above Gmail's 35 MB limit. Attach fewer or smaller files, or share large ones as Drive links (drive_share).`,
    );
  }
  // Uploads are slow on a bad link; allow 10 s per MB on top of a minute.
  const timeoutMs = transferTimeoutMs(bytes.length);
  if (bytes.length <= MAX_JSON_SEND_BYTES) {
    return ctx.google.request<T>(account, SERVICE, { method: target.method, url: target.path, body: target.withRaw(encodeBase64Url(bytes)), timeoutMs });
  }
  const url = UPLOAD_BASE + target.path;
  if (!target.metadata) {
    return ctx.google.request<T>(account, SERVICE, { method: target.method, url, query: { uploadType: 'media' }, body: bytes, contentType: 'message/rfc822', timeoutMs });
  }
  const boundary = randomBytes(16).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(target.metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return ctx.google.request<T>(account, SERVICE, {
    method: target.method,
    url,
    query: { uploadType: 'multipart' },
    body,
    contentType: `multipart/related; boundary=${boundary}`,
    timeoutMs,
  });
}

function sendRaw(ctx: ToolContext, account: string, mime: string, threadId?: string): Promise<SentMessage> {
  return uploadRawMessage<SentMessage>(ctx, account, sendTarget(threadId), mime);
}

/**
 * Loads the files to attach, one at a time so a too-large set stops early.
 * Errors name the attachment so Claude can fix that one entry.
 */
export async function outgoingAttachments(ctx: ToolContext, account: string, given: FileSpec[] | undefined): Promise<MimeAttachment[]> {
  const files: MimeAttachment[] = [];
  let total = 0;
  let specs: FileSpec[] | undefined;
  try {
    specs = expandUploadLinks(ctx, given);
  } catch (err) {
    if (err instanceof ToolInputError) throw new InputError(`attachments: ${err.message}`);
    throw err;
  }
  if ((specs?.length ?? 0) > 20) throw new InputError(`That is ${specs!.length} files; at most 20 can be attached to one email.`);
  for (const [i, spec] of (specs ?? []).entries()) {
    let file: MimeAttachment;
    try {
      const blob = await resolveFile(ctx, account, spec, { maxBytes: MAX_OUTGOING_ATTACHMENT_BYTES, nativeDefault: 'pdf' });
      file = { filename: blob.filename, mimeType: blob.mimeType, content: blob.data };
    } catch (err) {
      if (err instanceof ToolInputError) throw new InputError(`attachments[${i}]: ${err.message}`);
      throw err;
    }
    total += file.content.length;
    if (total > MAX_OUTGOING_ATTACHMENT_BYTES) {
      throw new InputError(`The attachments add up to more than Gmail's 25 MB limit (${mb(total)} MB after ${i + 1} of ${specs!.length}). Share large files as Drive links instead (drive_share).`);
    }
    files.push(file);
  }
  return files;
}

export function attachedSummary(files: MimeAttachment[]) {
  return files.length ? files.map((f) => ({ filename: f.filename, mime_type: f.mimeType.split(';')[0], size: f.content.length })) : undefined;
}

/** The account's own address, used as From and to drop itself from reply-all. */
export function accountEmail(ctx: ToolContext, account: string): string {
  return ctx.google.resolve(account, SERVICE).email;
}

/** Normalises recipient strings ("Ann <a@x>", "a@x") into header-safe mailboxes. */
export function recipients(values: string[] | undefined, field: string): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const parsed = parseAddresses(value);
    if (!parsed.length) throw new InputError(`${field}: "${value}" is not an email address.`);
    for (const a of parsed) {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a.email)) throw new InputError(`${field}: "${a.email}" is not a valid email address.`);
      out.push(formatAddress(a.name, a.email));
    }
  }
  return out;
}

function singleRecipient(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : recipients([value], field)[0];
}

/**
 * Plain-text body of a message: text/plain when it has readable content, else
 * the HTML converted. Invisible preheader padding is removed either way (some
 * senders ship a text part made only of it, so the check runs after cleaning).
 */
export function bodyText(body: ExtractedBody, stripQuotes: boolean): { text: string; source?: 'text' | 'html' } {
  const plain = normalizeNewlines(body.text);
  const text = cleanText(stripQuotes ? stripQuotedText(plain) : plain);
  if (text) return { text, source: 'text' };
  if (body.html.trim()) return { text: cleanText(htmlToText(stripQuotes ? stripQuotedHtml(body.html) : body.html)), source: 'html' };
  return { text: '' };
}

/** Body as shown to Claude: bodyText plus analytics parameters removed from links. */
function readableBody(body: ExtractedBody, stripQuotes: boolean): { text: string; source?: 'text' | 'html' } {
  const b = bodyText(body, stripQuotes);
  return { ...b, text: stripTrackingParams(b.text) };
}

/** Attachments the user would recognise as attached files; images embedded in the body are only counted. */
function splitAttachments(all: ExtractedAttachment[], includeEmbedded: boolean) {
  const embedded = all.filter((a) => a.embedded).length;
  const listed = includeEmbedded ? all : all.filter((a) => !a.embedded);
  return { listed, hiddenEmbedded: includeEmbedded ? 0 : embedded };
}

function clipFields(c: Clipped) {
  return { truncated: c.truncated, total_chars: c.totalChars, next_offset: c.nextOffset };
}

function attachmentSummary(a: ExtractedAttachment) {
  return { part_id: a.partId, attachment_id: a.attachmentId, filename: a.filename, mime_type: a.mimeType, size: a.size, charset: a.charset, inline: a.inline || a.embedded || undefined };
}

function replySubject(subject: string | undefined): string {
  const s = subject ?? '';
  return /^\s*re:/i.test(s) ? s.trim() : `Re: ${s}`;
}

function forwardSubject(subject: string | undefined): string {
  const s = subject ?? '';
  return /^\s*fwd?:/i.test(s) ? s.trim() : `Fwd: ${s}`;
}

/** Subject without reply/forward prefixes, for grouping messages of one thread. */
function bareSubject(subject: string | undefined): string {
  return (subject ?? '').replace(/^(\s*(re|fwd?|aw|wg)\s*:\s*)+/i, '').trim().toLowerCase();
}

/** Threading headers and default recipients for a reply to `original` (fetched with REPLY_HEADERS). */
function replyContext(original: GmailMessage, self: string, replyAll: boolean, aliases: string[] = []) {
  const h = original.payload?.headers;
  const messageId = headerValue(h, 'Message-ID');
  // RFC 5322 3.6.4: References = the original's References, or failing that its
  // In-Reply-To when that names a single message, followed by its Message-ID.
  const inReplyTo = headerValue(h, 'In-Reply-To')?.trim();
  const parents = headerValue(h, 'References')?.trim() || (inReplyTo && inReplyTo.split(/\s+/).length === 1 ? inReplyTo : undefined);
  const references = [parents, messageId].filter(Boolean).join(' ');
  const who = replyRecipients(
    { from: headerValue(h, 'From'), replyTo: headerValue(h, 'Reply-To'), to: headerValue(h, 'To'), cc: headerValue(h, 'Cc') },
    self,
    replyAll,
    aliases,
  );
  return {
    threadId: original.threadId,
    subject: replySubject(headerValue(h, 'Subject')),
    inReplyTo: messageId,
    references: references || undefined,
    to: who.to.map((a) => formatAddress(a.name, a.email)),
    cc: who.cc.map((a) => formatAddress(a.name, a.email)),
  };
}

const messageIdsParam = z.array(z.string().min(1)).min(1).max(1000).optional().describe('Message ids (from gmail_search / gmail_get_thread).');
const threadIdsParam = z.array(z.string().min(1)).min(1).max(100).optional().describe('Thread ids (from gmail_search / gmail_get_message).');
const ADDRESS_HINT = 'as email addresses, optionally with a display name ("Ann Lee <ann@example.com>").';
const requiredAddresses = (what: string) => z.array(z.string().min(1)).min(1).describe(`${what} ${ADDRESS_HINT}`);
export const optionalAddresses = (what: string) => z.array(z.string().min(1)).optional().describe(`${what} ${ADDRESS_HINT}`);
const bodyTextParam = z.string().describe('Plain-text body (UTF-8). Always sent, even when body_html is given, as the text alternative.');
const bodyHtmlParam = z.string().optional().describe('Optional HTML body; sent as multipart/alternative together with body_text.');
export const signatureParam = z
  .boolean()
  .optional()
  .describe("Add the account's Gmail signature below the text, as Gmail's composer does (default true; nothing is added when the account has none or the text already contains it). list_accounts shows each account's signature: do not type it yourself.");

// ---------------------------------------------------------------------------
// gmail_search
// ---------------------------------------------------------------------------

export function hasAttachments(payload: GmailPart | undefined): boolean | undefined {
  if (!payload) return undefined;
  if (payload.parts) return payload.parts.some((p) => Boolean(p.filename) || hasAttachments(p) === true);
  // Metadata format omits parts; multipart/mixed at the top is the usual sign of an attachment.
  return payload.mimeType?.toLowerCase() === 'multipart/mixed' ? true : undefined;
}

function summarizeMessage(m: GmailMessage) {
  const h = m.payload?.headers;
  return {
    id: m.id,
    thread_id: m.threadId,
    date: isoDate(m.internalDate),
    from: headerValue(h, 'From'),
    to: headerValue(h, 'To'),
    cc: headerValue(h, 'Cc'),
    subject: headerValue(h, 'Subject'),
    snippet: m.snippet ? oneLine(decodeEntities(m.snippet)) : undefined,
    labels: m.labelIds,
    unread: (m.labelIds ?? []).includes('UNREAD'),
    has_attachments: hasAttachments(m.payload),
  };
}

function mentionsDrafts(query: string | undefined): boolean {
  return /\b(?:in|label):drafts?\b/i.test(query ?? '');
}

/** message id → draft id for the account's drafts (first MAX_DRAFT_PAGES pages of 100; drafts.list has no query filter). */
async function draftIdsByMessage(ctx: ToolContext, account: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DRAFT_PAGES; page++) {
    const res = await ctx.google.request<DraftList>(account, SERVICE, { url: '/drafts', query: { maxResults: 100, pageToken } });
    for (const d of res.drafts ?? []) if (d.message?.id) map.set(d.message.id, d.id);
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return map;
}

const gmailSearch = defineTool({
  name: 'gmail_search',
  title: 'Search Gmail',
  description:
    'Searches messages using Gmail search syntax (e.g. "from:alice newer_than:7d has:attachment", "is:unread", "in:drafts", "subject:invoice"). ' +
    'Empty query returns the most recent mail. Returns compact rows: id, thread_id, date, from, to, subject, snippet, labels, unread and has_attachments (best effort). ' +
    'Use next_page_token to fetch the next page, gmail_get_message or gmail_get_thread for bodies. ' +
    'When the query targets drafts (in:drafts), rows also carry draft_id for gmail_update_draft / gmail_send_draft / gmail_delete_draft.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    query: z.string().optional().describe('Gmail search query (same syntax as the Gmail search box). Omit for the most recent messages.'),
    max_results: z.number().int().min(1).max(50).optional().describe('Messages per page, 1-50 (default 10).'),
    page_token: pageTokenParam,
    include_spam_trash: z.boolean().optional().describe('Also search Spam and Trash (default false).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const list = await ctx.google.request<MessageList>(args.account, SERVICE, {
      url: '/messages',
      query: {
        q: args.query?.trim() || undefined,
        maxResults: args.max_results ?? 10,
        pageToken: args.page_token,
        includeSpamTrash: args.include_spam_trash ? true : undefined,
      },
    });
    const ids = (list.messages ?? []).map((m) => m.id);
    const messages = await mapLimit(ids, FETCH_CONCURRENCY, (id) => getMessage(ctx, args.account, id, 'metadata', SUMMARY_HEADERS));
    const draftIds = mentionsDrafts(args.query) ? await draftIdsByMessage(ctx, args.account) : new Map<string, string>();
    ctx.log.debug('gmail search', { alias: args.account, results: messages.length });
    // Gmail's resultSizeEstimate is not returned: for any sizeable mailbox it reads ~201
    // whatever the query, which Claude would repeat as a count. Paging is the honest signal.
    if (messages.length === 0) return jsonResult({ note: 'No messages match this query.' });
    return jsonResult({
      results: messages.map((m) => ({ ...summarizeMessage(m), draft_id: draftIds.get(m.id) })),
      next_page_token: list.nextPageToken,
    });
  },
});

// ---------------------------------------------------------------------------
// gmail_get_message / gmail_get_thread
// ---------------------------------------------------------------------------

const gmailGetMessage = defineTool({
  name: 'gmail_get_message',
  title: 'Read a Gmail message',
  description:
    'Fetches one message by id: headers (from, to, cc, bcc, reply_to, date, subject, message_id_header, in_reply_to), labels, thread_id, ' +
    'the body as plain text (text/plain preferred, otherwise HTML converted to text; invisible padding and link tracking parameters removed) and the list of attachments with part_id, attachment_id, filename, mime_type and charset (when declared). ' +
    'Read an attachment with gmail_get_attachment (part_id); attach it to another email or save it to Drive with {gmail_message_id, gmail_part_id} as a file source. ' +
    'Images embedded in the body (logos, icons, pasted pictures) are only counted in inline_images unless include_inline_images is true. ' +
    'Long bodies are clipped to max_chars; when truncated is true call again with offset = next_offset. Read-only (does not mark the message read).',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    message_id: z.string().min(1).describe('Message id from gmail_search or gmail_get_thread.'),
    max_chars: maxCharsParam(8000),
    offset: offsetParam,
    strip_quotes: z.boolean().optional().describe('Drop quoted replies ("> ..." lines, "On ... wrote:" blocks) from the body (default false).'),
    include_inline_images: z
      .boolean()
      .optional()
      .describe('Also list images embedded in the body (logos, icons, pasted pictures) with their attachment ids (default false: only counted in inline_images).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const m = await getMessage(ctx, args.account, args.message_id, 'full');
    const h = m.payload?.headers;
    const body = extractBody(m.payload);
    const text = readableBody(body, args.strip_quotes ?? false);
    const files = splitAttachments(body.attachments, args.include_inline_images ?? false);
    const clipped = clip(text.text, args.max_chars ?? 8000, args.offset ?? 0);
    return jsonResult({
      id: m.id,
      thread_id: m.threadId,
      date: isoDate(m.internalDate),
      headers: {
        from: headerValue(h, 'From'),
        to: headerValue(h, 'To'),
        cc: headerValue(h, 'Cc'),
        bcc: headerValue(h, 'Bcc'),
        reply_to: headerValue(h, 'Reply-To'),
        date: headerValue(h, 'Date'),
        subject: headerValue(h, 'Subject'),
        message_id_header: headerValue(h, 'Message-ID'),
        in_reply_to: headerValue(h, 'In-Reply-To'),
      },
      labels: m.labelIds,
      body: clipped.text,
      body_source: text.source,
      ...clipFields(clipped),
      attachments: files.listed.map(attachmentSummary),
      inline_images: files.hiddenEmbedded || undefined,
    });
  },
});

const gmailGetThread = defineTool({
  name: 'gmail_get_thread',
  title: 'Read a Gmail thread',
  description:
    'Fetches a whole conversation by thread id and returns its messages in chronological order: id, date, from, to, cc, labels, a clipped plain-text body ' +
    '(quoted replies stripped by default) and attachment names. If the thread has more than max_messages, the newest are kept and omitted_older says how many were dropped. ' +
    'Per-message bodies are clipped to max_chars_per_message; use gmail_get_message for the full text or attachment ids.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    thread_id: z.string().min(1).describe('Thread id from gmail_search or gmail_get_message.'),
    max_messages: z.number().int().min(1).max(100).optional().describe('Maximum messages to return, newest kept (default 20).'),
    max_chars_per_message: z.number().int().min(200).max(50_000).optional().describe('Body characters per message (default 2500).'),
    strip_quotes: z.boolean().optional().describe('Drop quoted replies from each body (default true).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const thread = await ctx.google.request<GmailThread>(args.account, SERVICE, { url: `/threads/${encodeId(args.thread_id)}`, query: { format: 'full' } });
    const all = [...(thread.messages ?? [])].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
    const maxMessages = args.max_messages ?? 20;
    const kept = all.slice(Math.max(0, all.length - maxMessages));
    const threadSubject = headerValue(all[0]?.payload?.headers, 'Subject');
    const stripQuotes = args.strip_quotes ?? true;
    const messages = kept.map((m) => {
      const h = m.payload?.headers;
      const body = extractBody(m.payload);
      const clipped = clip(readableBody(body, stripQuotes).text, args.max_chars_per_message ?? 2500);
      const files = splitAttachments(body.attachments, false);
      const subject = headerValue(h, 'Subject');
      return {
        id: m.id,
        date: isoDate(m.internalDate),
        from: headerValue(h, 'From'),
        to: headerValue(h, 'To'),
        cc: headerValue(h, 'Cc'),
        subject: bareSubject(subject) === bareSubject(threadSubject) ? undefined : subject,
        labels: m.labelIds,
        body: clipped.text,
        ...clipFields(clipped),
        attachments: files.listed.map((a) => a.filename),
        inline_images: files.hiddenEmbedded || undefined,
      };
    });
    return jsonResult({
      thread_id: thread.id,
      subject: threadSubject,
      total_messages: all.length,
      omitted_older: all.length - kept.length || undefined,
      messages,
    });
  },
});

// ---------------------------------------------------------------------------
// gmail_get_attachment
// ---------------------------------------------------------------------------

/**
 * Where to go when an attachment cannot be read here: Drive shows previews of
 * any image and converts old Office formats, RTF and (by OCR) scanned PDFs into
 * Google files that drive_get_file reads as text.
 */
function unreadableHint(type: string, note: string, messageId: string, partId: string | undefined): string | undefined {
  if (!partId || /password/i.test(note)) return undefined;
  const source = `source {gmail_message_id: "${messageId}", gmail_part_id: "${partId}"}`;
  if (type.startsWith('image/')) return `To see it, save it to Drive (drive_create_file with ${source}); drive_get_file then shows Drive's preview of it.`;
  if (type === 'application/pdf') return 'To read a scan, call gmail_get_attachment again with ocr: true (Google reads it by OCR).';
  const kind = convertibleKind(type);
  if (!kind) return undefined;
  return `To read it, save a converted copy to Drive: drive_create_file with ${source} and kind "${kind}", then drive_get_file on the new file.`;
}

const gmailGetAttachment = defineTool({
  name: 'gmail_get_attachment',
  title: 'Read a Gmail attachment',
  description:
    'Reads one attachment of a message (part_id or attachment_id from gmail_get_message). Text files, HTML, CSV, JSON, PDF (its text layer), Word (.docx), Excel (.xlsx, each sheet as CSV) and PowerPoint (.pptx) ' +
    'come back as text, clipped to max_chars with offset paging; PNG, JPEG, GIF and WebP images up to 96 KB come back as an image you can look at (the most a tool result can carry); a larger one can be seen by saving it to Drive and opening it with drive_get_file, which shows Drive\'s preview. ' +
    'Scanned PDFs without text, other binary formats and attachments over 25 MB return a note instead; ocr: true reads a scanned PDF or a photo of a document with Google\'s OCR, through a temporary Google Doc in the account\'s Drive (needs Drive; deleted right after). ' +
    'To forward the file, attach it to another email or save it to Drive, pass {gmail_message_id, gmail_part_id} as the attachment or source there: no need to read it first.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    message_id: z.string().min(1).describe('Id of the message that carries the attachment.'),
    part_id: z.string().min(1).optional().describe('part_id from gmail_get_message (preferred: stable, and the file name, type and charset are looked up).'),
    attachment_id: z.string().min(1).optional().describe('attachment_id from gmail_get_message, when there is no part_id.'),
    filename: z.string().optional().describe('With attachment_id: the filename reported by gmail_get_message (used to detect the type).'),
    mime_type: z.string().optional().describe('With attachment_id: the MIME type reported by gmail_get_message (used to detect the type).'),
    charset: z.string().optional().describe('Character set of a text attachment when it is not declared (e.g. "windows-1251"). Default: as declared, else UTF-8.'),
    max_chars: maxCharsParam(20_000),
    offset: offsetParam,
    ocr: z.boolean().optional().describe('Read a scanned PDF or an image of a document as text with Google\'s OCR (when a note says the PDF has no text). Needs Drive on the account.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: guarded(async (args, ctx) => {
    if (!args.part_id && !args.attachment_id) throw new InputError('Give part_id (preferred) or attachment_id, as listed by gmail_get_message.');
    let meta: { filename?: string; mimeType?: string; charset?: string } = { filename: args.filename, mimeType: args.mime_type, charset: args.charset };
    let bytes: Buffer;
    if (args.part_id) {
      const m = await getMessage(ctx, args.account, args.message_id, 'full');
      const parts = extractBody(m.payload).attachments;
      const part = parts.find((a) => a.partId === args.part_id);
      if (!part) {
        const known = parts.filter((a) => !a.embedded).map((a) => `${a.partId} (${a.filename})`);
        return errorResult(`Message ${args.message_id} has no attachment with part_id "${args.part_id}". ${known.length ? `Its attachments: ${known.join(', ')}.` : 'It has no attachments.'}`);
      }
      if (part.size > MAX_ATTACHMENT_BYTES) return errorResult(`Attachment is ${mb(part.size)} MB, above the 25 MB limit.`);
      meta = { filename: args.filename ?? part.filename, mimeType: args.mime_type ?? part.mimeType, charset: args.charset ?? part.charset };
      if (part.data !== undefined) bytes = decodeBase64Url(part.data);
      else if (part.attachmentId) bytes = decodeBase64Url((await fetchAttachment(ctx, args.account, args.message_id, part.attachmentId)).data ?? '');
      else if (part.nested) return errorResult(`"${part.filename}" is an attached email that Gmail only provides part by part; read the message itself with gmail_get_message.`);
      else bytes = Buffer.alloc(0); // an empty file: Gmail sends neither data nor an attachment id
    } else {
      const res = await fetchAttachment(ctx, args.account, args.message_id, args.attachment_id!);
      if ((res.size ?? 0) > MAX_ATTACHMENT_BYTES) return errorResult(`Attachment is ${mb(res.size ?? 0)} MB, above the 25 MB limit.`);
      bytes = decodeBase64Url(res.data ?? '');
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) return errorResult(`Attachment is ${mb(bytes.length)} MB, above the 25 MB limit.`);
    // The attachment id is not echoed back: it is several hundred characters and the caller already has it.
    const base = { message_id: args.message_id, part_id: args.part_id, filename: meta.filename, mime_type: meta.mimeType, size: bytes.length };
    const charset = meta.charset?.trim() || charsetOfContentType(meta.mimeType);
    if (args.ocr) {
      const type = baseMime(meta.mimeType ?? '') === 'application/octet-stream' || !meta.mimeType ? (mimeFromFilename(meta.filename) ?? sniffMime(bytes) ?? '') : baseMime(meta.mimeType);
      if (!ocrType(type)) return errorResult(`ocr only applies to PDFs and images; this attachment is ${type || 'of an unknown type'}. Call without ocr.`);
      const { text, note } = await ocrText(ctx, args.account, { data: bytes, mimeType: type, name: meta.filename });
      const clipped = clip(text, args.max_chars ?? 20_000, args.offset ?? 0);
      return jsonResult({ ...base, extracted_from: 'ocr', format: 'text/markdown', text: clipped.text, ...clipFields(clipped), note: text.trim() ? note : "Google's OCR found no text in the attachment." });
    }
    const content = await readFileContent(bytes, { mimeType: meta.mimeType, filename: meta.filename, charset });
    if (content.kind === 'image') {
      return withImage(jsonResult({ ...base, note: content.note ?? 'The image follows.' }), content);
    }
    if (content.kind === 'none') {
      const hint = unreadableHint(content.type, content.note, args.message_id, args.part_id);
      return jsonResult({ ...base, note: hint ? `${content.note} ${hint}` : content.note });
    }
    const clipped = clip(content.text, args.max_chars ?? 20_000, args.offset ?? 0);
    const isTextFile = content.extractedFrom === undefined || content.extractedFrom === 'html';
    return jsonResult({
      ...base,
      charset: isTextFile ? content.charset : undefined,
      extracted_from: content.extractedFrom,
      // Extracted documents are Markdown (PDF pages, Word) or CSV (Excel); text files keep their own type.
      format: isTextFile ? undefined : content.format,
      text: clipped.text,
      ...clipFields(clipped),
      note: content.text ? content.note : (content.note ?? 'The attachment contains no text.'),
    });
  }),
});

// ---------------------------------------------------------------------------
// gmail_send / gmail_reply / gmail_forward
// ---------------------------------------------------------------------------

/** The texts an outgoing message will carry, as the recipient reads them. */
export function outgoingTexts(args: { body_text?: string; body_html?: string }): string[] {
  return [args.body_text ?? '', args.body_html ? htmlToText(args.body_html) : ''];
}

/** Blanks left in a saved draft's subject and own text; none when it cannot be read back (the check is advisory). */
export async function savedDraftBlanks(ctx: ToolContext, account: string, messageId: string | undefined): Promise<string[]> {
  if (!messageId) return [];
  try {
    const m = await getMessage(ctx, account, messageId, 'full');
    return messageBlanks(m.payload);
  } catch {
    return [];
  }
}

/**
 * Blanks in a message's subject and in its own words, in the plain text and in the HTML (which is what most
 * recipients see, and can differ from the text); quoted replies and forwarded messages are someone else's.
 */
export function messageBlanks(payload: GmailPart | undefined): string[] {
  const body = extractBody(payload);
  const html = body.html.trim() ? cleanText(htmlToText(stripQuotedHtml(body.html))) : '';
  return findPlaceholders({ subject: headerValue(payload?.headers, 'Subject'), texts: [cleanText(stripQuotedText(normalizeNewlines(body.text))), html] });
}

/** A message's own words (quoted replies left out), as the plain text or, failing that, the HTML. */
export function ownText(payload: GmailPart | undefined): string {
  const body = extractBody(payload);
  const text = cleanText(stripQuotedText(normalizeNewlines(body.text)));
  return text.trim() ? text : body.html.trim() ? cleanText(htmlToText(stripQuotedHtml(body.html))) : '';
}

/** Stops a send whose subject or text still has blanks such as "[téléphone]", unless they were confirmed. */
function refuseBlanks(args: { body_text?: string; body_html?: string; allow_placeholders?: boolean }, subject?: string): void {
  if (args.allow_placeholders) return;
  const blanks = findPlaceholders({ subject, texts: outgoingTexts(args) });
  if (blanks.length) throw new InputError(placeholderRefusal(blanks));
}

/** Addresses of recipient header values ("Ann <ann@x.fr>, bob@y.fr"). */
function addressesOf(values: (string | undefined)[]): { name?: string; email: string }[] {
  return values.flatMap((v) => (v ? parseAddresses(v) : [])).filter((a) => a.email.includes('@'));
}

/**
 * A send to sensitive contacts does not go out: the built message is saved as a draft (in its thread), and the result
 * carries the review Claude must take the user through before gmail_send_draft with reviewed_by_user. Undefined when
 * no recipient is sensitive.
 */
async function holdForReview(
  ctx: ToolContext,
  account: string,
  email: string,
  sensitive: SensitiveContact[],
  message: { mime: string; threadId?: string; subject?: string; text: string },
): Promise<CallToolResult | undefined> {
  if (!sensitive.length) return undefined;
  const draft = await uploadRawMessage<Draft>(ctx, account, draftTarget(undefined, message.threadId), message.mime);
  const review = await reviewFor(ctx, account, sensitive, message.subject, message.text);
  if (draft.id && draft.message?.id) review.review_token = reviewToken(ctx, account, draft.id, draft.message.id);
  ctx.log.info('send held for review', { alias: account, categories: [...new Set(sensitive.map((c) => c.category))].join(','), flags: review.flags.length });
  return jsonResult({
    sent: false,
    saved_as_draft: true,
    draft_id: draft.id,
    message_id: draft.message?.id,
    thread_id: draft.message?.threadId,
    web_url: draft.message?.id ? gmailWebUrl(email, 'draft', draft.message.id) : undefined,
    note: `Not sent: ${sensitive.map((c) => c.address).join(', ')} ${sensitive.length > 1 ? 'are sensitive contacts' : 'is a sensitive contact'}. The mail was saved as a draft for the user to review.`,
    review,
  });
}

const SENSITIVE_NOTE =
  'Mail to sensitive contacts (bailiffs, lawyers, notaries, courts, administrations, insurers, property managers, the user\'s own list in sensitive_contacts, people an open follow-up waits on) is not sent: it is saved as a draft and the result carries a risk review to go through with the user. ';

const gmailSend = defineTool({
  name: 'gmail_send',
  title: 'Send an email',
  description:
    'Sends a new email from the account (starts a new thread). body_text is always sent; add body_html for a rich version. ' +
    'attachments can carry Drive files (Google Docs/Sheets/Slides go as PDF by default), attachments of other emails, or files you write (text or base64), from this or another linked account. ' +
    'A subject or text that still has unfilled blanks ("[téléphone]", "{{name}}", "06 XX XX XX XX") is refused unless allow_placeholders. ' +
    SENSITIVE_NOTE +
    'Returns the sent message id, thread_id, label_ids and the attached files. Not reversible: confirm recipients, content and attachments before calling.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    to: requiredAddresses('Recipients'),
    cc: optionalAddresses('Cc recipients'),
    bcc: optionalAddresses('Bcc recipients'),
    subject: z.string().describe('Subject line (non-ASCII is fine).'),
    body_text: bodyTextParam,
    body_html: bodyHtmlParam,
    reply_to: z.string().optional().describe('Optional Reply-To address for answers to this email.'),
    attachments: attachmentsParam,
    allow_placeholders: allowPlaceholdersParam,
    signature: signatureParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    refuseBlanks(args, args.subject);
    const to = recipients(args.to, 'to');
    const cc = recipients(args.cc, 'cc');
    const bcc = recipients(args.bcc, 'bcc');
    const replyTo = singleRecipient(args.reply_to, 'reply_to');
    const files = await outgoingAttachments(ctx, args.account, args.attachments);
    const identity = await gmailIdentity(ctx, args.account);
    const body = withSignature({ text: args.body_text, html: args.body_html }, identity, args.signature ?? true);
    const mime = buildMimeMessage({ from: fromHeader(identity), to, cc, bcc, replyTo, subject: args.subject, text: body.text, html: body.html, attachments: files });
    const held = await holdForReview(ctx, args.account, identity.email, sensitiveRecipients(ctx, addressesOf([...to, ...cc, ...bcc])), {
      mime,
      subject: args.subject,
      text: outgoingTexts(args).find((t) => t.trim()) ?? '',
    });
    if (held) return held;
    const sent = await sendRaw(ctx, args.account, mime);
    return jsonResult({
      id: sent.id,
      thread_id: sent.threadId,
      label_ids: sent.labelIds,
      from: readableFrom(identity),
      signature_added: body.added || undefined,
      attachments: attachedSummary(files),
      web_url: gmailWebUrl(identity.email, 'message', sent.id),
    });
  }),
});

const gmailReply = defineTool({
  name: 'gmail_reply',
  title: 'Reply to an email',
  description:
    'Replies to a message in its thread. Recipients are derived from the original: Reply-To (or From) for a plain reply; reply_all also keeps the original To and Cc ' +
    'minus the account itself. Subject gets a "Re: " prefix, In-Reply-To and References are set so mail clients thread it. attachments works as in gmail_send. ' +
    SENSITIVE_NOTE +
    'Returns the new message id and thread_id.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    message_id: z.string().min(1).describe('Id of the message to reply to.'),
    body_text: bodyTextParam,
    body_html: bodyHtmlParam,
    reply_all: z.boolean().optional().describe('Reply to everyone on the original message (default false).'),
    extra_cc: optionalAddresses('Additional Cc recipients'),
    attachments: attachmentsParam,
    allow_placeholders: allowPlaceholdersParam,
    signature: signatureParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    refuseBlanks(args);
    const identity = await gmailIdentity(ctx, args.account);
    const extraCc = recipients(args.extra_cc, 'extra_cc');
    const original = await getMessage(ctx, args.account, args.message_id, 'metadata', REPLY_HEADERS);
    const reply = replyContext(original, identity.email, args.reply_all ?? false, identity.addresses);
    if (!reply.to.length) return errorResult('Could not determine a recipient: the original message has no From or Reply-To header.');
    const files = await outgoingAttachments(ctx, args.account, args.attachments);
    const body = withSignature({ text: args.body_text, html: args.body_html }, identity, args.signature ?? true);
    const mime = buildMimeMessage({
      from: fromHeader(identity),
      to: reply.to,
      cc: [...reply.cc, ...extraCc],
      subject: reply.subject,
      text: body.text,
      html: body.html,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
      attachments: files,
    });
    const held = await holdForReview(ctx, args.account, identity.email, sensitiveRecipients(ctx, addressesOf([...reply.to, ...reply.cc, ...extraCc])), {
      mime,
      threadId: reply.threadId,
      subject: reply.subject,
      text: outgoingTexts(args).find((t) => t.trim()) ?? '',
    });
    if (held) return held;
    const sent = await sendRaw(ctx, args.account, mime, reply.threadId);
    return jsonResult({
      id: sent.id,
      thread_id: sent.threadId,
      to: reply.to,
      cc: reply.cc,
      signature_added: body.added || undefined,
      attachments: attachedSummary(files),
      web_url: gmailWebUrl(identity.email, 'message', sent.id),
    });
  }),
});

/** Downloads the original attachments for a forward, unless together they exceed the size limit. */
async function forwardAttachments(ctx: ToolContext, account: string, messageId: string, attachments: ExtractedAttachment[]): Promise<{ files: MimeAttachment[]; note?: string }> {
  const total = attachments.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_FORWARD_ATTACHMENT_BYTES) {
    return { files: [], note: `Original attachments total ${mb(total)} MB, above the 20 MB forwarding limit; forwarded without attachments.` };
  }
  const files = await mapLimit(attachments, FETCH_CONCURRENCY, async (a): Promise<MimeAttachment | undefined> => {
    const data = a.data ?? (a.attachmentId ? (await fetchAttachment(ctx, account, messageId, a.attachmentId)).data : undefined);
    return data ? { filename: a.filename, mimeType: a.mimeType, content: decodeBase64Url(data) } : undefined;
  });
  return { files: files.filter((f): f is MimeAttachment => f !== undefined) };
}

function forwardedBlock(original: GmailMessage, body: string): string {
  const h = original.payload?.headers;
  const lines = ['---------- Forwarded message ---------', `From: ${headerValue(h, 'From') ?? ''}`, `Date: ${headerValue(h, 'Date') ?? isoDate(original.internalDate) ?? ''}`, `Subject: ${headerValue(h, 'Subject') ?? ''}`, `To: ${headerValue(h, 'To') ?? ''}`];
  const cc = headerValue(h, 'Cc');
  if (cc) lines.push(`Cc: ${cc}`);
  return `${lines.join('\n')}\n\n\n${body}`;
}

const gmailForward = defineTool({
  name: 'gmail_forward',
  title: 'Forward an email',
  description:
    'Forwards a message to new recipients as a new thread: your note, then a "---------- Forwarded message ---------" block with the original From/Date/Subject/To and its body as plain text. ' +
    'Original attachments are re-attached unless include_attachments is false or they exceed 20 MB in total (then a note is returned). Subject gets a "Fwd: " prefix. ' +
    SENSITIVE_NOTE +
    'Returns the new message id and thread_id.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    message_id: z.string().min(1).describe('Id of the message to forward.'),
    to: requiredAddresses('Recipients'),
    note: z.string().optional().describe('Text placed above the forwarded block.'),
    include_attachments: z.boolean().optional().describe('Re-attach the original attachments (default true).'),
    allow_placeholders: allowPlaceholdersParam,
    signature: signatureParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    // Only the note is checked: the forwarded message is someone else's and goes as it is.
    const blanks = args.allow_placeholders ? [] : findPlaceholders({ texts: [args.note] });
    if (blanks.length) throw new InputError(placeholderRefusal(blanks));
    const to = recipients(args.to, 'to');
    const identity = await gmailIdentity(ctx, args.account);
    const original = await getMessage(ctx, args.account, args.message_id, 'full');
    const body = extractBody(original.payload);
    // The signature goes under the note and above the forwarded message, as in Gmail's composer.
    const note = withSignature({ text: args.note?.trim() ?? '' }, identity, args.signature ?? true);
    const text = [note.text.trim(), forwardedBlock(original, bodyText(body, false).text)].filter(Boolean).join('\n\n');
    // Images embedded in the original HTML are not re-attached: the forward carries the text version, where they would only be clutter.
    const realAttachments = body.attachments.filter((a) => !a.embedded);
    const attached = args.include_attachments === false ? { files: [] } : await forwardAttachments(ctx, args.account, args.message_id, realAttachments);
    const mime = buildMimeMessage({
      from: fromHeader(identity),
      to,
      subject: forwardSubject(headerValue(original.payload?.headers, 'Subject')),
      text,
      attachments: attached.files,
    });
    const held = await holdForReview(ctx, args.account, identity.email, sensitiveRecipients(ctx, addressesOf(to)), {
      mime,
      subject: forwardSubject(headerValue(original.payload?.headers, 'Subject')),
      text: args.note ?? '',
    });
    if (held) return held;
    const sent = await sendRaw(ctx, args.account, mime);
    return jsonResult({
      id: sent.id,
      thread_id: sent.threadId,
      attachments_included: attached.files.length,
      signature_added: note.added || undefined,
      note: attached.note,
      web_url: gmailWebUrl(identity.email, 'message', sent.id),
    });
  }),
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const gmailCreateDraft = defineTool({
  name: 'gmail_create_draft',
  title: 'Create or update a draft',
  description:
    'Creates a draft (nothing is sent) or, with draft_id, replaces that draft\'s content. With reply_to_message_id the draft becomes a reply in that thread: ' +
    'recipients default to the original sender (Reply-To or From), subject to "Re: ...", and In-Reply-To/References are set; pass to/subject to override. ' +
    'attachments works as in gmail_send. For the same message to several separate recipients, use gmail_create_drafts (one personalised draft each). With draft_id the whole draft is rewritten from these arguments; to change only part of an existing draft (add or remove an attachment, fix the subject or recipients) use gmail_update_draft, which keeps the rest. ' +
    'Returns draft_id (for gmail_update_draft / gmail_send_draft / gmail_delete_draft), message_id, thread_id, the attached files, and a warning when the text has unfilled blanks such as "[téléphone]" to fill in before sending.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    to: optionalAddresses('Recipients').describe(`Recipients ${ADDRESS_HINT} Required unless reply_to_message_id is given.`),
    cc: optionalAddresses('Cc recipients'),
    bcc: optionalAddresses('Bcc recipients'),
    subject: z.string().optional().describe('Subject. Required unless reply_to_message_id is given (then defaults to "Re: <original>").'),
    body_text: bodyTextParam,
    body_html: bodyHtmlParam,
    reply_to_message_id: z.string().optional().describe('Make this a reply draft to that message (sets thread, In-Reply-To, References).'),
    draft_id: z.string().optional().describe('Existing draft to update instead of creating a new one.'),
    attachments: attachmentsParam,
    signature: signatureParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    if (!args.reply_to_message_id && !args.to?.length) return errorResult('Provide at least one recipient in `to` (or a reply_to_message_id whose sender can be used).');
    if (!args.reply_to_message_id && args.subject === undefined) return errorResult('Provide a subject (or a reply_to_message_id to reuse the original subject).');
    const cc = recipients(args.cc, 'cc');
    const bcc = recipients(args.bcc, 'bcc');
    const identity = await gmailIdentity(ctx, args.account);
    const reply = args.reply_to_message_id
      ? replyContext(await getMessage(ctx, args.account, args.reply_to_message_id, 'metadata', REPLY_HEADERS), identity.email, false, identity.addresses)
      : undefined;
    const to = args.to?.length ? recipients(args.to, 'to') : (reply?.to ?? []);
    if (!to.length) return errorResult('Provide at least one recipient in `to` (or a reply_to_message_id whose sender can be used).');
    const subject = args.subject ?? reply?.subject;
    if (subject === undefined) return errorResult('Provide a subject (or a reply_to_message_id to reuse the original subject).');
    const files = await outgoingAttachments(ctx, args.account, args.attachments);
    const body = withSignature({ text: args.body_text, html: args.body_html }, identity, args.signature ?? true);
    const mime = buildMimeMessage({
      from: fromHeader(identity),
      to,
      cc,
      bcc,
      subject,
      text: body.text,
      html: body.html,
      inReplyTo: reply?.inReplyTo,
      references: reply?.references,
      attachments: files,
    });
    const draft = await uploadRawMessage<Draft>(ctx, args.account, draftTarget(args.draft_id, reply?.threadId), mime);
    const sensitive = sensitiveRecipients(ctx, addressesOf([...to, ...cc, ...bcc]));
    const review = sensitive.length ? await reviewFor(ctx, args.account, sensitive, subject, outgoingTexts(args).find((t) => t.trim()) ?? '') : undefined;
    if (review && draft.id && draft.message?.id) review.review_token = reviewToken(ctx, args.account, draft.id, draft.message.id);
    return jsonResult({
      draft_id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId,
      updated: args.draft_id ? true : undefined,
      signature_added: body.added || undefined,
      attachments: attachedSummary(files),
      warning: placeholderWarning(findPlaceholders({ subject, texts: outgoingTexts(args) })),
      web_url: draft.message?.id ? gmailWebUrl(identity.email, 'draft', draft.message.id) : undefined,
      review,
    });
  }),
});

/** Most drafts one gmail_send_draft call sends: all are checked first and sent one after the other. */
const MAX_DRAFTS_PER_SEND = 25;

interface FullDraft {
  id: string;
  message?: GmailMessage;
}

const gmailSendDraft = defineTool({
  name: 'gmail_send_draft',
  title: 'Send drafts',
  description:
    'Sends existing drafts as they are: draft_id for one, or draft_ids for several in one call (up to 25, e.g. a batch the user has reviewed). ' +
    'Every draft is checked before any is sent: if one is missing or its subject or new text still has unfilled blanks such as "[téléphone]", "{{name}}" or "06 XX XX XX XX", nothing is sent. ' +
    'Drafts to sensitive contacts (see sensitive_contacts) are sent only with reviewed_by_user: true and their review_token (in review_tokens), once the user saw that exact text and its risk review; otherwise nothing is sent and the reviews, with their tokens, come back. ' +
    'Sent drafts leave the drafts folder. Returns the sent message id and thread_id (for draft_ids, one result per draft, in order).',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    draft_id: z.string().min(1).optional().describe('Draft id (not the message id), from gmail_create_draft or gmail_search with in:drafts.'),
    draft_ids: z.array(z.string().min(1)).min(1).max(MAX_DRAFTS_PER_SEND).optional().describe('Several draft ids to send in one call, in this order (instead of draft_id).'),
    allow_placeholders: allowPlaceholdersParam,
    reviewed_by_user: reviewedByUserParam,
    review_tokens: reviewTokensParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    const ids = [...new Set([...(args.draft_id ? [args.draft_id] : []), ...(args.draft_ids ?? [])].map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return errorResult('Give draft_id, or draft_ids for several drafts.');
    if (ids.length > MAX_DRAFTS_PER_SEND) return errorResult(`At most ${MAX_DRAFTS_PER_SEND} drafts per call; send the rest in another call.`);
    const batch = args.draft_ids !== undefined;

    // Every draft is read and checked before any is sent, so a problem in one leaves the whole batch unsent.
    const drafts = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
      try {
        return { id, draft: await ctx.google.request<FullDraft>(args.account, SERVICE, { url: `/drafts/${encodeId(id)}`, query: { format: 'full' } }) };
      } catch (err) {
        if (err instanceof GoogleApiError && (err.status === 404 || err.status === 400)) return { id, draft: undefined };
        throw err;
      }
    });
    const missing = drafts.filter((d) => !d.draft?.message).map((d) => d.id);
    if (missing.length) {
      return errorResult(
        `Nothing was sent: this account has no draft ${missing.map((id) => `"${id}"`).join(', ')}. ` +
          'It needs the draft id (gmail_search with "in:drafts" lists it as draft_id), not the message id; the draft may also have been sent or deleted already.',
      );
    }
    const checked = drafts.map(({ id, draft }) => {
      const h = draft!.message!.payload?.headers;
      const subject = headerValue(h, 'Subject') ?? '';
      const sensitive = sensitiveRecipients(ctx, addressesOf([headerValue(h, 'To'), headerValue(h, 'Cc'), headerValue(h, 'Bcc')]));
      return {
        id,
        to: oneLine(headerValue(h, 'To') ?? ''),
        subject: oneLine(subject),
        blanks: messageBlanks(draft!.message!.payload),
        sensitive,
        payload: draft!.message!.payload,
        token: reviewToken(ctx, args.account, id, draft!.message!.id),
      };
    });
    const withBlanks = checked.filter((d) => d.blanks.length);
    if (withBlanks.length && !args.allow_placeholders) {
      if (!batch) return errorResult(placeholderRefusal(withBlanks[0]!.blanks));
      return errorResult(
        `Nothing was sent: ${withBlanks.length} of the ${checked.length} drafts still have what look like unfilled blanks:\n` +
          withBlanks.map((d) => `- ${d.id} (${d.subject || 'no subject'} → ${d.to || 'no recipient'}): ${quoteList(d.blanks)}`).join('\n') +
          '\nFill them in with gmail_update_draft (ask the user for the missing details), or call again with allow_placeholders: true if they belong there.',
      );
    }

    // Sensitive contacts: nothing goes out before the user reviewed that exact version. The reviews (with the token
    // each needs) come back for every such draft not yet confirmed.
    const tokens = new Set(args.reviewed_by_user ? (args.review_tokens ?? []) : []);
    const toReview = checked.filter((d) => d.sensitive.length && !tokens.has(d.token));
    if (toReview.length) {
      const cache: CadenceCache = new Map();
      const reviews = await mapLimit(toReview, FETCH_CONCURRENCY, async (d) => {
        const review = await reviewFor(ctx, args.account, d.sensitive, d.subject, ownText(d.payload), cache);
        return { draft_id: d.id, to: d.to, subject: d.subject, review: { ...review, review_token: d.token } };
      });
      ctx.log.info('send held for review', { alias: args.account, drafts: toReview.length });
      return jsonResult({
        sent: 0,
        note:
          `Nothing was sent: ${batch ? `${toReview.length} of these drafts go` : 'this draft goes'} to sensitive contacts. ` +
          'Go through the review with the user (show the final text), then call again with reviewed_by_user: true and review_tokens (each review\'s review_token) once they confirm. A token from before an edit no longer counts.',
        reviews,
      });
    }

    const email = accountEmail(ctx, args.account);
    if (!batch) {
      const sent = await ctx.google.request<SentMessage>(args.account, SERVICE, { method: 'POST', url: '/drafts/send', body: { id: ids[0] } });
      return jsonResult({ id: sent.id, thread_id: sent.threadId, label_ids: sent.labelIds, web_url: gmailWebUrl(email, 'message', sent.id) });
    }
    // One after the other, so the results come back in order and a failure is tied to its draft; a failed
    // draft does not stop the others, and each result says whether it went.
    const results: Record<string, unknown>[] = [];
    for (const d of checked) {
      try {
        const sent = await ctx.google.request<SentMessage>(args.account, SERVICE, { method: 'POST', url: '/drafts/send', body: { id: d.id } });
        results.push({ draft_id: d.id, to: d.to, subject: d.subject, id: sent.id, thread_id: sent.threadId, web_url: gmailWebUrl(email, 'message', sent.id) });
      } catch (err) {
        results.push({ draft_id: d.id, to: d.to, subject: d.subject, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const failed = results.filter((r) => r['error'] !== undefined).length;
    return jsonResult({
      sent: results.length - failed,
      failed: failed || undefined,
      results,
      note: failed ? 'The drafts with an error were not sent and are still in the drafts folder.' : undefined,
    });
  }),
});

const gmailDeleteDraft = defineTool({
  name: 'gmail_delete_draft',
  title: 'Delete a draft',
  description: 'Permanently deletes a draft (draft_id from gmail_create_draft or gmail_search with in:drafts). Cannot be undone.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    draft_id: z.string().min(1).describe('Draft id (not the message id).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (args, ctx) => {
    await ctx.google.request(args.account, SERVICE, { method: 'DELETE', url: `/drafts/${encodeId(args.draft_id)}` });
    return jsonResult({ deleted: true, draft_id: args.draft_id });
  },
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function listLabels(ctx: ToolContext, account: string): Promise<GmailLabel[]> {
  return ctx.google.request<{ labels?: GmailLabel[] }>(account, SERVICE, { url: '/labels' }).then((r) => r.labels ?? []);
}

const gmailListLabels = defineTool({
  name: 'gmail_list_labels',
  title: 'List Gmail labels',
  description: 'Lists the account\'s labels (id, name, type) with system labels (INBOX, UNREAD, STARRED, ...) first, then user labels sorted by name. Nested labels appear as "Parent/Child".',
  service: SERVICE,
  inputSchema: { account: accountParam },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const labels = (await listLabels(ctx, args.account))
      .map((l) => ({ id: l.id, name: l.name, type: l.type }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'system' ? -1 : 1));
    return jsonResult({ labels });
  },
});

interface LabelResolution {
  ids: string[];
  created: { id: string; name: string }[];
}

/**
 * Turns label names or ids into ids. System labels resolve without a network
 * call; user labels are matched case-insensitively against labels.list, and
 * unknown names are created when allowed (only for labels being added).
 */
async function resolveLabels(ctx: ToolContext, account: string, wanted: string[], catalog: () => Promise<GmailLabel[]>, createMissing: boolean): Promise<LabelResolution> {
  const ids = new Set<string>();
  const created: { id: string; name: string }[] = [];
  for (const raw of wanted) {
    const name = raw.trim();
    if (!name) continue;
    if (SYSTEM_LABELS.has(name.toUpperCase())) {
      ids.add(name.toUpperCase());
      continue;
    }
    const labels = await catalog();
    const found = labels.find((l) => l.id === name) ?? labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (found) {
      ids.add(found.id);
      continue;
    }
    if (!createMissing) throw new InputError(`Unknown label "${name}". Call gmail_list_labels to see the existing labels.`);
    const label = await ctx.google.request<GmailLabel>(account, SERVICE, {
      method: 'POST',
      url: '/labels',
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    labels.push(label);
    ids.add(label.id);
    created.push({ id: label.id, name: label.name });
  }
  return { ids: [...ids], created };
}

const gmailModifyLabels = defineTool({
  name: 'gmail_modify_labels',
  title: 'Add or remove labels',
  description:
    'Adds and/or removes labels on messages and/or threads. Labels may be given as names (case-insensitive, "Parent/Child" for nested) or ids; system labels: INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, SENT, DRAFT, CATEGORY_*. ' +
    'Shortcuts: archive = remove INBOX; mark read = remove UNREAD; mark unread = add UNREAD; star = add STARRED; restore from trash = remove TRASH; move to inbox = add INBOX. ' +
    'Adding TRASH or SPAM is refused (use gmail_trash to trash); removing them is allowed. ' +
    'Unknown user labels in add_labels are created when create_missing is true (default). Idempotent. Returns counts and the resolved label ids.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    message_ids: messageIdsParam,
    thread_ids: threadIdsParam,
    add_labels: z.array(z.string().min(1)).optional().describe('Labels to add (names or ids).'),
    remove_labels: z.array(z.string().min(1)).optional().describe('Labels to remove (names or ids).'),
    create_missing: z.boolean().optional().describe('Create user labels named in add_labels that do not exist yet (default true).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: guarded(async (args, ctx) => {
    const messageIds = args.message_ids ?? [];
    const threadIds = args.thread_ids ?? [];
    if (!messageIds.length && !threadIds.length) return errorResult('Provide message_ids and/or thread_ids.');
    if (!args.add_labels?.length && !args.remove_labels?.length) return errorResult('Provide add_labels and/or remove_labels.');
    // This tool is announced as non-destructive; adding TRASH or SPAM would trash or spam the mail.
    const dangerous = (args.add_labels ?? []).map((l) => l.trim().toUpperCase()).find((l) => l === 'TRASH' || l === 'SPAM');
    if (dangerous) {
      return errorResult(dangerous === 'TRASH' ? 'Adding TRASH is refused here: use gmail_trash to move mail to Trash.' : 'Adding SPAM is refused here: marking mail as spam is not supported (use gmail_trash to trash it).');
    }
    const catalog = lazy(() => listLabels(ctx, args.account));
    const add = await resolveLabels(ctx, args.account, args.add_labels ?? [], catalog, args.create_missing ?? true);
    const remove = await resolveLabels(ctx, args.account, args.remove_labels ?? [], catalog, false);
    const change = { addLabelIds: add.ids.length ? add.ids : undefined, removeLabelIds: remove.ids.length ? remove.ids : undefined };
    // Label changes are set operations, so repeating one after a timeout is harmless: let the client retry.
    if (messageIds.length) {
      await ctx.google.request(args.account, SERVICE, { method: 'POST', url: '/messages/batchModify', body: { ids: messageIds, ...change }, idempotent: true });
    }
    await mapLimit(threadIds, FETCH_CONCURRENCY, (id) => ctx.google.request(args.account, SERVICE, { method: 'POST', url: `/threads/${encodeId(id)}/modify`, body: change, idempotent: true }));
    return jsonResult({
      messages_modified: messageIds.length,
      threads_modified: threadIds.length,
      added_label_ids: add.ids,
      removed_label_ids: remove.ids,
      created_labels: add.created,
    });
  }),
});

// ---------------------------------------------------------------------------
// gmail_trash
// ---------------------------------------------------------------------------

const gmailTrash = defineTool({
  name: 'gmail_trash',
  title: 'Trash or restore messages',
  description:
    'Moves messages and/or threads to Trash (action "trash", the default; Gmail deletes trashed mail permanently after 30 days) or restores them (action "untrash"). ' +
    'To archive instead of trashing, use gmail_modify_labels to remove INBOX. Returns counts.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    message_ids: messageIdsParam,
    thread_ids: threadIdsParam,
    action: z.enum(['trash', 'untrash']).optional().describe('"trash" (default) or "untrash".'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (args, ctx) => {
    const messageIds = args.message_ids ?? [];
    const threadIds = args.thread_ids ?? [];
    if (!messageIds.length && !threadIds.length) return errorResult('Provide message_ids and/or thread_ids.');
    const action = args.action ?? 'trash';
    // Trashing twice is the same as trashing once, so these POSTs may be retried.
    await mapLimit(messageIds, FETCH_CONCURRENCY, (id) => ctx.google.request(args.account, SERVICE, { method: 'POST', url: `/messages/${encodeId(id)}/${action}`, idempotent: true }));
    await mapLimit(threadIds, FETCH_CONCURRENCY, (id) => ctx.google.request(args.account, SERVICE, { method: 'POST', url: `/threads/${encodeId(id)}/${action}`, idempotent: true }));
    return jsonResult({ action, messages: messageIds.length, threads: threadIds.length });
  },
});

export const gmailTools: ToolDefinition[] = [
  gmailSearch,
  gmailGetMessage,
  gmailGetThread,
  gmailGetAttachment,
  gmailSend,
  gmailReply,
  gmailForward,
  gmailCreateDraft,
  gmailSendDraft,
  gmailDeleteDraft,
  gmailListLabels,
  gmailModifyLabels,
  gmailTrash,
];
