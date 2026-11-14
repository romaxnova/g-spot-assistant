/**
 * Byte-exact editing of raw RFC 5322 messages, for gmail_update_draft.
 *
 * Updating a draft means fetching it as format=raw, changing what Claude was
 * asked to change (recipients, subject, text, attachments) and uploading the
 * result with drafts.update. Rebuilding the message from Gmail's parsed payload
 * would lose everything the connector does not model: HTML formatting, images
 * pasted into the text (multipart/related parts referenced by Content-ID), other
 * attachments, threading headers, the From alias, unknown headers, folding. So
 * the message is parsed into a tree that keeps every header line and every body
 * byte as it was, edits replace only the entities they change, and
 * serialization writes everything else back byte for byte.
 *
 * Messages are handled as 'latin1' strings (one character per byte), so 8-bit
 * bodies and raw UTF-8 headers survive untouched. Decoding bodies and building
 * new parts is not done here (see gmail-mime.ts); new parts arrive as text.
 */
import { randomBytes } from 'node:crypto';
import { decodeBytes } from './gmail-mime.js';

const CRLF = '\r\n';

/**
 * Deepest entity the parser creates (the message is depth 0). A multipart at
 * this depth stays an unparsed leaf, which still round-trips; the limit only
 * bounds recursion on hostile input.
 */
const MAX_DEPTH = 40;

/** An edit that cannot be made. Messages are shown to Claude and the user, so they say what is wrong in their terms. */
export class MimeEditError extends Error {
  override name = 'MimeEditError';
}

export interface MimeEntity {
  /** Header fields in order, each exactly as in the source including folded continuation lines (joined with CRLF), without the terminating CRLF. */
  headers: string[];
  /** Base MIME type, lower-cased, e.g. 'multipart/mixed', 'text/plain'. Absent or unparsable Content-Type means 'text/plain'. */
  type: string;
  /** Gmail-compatible part id: '' for the message itself; '0', '1', ... for the parts of the top-level multipart; '1.0', '1.1', ... below. */
  partId: string;
  /** Leaf entities (anything that is not a parsed multipart; message/rfc822 is a leaf): the raw body exactly as in the source. */
  body?: string;
  /** Multipart entities only. */
  boundary?: string;
  preamble?: string;
  parts?: MimeEntity[];
  epilogue?: string;
}

export interface AttachmentInfo {
  partId: string;
  /** Decoded file name (RFC 2231, RFC 2047, quoted strings); absent when the part has none. */
  filename?: string;
  /** Lower-cased MIME type. */
  type: string;
  /** Decoded size in bytes for base64 parts, raw size otherwise. */
  size: number;
  /** Shown inside the text rather than attached: Content-Disposition: inline, or no disposition on a part inside multipart/related or with a Content-ID (which exists to be referenced from the text, RFC 2392). */
  inline: boolean;
}

// ---------------------------------------------------------------------------
// Layout the entity fields do not carry
// ---------------------------------------------------------------------------

/**
 * Details a byte-exact round trip needs but callers never edit. They live in a
 * side table rather than on MimeEntity so the public shape stays small; an
 * entity built elsewhere simply gets the canonical layout.
 */
interface Layout {
  /** Spaces/tabs after the delimiter line that opens this part (RFC 2046 transport padding). */
  padding?: string;
  /** Spaces/tabs after this multipart's close delimiter. */
  closePadding?: string;
  /** Header/body separator of an entity that had no empty line ('' or CRLF). Only used while its body stays empty. */
  separator?: string;
  /** Empty part squeezed between two delimiter lines ("--b" CRLF "--b"): one CRLF ends the first line and starts the next delimiter. */
  squeezed?: boolean;
}

const layouts = new WeakMap<MimeEntity, Layout>();

function clearLayout(entity: MimeEntity, key: keyof Layout): void {
  const layout = layouts.get(entity);
  if (layout) delete layout[key];
}

