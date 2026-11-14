/**
 * File sources for the tools that attach or upload files. A source is one of:
 * a Drive file (Google Docs/Sheets/Slides/Drawings are exported), an attachment
 * of a Gmail message, text written by Claude, or base64 bytes. Drive files and
 * Gmail messages may belong to another linked account (from_account), which is
 * how files move between accounts.
 *
 * Everything is held in memory, so each source is capped (see the callers'
 * maxBytes); nothing is written to disk and no content is logged.
 */
import { createHash } from 'node:crypto';
import * as z from 'zod';
import { GoogleApiError } from '../../google/client.js';
import { effectiveType, isTextType, textCharset } from '../extract/readable.js';
import { baseMime, mimeFromFilename, sniffMime, withExtension } from '../file-types.js';
import { ToolInputError, type ToolContext } from '../registry.js';
import { extractFileId, friendlyType, GOOGLE_MIME } from './drive-files.js';
import { decodeBase64Url, decodeBytes, extractBody, type ExtractedAttachment, type GmailPart } from './gmail-mime.js';

/* ---------- Export of Google-native files to real files ---------- */

export const FILE_EXPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'tsv', 'html', 'epub', 'png', 'jpg', 'svg'] as const;
export type FileExportFormat = (typeof FILE_EXPORT_FORMATS)[number];

export const EXPORT_MIME: Record<FileExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  epub: 'application/epub+zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
};

const DRAWING_MIME = 'application/vnd.google-apps.drawing';

/** Formats Google exports each native type to (files.export), PDF first. csv/tsv cover the first tab; png/jpg/svg the first slide. */
export const NATIVE_EXPORTS: Record<string, readonly FileExportFormat[]> = {
  [GOOGLE_MIME.document]: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'md', 'html', 'epub'],
  [GOOGLE_MIME.spreadsheet]: ['pdf', 'xlsx', 'ods', 'csv', 'tsv'],
  [GOOGLE_MIME.presentation]: ['pdf', 'pptx', 'odp', 'txt', 'png', 'jpg', 'svg'],
  [DRAWING_MIME]: ['pdf', 'png', 'jpg', 'svg'],
};

/** The editable Office format for each native type: what a copy into another account goes through. */
export const OFFICE_EXPORT: Record<string, FileExportFormat> = {
  [GOOGLE_MIME.document]: 'docx',
  [GOOGLE_MIME.spreadsheet]: 'xlsx',
  [GOOGLE_MIME.presentation]: 'pptx',
  [DRAWING_MIME]: 'png',
};

/* ---------- Parameters ---------- */

const sourceFields = {
  drive_file_id: z.string().min(1).optional().describe('Drive file id or URL. Google Docs/Sheets/Slides/Drawings are exported (see export_format).'),
  export_format: z
    .enum(FILE_EXPORT_FORMATS)
    .optional()
    .describe(
      'Export format for a Google Doc/Sheet/Slides/Drawing, suited to its type: pdf for all; docx, odt, rtf, txt, md, html, epub for Docs; xlsx, ods, csv, tsv for Sheets (csv/tsv: first tab); pptx, odp, txt, png, jpg, svg for Slides (images: first slide); png, jpg, svg for Drawings.',
    ),
  gmail_message_id: z.string().min(1).optional().describe('Gmail message whose attachment is used, with gmail_part_id.'),
  gmail_part_id: z.string().min(1).optional().describe('part_id of the attachment (from gmail_get_message).'),
  gmail_attachment_id: z.string().min(1).optional().describe('attachment_id instead of gmail_part_id (less reliable).'),
  from_account: z.string().min(1).optional().describe('Linked account that owns the Drive file or email, when it is not this one.'),
  upload_id: z.string().min(1).optional().describe('A staged file (from create_upload_link, list_uploads or upload_file); a link_id attaches every file uploaded through that link.'),
  sha256: z.string().optional().describe('Optional hex SHA-256 the file must have; the call fails if it does not (catches mistyped base64).'),
};

