/**
 * MIME helpers for the Gmail tools.
 *
 * Decoding side: base64url bodies, nested multipart payloads as Gmail's API
 * returns them, HTML to readable text, quoted-reply stripping. Encoding side:
 * RFC 5322 messages (RFC 2047 headers, MIME attachments) for sending.
 * Everything here is pure so it can be unit-tested without Google.
 */
import { randomBytes } from 'node:crypto';

const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// Gmail payload shapes (the subset we read)
// ---------------------------------------------------------------------------

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export function decodeBase64Url(data: string): Buffer {
  // Node accepts both the base64url and the standard alphabet here, padded or not.
  return Buffer.from(data, 'base64url');
}

export function encodeBase64Url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

/** Case-insensitive header lookup. Gmail returns header values already decoded (RFC 2047 words expanded). */
export function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/** charset parameter of a Content-Type value ("text/plain; charset=windows-1251"), if any. */
export function charsetOfContentType(contentType: string | undefined): string | undefined {
  const m = contentType ? /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType) : null;
  return m?.[1];
}

/** charset parameter of a part's Content-Type header, if any. */
function charsetOf(part: GmailPart): string | undefined {
  return charsetOfContentType(headerValue(part.headers, 'Content-Type'));
}

/** Decodes bytes with the given charset label, falling back to UTF-8 when the label is unknown. */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  return textDecoder(charset || 'utf-8').decode(bytes);
}

function textDecoder(label: string) {
  try {
    return new TextDecoder(label);
  } catch {
    // Unknown or unsupported charset label (RangeError): UTF-8 is the best guess.
    return new TextDecoder('utf-8');
  }
}

/** Text of a leaf part, honouring the part's declared charset. */
export function decodePartText(part: GmailPart): string {
  const data = part.body?.data;
  return data ? decodeBytes(decodeBase64Url(data), charsetOf(part)) : '';
}

/** part_id of a message that is nothing but one attachment: Gmail gives its top-level part the empty id. */
export const WHOLE_MESSAGE_PART = 'root';

export interface ExtractedAttachment {
  /** Position of the part in the MIME tree ("1", "2.1", or WHOLE_MESSAGE_PART): unlike attachmentId it is the same on every fetch. */
  partId?: string;
  /** Missing only for tiny inline parts whose bytes Gmail embedded directly (then `data` is set). Changes from one fetch to the next. */
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  /** True for parts without a filename (inline images and the like); the name is generated. */
  inline: boolean;
  /**
   * True for images shown inside the HTML body (logos, social icons, signature
   * pictures, photos pasted into the text) rather than attached: referenced by
   * Content-ID or unnamed, and not marked Content-Disposition: attachment.
   */
  embedded: boolean;
  /** base64url bytes when Gmail embedded them in the payload instead of giving an attachmentId. */
  data?: string;
  /** charset declared on the part's Content-Type (text attachments are not always UTF-8). */
  charset?: string;
  /** Set when the part has child parts (an attached email Gmail shows part by part) instead of its own bytes. */
  nested?: true;
}

export interface ExtractedBody {
  /** All text/plain parts joined with blank lines. */
  text: string;
  /** All text/html parts joined. */
  html: string;
  attachments: ExtractedAttachment[];
}

/**
 * Walks a message payload (single part or arbitrarily nested multipart/mixed,
 * alternative, related) and separates body text from attachments.
 */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  const acc = { text: [] as string[], html: [] as string[], attachments: [] as ExtractedAttachment[] };
  if (payload) walkPart(payload, acc);
  return { text: acc.text.join('\n\n'), html: acc.html.join('\n'), attachments: acc.attachments };
}