function layoutOf(entity: MimeEntity): Layout {
  let layout = layouts.get(entity);
  if (!layout) {
    layout = {};
    layouts.set(entity, layout);
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parses a raw message (Gmail format=raw bytes) into a tree that serializeMessage writes back unchanged. Never throws: whatever does not parse stays a raw leaf. */
export function parseMessage(raw: Buffer): MimeEntity {
  return parseText(normalizeLineBreaks(raw.toString('latin1')), '', 0);
}

/** Parses one MIME entity given as text ("headers CRLF CRLF body"), e.g. a new attachment part built elsewhere. Part ids are assigned by the edit functions. */
export function parseEntity(text: string): MimeEntity {
  // Serialization writes one byte per character; anything wider would be silently truncated.
  if (/[^\x00-\xff]/.test(text)) throw new MimeEditError('A new MIME part contains characters that are not encoded (use base64 or RFC 2047).');
  return parseText(normalizeLineBreaks(text), '', 0);
}

/** Bare LF and bare CR become CRLF, the only line break MIME structure is defined with. The common all-CRLF case is not copied. */
function normalizeLineBreaks(text: string): string {
  return /\r(?!\n)|(?<!\r)\n/.test(text) ? text.replace(/\r\n|\r|\n/g, CRLF) : text;
}

function parseText(text: string, partId: string, depth: number): MimeEntity {
  let head: string;
  let body: string;
  let separator: string | undefined;
  if (text.startsWith(CRLF)) {
    head = '';
    body = text.slice(CRLF.length);
  } else {
    const end = text.indexOf(CRLF + CRLF);
    if (end >= 0) {
      head = text.slice(0, end);
      body = text.slice(end + 2 * CRLF.length);
    } else {
      // No empty line: everything is header (a part without body, or a truncated message).
      separator = text.endsWith(CRLF) ? CRLF : '';
      head = text.slice(0, text.length - separator.length);
      body = '';
    }
  }
  // A CRLF followed by a space or tab is a fold inside a field, any other CRLF ends one.
  const headers = head === '' ? [] : head.split(/\r\n(?![ \t])/);
  const { type, params } = contentTypeOf(headers);
  const entity: MimeEntity = { headers, type, partId };
  const boundary = type.startsWith('multipart/') && depth < MAX_DEPTH ? boundaryParam(params) : undefined;
  const multipart = boundary === undefined ? undefined : splitMultipart(body, boundary);
  if (!multipart) {
    entity.body = body;
    if (separator !== undefined) layoutOf(entity).separator = separator;
    return entity;
  }
  entity.boundary = boundary;
  if (multipart.preamble !== undefined) entity.preamble = multipart.preamble;
  entity.parts = multipart.parts.map((part, i) => {
    const child = parseText(part.text, childId(partId, i), depth + 1);
    if (part.padding) layoutOf(child).padding = part.padding;
    if (part.squeezed) layoutOf(child).squeezed = true;
    return child;
  });
  if (multipart.epilogue !== undefined) entity.epilogue = multipart.epilogue;
  if (multipart.closePadding) layoutOf(entity).closePadding = multipart.closePadding;
  return entity;
}

function childId(parentId: string, index: number): string {
  return parentId === '' ? String(index) : `${parentId}.${index}`;
}

interface Delimiter {
  /** Index of the leading "--". */
  start: number;
  /** Index of the CRLF ending the delimiter line, or the end of the body. */
  lineEnd: number;
  close: boolean;
  padding: string;
}

interface SplitMultipart {
  preamble?: string;
  parts: { text: string; padding: string; squeezed?: boolean }[];
  closePadding?: string;
  epilogue?: string;
}

/**
 * Splits a multipart body on its delimiter lines (RFC 2046 5.1.1): the CRLF
 * before a delimiter belongs to the delimiter, not to the part or preamble in
 * front of it. Undefined when there is no opening delimiter line, so the
 * caller keeps the entity as a leaf. A missing close delimiter is tolerated:
 * the last part runs to the end, and a CRLF ending it is taken as the start of
 * the close delimiter that serialization then writes.
 */
function splitMultipart(body: string, boundary: string): SplitMultipart | undefined {
  const dash = `--${boundary}`;
  const delimiters: Delimiter[] = [];
  for (let from = 0; ; ) {
    const delimiter = nextDelimiter(body, dash, from);
    if (!delimiter) break;
    from = delimiter.lineEnd;
    // A close delimiter before any part is just preamble text.
    if (delimiter.close && delimiters.length === 0) continue;
    delimiters.push(delimiter);
    if (delimiter.close) break;
  }
  const first = delimiters[0];
  if (!first) return undefined;
  const result: SplitMultipart = { parts: [] };
  if (first.start > 0) result.preamble = body.slice(0, first.start - CRLF.length);
  for (let i = 0; i < delimiters.length; i++) {
    const delimiter = delimiters[i]!;
    if (delimiter.close) break;
    const start = Math.min(delimiter.lineEnd + CRLF.length, body.length);
    const next = delimiters[i + 1];
    if (next) {
      const end = next.start - CRLF.length;
      // "--b CRLF --b" (malformed) leaves no room for a part, not even an empty one.
      if (end < start) result.parts.push({ text: '', padding: delimiter.padding, squeezed: true });
      else result.parts.push({ text: body.slice(start, end), padding: delimiter.padding });
      continue;
    }
    let text = body.slice(start);
    if (text.endsWith(CRLF)) {
      text = text.slice(0, -CRLF.length);
      result.epilogue = '';
    }
    result.parts.push({ text, padding: delimiter.padding });
  }
  const last = delimiters[delimiters.length - 1]!;
  if (last.close) {
    result.closePadding = last.padding;
    if (last.lineEnd < body.length) result.epilogue = body.slice(last.lineEnd + CRLF.length);
  }
  return result;
}

/** Next line from `from` on that is "--boundary" or "--boundary--", each optionally followed by spaces/tabs. */
function nextDelimiter(body: string, dash: string, from: number): Delimiter | undefined {
  for (let at = body.indexOf(dash, from); at >= 0; at = body.indexOf(dash, at + 1)) {
    if (at > 0 && !(body[at - 1] === '\n' && body[at - 2] === '\r')) continue;
    const found = body.indexOf(CRLF, at + dash.length);
    const lineEnd = found < 0 ? body.length : found;
    const m = /^(--)?([ \t]*)$/.exec(body.slice(at + dash.length, lineEnd));
    if (m) return { start: at, lineEnd, close: m[1] !== undefined, padding: m[2]! };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Header fields
// ---------------------------------------------------------------------------

/** RFC 5322 field-name: printable ASCII except colon. */
const FIELD_NAME = /^[!-9;-~]+$/;

/** Lower-cased name of a header field, or undefined for a malformed line (no colon, spaces in the name, an mbox "From " line). */
function fieldName(field: string): string | undefined {
  const colon = field.indexOf(':');
  if (colon <= 0) return undefined;
  // "Name : value" is obsolete syntax (RFC 5322 4.5) but still seen.
  const name = field.slice(0, colon).replace(/[ \t]+$/, '');
  return FIELD_NAME.test(name) ? name.toLowerCase() : undefined;
}

/**
 * Trims spaces and tabs only. String.prototype.trim would also strip U+00A0,
 * which in these byte strings is 0xA0, a continuation byte of raw UTF-8.
 */
function trimWsp(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Unfolded values of a header (case-insensitive name), in order; RFC 2047 encoded-words are left as they are. */
export function headerValues(entity: MimeEntity, name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (const field of entity.headers) if (fieldName(field) === wanted) values.push(fieldValue(field));
  return values;
}

/** Unfolded value of a well-formed field: folds are removed (RFC 5322 2.2.3), not replaced by a space. */
function fieldValue(field: string): string {
  return trimWsp(field.slice(field.indexOf(':') + 1).replace(/\r\n(?=[ \t])/g, ''));
}

/**
 * Replaces every field with this name by one new field "Name: value" (value is
 * ASCII, already encoded, possibly already folded with CRLF+WSP) at the position
 * of the first occurrence; appends it at the end of the header block when
 * absent; removes all occurrences when value is undefined.
 */
export function setHeader(entity: MimeEntity, name: string, value: string | undefined): void {
  if (!FIELD_NAME.test(name)) throw new MimeEditError(`"${name}" is not a valid header name.`);
  // Any other line break would end the field and start a new one (header injection) or the body.
  if (value !== undefined && (!/^(?:[\t\x20-\x7e]|\r\n[ \t])*$/.test(value) || /\r\n[ \t]*(?:\r\n|$)/.test(value))) {
    throw new MimeEditError(`Invalid value for the ${name} header: it must be encoded ASCII, with line breaks only as folds (CRLF and a space).`);
  }
  replaceField(entity, name, value === undefined ? undefined : `${name}: ${value}`);
}

/** setHeader without the checks, for fields rebuilt from the message's own (possibly 8-bit) values. */
function replaceField(entity: MimeEntity, name: string, field: string | undefined): void {
  const wanted = name.toLowerCase();
  const first = entity.headers.findIndex((h) => fieldName(h) === wanted);
  // Fields before the first match all stay, so its index is the same after filtering.
  const kept = entity.headers.filter((h) => fieldName(h) !== wanted);
  if (field !== undefined) kept.splice(first < 0 ? kept.length : first, 0, field);
  entity.headers.splice(0, entity.headers.length, ...kept);
  if (wanted === 'content-type') entity.type = contentTypeOf(entity.headers).type;
  // The entity is edited, so it gets the canonical header/body separator.
  clearLayout(entity, 'separator');
}

function isContentField(field: string): boolean {
  return fieldName(field)?.startsWith('content-') ?? false;
}

/** Replaces all Content-* fields by `fields`, placed where the first old one was (else at the end); other fields keep their order. */
function setContentFields(entity: MimeEntity, fields: string[]): void {
  const first = entity.headers.findIndex(isContentField);
  const kept = entity.headers.filter((h) => !isContentField(h));
  kept.splice(first < 0 ? kept.length : first, 0, ...fields);
  entity.headers.splice(0, entity.headers.length, ...kept);
}

// ---------------------------------------------------------------------------
// Structured fields (Content-Type, Content-Disposition) and their parameters
// ---------------------------------------------------------------------------

interface StructuredField {
  /** Main value ("text/plain", "attachment"), trimmed. */
  value: string;
  /** Parameters by lower-cased name (first occurrence wins), quoted strings unquoted. */
  params: Map<string, string>;
}

/**
 * Splits a structured field value on the semicolons outside quoted strings
 * and comments. Comments are replaced by a space unless keepComments is set
 * (for rebuilding a field without losing anything).
 */
function splitSegments(value: string, keepComments = false): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; ) {
    const c = value[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < value.length && value[j] !== '"') j += value[j] === '\\' ? 2 : 1;
      current += value.slice(i, j + 1);
      i = j + 1;
    } else if (c === '(') {
      // Comments nest and may contain quoted pairs (RFC 5322 3.2.2).
      let depth = 0;
      let j = i;
      for (; j < value.length; j++) {
        if (value[j] === '\\') j++;
        else if (value[j] === '(') depth++;
        else if (value[j] === ')' && --depth === 0) break;
      }
      current += keepComments ? value.slice(i, j + 1) : ' ';
      i = j + 1;
    } else if (c === ';') {
      segments.push(current);
      current = '';
      i++;
    } else {
      current += c;
      i++;
    }
  }
  segments.push(current);
  return segments;
}

function parseStructured(value: string): StructuredField {
  const [main = '', ...rest] = splitSegments(value);
  const params = new Map<string, string>();
  for (const segment of rest) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const name = trimWsp(segment.slice(0, eq)).toLowerCase();
    if (name && !params.has(name)) params.set(name, unquote(trimWsp(segment.slice(eq + 1))));
  }
  return { value: trimWsp(main), params };
}

/** Content of a quoted string with its escapes resolved; anything else as it is (lenient: unquoted values may contain '=' and the like). */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  let out = '';
  for (let i = 1; i < value.length; i++) {
    const c = value[i]!;
    if (c === '"') break;
    out += c === '\\' && i + 1 < value.length ? value[++i]! : c;
  }
  return out;
}