/** A file to attach to an email: an existing Drive file or Gmail attachment, or new content. */
export const attachmentSchema = z.object({
  ...sourceFields,
  content: z.string().optional().describe('Text of a new file (UTF-8), e.g. CSV, Markdown, HTML, ICS. Needs filename.'),
  content_base64: z.string().optional().describe('Bytes of a new file, base64-encoded. Needs filename.'),
  filename: z.string().min(1).max(255).optional().describe('File name with extension. Required with content/content_base64; otherwise renames the source.'),
  mime_type: z.string().min(1).optional().describe('MIME type, when neither the source nor the extension tells.'),
});

/** An existing file to copy: a Drive file (possibly of another account) or a Gmail attachment. */
export const copySourceSchema = z.object(sourceFields);

export type FileSpec = z.infer<typeof attachmentSchema>;

export const attachmentsParam = z
  .array(attachmentSchema)
  .max(10)
  .optional()
  .describe(
    'Files to attach (up to 10, 25 MB in total). Each is exactly one of: {drive_file_id} (Google Docs/Sheets/Slides are sent as PDF unless export_format says otherwise), {gmail_message_id, gmail_part_id} (an attachment of another email), {upload_id} (a file from this chat, e.g. a PDF the user uploaded: stage it first with create_upload_link, or upload_file for small files), {content, filename} (a text file you write, e.g. a CSV), or {content_base64, filename} (small files only). Add from_account when the Drive file or email belongs to another linked account.',
  );

/**
 * The same file forms without a description per field, for a second list in one tool that points back to
 * attachmentsParam's description: every tool description is sent in every chat, so repeating it costs context.
 */
export const compactAttachmentsParam = z
  .array(
    z.object({
      drive_file_id: z.string().min(1).optional(),
      export_format: z.enum(FILE_EXPORT_FORMATS).optional(),
      gmail_message_id: z.string().min(1).optional(),
      gmail_part_id: z.string().min(1).optional(),
      gmail_attachment_id: z.string().min(1).optional(),
      from_account: z.string().min(1).optional(),
      upload_id: z.string().min(1).optional(),
      sha256: z.string().optional(),
      content: z.string().optional(),
      content_base64: z.string().optional(),
      filename: z.string().min(1).max(255).optional(),
      mime_type: z.string().min(1).optional(),
    }),
  )
  .max(10)
  .optional();

/* ---------- Resolution ---------- */

export interface FileBlob {
  filename: string;
  mimeType: string;
  data: Buffer;
  /** Where the bytes came from, for results ("drive:<id>", "gmail:<message id>/<part id>", "content"). */
  origin: string;
  /** Drive sources: the file's own name and type (a Google Doc exported as docx still says it was a Doc). */
  sourceName?: string;
  sourceMimeType?: string;
}

/** A Drive file a same-account copy can use without downloading it (files.copy). */
export interface DriveSourceInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

export interface ResolveOptions {
  /** Refuse sources larger than this. */
  maxBytes: number;
  /** Used when a native Google file is exported without export_format: 'pdf' for email attachments, 'office' for copies meant to stay editable. */
  nativeDefault: 'pdf' | 'office';
}

interface DriveFileMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

interface GmailMessage {
  id: string;
  payload?: GmailPart;
}

/** Which kind of source a spec names; throws when it names none or several. */
export type SourceKind = 'drive' | 'gmail' | 'upload' | 'content' | 'base64';

/** Which kind of source a spec names; throws when it names none or several. */
export function sourceKind(spec: Partial<FileSpec>, what = 'Each attachment'): SourceKind {
  const kinds: SourceKind[] = [];
  if (spec.drive_file_id) kinds.push('drive');
  if (spec.gmail_message_id || spec.gmail_part_id || spec.gmail_attachment_id) kinds.push('gmail');
  if (spec.upload_id) kinds.push('upload');
  if (spec.content !== undefined) kinds.push('content');
  if (spec.content_base64 !== undefined) kinds.push('base64');
  if (kinds.length !== 1) {
    // Drive sources (what === 'source') take existing files only; attachments may also be written inline.
    const allowed = what === 'source' ? 'drive_file_id, gmail_message_id with gmail_part_id, or upload_id' : 'drive_file_id, gmail_message_id with gmail_part_id, upload_id, content, or content_base64';
    throw new ToolInputError(`${what} needs exactly one source: ${allowed}${kinds.length ? ` (got ${kinds.join(' and ')})` : ''}.`);
  }
  return kinds[0]!;
}