function walkPart(part: GmailPart, acc: { text: string[]; html: string[]; attachments: ExtractedAttachment[] }): void {
  const mime = (part.mimeType ?? '').toLowerCase();
  const disposition = headerValue(part.headers, 'Content-Disposition') ?? '';
  const embedded = isEmbeddedImage(part, mime, disposition);
  if (part.filename || /^attachment/i.test(disposition)) {
    acc.attachments.push(toAttachment(part, !part.filename, embedded));
    return;
  }
  if (part.parts?.length) {
    for (const child of part.parts) walkPart(child, acc);
    return;
  }
  if (mime === 'text/plain' && part.body?.data) acc.text.push(decodePartText(part));
  else if (mime === 'text/html' && part.body?.data) acc.html.push(decodePartText(part));
  else if (part.body?.attachmentId || part.body?.data) {
    // Inline content without a filename: usually an embedded image, sometimes an
    // Outlook meeting invitation (text/calendar), which must stay visible.
    acc.attachments.push(toAttachment(part, true, embedded));
  }
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/html': 'html',
  'message/rfc822': 'eml',
};

function isEmbeddedImage(part: GmailPart, mime: string, disposition: string): boolean {
  if (!mime.startsWith('image/') || /^attachment/i.test(disposition)) return false;
  return Boolean(headerValue(part.headers, 'Content-ID')) || !part.filename;
}