const MIME_TYPE = /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+$/;

function contentTypeOf(headers: string[]): { type: string; params: Map<string, string> } {
  const field = headers.find((h) => fieldName(h) === 'content-type');
  if (field === undefined) return { type: 'text/plain', params: new Map() };
  const { value, params } = parseStructured(fieldValue(field));
  const type = value.replace(/[ \t]*\/[ \t]*/, '/').toLowerCase();
  // RFC 2045 5.2: an unparsable Content-Type means the default. Parameters stay readable (a name= on a broken type is still a name).
  return { type: MIME_TYPE.test(type) ? type : 'text/plain', params };
}

function dispositionOf(entity: MimeEntity): StructuredField {
  const value = headerValues(entity, 'Content-Disposition')[0];
  if (value === undefined) return { value: '', params: new Map() };
  const parsed = parseStructured(value);
  return { value: parsed.value.toLowerCase(), params: parsed.params };
}

interface RawParam {
  /** Byte string (latin1): percent-decoding and continuations resolved, charset not yet applied. */
  value: string;
  /** True for RFC 2231 values (name*=, name*0*=), whose bytes are in `charset` rather than RFC 2047 text. */
  extended: boolean;
  charset?: string;
}

/**
 * A parameter with RFC 2231 applied: the extended form (name*=charset'lang'%xx)
 * and continuations (name*0*=, name*1=, ...) take precedence over a plain
 * name=, which mailers add as an ASCII fallback.
 */