function tooLarge(what: string, bytes: number, maxBytes: number): ToolInputError {
  return new ToolInputError(`${what} is ${mb(bytes)} MB, above the ${mb(maxBytes)} MB limit for this operation.`);
}

/** Megabytes for messages: "26", "25.4", "0.3". */
/**
 * Timeout for moving `bytes` to or from Google: a minute plus 10 s per MB, but
 * never more than 150 s, well inside claude.ai's 240 s limit on a tool call, so
 * a slow send cannot complete after Claude has given up on it (and retry it).
 */
export function transferTimeoutMs(bytes: number): number {
  return Math.min(150_000, 60_000 + 10_000 * Math.ceil(Math.max(0, bytes) / (1024 * 1024)));
}

export function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Loads a source into memory. `account` is the account the tool acts on; from_account overrides it for Drive/Gmail sources. */
export async function resolveFile(ctx: ToolContext, account: string, spec: FileSpec, opts: ResolveOptions): Promise<FileBlob> {
  const blob = await resolveUnchecked(ctx, account, spec, opts);
  const expected = spec.sha256?.trim().toLowerCase();
  if (expected) {
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new ToolInputError('sha256 must be 64 hexadecimal characters (the output of sha256sum).');
    const actual = createHash('sha256').update(blob.data).digest('hex');
    if (actual !== expected) throw new ToolInputError(`"${blob.filename}" has SHA-256 ${actual}, not the expected ${expected}: the bytes differ from the original (for content_base64, a character was probably mistyped).`);
  }
  return blob;
}

async function resolveUnchecked(ctx: ToolContext, account: string, spec: FileSpec, opts: ResolveOptions): Promise<FileBlob> {
  const kind = sourceKind(spec);
  if (spec.export_format && kind !== 'drive') throw new ToolInputError('export_format only applies to a drive_file_id source.');
  if (spec.from_account && kind !== 'drive' && kind !== 'gmail') throw new ToolInputError('from_account only applies to drive_file_id and gmail_message_id sources.');
  const owner = spec.from_account?.trim() || account;
  switch (kind) {
    case 'upload':
      return stagedBlob(ctx, spec, opts);
    case 'content': {
      const filename = requireFilename(spec, 'content');
      const data = Buffer.from(spec.content ?? '', 'utf8');
      if (data.length > opts.maxBytes) throw tooLarge(`"${filename}"`, data.length, opts.maxBytes);
      const mimeType = spec.mime_type ? normalizeMime(spec.mime_type) : (mimeFromFilename(filename) ?? 'text/plain');
      return { filename, mimeType: withTextCharset(mimeType), data, origin: 'content' };
    }
    case 'base64': {
      const filename = requireFilename(spec, 'content_base64');
      const data = decodeBase64Strict(spec.content_base64 ?? '', filename);
      if (data.length > opts.maxBytes) throw tooLarge(`"${filename}"`, data.length, opts.maxBytes);
      const mimeType = spec.mime_type ? normalizeMime(spec.mime_type) : (mimeFromFilename(filename) ?? sniffMime(data) ?? 'application/octet-stream');
      return { filename, mimeType, data, origin: 'content_base64' };
    }
    case 'drive':
      return driveBlob(ctx, owner, spec, opts);
    case 'gmail':
      return gmailBlob(ctx, owner, spec, opts);
  }
}

/**
 * Attachment lists may name an upload link (link_id, "ln_…") instead of a file: it stands for every
 * file uploaded through that link, oldest first, so Claude need not look up each upload_id.
 */
export function expandUploadLinks(ctx: ToolContext, specs: FileSpec[] | undefined): FileSpec[] | undefined {
  if (!specs?.some((s) => isLinkId(s.upload_id))) return specs;
  return specs.flatMap((spec) => {
    if (!isLinkId(spec.upload_id)) return [spec];
    const files = linkFiles(ctx, spec.upload_id!.trim());
    if (files.length > 1 && (spec.filename || spec.sha256)) throw new ToolInputError(`${spec.upload_id} carried ${files.length} files: filename and sha256 need one upload_id each (list_uploads).`);
    return files.map((f) => ({ ...spec, upload_id: f.id }));
  });
}

export function isLinkId(id: string | undefined): boolean {
  return /^ln_[0-9a-f]{16}$/.test(id?.trim() ?? '');
}