function toAttachment(part: GmailPart, inline: boolean, embedded: boolean): ExtractedAttachment {
  const mimeType = (part.mimeType || 'application/octet-stream').toLowerCase();
  const extension = EXTENSION_BY_MIME[mimeType] ?? ((mimeType.split('/')[1] ?? '').replace(/[^a-z0-9]+/g, '') || 'bin');
  const generated = `inline-${part.partId ?? '0'}.${extension}`;
  return {
    partId: part.partId === '' ? WHOLE_MESSAGE_PART : part.partId,
    attachmentId: part.body?.attachmentId,
    filename: part.filename || generated,
    mimeType,
    size: part.body?.size ?? 0,
    inline,
    embedded,
    data: part.body?.attachmentId ? undefined : part.body?.data,
    charset: charsetOf(part),
    ...(part.parts?.length ? { nested: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

/** Marks a paragraph break; resolved to a blank line once whitespace is normalised. */
const PARA = '\u0001';
const BLOCK_TAGS = 'p|div|li|tr|h[1-6]|blockquote|table|ul|ol|pre|section|article|header|footer|dl|dd|dt|address|figure|figcaption';
const PARAGRAPH_TAGS = 'p|h[1-6]|blockquote|table|ul|ol|pre';
const LINK_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

/** Converts HTML to compact plain text: block structure becomes newlines, links keep their target when it adds information. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Line breaks in HTML source are just whitespace; only tags create structure.
    .replace(/[\r\n\t]+/g, ' ')
    .replace(LINK_RE, (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => linkToText(dq ?? sq ?? bare ?? '', inner))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, `${PARA}---${PARA}`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(new RegExp(`</(${PARAGRAPH_TAGS})\\s*>`, 'gi'), PARA)
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return collapseWhitespace(decodeEntities(text));
}

function linkToText(href: string, inner: string): string {
  const url = decodeEntities(href).trim();
  const label = collapseWhitespace(decodeEntities(inner.replace(/<[^>]+>/g, '')));
  if (!label || !url || /^(#|javascript:)/i.test(url) || sameTarget(label, url)) return inner;
  return `${inner} (${url})`;
}

function sameTarget(label: string, url: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^(https?:\/\/|mailto:)/, '').replace(/^www\./, '').replace(/\/+$/, '');
  return norm(label) === norm(url);
}

function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *([\n\u0001]) */g, '$1')
    .replace(/[\n\u0001]+/g, (run) => (run.includes(PARA) ? '\n\n' : '\n'))
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢', middot: '·', bull: '•', deg: '°', times: '×',
  shy: '', zwnj: '', zwj: '',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä',
  ccedil: 'ç', ntilde: 'ñ', iacute: 'í', icirc: 'î', iuml: 'ï', oacute: 'ó', ocirc: 'ô', ouml: 'ö',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', szlig: 'ß', oslash: 'ø', aring: 'å', aelig: 'æ',
};

/** Decodes named (common subset) and numeric HTML entities. Gmail snippets are entity-encoded too. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const cp = hex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Quoted-reply stripping
// ---------------------------------------------------------------------------

const QUOTED_LINE = /^\s*>/;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;

/**
 * Removes quoted text from a plain-text body: lines starting with ">", the
 * trailing "On <date>, <name> wrote:" attribution (which Gmail may wrap onto two
 * lines) and everything from an Outlook "-----Original Message-----" marker on.
 */
export function stripQuotedText(text: string): string {
  let lines = text.split(/\r?\n/);
  const marker = lines.findIndex((l) => ORIGINAL_MESSAGE.test(l));
  if (marker >= 0) lines = lines.slice(0, marker);
  lines = lines.slice(0, attributionStart(lines));
  return lines
    .filter((l) => !QUOTED_LINE.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Verb of an attribution line, as the common mail clients localise it:
 * "wrote:", "a écrit :", "написал(а):"/"написала:"/"пишет:", "schrieb Ann:",
 * "escribió:", "ha scritto:". German puts the name after the verb, so the verb
 * is looked for anywhere in the line and only the trailing colon is anchored.
 * No trailing \b after accented letters: JS word boundaries are ASCII-only.
 */
const ATTRIBUTION_VERB = /\bwrote\b|\ba écrit|написал|пишет|\bschrieb\b|\bescribió|\bha scritto\b/i;
/** How attribution lines begin: "On ...", "Le ...", "Am ...", "El ...", "Il ...", or a date (digits, Russian weekday). */
const ATTRIBUTION_LEAD = /^\s*(?:On|Le|Am|El|Il)\b|^\s*[\d\u0400-\u04ff]/i;

function isAttributionLine(line: string): boolean {
  return /:\s*$/.test(line) && ATTRIBUTION_VERB.test(line);
}

/** Index where a trailing attribution line starts (only when nothing but quoted or blank lines follow it), else lines.length. */
function attributionStart(lines: string[]): number {
  let i = lines.length - 1;
  while (i >= 0 && (lines[i]!.trim() === '' || QUOTED_LINE.test(lines[i]!))) i--;
  if (i < 0 || !isAttributionLine(lines[i]!)) return lines.length;
  if (ATTRIBUTION_LEAD.test(lines[i]!)) return i;
  // Gmail wraps long attributions onto two lines: "On <date>, <name> <addr>" / "wrote:".
  if (i > 0 && ATTRIBUTION_LEAD.test(lines[i - 1]!)) return i - 1;
  return lines.length;
}

/** Removes the quoted part of an HTML body before conversion: Gmail's gmail_quote block, blockquotes, Outlook's reply header. */
export function stripQuotedHtml(html: string): string {
  return removeBlockquotes(
    html.replace(/<div[^>]*class=["'][^"']*\bgmail_quote\b[^"']*["'][\s\S]*$/i, '').replace(/<div[^>]*id=["']divRplyFwdMsg["'][\s\S]*$/i, ''),
  );
}

/**
 * Removes every <blockquote> element with its content, tracking nesting so
 * that text between two separate quotes (interleaved replies) survives. An
 * unclosed blockquote swallows the rest of the document.
 */
function removeBlockquotes(html: string): string {
  const tag = /<(\/?)blockquote\b[^>]*>/gi;
  let out = '';
  let depth = 0;
  let keepFrom = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m[1] !== '/') {
      if (depth === 0) out += html.slice(keepFrom, m.index);
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) keepFrom = m.index + m[0].length;
    }
  }
  return depth === 0 ? out + html.slice(keepFrom) : out;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export interface Address {
  name?: string;
  email: string;
}

/** Parses an address-list header ("Ann <a@x>, "Doe, John" <j@x>, c@x") leniently. */
export function parseAddresses(header: string | undefined): Address[] {
  const out: Address[] = [];
  for (const raw of splitAddressList(header ?? '')) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^(.*?)\s*<([^<>]*)>\s*$/.exec(s);
    if (!m) {
      out.push({ email: s });
      continue;
    }
    let name = m[1]!.trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    const email = m[2]!.trim();
    out.push(name ? { name, email } : { email });
  }
  return out;
}

/** Splits on commas that are outside quotes and angle brackets. */
function splitAddressList(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted && c === '\\') {
      current += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') depth++;
    else if (!quoted && c === '>') depth = Math.max(0, depth - 1);
    if (c === ',' && !quoted && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

const ATEXT_AND_SPACE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;

/** Formats a mailbox for a header: bare address, `Name <addr>`, quoted or RFC 2047-encoded name as needed. */
export function formatAddress(name: string | undefined, email: string): string {
  const addr = email.trim();
  const display = name?.replace(/[\r\n]+/g, ' ').trim();
  if (!display) return addr;
  if (!isPrintableAscii(display)) return `${encodeHeader(display)} <${addr}>`;
  if (ATEXT_AND_SPACE.test(display)) return `${display} <${addr}>`;
  return `"${display.replace(/["\\]/g, '\\$&')}" <${addr}>`;
}

export interface ReplyRecipients {
  to: Address[];
  cc: Address[];
}

/**
 * Who a reply goes to. Reply: the Reply-To address, else From (or the original
 * To when replying to a message the account itself sent). Reply-all adds the
 * original To and Cc recipients, minus the account's own address and duplicates.
 */
export function replyRecipients(
  original: { from?: string; replyTo?: string; to?: string; cc?: string },
  selfEmail: string,
  replyAll: boolean,
  /** Other addresses the account sends as (Gmail send-as aliases): also "self". */
  aliases: string[] = [],
): ReplyRecipients {
  const selves = new Set([selfEmail, ...aliases].map((a) => a.trim().toLowerCase()));
  const from = parseAddresses(original.from);
  const replyTo = parseAddresses(original.replyTo);
  const originalTo = parseAddresses(original.to);
  const fromIsSelf = from.length > 0 && from.every((a) => selves.has(a.email.toLowerCase()));
  const to = dedupe(replyTo.length ? replyTo : fromIsSelf ? originalTo : from);
  if (!replyAll) return { to, cc: [] };
  const seen = new Set([...selves, ...to.map((a) => a.email.toLowerCase())]);
  const cc = [...originalTo, ...parseAddresses(original.cc)].filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { to, cc };
}

function dedupe(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/**
 * Header value safe for RFC 5322: printable ASCII passes through, anything else
 * becomes RFC 2047 "B" encoded-words of at most 75 characters (45 UTF-8 bytes
 * each), split on code-point boundaries and folded onto continuation lines.
 */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  if (isPrintableAscii(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (chunk && Buffer.byteLength(chunk + ch) > 45) {
      words.push(encodedWord(chunk));
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(encodedWord(chunk));
  return words.join(`${CRLF} `);
}

function encodedWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

// ---------------------------------------------------------------------------
// Building outgoing messages
// ---------------------------------------------------------------------------

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface MimeMessageInput {
  /** Already formatted mailboxes (see formatAddress). */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  /** Defaults to now; injectable for tests. */
  date?: Date;
  /** "<left@right>"; left out, Gmail gives a message it sends one of its own. */
  messageId?: string;
}

/** Builds a complete RFC 5322 message (CRLF line endings) ready to be base64url-encoded for messages.send. */
export function buildMimeMessage(msg: MimeMessageInput): string {
  const headers = [`Date: ${rfc5322Date(msg.date ?? new Date())}`, `From: ${msg.from}`, addressHeader('To', msg.to)];
  if (msg.cc?.length) headers.push(addressHeader('Cc', msg.cc));
  // Gmail strips the Bcc header before delivery but uses it to pick recipients.
  if (msg.bcc?.length) headers.push(addressHeader('Bcc', msg.bcc));
  if (msg.replyTo) headers.push(`Reply-To: ${msg.replyTo}`);
  headers.push(`Subject: ${encodeHeader(msg.subject)}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references) headers.push(`References: ${msg.references.trim().split(/\s+/).join(`${CRLF} `)}`);
  if (msg.messageId !== undefined) {
    if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(msg.messageId)) throw new Error('Invalid Message-ID');
    headers.push(`Message-ID: ${msg.messageId}`);
  }
  headers.push('MIME-Version: 1.0');

  const boundary = `=_${randomBytes(12).toString('hex')}`;
  let content = msg.html ? multipart('alternative', `${boundary}_alt`, [textPart('text/plain', msg.text), textPart('text/html', msg.html)]) : textPart('text/plain', msg.text);
  if (msg.attachments?.length) {
    content = multipart('mixed', `${boundary}_mix`, [content, ...msg.attachments.map(attachmentPart)]);
  }
  return headers.join(CRLF) + CRLF + content;
}

/** The message text as one MIME entity (header fields, blank line, body): text/plain, or multipart/alternative with an HTML version. */
export function bodyEntityText(text: string, html?: string): string {
  return html ? multipart('alternative', `=_${randomBytes(12).toString('hex')}_alt`, [textPart('text/plain', text), textPart('text/html', html)]) : textPart('text/plain', text);
}

/** One attachment as a MIME entity (header fields, blank line, base64 body). */
export function attachmentEntityText(a: MimeAttachment): string {
  return attachmentPart(a);
}

/** The value of an address header ("a@x, Ann <b@y>"), folded like addressHeader folds it. */
export function addressHeaderValue(name: string, mailboxes: string[]): string {
  return addressHeader(name, mailboxes).slice(name.length + 2);
}

export function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

/** Preferred line length for folded headers (RFC 5322 2.1.1; 998 is the hard limit). */
const FOLD_AT = 78;

/**
 * Address-list header folded at the commas between mailboxes so no line
 * exceeds FOLD_AT (a single mailbox longer than that stays on its own line).
 * Mailboxes may already contain folds from encodeHeader.
 */
export function addressHeader(name: string, mailboxes: string[]): string {
  let out = `${name}:`;
  let lineLength = out.length;
  mailboxes.forEach((mailbox, i) => {
    if (i > 0) {
      out += ',';
      lineLength++;
    }
    const firstLine = mailbox.split(CRLF)[0]!.length;
    if (i > 0 && lineLength + 1 + firstLine > FOLD_AT) {
      out += `${CRLF} `;
      lineLength = 1;
    } else {
      out += ' ';
      lineLength++;
    }
    out += mailbox;
    const lastFold = mailbox.lastIndexOf(CRLF);
    lineLength = lastFold >= 0 ? mailbox.length - lastFold - CRLF.length : lineLength + mailbox.length;
  });
  return out;
}

/** Base64 with the 76-character lines MIME requires. */
function base64Lines(data: Buffer | string): string {
  const b64 = Buffer.from(data).toString('base64');
  return b64.match(/.{1,76}/g)?.join(CRLF) ?? '';
}

function textPart(mimeType: 'text/plain' | 'text/html', text: string): string {
  // Text must be in canonical form (CRLF line breaks) before base64 encoding (RFC 2045 6.8, RFC 2049 4).
  const canonical = text.replace(/\r\n|\r|\n/g, CRLF);
  return [`Content-Type: ${mimeType}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(canonical)].join(CRLF);
}

function attachmentPart(a: MimeAttachment): string {
  return [
    `Content-Type: ${a.mimeType || 'application/octet-stream'}${filenameParams('name', a.filename)}`,
    `Content-Disposition: attachment${filenameParams('filename', a.filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(a.content),
  ].join(CRLF);
}

/**
 * `; name="ascii"` for an ASCII filename; otherwise an ASCII fallback plus the
 * RFC 2231 form `; name*=UTF-8''percent-encoded` (RFC 2047 encoded-words are
 * not allowed inside MIME parameters, RFC 2047 5).
 */
export function filenameParams(attribute: string, filename: string): string {
  const clean = filename.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || 'attachment';
  const quoted = `; ${attribute}="${clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '\\$&')}"`;
  if (isPrintableAscii(clean)) return quoted;
  return `${quoted}; ${attribute}*=UTF-8''${rfc2231Encode(clean)}`;
}

/** Percent-encodes everything outside RFC 2231 attribute-char (ASCII minus space, controls, *'% and tspecials). */
function rfc2231Encode(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9!#$&+\-.^_`|~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function multipart(subtype: 'alternative' | 'mixed', boundary: string, parts: string[]): string {
  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF);
  return `Content-Type: multipart/${subtype}; boundary="${boundary}"${CRLF}${CRLF}${body}${CRLF}--${boundary}--${CRLF}`;
}