function rawParam(params: Map<string, string>, name: string): RawParam | undefined {
  const extended = params.get(`${name}*`);
  if (extended !== undefined) return { ...extendedValue(extended), extended: true };
  if (params.has(`${name}*0`) || params.has(`${name}*0*`)) {
    let value = '';
    let charset: string | undefined;
    for (let i = 0; ; i++) {
      const encoded = params.get(`${name}*${i}*`);
      const plain = params.get(`${name}*${i}`);
      if (encoded !== undefined) {
        // Only the first section carries charset'language'.
        if (i === 0) {
          const first = extendedValue(encoded);
          value += first.value;
          charset = first.charset;
        } else value += percentDecode(encoded);
      } else if (plain !== undefined) value += plain;
      else break;
    }
    return { value, extended: true, charset };
  }
  const plain = params.get(name);
  return plain === undefined ? undefined : { value: plain, extended: false };
}

function extendedValue(value: string): { value: string; charset?: string } {
  const m = /^([^']*)'[^']*'([\s\S]*)$/.exec(value);
  if (!m) return { value: percentDecode(value) };
  return m[1] ? { value: percentDecode(m[2]!), charset: m[1] } : { value: percentDecode(m[2]!) };
}

function percentDecode(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function boundaryParam(params: Map<string, string>): string | undefined {
  // Boundaries are ASCII; the byte string is exactly what appears in the body.
  const boundary = rawParam(params, 'boundary')?.value;
  return boundary ? boundary : undefined;
}

/** Text of a plain parameter or header value: raw UTF-8 bytes (RFC 6532) decoded when valid, then RFC 2047 encoded-words. */
function decodeHeaderText(value: string): string {
  let text = value;
  if (/[\x80-\xff]/.test(text)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'latin1'));
    } catch {
      // Not UTF-8: most likely ISO-8859-1, which latin1 already is.
    }
  }
  return decodeEncodedWords(text);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/**
 * Decodes RFC 2047 encoded-words, also inside quoted parameter values where
 * mailers (Gmail and Outlook included) put them despite RFC 2047 5. Whitespace
 * between adjacent words is dropped (6.2), and adjacent words in one charset
 * are decoded together because some mailers split a character across two.
 */
function decodeEncodedWords(text: string): string {
  let out = '';
  let last = 0;
  let charset: string | undefined;
  let chunks: Buffer[] = [];
  const flush = () => {
    if (charset !== undefined) out += decodeBytes(Buffer.concat(chunks), charset);
    charset = undefined;
    chunks = [];
  };
  for (const m of text.matchAll(ENCODED_WORD)) {
    const between = text.slice(last, m.index);
    const adjacent = charset !== undefined && /^[ \t]*$/.test(between);
    // RFC 2231 5 allows a language after the charset: =?UTF-8*en?Q?...?=.
    const wordCharset = m[1]!.split('*')[0]!.toLowerCase();
    if (!adjacent || wordCharset !== charset) {
      flush();
      if (!adjacent) out += between;
      charset = wordCharset;
    }
    const data = m[3]!;
    const bytes = m[2]!.toUpperCase() === 'B' ? data : data.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_x, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    chunks.push(Buffer.from(bytes, m[2]!.toUpperCase() === 'B' ? 'base64' : 'latin1'));
    last = m.index + m[0].length;
  }
  flush();
  return out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Structure queries
// ---------------------------------------------------------------------------

function isMixed(entity: MimeEntity): entity is MimeEntity & { parts: MimeEntity[] } {
  return entity.type === 'multipart/mixed' && entity.parts !== undefined;
}

/** Decoded file name: Content-Disposition filename, else Content-Type name (the older convention). */
function filenameOf(entity: MimeEntity): string | undefined {
  for (const param of [rawParam(dispositionOf(entity).params, 'filename'), rawParam(contentTypeOf(entity.headers).params, 'name')]) {
    if (!param) continue;
    const name = param.extended ? decodeBytes(Buffer.from(param.value, 'latin1'), param.charset) : decodeHeaderText(param.value);
    if (name) return name;
  }
  return undefined;
}

/** An attachment: Content-Disposition: attachment, or a named part that is not a container. */
function isAttachment(entity: MimeEntity): boolean {
  if (dispositionOf(entity).value === 'attachment') return true;
  return !entity.type.startsWith('multipart/') && filenameOf(entity) !== undefined;
}

/**
 * The entity that holds the message text: the message itself unless it is
 * multipart/mixed; for multipart/mixed its first part that is not an
 * attachment; undefined when there is none.
 */
export function bodyEntity(message: MimeEntity): MimeEntity | undefined {
  if (!isMixed(message)) return message;
  return message.parts.find((part) => !isAttachment(part));
}

/**
 * Leaf entities that are attachments or inline files (not the text/plain or
 * text/html of the body), in document order. The message itself is listed
 * only when it is a file (a message that is nothing but one attachment).
 */
export function listAttachments(message: MimeEntity): AttachmentInfo[] {
  const found: AttachmentInfo[] = [];
  const visit = (entity: MimeEntity, parent: MimeEntity | undefined) => {
    if (entity.parts) {
      for (const part of entity.parts) visit(part, entity);
      return;
    }
    const disposition = dispositionOf(entity).value;
    const filename = filenameOf(entity);
    const file = disposition === 'attachment' || filename !== undefined;
    if (!file && (parent === undefined || entity.type === 'text/plain' || entity.type === 'text/html')) return;
    // Without a disposition, a part is shown in the text when the text can reference it: it sits in
    // multipart/related, or it has a Content-ID for a cid: URL (RFC 2392), as some mailers put in multipart/mixed.
    const referenced = parent !== undefined && (parent.type === 'multipart/related' || headerValues(entity, 'Content-ID').length > 0);
    found.push({
      partId: entity.partId,
      ...(filename !== undefined ? { filename } : {}),
      type: entity.type,
      size: decodedSize(entity),
      inline: disposition === 'inline' || (disposition === '' && referenced),
    });
  };
  visit(message, undefined);
  return found;
}

/** Decoded length of a base64 body, counted rather than decoded (attachments can be tens of MB); raw length for other encodings. */
function decodedSize(entity: MimeEntity): number {
  const body = entity.body ?? '';
  const encoding = headerValues(entity, 'Content-Transfer-Encoding')[0];
  if (encoding === undefined || parseStructured(encoding).value.toLowerCase() !== 'base64') return body.length;
  let chars = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 0x3d) break; // '=': padding ends the data, as in Buffer.from(body, 'base64')
    if (isBase64Char(c)) chars++;
  }
  return Math.floor((chars * 3) / 4);
}

/** A-Z a-z 0-9 + / and the URL-safe - _ that Node's decoder accepts too; line breaks and other bytes are skipped. */
function isBase64Char(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f || c === 0x2d || c === 0x5f;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Replaces the message text (and everything inside the body entity, e.g.
 * images pasted into it) with replacement. For a non-mixed message, the
 * message's own Content-* fields are replaced by the replacement's Content-*
 * fields, where the first old one was; every other header (From, To, Subject,
 * In-Reply-To, ...) stays in place. For multipart/mixed, the body part is
 * replaced in place, or the replacement is inserted as the first part when
 * there is no body part.
 */
export function replaceBody(message: MimeEntity, replacement: MimeEntity): void {
  if (isMixed(message)) {
    const current = bodyEntity(message);
    if (current) {
      message.parts[message.parts.indexOf(current)] = replacement;
      // The delimiter line in front of the slot is the parent's, not the old part's.
      const padding = layouts.get(current)?.padding;
      if (padding) layoutOf(replacement).padding = padding;
    } else {
      message.parts.unshift(replacement);
    }
    ensureBoundaryUnused(message, [replacement]);
  } else {
    setContentFields(message, replacement.headers.filter(isContentField));
    moveContent(replacement, message);
    clearLayout(message, 'separator');
  }
  renumber(message, '');
}

/**
 * Removes the parts with these ids and returns them, in the order asked for.
 * Throws MimeEditError (before changing anything) for an unknown id, for ''
 * (the message), for the body entity and for any part that contains it. A
 * multipart left with no parts is removed too; a message left with none
 * becomes an empty text/plain message.
 */
export function removeParts(message: MimeEntity, partIds: string[]): MimeEntity[] {
  const parents = new Map<MimeEntity, MimeEntity>();
  const byId = new Map<string, MimeEntity>();
  const index = (entity: MimeEntity, id: string) => {
    byId.set(id, entity);
    entity.parts?.forEach((part, i) => {
      parents.set(part, entity);
      index(part, childId(id, i));
    });
  };
  index(message, '');
  const body = bodyEntity(message);
  const targets: MimeEntity[] = [];
  for (const id of new Set(partIds)) {
    if (id === '') throw new MimeEditError('Part "" is the whole message and cannot be removed.');
    const target = byId.get(id);
    if (!target) throw new MimeEditError(`There is no part "${id}" in this message. Its parts are: ${[...byId.keys()].filter(Boolean).join(', ') || 'none'}.`);
    if (target === body) throw new MimeEditError(`Part "${id}" holds the message text and cannot be removed.`);
    if (body && contains(target, body)) throw new MimeEditError(`Part "${id}" contains the message text and cannot be removed.`);
    targets.push(target);
  }
  const removing = new Set(targets);
  for (const target of targets) {
    // A part inside another removed part leaves with it; detaching it would change what is returned.
    if (ancestors(target, parents).some((a) => removing.has(a))) continue;
    let child = target;
    let parent = parents.get(child);
    while (parent?.parts) {
      const at = parent.parts.indexOf(child);
      if (at < 0) break;
      parent.parts.splice(at, 1);
      if (parent.parts.length > 0 || parent === message) break;
      child = parent;
      parent = parents.get(child);
    }
  }
  if (message.parts?.length === 0) {
    // A multipart needs at least one part (RFC 2046 5.1.1), and the message itself cannot go.
    setContentFields(message, []);
    moveContent({ headers: [], type: 'text/plain', partId: '', body: '' }, message);
  }
  renumber(message, '');
  return targets;
}

/**
 * Appends parts as attachments. A message that is not multipart/mixed first
 * becomes one: a new first part carries its Content-* fields and its content,
 * and the message gets a multipart/mixed Content-Type with a fresh boundary
 * (plus MIME-Version: 1.0 if missing), where its first Content-* field was.
 * Every other header stays on the message, in place.
 */
export function addParts(message: MimeEntity, parts: MimeEntity[]): void {
  if (parts.length === 0) return;
  if (isMixed(message)) {
    message.parts.push(...parts);
    ensureBoundaryUnused(message, parts);
  } else {
    const first: MimeEntity = { headers: message.headers.filter(isContentField), type: message.type, partId: '0' };
    moveContent(message, first);
    const boundary = freshBoundary([first, ...parts].map(serializeEntity).join(''));
    const contentType = `Content-Type: multipart/mixed; boundary="${boundary}"`;
    setContentFields(message, headerValues(message, 'MIME-Version').length ? [contentType] : ['MIME-Version: 1.0', contentType]);
    moveContent({ headers: [], type: 'multipart/mixed', partId: '', boundary, parts: [first, ...parts], epilogue: '' }, message);
    clearLayout(message, 'separator');
  }
  renumber(message, '');
}

/** Moves the content (type, body or multipart structure, close padding) of one entity onto another; headers are not touched. */
function moveContent(from: MimeEntity, to: MimeEntity): void {
  to.type = from.type;
  delete to.body;
  delete to.boundary;
  delete to.preamble;
  delete to.parts;
  delete to.epilogue;
  if (from.body !== undefined) to.body = from.body;
  if (from.boundary !== undefined) to.boundary = from.boundary;
  if (from.preamble !== undefined) to.preamble = from.preamble;
  if (from.parts !== undefined) to.parts = from.parts;
  if (from.epilogue !== undefined) to.epilogue = from.epilogue;
  const closePadding = layouts.get(from)?.closePadding;
  if (closePadding) layoutOf(to).closePadding = closePadding;
  else clearLayout(to, 'closePadding');
}

/**
 * New parts must not contain a line that starts with the delimiter of the
 * multipart they go into (an attached copy of the same message would), or the
 * multipart would split in the wrong places. Then the multipart gets a fresh
 * boundary. Lines are matched by prefix because some parsers do that.
 */
function ensureBoundaryUnused(multipart: MimeEntity, added: MimeEntity[]): void {
  const dash = `--${multipart.boundary}`;
  const clash = added.some((part) => {
    const text = serializeEntity(part);
    return text.startsWith(dash) || text.includes(CRLF + dash);
  });
  if (!clash) return;
  const boundary = freshBoundary((multipart.parts ?? []).map(serializeEntity).join('') + (multipart.preamble ?? '') + (multipart.epilogue ?? ''));
  const value = headerValues(multipart, 'Content-Type')[0] ?? multipart.type;
  const [main = multipart.type, ...params] = splitSegments(value, true);
  const kept = params.map(trimWsp).filter((p) => p !== '' && !/^boundary(?:\*|[ \t]*=)/i.test(p));
  replaceField(multipart, 'Content-Type', `Content-Type: ${[trimWsp(main), ...kept, `boundary="${boundary}"`].join('; ')}`);
  multipart.boundary = boundary;
}

/** "=_" and 24 random hex digits that do not occur in the content they will delimit. */
function freshBoundary(content: string): string {
  for (;;) {
    const boundary = `=_${randomBytes(12).toString('hex')}`;
    if (!content.includes(boundary)) return boundary;
  }
}

function renumber(entity: MimeEntity, id: string): void {
  entity.partId = id;
  entity.parts?.forEach((part, i) => renumber(part, childId(id, i)));
}

function contains(ancestor: MimeEntity, entity: MimeEntity): boolean {
  return ancestor.parts?.some((part) => part === entity || contains(part, entity)) ?? false;
}

function ancestors(entity: MimeEntity, parents: Map<MimeEntity, MimeEntity>): MimeEntity[] {
  const found: MimeEntity[] = [];
  for (let p = parents.get(entity); p; p = parents.get(p)) found.push(p);
  return found;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** The message as bytes: untouched entities exactly as parsed, edited ones in canonical form. */
export function serializeMessage(message: MimeEntity): Buffer {
  return Buffer.from(serializeEntity(message), 'latin1');
}

function serializeEntity(entity: MimeEntity): string {
  const head = entity.headers.join(CRLF);
  const canonical = entity.headers.length > 0 ? CRLF + CRLF : CRLF;
  if (entity.parts) return head + canonical + multipartBody(entity, entity.parts);
  const body = entity.body ?? '';
  const separator = body === '' ? layouts.get(entity)?.separator : undefined;
  return head + (separator ?? canonical) + body;
}

function multipartBody(entity: MimeEntity, parts: MimeEntity[]): string {
  if (!entity.boundary) throw new MimeEditError(`Part "${entity.partId}" is a multipart without a boundary.`);
  const dash = `--${entity.boundary}`;
  const chunks: string[] = [];
  if (entity.preamble !== undefined) chunks.push(entity.preamble, CRLF);
  parts.forEach((part, i) => {
    if (i > 0) chunks.push(CRLF);
    const text = serializeEntity(part);
    chunks.push(dash, layouts.get(part)?.padding ?? '');
    // A squeezed part shares its line break with the next delimiter; once it has content it gets its own.
    if (text !== '' || !layouts.get(part)?.squeezed) chunks.push(CRLF, text);
  });
  // The CRLF in front of the close delimiter belongs to it; after the preamble it is already there.
  if (parts.length > 0) chunks.push(CRLF);
  chunks.push(dash, '--', layouts.get(entity)?.closePadding ?? '');
  if (entity.epilogue !== undefined) chunks.push(CRLF, entity.epilogue);
  return chunks.join('');
}