export function linkFiles(ctx: ToolContext, linkId: string) {
  const files = ctx.uploads.list(linkId).sort((a, b) => a.createdAt - b.createdAt);
  if (!files.length) throw new ToolInputError(`Nothing has been uploaded through ${linkId} (yet, or its files expired). Ask the user whether the upload page confirmed the files.`);
  return files;
}

/** A file staged from the chat (create_upload_link / upload_file). */
function stagedBlob(ctx: ToolContext, spec: FileSpec, opts: ResolveOptions): FileBlob {
  let id = spec.upload_id!.trim();
  if (isLinkId(id)) {
    const files = linkFiles(ctx, id);
    if (files.length > 1) throw new ToolInputError(`${id} carried ${files.length} files (${files.map((f) => `${f.id} ${f.filename ?? ''}`.trim()).join(', ')}): name one upload_id here.`);
    id = files[0]!.id;
  }
  const staged = ctx.uploads.get(id);
  if (!staged) {
    throw new ToolInputError(`No staged file "${id}": staged files are kept for 24 hours after their last change. Stage it again with create_upload_link or upload_file.`);
  }
  if (staged.data.length > opts.maxBytes) throw tooLarge(`"${staged.filename ?? id}"`, staged.data.length, opts.maxBytes);
  const type = spec.mime_type ? normalizeMime(spec.mime_type) : normalizeMime(effectiveType(staged.data, staged.mimeType, staged.filename), 'application/octet-stream');
  const filename = spec.filename?.trim() || staged.filename || withExtension('attachment', type);
  return { filename, mimeType: type, data: staged.data, origin: `upload:${id}` };
}

function requireFilename(spec: FileSpec, field: string): string {
  const name = spec.filename?.trim();
  if (!name) throw new ToolInputError(`A ${field} attachment needs a filename (with extension, e.g. "report.csv").`);
  return name;
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * A MIME type without parameters, checked to be a plain type/subtype token: the
 * value ends up in MIME and multipart headers, where a line break would let it
 * add headers of its own. A caller-given type that is not one is refused; a
 * malformed type from Google or a sender falls back to `fallback`.
 */
export function normalizeMime(mime: string | undefined, fallback?: string): string {
  const m = baseMime(mime);
  if (MIME_RE.test(m)) return m;
  if (fallback !== undefined) return fallback;
  throw new ToolInputError(`"${mime}" is not a MIME type (expected something like "application/pdf").`);
}

/** Text files carry their charset so mail clients and Drive decode non-ASCII correctly. */
function withTextCharset(mime: string): string {
  return mime.startsWith('text/') ? `${mime}; charset=UTF-8` : mime;
}

/** Accepts standard or URL-safe base64, with or without padding and line breaks; refuses anything else. */
export function decodeBase64Strict(input: string, label: string): Buffer {
  const compact = input.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) {
    throw new ToolInputError(`content_base64 of "${label}" is not valid base64.`);
  }
  return Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/* ---------- Drive ---------- */

const META_FIELDS = 'id,name,mimeType,size,shortcutDetails';

/** Metadata of a Drive file, following a shortcut to its target. Refuses folders. */
export async function driveSourceInfo(ctx: ToolContext, account: string, fileId: string): Promise<DriveSourceInfo> {
  const get = (id: string) =>
    ctx.google.request<DriveFileMeta>(account, 'drive', { url: `/files/${encodeURIComponent(id)}`, query: { fields: META_FIELDS, supportsAllDrives: true } });
  let id: string;
  try {
    id = extractFileId(fileId);
  } catch (err) {
    throw new ToolInputError(err instanceof Error ? err.message : String(err));
  }
  let meta = await get(id);
  if (meta.mimeType === GOOGLE_MIME.shortcut && meta.shortcutDetails?.targetId) meta = await get(meta.shortcutDetails.targetId);
  if (meta.mimeType === GOOGLE_MIME.folder) throw new ToolInputError(`"${meta.name ?? id}" is a folder; only files can be attached or copied.`);
  const size = meta.size === undefined ? undefined : Number(meta.size);
  return { id: meta.id ?? id, name: meta.name ?? id, mimeType: meta.mimeType ?? 'application/octet-stream', size: Number.isFinite(size) ? size : undefined };
}

/** The export format used for a native file, validated against what Google offers for its type. */
export function chooseExport(mimeType: string, requested: FileExportFormat | undefined, nativeDefault: 'pdf' | 'office'): FileExportFormat {
  const offered = NATIVE_EXPORTS[mimeType];
  if (!offered) {
    throw new ToolInputError(`This Google ${friendlyType(mimeType)} (${mimeType}) cannot be exported as a file.`);
  }
  if (requested) {
    if (!offered.includes(requested)) throw new ToolInputError(`A Google ${friendlyType(mimeType)} cannot be exported as ${requested}; choose one of: ${offered.join(', ')}.`);
    return requested;
  }
  return nativeDefault === 'office' ? (OFFICE_EXPORT[mimeType] ?? 'pdf') : 'pdf';
}

async function driveBlob(ctx: ToolContext, account: string, spec: FileSpec, opts: ResolveOptions): Promise<FileBlob> {
  const info = await driveSourceInfo(ctx, account, spec.drive_file_id!);
  const path = `/files/${encodeURIComponent(info.id)}`;
  if (info.mimeType.startsWith('application/vnd.google-apps.')) {
    const format = chooseExport(info.mimeType, spec.export_format, opts.nativeDefault);
    const mimeType = EXPORT_MIME[format];
    let data: Buffer;
    try {
      data = await ctx.google.request<Buffer>(account, 'drive', { url: `${path}/export`, query: { mimeType }, responseType: 'buffer', timeoutMs: 120_000 });
    } catch (err) {
      if (err instanceof GoogleApiError && (err.reason === 'exportSizeLimitExceeded' || /too large to be exported/i.test(err.message))) {
        throw new ToolInputError(`"${info.name}" is too large for Google to export as ${format} (the export limit is 10 MB). Try another format, or share a Drive link instead.`);
      }
      throw err;
    }
    if (data.length > opts.maxBytes) throw tooLarge(`"${info.name}" as ${format}`, data.length, opts.maxBytes);
    return {
      filename: spec.filename?.trim() || withExtension(info.name, mimeType),
      mimeType: spec.mime_type ? normalizeMime(spec.mime_type) : mimeType,
      data,
      origin: `drive:${info.id}`,
      sourceName: info.name,
      sourceMimeType: info.mimeType,
    };
  }
  if (spec.export_format) throw new ToolInputError(`export_format only applies to Google Docs, Sheets, Slides and Drawings; "${info.name}" is ${info.mimeType}.`);
  if (info.size !== undefined && info.size > opts.maxBytes) throw tooLarge(`"${info.name}"`, info.size, opts.maxBytes);
  const timeoutMs = transferTimeoutMs(info.size ?? 0);
  const data = await ctx.google.request<Buffer>(account, 'drive', { url: path, query: { alt: 'media', supportsAllDrives: true }, responseType: 'buffer', timeoutMs });
  if (data.length > opts.maxBytes) throw tooLarge(`"${info.name}"`, data.length, opts.maxBytes);
  const filename = spec.filename?.trim() || info.name;
  return {
    filename,
    mimeType: spec.mime_type ? normalizeMime(spec.mime_type) : normalizeMime(effectiveType(data, info.mimeType, info.name), 'application/octet-stream'),
    data,
    origin: `drive:${info.id}`,
    sourceName: info.name,
    sourceMimeType: info.mimeType,
  };
}

/* ---------- Gmail ---------- */

/** Every attachment-like part of a message, embedded images included, with part ids. */
export function messageAttachments(payload: GmailPart | undefined): ExtractedAttachment[] {
  return extractBody(payload).attachments;
}

function describeParts(parts: ExtractedAttachment[]): string {
  const named = parts.filter((p) => !p.embedded);
  const list = (named.length ? named : parts).map((p) => `${p.partId ?? '?'} (${p.filename})`);
  return list.length ? `Attachments of this message (part_id, name): ${list.join(', ')}.` : 'This message has no attachments.';
}

/**
 * A Gmail attachment. The message is fetched afresh because attachment ids are
 * not stable across fetches; part ids are. A caller that only kept an
 * attachment_id still works: Gmail accepts older ids, and the part is then
 * identified by its size to recover the file name and type.
 */
async function gmailBlob(ctx: ToolContext, account: string, spec: FileSpec, opts: ResolveOptions): Promise<FileBlob> {
  const messageId = spec.gmail_message_id?.trim();
  if (!messageId) throw new ToolInputError('A Gmail attachment source needs gmail_message_id together with gmail_part_id (or gmail_attachment_id).');
  if (!spec.gmail_part_id && !spec.gmail_attachment_id) {
    throw new ToolInputError('Give gmail_part_id (or gmail_attachment_id) with gmail_message_id; gmail_get_message lists them for each attachment.');
  }
  const message = await ctx.google.request<GmailMessage>(account, 'gmail', { url: `/messages/${encodeURIComponent(messageId)}`, query: { format: 'full' } });
  const parts = messageAttachments(message.payload);
  let part: ExtractedAttachment | undefined;
  if (spec.gmail_part_id) {
    part = parts.find((p) => p.partId === spec.gmail_part_id?.trim());
    if (!part) throw new ToolInputError(`Message ${messageId} has no attachment with part_id "${spec.gmail_part_id}". ${describeParts(parts)}`);
  } else {
    part = parts.find((p) => p.attachmentId === spec.gmail_attachment_id);
  }
  if (part && part.size > opts.maxBytes) throw tooLarge(`"${part.filename}"`, part.size, opts.maxBytes);

  let data: Buffer;
  if (part?.data !== undefined) data = decodeBase64Url(part.data);
  else if (part && !part.attachmentId) {
    // Gmail sends neither data nor an attachment id for an empty file, but also for an attached
    // email it only shows as separate parts: that one cannot be passed on as a single file.
    if (part.nested) throw new ToolInputError(`"${part.filename}" is an attached email that Gmail only provides part by part, so it cannot be used as one file.`);
    data = Buffer.alloc(0);
  } else {
    const attachmentId = part?.attachmentId ?? spec.gmail_attachment_id!;
    const body = await ctx.google.request<{ size?: number; data?: string }>(account, 'gmail', {
      url: `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      timeoutMs: 120_000,
    });
    data = decodeBase64Url(body.data ?? '');
    if (!part) {
      // An attachment id from an earlier fetch: recognise the part by its size.
      const sameSize = parts.filter((p) => p.size === data.length);
      part = sameSize.length === 1 ? sameSize[0] : undefined;
    }
  }
  if (data.length > opts.maxBytes) throw tooLarge(`"${part?.filename ?? 'The attachment'}"`, data.length, opts.maxBytes);
  const filename = spec.filename?.trim() || part?.filename || 'attachment';
  // Senders' labels are often generic or wrong (Outlook calls .csv files Excel); the name and the bytes settle it.
  const type = spec.mime_type ? normalizeMime(spec.mime_type) : normalizeMime(effectiveType(data, part?.mimeType, part?.filename ?? filename), 'application/octet-stream');
  return {
    filename,
    mimeType: withCharset(type, part?.charset),
    data,
    origin: `gmail:${messageId}/${part?.partId ?? 'attachment'}`,
  };
}

const CHARSET_RE = /^[A-Za-z0-9._:-]{1,40}$/;

/** A text type with its declared charset (e.g. "text/csv; charset=ISO-8859-1"), so a re-attached file keeps its encoding. */
function withCharset(type: string, charset: string | undefined): string {
  return isTextType(type) && charset && CHARSET_RE.test(charset) ? `${type}; charset=${charset}` : type;
}

/**
 * The file as Drive should receive it: text re-encoded as UTF-8 (Drive reads
 * text uploads as UTF-8, so a Latin-1 CSV would lose every accent when it
 * becomes a Sheet); anything else unchanged. The type loses its charset label.
 */
export function forDrive(blob: FileBlob): FileBlob {
  const type = baseMime(blob.mimeType);
  if (!isTextType(type)) return { ...blob, mimeType: type };
  const declared = /;\s*charset="?([^";]+)"?/i.exec(blob.mimeType)?.[1];
  const charset = textCharset(blob.data, declared);
  if (!charset || /^utf-?8$/i.test(charset)) return { ...blob, mimeType: type };
  return { ...blob, mimeType: type, data: Buffer.from(decodeBytes(blob.data, charset), 'utf8') };
}
