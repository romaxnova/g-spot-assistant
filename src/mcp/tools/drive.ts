/**
 * Google Drive tools: search, get (metadata + content), create, update
 * (rename / move / restore / replace content), share, trash.
 *
 * Drive API surprises handled here:
 * - Google-native files (Docs, Sheets, Slides) have no bytes to download; they
 *   are exported through files/{id}/export, which Google caps at 10 MB.
 * - `size` is a string, and absent on native files and folders.
 * - A file is moved with the addParents/removeParents query parameters on
 *   PATCH; `parents` in the body is rejected. So the current parents are read first.
 * - Uploads go to a different host (DRIVE_UPLOAD_BASE): multipart/related up to
 *   5 MB, a resumable session (POST metadata, then PUT the bytes) above that.
 *   Uploading an importable type (text, CSV, Office, PDF, images) with a Google
 *   mimeType in the metadata makes Drive convert it into a Doc/Sheet/Slides deck.
 * - files.copy duplicates a file inside Google (no bytes through the connector)
 *   and converts Office files when given a Google mimeType; it only works within
 *   one account, so cross-account copies are downloaded and uploaded again.
 * - Conversions (into a Google Doc/Sheet/Slides, OCR of scans) can take minutes:
 *   they get CONVERSION_TIMEOUT_MS, and a create that times out is looked for
 *   (Google usually finishes it anyway) instead of failing, so a retry does not
 *   leave two copies.
 * - supportsAllDrives=true is required on every file call, otherwise files in
 *   shared drives answer 404.
 * - A file only knows its parent ids: drive_search reads the folders above it
 *   (drive-paths.ts) to show where it lives.
 */
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DRIVE_UPLOAD_BASE, GoogleApiError, type QueryValue } from '../../google/client.js';
import { officeKind } from '../extract/office.js';
import { humanSize, MAX_IMAGE_BYTES, readFileContent, type ReadableContent } from '../extract/readable.js';
import { baseMime, mimeFromFilename, sniffMime, VIEWABLE_IMAGE_TYPES } from '../file-types.js';
import {
  accountParam,
  clip,
  defineTool,
  errorResult,
  jsonResult,
  maxCharsParam,
  offsetParam,
  pageTokenParam,
  stripEmpty,
  ToolInputError,
  withImage,
  type ToolContext,
  type ToolDefinition,
} from '../registry.js';
import { cleanText, normalizeNewlines, trimCsv } from '../text.js';
import { folderPathsOf } from './drive-paths.js';
import { notificationRefusal, reviewedByUserParam } from './sensitive.js';
import { copySourceSchema, decodeBase64Strict, driveSourceInfo, forDrive, mb, normalizeMime, resolveFile, sourceKind, transferTimeoutMs, type FileBlob } from './file-sources.js';
import {
  assertImportable,
  buildSearchQuery,
  convertibleKind,
  DriveInputError,
  escapeQ,
  EXPORT_FORMATS,
  exportPlan,
  extractFileId,
  friendlyType,
  GOOGLE_MIME,
  isTextLike,
  multipartRelated,
  SEARCH_TYPES,
  withUtf8Charset,
  type ExportFormat,
  type ExportPlan,
  type NativeKind,
} from './drive-files.js';

const SERVICE = 'drive' as const;

/** Text content larger than this is never downloaded (Google's export cap is the same 10 MB). */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
/** PDFs, Office files and images are downloaded for reading up to this size. */
export const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;
/** Files uploaded or copied through the connector (held in memory while in transit). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Above this, uploads use a resumable session instead of one multipart request (Google's recommendation). */
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Image files larger than what a tool result can carry inline are shown
 * through Drive's preview instead, at the largest of these sizes (longest
 * side, px) that fits. Smaller images are sent as they are.
 */
const PREVIEW_IMAGES_ABOVE_BYTES = MAX_IMAGE_BYTES;
const PREVIEW_SIZES = [1600, 1200, 800, 512];
const DRAWING_MIME = 'application/vnd.google-apps.drawing';
/**
 * Converting into a Google file (a long Word file, OCR of a 15 MB scan) can take minutes. Three of them, plus the look
 * for the file after a timeout, stay inside claude.ai's 240 s per tool call.
 */
export const CONVERSION_TIMEOUT_MS = 180_000;
/** Copies inside Google without conversion: quick, but a large file can take more than the default 30 s. */
const COPY_TIMEOUT_MS = 60_000;
/** Waits before each look for a file whose create timed out: Google may still be finishing it. Tests shorten them. */
export const createdFileLookup = { delaysMs: [0, 5_000, 10_000] };

/* ---------- Google shapes ---------- */

export interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
  owners?: { emailAddress?: string; displayName?: string }[];
  shared?: boolean;
  trashed?: boolean;
  starred?: boolean;
  description?: string;
  permissions?: DrivePermission[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  /** Set by the connector, not Google: the create timed out and the file was found afterwards. */
  recovered?: boolean;
}

interface DrivePermission {
  id?: string;
  type?: string;
  role?: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
}

interface FileList {
  nextPageToken?: string;
  files?: DriveFile[];
}

const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,webViewLink,shared,owners(emailAddress),trashed,shortcutDetails)';
const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,owners(emailAddress,displayName),shared,trashed,starred,description,permissions(id,type,role,emailAddress,domain,displayName),shortcutDetails';
const WRITE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,starred,trashed,description';

/* ---------- Shared parameters ---------- */

const fileIdParam = z.string().min(1).describe('Drive file id, or the full Google Drive/Docs/Sheets/Slides URL (the id is read from /d/<id>, /folders/<id> or ?id=<id>).');
const contentMimeParam = (defaultNote: string) =>
  z.string().optional().describe(`MIME type of \`content\` (${defaultNote}). For Google Docs use text/markdown or text/html to keep formatting; for Google Sheets use text/csv.`);

/* ---------- Helpers ---------- */

/** Turns DriveInputError and ToolInputError (arguments Claude can fix) into an errorResult; everything else propagates. */
export async function withInputErrors(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DriveInputError || err instanceof ToolInputError) return errorResult(err.message);
    throw err;
  }
}

function filePath(id: string, suffix = ''): string {
  return `/files/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Metadata bodies drop only the fields that were not given. Unlike stripEmpty,
 * an empty string is kept: PATCH {description: ""} is how Drive clears a
 * description, and omitting the field leaves it untouched.
 */
function withoutUndefined(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined));
}

export function sizeBytes(f: DriveFile): number | undefined {
  if (f.size === undefined) return undefined;
  const n = Number(f.size);
  return Number.isFinite(n) ? n : undefined;
}

function fileSummary(f: DriveFile) {
  return {
    id: f.id,
    name: f.name,
    type: friendlyType(f.mimeType),
    mime_type: f.mimeType,
    modified_time: f.modifiedTime,
    size: sizeBytes(f),
    parents: f.parents,
    owner: f.owners?.[0]?.emailAddress,
    shared: f.shared,
    trashed: f.trashed || undefined,
    starred: f.starred || undefined,
    web_view_link: f.webViewLink,
    shortcut_target: f.shortcutDetails ? { id: f.shortcutDetails.targetId, type: friendlyType(f.shortcutDetails.targetMimeType) } : undefined,
  };
}

function permissionSummary(p: DrivePermission) {
  return { id: p.id, type: p.type, role: p.role, email: p.emailAddress, domain: p.domain, name: p.displayName };
}

interface ContentResult {
  content?: string;
  content_format?: string;
  /** Set when the text was extracted from a binary file: pdf, docx, xlsx, pptx. */
  extracted_from?: string;
  truncated?: boolean;
  total_chars?: number;
  next_offset?: number;
  content_note?: string;
  /** Returned to Claude as an image content block, not as JSON. */
  image?: { data: Buffer; mimeType: string };
}

/**
 * Content as shown to Claude. CSV loses trailing empty cells (a sheet with a note
 * in column K otherwise pads every row with commas); prose loses invisible
 * characters and blank-line runs; other data formats only get \n line endings.
 */
export function readableContent(text: string, format: string): string {
  if (format === 'text/csv') return trimCsv(normalizeNewlines(text));
  if (format === 'text/plain' || format === 'text/markdown') return cleanText(text);
  return normalizeNewlines(text);
}

function clippedText(text: string, format: string, maxChars: number, offset: number, note?: string): ContentResult {
  const c = clip(text, maxChars, offset);
  return {
    content: c.text,
    content_format: format,
    truncated: c.truncated,
    total_chars: c.totalChars,
    next_offset: c.nextOffset,
    content_note: text.length === 0 ? 'The file is empty.' : note,
  };
}

function clippedContent(raw: string, format: string, maxChars: number, offset: number, note?: string): ContentResult {
  return clippedText(readableContent(raw, format), format, maxChars, offset, note);
}

/** Exports a Google-native file as text, falling back once when Google refuses the preferred format. */
async function exportText(ctx: ToolContext, account: string, id: string, plan: ExportPlan, deadline?: number): Promise<{ text: string; mimeType: string }> {
  const fetchAs = (mimeType: string) =>
    ctx.google.request<string>(account, SERVICE, { url: filePath(id, '/export'), query: { mimeType }, responseType: 'text', timeoutMs: within(deadline, 30_000) });
  try {
    return { text: await fetchAs(plan.mimeType), mimeType: plan.mimeType };
  } catch (err) {
    // A 404 means the file itself is missing; anything else (400 unsupported format, 500) is worth one retry in the fallback format.
    if (!plan.fallbackMimeType || !(err instanceof GoogleApiError) || err.status === 404) throw err;
    ctx.log.info('drive export fallback', { alias: account, from: plan.mimeType, to: plan.fallbackMimeType, status: err.status });
    return { text: await fetchAs(plan.fallbackMimeType), mimeType: plan.fallbackMimeType };
  }
}

interface ContentOptions {
  maxChars: number;
  offset: number;
  format?: ExportFormat;
}

/** Binary types worth downloading because they can be turned into text or shown as an image (Office files also by their name). */
function isReadableBinary(mime: string, name: string | undefined): boolean {
  const m = baseMime(mime);
  if (m === 'application/pdf' || m.startsWith('image/') || officeKind(m, name)) return true;
  return m === 'application/octet-stream' && mimeFromFilename(name) === 'application/pdf';
}

/**
 * Drive's own preview of a file (images, PDFs, videos), at the largest of
 * PREVIEW_SIZES whose JPEG/PNG fits MAX_IMAGE_BYTES. thumbnailLink points at a
 * Google content host and needs the account's token when the file is not
 * public; any other host is refused.
 */
async function thumbnail(ctx: ToolContext, account: string, id: string): Promise<{ data: Buffer; mimeType: string; px: number } | undefined> {
  const meta = await ctx.google.request<{ thumbnailLink?: string }>(account, SERVICE, { url: filePath(id), query: { fields: 'thumbnailLink', supportsAllDrives: true } });
  const link = meta.thumbnailLink;
  if (!link) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !/(^|\.)(googleusercontent\.com|google\.com)$/.test(url.hostname)) return undefined;
  const resizable = /=s\d+$/.test(link) || /[?&]sz=s?\d+/.test(link);
  for (const px of PREVIEW_SIZES) {
    const sized = /=s\d+$/.test(link) ? link.replace(/=s\d+$/, `=s${px}`) : link.replace(/([?&]sz=)s?\d+/, `$1s${px}`);
    try {
      const data = await ctx.google.request<Buffer>(account, SERVICE, { url: sized, responseType: 'buffer', contentHost: true });
      const type = sniffMime(data);
      if (!type || !VIEWABLE_IMAGE_TYPES.has(type)) return undefined;
      if (data.length <= MAX_IMAGE_BYTES) return { data, mimeType: type, px };
      if (!resizable) return undefined;
    } catch (err) {
      if (err instanceof GoogleApiError) return undefined;
      throw err;
    }
  }
  return undefined;
}

/**
 * How to get text out of a file that cannot be read directly: Google converts
 * old Office formats, OpenDocument, RTF and (by OCR) scanned PDFs into Google
 * files, which drive_get_file exports as text.
 */
export function conversionHint(fileId: string, type: string, note = ''): string | undefined {
  const kind = convertibleKind(type);
  if (!kind || type.startsWith('image/') || /password/i.test(note)) return undefined;
  if (type === 'application/pdf') return 'To read a scan, call drive_get_file again with ocr: true (Google reads it by OCR).';
  return `To read it, make a converted copy: drive_create_file with source {drive_file_id: "${fileId}"} and kind "${kind}", then drive_get_file on the copy.`;
}

/** Maps extracted content to result fields; images and scanned PDFs fall back to Drive's preview. */
async function fromReadable(ctx: ToolContext, account: string, file: DriveFile, readable: ReadableContent, opts: ContentOptions): Promise<ContentResult> {
  if (readable.kind === 'text') {
    const out = clippedText(readable.text, readable.format, opts.maxChars, opts.offset, readable.note);
    if (readable.extractedFrom) out.extracted_from = readable.extractedFrom;
    if (readable.text.length === 0) out.content_note = readable.note ?? 'No text found in the file.';
    return out;
  }
  if (readable.kind === 'image') return { content_note: readable.note ?? 'The image follows.', image: { data: readable.data, mimeType: readable.mimeType } };
  const hint = conversionHint(file.id ?? '', readable.type, readable.note);
  return previewFallback(ctx, account, file, hint ? `${readable.note} ${hint}` : readable.note, readable.type);
}

/** A PDF or image that could not be shown: Drive's preview (a PDF's first page) when there is one. */
async function previewFallback(ctx: ToolContext, account: string, file: DriveFile, note: string, type: string): Promise<ContentResult> {
  if (type === 'application/pdf' || type.startsWith('image/')) {
    const preview = await thumbnail(ctx, account, file.id ?? '');
    if (preview) {
      const what = `Drive's preview of ${type === 'application/pdf' ? 'the first page' : 'the image'} follows (at most ${preview.px} px)`;
      return { content_note: `${note} ${what}.`, image: { data: preview.data, mimeType: preview.mimeType } };
    }
  }
  return { content_note: `${note} Open web_view_link to view it.` };
}

/** Decides how (or whether) the file's content can be shown and fetches it. */
async function readContent(ctx: ToolContext, account: string, file: DriveFile, opts: ContentOptions): Promise<ContentResult> {
  const id = file.id ?? '';
  const mime = file.mimeType ?? 'application/octet-stream';
  if (mime === GOOGLE_MIME.folder) {
    return { content_note: `This is a folder; list its contents with drive_search folder_id="${id}".` };
  }
  if (mime === GOOGLE_MIME.shortcut) {
    const target = file.shortcutDetails;
    return { content_note: `This is a shortcut to ${friendlyType(target?.targetMimeType)} "${target?.targetId ?? '?'}"; call drive_get_file with that id.` };
  }
  const plan = exportPlan(mime, opts.format);
  if (plan) {
    const exported = await exportText(ctx, account, id, plan);
    const note = exported.mimeType !== plan.mimeType ? `Google refused ${plan.mimeType}; exported as ${exported.mimeType} instead.` : plan.note;
    return clippedContent(exported.text, exported.mimeType, opts.maxChars, opts.offset, note);
  }
  if (opts.format) throw new DriveInputError(`export_format only applies to Google Docs, Sheets and Slides; this file is ${mime}.`);
  if (mime === DRAWING_MIME) {
    const png = await ctx.google.request<Buffer>(account, SERVICE, { url: filePath(id, '/export'), query: { mimeType: 'image/png' }, responseType: 'buffer' });
    return fromReadable(ctx, account, file, await readFileContent(png, { mimeType: 'image/png' }), opts);
  }
  const bytes = sizeBytes(file);
  if (isTextLike(mime)) {
    if (bytes !== undefined && bytes > MAX_CONTENT_BYTES) {
      return { content_note: `Content not downloaded: ${(bytes / 1_048_576).toFixed(1)} MB exceeds the ${MAX_CONTENT_BYTES / 1_048_576} MB limit. Open web_view_link instead.` };
    }
    const text = await ctx.google.request<string>(account, SERVICE, { url: filePath(id), query: { alt: 'media', supportsAllDrives: true }, responseType: 'text' });
    return clippedContent(text, mime, opts.maxChars, opts.offset);
  }
  if (!isReadableBinary(mime, file.name)) {
    const hint = conversionHint(id, baseMime(mime));
    return {
      content_note: `The content of this file type (${mime}${bytes !== undefined ? `, ${bytes} bytes` : ''}) cannot be read; PDF, Word, Excel, PowerPoint, text files and PNG/JPEG/GIF/WebP images can. ${hint ?? 'Open web_view_link to view it.'}`,
    };
  }
  // Large images and formats Claude cannot take (HEIC, TIFF, ...) are shown through Drive's preview, without downloading them.
  if (mime.startsWith('image/')) {
    const viewable = VIEWABLE_IMAGE_TYPES.has(baseMime(mime));
    const size = bytes ?? 0;
    if (!viewable || size > PREVIEW_IMAGES_ABOVE_BYTES) {
      const preview = await thumbnail(ctx, account, id);
      if (preview) {
        const what = viewable
          ? `The image is ${humanSize(size)}; Drive's preview of it (at most ${preview.px} px) follows.`
          : `${mime} images cannot be shown as they are; Drive's preview of it (at most ${preview.px} px) follows.`;
        return { content_note: what, image: { data: preview.data, mimeType: preview.mimeType } };
      }
      if (!viewable) return { content_note: `${mime} images cannot be shown as they are, and Drive has no preview of this one. Open web_view_link to view it.` };
      if (size > MAX_IMAGE_BYTES) {
        return { content_note: `The image is ${humanSize(size)}, above the ${humanSize(MAX_IMAGE_BYTES)} a tool result can carry, and Drive has no preview of it that fits. Open web_view_link to view it.` };
      }
    }
  }
  if (bytes !== undefined && bytes > MAX_EXTRACT_BYTES) {
    return previewFallback(ctx, account, file, `Content not downloaded: ${mb(bytes)} MB exceeds the ${mb(MAX_EXTRACT_BYTES)} MB limit for reading.`, baseMime(mime));
  }
  const timeoutMs = transferTimeoutMs(bytes ?? 0);
  const data = await ctx.google.request<Buffer>(account, SERVICE, { url: filePath(id), query: { alt: 'media', supportsAllDrives: true }, responseType: 'buffer', timeoutMs });
  return fromReadable(ctx, account, file, await readFileContent(data, { mimeType: mime, filename: file.name }), opts);
}

/* ---------- Uploads and copies ---------- */

interface Media {
  data: Buffer;
  mimeType: string;
}

interface UploadOptions {
  method: 'POST' | 'PATCH';
  fileId?: string;
  metadata: Record<string, unknown>;
  media: Media;
  query?: Record<string, QueryValue>;
  /** Google converts the content (into a Google file it already is, for a PATCH): allow for it. */
  converting?: boolean;
  /** Epoch ms by which the call must be over (claude.ai gives a tool call 240 s): timeouts shrink to fit. */
  deadline?: number;
}

export function isTimeout(err: unknown): err is GoogleApiError {
  return err instanceof GoogleApiError && err.reason === 'timeout';
}

/** A Drive query string literal. */
function quoted(value: string): string {
  return `'${escapeQ(value)}'`;
}

/** The private property (appProperties) each create carries, so the file a timed-out create made is known for sure. */
const CREATE_TAG = 'connectorCreate';

/** Files of the account carrying an app property, newest first. */
async function filesTagged(ctx: ToolContext, account: string, key: string, value: string, timeoutMs?: number): Promise<DriveFile[]> {
  const res = await ctx.google.request<{ files?: DriveFile[] }>(account, SERVICE, {
    url: '/files',
    query: {
      q: `appProperties has { key=${quoted(key)} and value=${quoted(value)} } and trashed = false`,
      orderBy: 'createdTime desc',
      pageSize: 5,
      fields: `files(${WRITE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    timeoutMs,
  });
  return res.files ?? [];
}

/**
 * The file a create that timed out made, found by the tag it was created with: Google usually finishes the create (a
 * conversion, an upload) after the connector stopped waiting. Undefined when it is not there yet.
 */
export async function findCreated(ctx: ToolContext, account: string, tag: string, deadline = Number.POSITIVE_INFINITY): Promise<DriveFile | undefined> {
  for (const delay of createdFileLookup.delaysMs) {
    if (Date.now() + delay > deadline) break;
    if (delay) await sleep(delay);
    const found = (await filesTagged(ctx, account, CREATE_TAG, tag))[0];
    if (found?.id) return { ...found, recovered: true };
  }
  return undefined;
}

/** Thrown when a create timed out and its file has not appeared (yet). */
export class CreateTimeoutError extends GoogleApiError {
  constructor(name: string) {
    super(
      `Google did not finish creating "${name}" in time; it may still be working on it (conversions of large scans take minutes). ` +
        'Do not create it again: look for it with drive_search in a minute or two.',
      0,
      'timeout',
    );
  }
}

/**
 * Runs a create that may outlast its timeout (a conversion, a large upload), tagged with a private app property. On a
 * timeout, the file carrying that tag is looked for; when Google has not made it yet, the error says not to create it
 * again.
 */
async function createOrFind(
  ctx: ToolContext,
  account: string,
  metadata: Record<string, unknown>,
  create: (metadata: Record<string, unknown>) => Promise<DriveFile>,
  deadline?: number,
): Promise<DriveFile> {
  const tag = randomBytes(12).toString('base64url');
  const appProperties = { ...(metadata['appProperties'] as Record<string, string> | undefined), [CREATE_TAG]: tag };
  try {
    return await create({ ...metadata, appProperties });
  } catch (err) {
    if (!isTimeout(err)) throw err;
    const found = await findCreated(ctx, account, tag, deadline);
    ctx.log.info('drive create timed out', { alias: account, found: found !== undefined });
    if (found) return found;
    throw new CreateTimeoutError(String(metadata['name'] ?? 'the file'));
  }
}

/** A timeout for a step of a call that must end by `deadline` (epoch ms): what is left, at least 5 s, at most `max`. */
export function within(deadline: number | undefined, max: number): number {
  return deadline === undefined ? max : Math.max(5_000, Math.min(max, deadline - Date.now()));
}

/** Creates a file or replaces its content through Drive's upload host: multipart up to 5 MB, a resumable session above. */
export async function upload(ctx: ToolContext, account: string, opts: UploadOptions): Promise<DriveFile> {
  const metadata = withoutUndefined(opts.metadata);
  // Replacing content may be converting it into the Google file it is: allow for that too.
  const converting = opts.converting ?? (opts.method === 'PATCH' || (typeof metadata['mimeType'] === 'string' && isNative(metadata['mimeType'])));
  if (opts.method === 'POST') return createOrFind(ctx, account, metadata, (tagged) => send(ctx, account, opts, tagged, converting), opts.deadline);
  return send(ctx, account, opts, metadata, converting);
}

async function send(ctx: ToolContext, account: string, opts: UploadOptions, metadata: Record<string, unknown>, converting: boolean): Promise<DriveFile> {
  const url = `${DRIVE_UPLOAD_BASE}/files${opts.fileId ? `/${encodeURIComponent(opts.fileId)}` : ''}`;
  const query = { supportsAllDrives: true, fields: WRITE_FIELDS, ...opts.query };
  const size = opts.media.data.length;
  const mediaType = withUtf8Charset(opts.media.mimeType);
  // Uploads are slow on a bad link; allow 10 s per MB on top of a minute, and Google time to convert.
  const timeoutMs = within(opts.deadline, Math.max(transferTimeoutMs(size), converting ? CONVERSION_TIMEOUT_MS : 0));
  if (size <= MULTIPART_MAX_BYTES) {
    const { body, contentType } = multipartRelated(metadata, opts.media.data, mediaType);
    return ctx.google.request<DriveFile>(account, SERVICE, { method: opts.method, url, query: { uploadType: 'multipart', ...query }, body, contentType, timeoutMs });
  }
  const session = await ctx.google.request<Record<string, string>>(account, SERVICE, {
    method: opts.method,
    url,
    query: { uploadType: 'resumable', ...query },
    body: metadata,
    contentType: 'application/json; charset=UTF-8',
    headers: { 'x-upload-content-type': mediaType, 'x-upload-content-length': String(size) },
    responseType: 'headers',
  });
  const location = session['location'];
  let sessionUrl: URL | undefined;
  try {
    sessionUrl = location ? new URL(location) : undefined;
  } catch {
    sessionUrl = undefined;
  }
  // The bytes (and the token) only ever go back to Google's upload host.
  if (!sessionUrl || sessionUrl.protocol !== 'https:' || !sessionUrl.hostname.endsWith('.googleapis.com') || !sessionUrl.pathname.startsWith('/upload/')) {
    throw new GoogleApiError('Drive did not open an upload session (no valid upload URL returned).', 0, 'invalid_response');
  }
  return ctx.google.request<DriveFile>(account, SERVICE, { method: 'PUT', url: sessionUrl.href, body: opts.media.data, contentType: mediaType, timeoutMs });
}

/** Plain metadata create (folders, empty Docs/Sheets/Slides, empty files). */
export async function createMetadataOnly(ctx: ToolContext, account: string, metadata: Record<string, unknown>): Promise<DriveFile> {
  return ctx.google.request<DriveFile>(account, SERVICE, {
    method: 'POST',
    url: '/files',
    query: { supportsAllDrives: true, fields: WRITE_FIELDS },
    body: withoutUndefined(metadata),
  });
}

/** Server-side copy within one account; a Google mimeType converts an Office file (or a scan, by OCR) on the way. */
export async function copyWithinAccount(ctx: ToolContext, account: string, id: string, metadata: Record<string, unknown>, deadline?: number): Promise<DriveFile> {
  const body = withoutUndefined(metadata);
  const converting = typeof body['mimeType'] === 'string' && isNative(body['mimeType']);
  return createOrFind(
    ctx,
    account,
    body,
    (tagged) =>
      ctx.google.request<DriveFile>(account, SERVICE, {
        method: 'POST',
        url: filePath(id, '/copy'),
        query: { supportsAllDrives: true, fields: WRITE_FIELDS },
        body: tagged,
        timeoutMs: within(deadline, converting ? CONVERSION_TIMEOUT_MS : COPY_TIMEOUT_MS),
      }),
    deadline,
  );
}

/** Types Google's OCR reads into a Doc, under the names mail clients give them. */
const OCR_TYPES: Record<string, string> = {
  'application/pdf': 'application/pdf',
  'application/x-pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/bmp': 'image/bmp',
};

/** The type to give Google's OCR, or undefined when it reads no such file. */
export function ocrType(mime: string): string | undefined {
  return OCR_TYPES[baseMime(mime)];
}

/** The longest an OCR read may take, inside claude.ai's 240 s per tool call. */
const OCR_BUDGET_MS = 220_000;
/** The private property naming what a temporary OCR Doc was made from, so a retry after a timeout reuses it. */
const OCR_TAG = 'connectorOcr';

/**
 * The text of a scan (PDF or image) by Google's OCR: converted into a temporary Google Doc in the account's Drive,
 * exported as Markdown, then deleted. The source is a Drive file of the account, or bytes (an email attachment).
 * When Google takes longer than a tool call may, the Doc it finishes later is tagged with its source: the next call
 * for the same file reads that one instead of converting again.
 */
export async function ocrText(
  ctx: ToolContext,
  account: string,
  from: { fileId: string; name?: string } | { data: Buffer; mimeType: string; name?: string },
): Promise<{ text: string; note?: string }> {
  const deadline = Date.now() + OCR_BUDGET_MS;
  const source = createHash('sha256')
    .update('fileId' in from ? `drive:${from.fileId}` : from.data)
    .digest('base64url')
    .slice(0, 32);
  const name = `_ocr ${withoutExtension(from.name ?? 'scan')}`.slice(0, 200);
  let doc = (await filesTagged(ctx, account, OCR_TAG, source))[0];
  if (!doc) {
    const metadata = {
      name,
      parents: ['root'],
      mimeType: GOOGLE_MIME.document,
      description: 'Temporary copy for reading a scan; deleted right after.',
      appProperties: { [OCR_TAG]: source },
    };
    try {
      doc =
        'fileId' in from
          ? await copyWithinAccount(ctx, account, from.fileId, metadata, deadline)
          : await upload(ctx, account, { method: 'POST', metadata, media: { data: from.data, mimeType: ocrType(from.mimeType) ?? from.mimeType }, deadline });
    } catch (err) {
      if (!(err instanceof CreateTimeoutError)) throw err;
      throw new GoogleApiError(
        "Google's OCR did not finish in time (long scans take minutes). Call again with ocr: true in a minute or two: the text Google is still reading will be picked up then, not read again.",
        0,
        'timeout',
      );
    }
  }
  // Deleted whatever the export gives: permanently, as the copy is the connector's own and a trashed one would sit
  // in the user's trash for 30 days.
  const remove = async (): Promise<string | undefined> => {
    try {
      await ctx.google.request(account, SERVICE, { method: 'DELETE', url: filePath(doc.id ?? ''), query: { supportsAllDrives: true }, timeoutMs: within(deadline, 30_000) });
      return undefined;
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      ctx.log.info('drive ocr copy not deleted', { alias: account, status: err.status });
      return `The temporary Google Doc "${doc.name ?? name}" could not be deleted; trash it with drive_trash (${doc.id}).`;
    }
  };
  let exported: { text: string; mimeType: string };
  try {
    exported = await exportText(ctx, account, doc.id ?? '', exportPlan(GOOGLE_MIME.document)!, deadline);
  } catch (err) {
    const left = await remove();
    if (left && err instanceof GoogleApiError) throw new GoogleApiError(`${err.message} ${left}`, err.status, err.reason);
    throw err;
  }
  return { text: readableContent(exported.text, exported.mimeType), note: await remove() };
}

type CreateKind = NativeKind | 'file';

export function nativeKind(mime: string | undefined): NativeKind | undefined {
  if (mime === GOOGLE_MIME.document) return 'document';
  if (mime === GOOGLE_MIME.spreadsheet) return 'spreadsheet';
  if (mime === GOOGLE_MIME.presentation) return 'presentation';
  return undefined;
}

export function isNative(mime: string): boolean {
  return mime.startsWith('application/vnd.google-apps.');
}

/** The Office format each Google type imports from a ZIP package. */
const OFFICE_TYPE_FOR: Record<NativeKind, string> = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * Type of bytes replacing a file's content when none is given: from the new
 * name, the bytes themselves (a ZIP says little: Office files are ZIPs, and
 * one going into a Google Doc/Sheet/Slides deck can only be the matching Office
 * file), the file's current name, then its current type unless that is a Google type.
 */
function bytesType(data: Buffer, newName: string | undefined, current: DriveFile): string {
  const sniffed = sniffMime(data);
  const targetKind = nativeKind(current.mimeType);
  const currentType = current.mimeType && !isNative(current.mimeType) ? normalizeMime(current.mimeType, '') : '';
  return (
    mimeFromFilename(newName) ??
    (sniffed === 'application/zip' && targetKind ? OFFICE_TYPE_FOR[targetKind] : undefined) ??
    (sniffed !== 'application/zip' ? sniffed : undefined) ??
    mimeFromFilename(current.name) ??
    (currentType || (sniffed ?? 'application/octet-stream'))
  );
}

/** "Report.docx" → "Report": converted files are named like Drive's own import does. */
export function withoutExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, '') || name;
}

/** Uploads new content as a plain file, or converted into a Google Doc/Sheet/Slides deck. */
async function createWithMedia(ctx: ToolContext, account: string, kind: CreateKind, metadata: Record<string, unknown>, media: Media): Promise<DriveFile> {
  if (kind !== 'file') assertImportable(kind, media.mimeType);
  return upload(ctx, account, { method: 'POST', metadata: { ...metadata, mimeType: kind === 'file' ? undefined : GOOGLE_MIME[kind] }, media });
}

type CopySource = z.infer<typeof copySourceSchema>;

interface CopyTarget {
  kind?: CreateKind;
  name?: string;
  parents?: string[];
  description?: string;
}

/**
 * Creates a file from an existing one: a Drive file of this account is copied
 * inside Google (converted when kind asks for it); a Drive file of another
 * account or a Gmail attachment is downloaded and uploaded. A Google Doc, Sheet
 * or Slides deck from another account travels as docx/xlsx/pptx and becomes a
 * Google file again unless kind is "file".
 */
async function createFromSource(ctx: ToolContext, account: string, source: CopySource, target: CopyTarget): Promise<{ file: DriveFile; how: string }> {
  const fromDrive = sourceKind(source, 'source') === 'drive';
  const owner = (source.from_account?.trim() || account).toLowerCase();
  const { kind, name, parents, description } = target;
  // Without parents, files.copy puts the copy next to the original, possibly in a folder shared with others.
  const copyParents = parents ?? ['root'];

  if (fromDrive && owner === account.trim().toLowerCase() && !source.export_format) {
    const info = await driveSourceInfo(ctx, account, source.drive_file_id!);
    if (!isNative(info.mimeType)) {
      if (kind === undefined || kind === 'file') {
        return { file: await copyWithinAccount(ctx, account, info.id, { name: name ?? info.name, parents: copyParents, description }), how: 'copied within Drive' };
      }
      assertImportable(kind, info.mimeType);
      const file = await copyWithinAccount(ctx, account, info.id, { name: name ?? withoutExtension(info.name), parents: copyParents, description, mimeType: GOOGLE_MIME[kind] });
      return { file, how: `copied within Drive and converted to a Google ${kind}` };
    }
    if (kind === undefined || kind === nativeKind(info.mimeType)) {
      return { file: await copyWithinAccount(ctx, account, info.id, { name: name ?? info.name, parents: copyParents, description }), how: 'copied within Drive' };
    }
    if (kind !== 'file') {
      throw new DriveInputError(`A Google ${friendlyType(info.mimeType)} cannot become a ${kind}. Omit kind to copy it as it is, or use kind "file" (with export_format) to save it as a file.`);
    }
    // kind "file" for a Google Doc/Sheet/Slides: exported below.
  }

  const blob: FileBlob = forDrive(await resolveFile(ctx, account, { ...source }, { maxBytes: MAX_UPLOAD_BYTES, nativeDefault: 'office' }));
  const back = kind === undefined && !source.export_format ? nativeKind(blob.sourceMimeType) : undefined;
  const finalKind: CreateKind = kind ?? back ?? 'file';
  const convert = finalKind !== 'file';
  if (convert) assertImportable(finalKind, blob.mimeType);
  const fileName = name ?? (convert ? (blob.sourceName ?? withoutExtension(blob.filename)) : blob.filename);
  const file = await upload(ctx, account, {
    method: 'POST',
    metadata: { name: fileName, parents, description, mimeType: convert ? GOOGLE_MIME[finalKind] : undefined },
    media: { data: blob.data, mimeType: blob.mimeType },
  });
  return { file, how: `uploaded from ${blob.origin}${convert ? ` and converted to a Google ${finalKind}` : ''}` };
}

/** addParents/removeParents for moving into `target`, given the file's current parents. */
export function moveParams(currentParents: readonly string[], target: string): { addParents?: string; removeParents?: string } {
  const remove = currentParents.filter((p) => p !== target);
  return {
    addParents: currentParents.includes(target) ? undefined : target,
    removeParents: remove.length ? remove.join(',') : undefined,
  };
}

/* ---------- Tools ---------- */

/** One page of files.list over My Drive, shared drives and files shared with the account. */
export async function listFiles(ctx: ToolContext, account: string, opts: { q: string; orderBy?: string; pageSize: number; pageToken?: string }): Promise<FileList> {
  return ctx.google.request<FileList>(account, SERVICE, {
    url: '/files',
    query: {
      q: opts.q || undefined,
      orderBy: opts.orderBy ?? 'modifiedTime desc',
      pageSize: opts.pageSize,
      pageToken: opts.pageToken,
      fields: LIST_FIELDS,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
  });
}

const driveSearch = defineTool({
  name: 'drive_search',
  title: 'Search Drive files',
  description:
    'Searches or lists files in Google Drive (My Drive, shared drives and files shared with the account). Returns up to max_results entries {id, name, type, mime_type, modified_time, size, parents, path (the folders holding it, e.g. "My Drive/Appartements/Lisbonne"), owner, shared, web_view_link}, next_page_token when more exist, and q_used (the Drive query that was sent). With no filters it lists the most recently modified files. Read-only.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    query: z.string().optional().describe("Free-text search over file names and full text (sent as name contains 'x' or fullText contains 'x'). Ignored when raw_q is given."),
    raw_q: z
      .string()
      .optional()
      .describe(
        "Native Drive query used verbatim instead of query, e.g. \"name = 'Budget 2026' and modifiedTime > '2026-01-01T00:00:00'\". The folder_id, type, include_trashed and shared_with_me filters are still and-ed onto it.",
      ),
    folder_id: z.string().optional().describe("Only direct children of this folder: folder id, folder URL, or 'root' for the top level of My Drive."),
    type: z
      .enum(SEARCH_TYPES)
      .optional()
      .describe('Restrict to one kind (default any): folder, document (Google Docs), spreadsheet (Google Sheets), presentation (Google Slides), pdf, image, or other (none of those).'),
    include_trashed: z.boolean().optional().describe('Include trashed files (default false).'),
    order_by: z
      .string()
      .optional()
      .describe("Sort order (default 'modifiedTime desc'): comma-separated Drive keys, each optionally followed by ' desc': createdTime, folder, modifiedTime, name, recency, sharedWithMeTime, starred, viewedByMeTime."),
    max_results: z.number().int().min(1).max(100).optional().describe('Files per page, 1-100 (default 20).'),
    page_token: pageTokenParam,
    shared_with_me: z.boolean().optional().describe('Only files other people shared with this account (default false).'),
    include_paths: z.boolean().optional().describe('Add each file\'s folder path (default true; false saves the folder lookups).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const q = buildSearchQuery({
        query: args.query,
        rawQ: args.raw_q,
        folderId: args.folder_id ? extractFileId(args.folder_id) : undefined,
        type: args.type,
        includeTrashed: args.include_trashed ?? false,
        sharedWithMe: args.shared_with_me ?? false,
      });
      const list = await listFiles(ctx, args.account, { q, orderBy: args.order_by, pageSize: args.max_results ?? 20, pageToken: args.page_token });
      const found = list.files ?? [];
      const { paths, note } = args.include_paths === false ? { paths: [], note: undefined } : await folderPathsOf(ctx, args.account, found);
      const files = found.map((f, i) => ({ ...fileSummary(f), path: paths[i] }));
      return jsonResult({ files, next_page_token: list.nextPageToken, q_used: q || undefined, note: files.length === 0 ? 'No files matched.' : note });
    });
  },
});

const driveGetFile = defineTool({
  name: 'drive_get_file',
  title: 'Get Drive file and content',
  description:
    'Returns a file\'s metadata (id, name, type, size, times, parents, owner, sharing state, permissions [{id, type, role, email}], web_view_link) and, by default, its content: Google Docs are exported as markdown (plain text if Google refuses markdown), Google Sheets as CSV of the first tab only (use sheets_read for more), Google Slides as plain text; ' +
    'text files (text/*, JSON, XML, CSV, markdown) are read as-is; PDFs (text layer), Word (.docx), Excel (.xlsx, each sheet as CSV) and PowerPoint (.pptx) files are converted to text (extracted_from says from what); ' +
    'PNG/JPEG/GIF/WebP images and Google Drawings come back as an image you can look at, and other images, large images and scanned PDFs as Drive\'s preview image when there is one. Other binary files return content_note instead. ' +
    'ocr: true reads a scanned PDF or a photo of a document as text with Google\'s OCR, in one step (a temporary Google Doc is made and deleted right after; long scans take a minute or more). ' +
    'Long content is clipped to max_chars with truncated/total_chars/next_offset; call again with offset to continue. Read-only.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    file_id: fileIdParam,
    include_content: z.boolean().optional().describe('Fetch the content as text (default true). Set false for metadata and permissions only.'),
    max_chars: maxCharsParam(10_000),
    offset: offsetParam,
    export_format: z
      .enum(EXPORT_FORMATS)
      .optional()
      .describe('Override the export format for Google-native files: markdown, text or html for Docs; csv for Sheets; text for Slides. Default: markdown / csv / text.'),
    ocr: z
      .boolean()
      .optional()
      .describe('Read a scanned PDF or an image of a document as text with Google\'s OCR (when content_note says the PDF has no text). A temporary Google Doc is made and deleted.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const id = extractFileId(args.file_id);
      const file = await ctx.google.request<DriveFile>(args.account, SERVICE, { url: filePath(id), query: { fields: FILE_FIELDS, supportsAllDrives: true } });
      const maxChars = args.max_chars ?? 10_000;
      const offset = args.offset ?? 0;
      let read: () => Promise<ContentResult> = () => readContent(ctx, args.account, file, { maxChars, offset, format: args.export_format });
      if (args.ocr && args.include_content !== false) {
        const mime = file.mimeType ?? '';
        if (!ocrType(mime)) return errorResult(`ocr only applies to PDFs and images; this file is ${friendlyType(mime)} (${mime}). Call without ocr.`);
        read = async () => {
          const { text, note } = await ocrText(ctx, args.account, { fileId: id, name: file.name });
          const out = clippedText(text, 'text/markdown', maxChars, offset, note);
          return { ...out, extracted_from: 'ocr', content_note: text.trim() ? out.content_note : 'Google\'s OCR found no text in the file.' };
        };
      }
      const { image, ...content }: ContentResult = args.include_content === false ? {} : await read();
      const result = jsonResult({
        ...fileSummary(file),
        created_time: file.createdTime,
        owner_name: file.owners?.[0]?.displayName,
        description: file.description,
        permissions: file.permissions?.map(permissionSummary),
        ...content,
      });
      return image ? withImage(result, image) : result;
    });
  },
});

const sourceParam = copySourceSchema
  .optional()
  .describe(
    'Copy an existing file instead of giving content: {drive_file_id} copies a Drive file (add from_account for a file of another linked account; export_format saves a Google Doc/Sheet/Slides as pdf, docx, xlsx, ...), {gmail_message_id, gmail_part_id} saves an email attachment, {upload_id} saves a file from this chat (staged with create_upload_link or upload_file). A copy within one account happens inside Google; other sources go through the connector, up to 50 MB.',
  );

const driveCreateFile = defineTool({
  name: 'drive_create_file',
  title: 'Create Drive file or folder',
  description:
    'Creates a folder, a Google Doc/Sheet/Slides deck, or a plain file in Drive, optionally inside parent_folder_id. Content comes from exactly one of: `content` (text), `content_base64` (bytes) or `source` (an existing Drive file or email attachment, possibly of another linked account). ' +
    'With kind document/spreadsheet/presentation, Google converts the content: text, Markdown, HTML, Word, RTF, PDF or images (OCR) into a Doc; CSV, TSV or Excel into a Sheet; PowerPoint into Slides. kind=file stores it as it is. ' +
    'A Google Doc/Sheet/Slides copied from another account stays a Google file unless kind is file. Returns {id, name, type, mime_type, web_view_link, parents} and how a copy was made. Not destructive; calling twice creates two files.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    name: z.string().min(1).optional().describe("File or folder name, with an extension for plain files. Optional with `source` (defaults to the source's name)."),
    kind: z
      .enum(['folder', 'document', 'spreadsheet', 'presentation', 'file'])
      .optional()
      .describe("What to create: folder, document (Google Docs), spreadsheet (Google Sheets), presentation (Google Slides), or file (content stored as it is). Default file, or the source's own kind when copying a Google Doc/Sheet/Slides."),
    content: z.string().optional().describe('Text content. Omit all content to create an empty document/spreadsheet/presentation/file.'),
    content_base64: z.string().optional().describe('Binary content, base64-encoded (e.g. a PDF or image you produced). The type comes from content_mime_type, the name extension, or the bytes.'),
    content_mime_type: contentMimeParam('default text/plain, or text/csv when kind is spreadsheet; for content_base64, inferred from the name'),
    source: sourceParam,
    parent_folder_id: z.string().optional().describe("Folder to create in: folder id, folder URL, or 'root' (default: the root of My Drive)."),
    description: z.string().optional().describe('Optional description shown in Drive file details.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const given = (['content', 'content_base64', 'source'] as const).filter((k) => args[k] !== undefined);
      if (given.length > 1) return errorResult(`Give only one of content, content_base64 or source (got ${given.join(' and ')}).`);
      const parents = args.parent_folder_id ? [extractFileId(args.parent_folder_id)] : undefined;
      let created: DriveFile;
      let how: string | undefined;
      if (args.kind === 'folder') {
        if (given.length) return errorResult(`A folder cannot have content; drop \`${given[0]}\` or choose another kind.`);
        if (!args.name) return errorResult('name is required for a folder.');
        created = await createMetadataOnly(ctx, args.account, { name: args.name, parents, description: args.description, mimeType: GOOGLE_MIME.folder });
      } else if (args.source) {
        ({ file: created, how } = await createFromSource(ctx, args.account, args.source, { kind: args.kind, name: args.name, parents, description: args.description }));
      } else {
        if (!args.name) return errorResult('name is required (it is optional only when copying from source).');
        const kind = args.kind ?? 'file';
        const metadata = { name: args.name, parents, description: args.description };
        if (args.content_base64 !== undefined) {
          const data = decodeBase64Strict(args.content_base64, args.name);
          if (data.length > MAX_UPLOAD_BYTES) return errorResult(`content_base64 is ${mb(data.length)} MB, above the ${mb(MAX_UPLOAD_BYTES)} MB limit.`);
          const mimeType = args.content_mime_type ? normalizeMime(args.content_mime_type) : (mimeFromFilename(args.name) ?? sniffMime(data) ?? 'application/octet-stream');
          created = await createWithMedia(ctx, args.account, kind, metadata, { data, mimeType });
        } else {
          // Drive imports text/plain into a Doc but not into a Sheet (only csv/tsv and
          // spreadsheet binaries), so a spreadsheet's content is csv unless told otherwise.
          const mediaType = args.content_mime_type ? normalizeMime(args.content_mime_type) : kind === 'spreadsheet' ? 'text/csv' : 'text/plain';
          if (args.content === undefined) {
            created = await createMetadataOnly(ctx, args.account, { ...metadata, mimeType: kind === 'file' ? mediaType : GOOGLE_MIME[kind] });
          } else if (kind === 'presentation') {
            // Drive's import formats for Slides are only pptx/odp-style binaries, never text.
            return errorResult('Google cannot convert text into a presentation. Create it without `content` (or from a PowerPoint file via source or content_base64), then edit it in Google Slides.');
          } else {
            created = await createWithMedia(ctx, args.account, kind, metadata, { data: Buffer.from(args.content, 'utf8'), mimeType: mediaType });
          }
        }
      }
      ctx.log.info('drive file created', { alias: args.account, kind: args.kind ?? (args.source ? 'copy' : 'file'), recovered: created.recovered });
      return jsonResult({
        id: created.id,
        name: created.name,
        type: friendlyType(created.mimeType),
        mime_type: created.mimeType,
        size: sizeBytes(created),
        web_view_link: created.webViewLink,
        parents: created.parents,
        how,
        note: created.recovered ? 'Google took longer than expected but created the file; it is not duplicated.' : undefined,
      });
    });
  },
});

const driveUpdateFile = defineTool({
  name: 'drive_update_file',
  title: 'Rename, move or update Drive file',
  description:
    'Updates an existing file: rename, change description, move to another folder (replaces all current parents), star/unstar, restore from trash, or replace its content with `content` (text), `content_base64` (bytes) or `source` (another Drive file or an email attachment); for a Google Doc/Sheet the new content is converted, replacing the whole document. ' +
    'Only the given fields change. Returns the updated metadata {id, name, type, mime_type, modified_time, size, parents, web_view_link, starred, trashed}. Not destructive, but replacing content overwrites the previous version (Drive keeps revisions).',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    file_id: fileIdParam,
    name: z.string().min(1).optional().describe('New name.'),
    description: z.string().optional().describe('New description (empty string clears it).'),
    move_to_folder_id: z.string().optional().describe("Destination folder id, folder URL, or 'root'. The file is removed from its current folders."),
    starred: z.boolean().optional().describe('Star (true) or unstar (false) the file.'),
    restore_from_trash: z.boolean().optional().describe('true takes the file out of the trash.'),
    content: z.string().optional().describe('New text content replacing the current content entirely.'),
    content_base64: z.string().optional().describe('New binary content, base64-encoded, replacing the current content entirely.'),
    content_mime_type: contentMimeParam('default text/plain for content; for content_base64, detected from the bytes or the current file'),
    source: copySourceSchema.optional().describe('Replace the content with that of an existing file: {drive_file_id} (from_account for another linked account), {gmail_message_id, gmail_part_id}, or {upload_id} (a file staged from this chat).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const id = extractFileId(args.file_id);
      const metadata = { name: args.name, description: args.description, starred: args.starred, trashed: args.restore_from_trash ? false : undefined };
      const hasMetadata = Object.values(metadata).some((v) => v !== undefined);
      const given = (['content', 'content_base64', 'source'] as const).filter((k) => args[k] !== undefined);
      if (given.length > 1) return errorResult(`Give only one of content, content_base64 or source (got ${given.join(' and ')}).`);
      if (!hasMetadata && !args.move_to_folder_id && given.length === 0) {
        return errorResult('Nothing to update: give at least one of name, description, move_to_folder_id, starred, restore_from_trash, content, content_base64 or source.');
      }
      let media: Media | undefined;
      if (args.content !== undefined) {
        media = { data: Buffer.from(args.content, 'utf8'), mimeType: args.content_mime_type ? normalizeMime(args.content_mime_type) : 'text/plain' };
      } else if (args.content_base64 !== undefined || args.source) {
        // Bytes replacing a file: the file's current name and type help type them, and a Google file only takes what Google converts.
        const current = await ctx.google.request<DriveFile>(args.account, SERVICE, { url: filePath(id), query: { fields: 'name,mimeType', supportsAllDrives: true } });
        if (args.content_base64 !== undefined) {
          const data = decodeBase64Strict(args.content_base64, args.name ?? current.name ?? id);
          if (data.length > MAX_UPLOAD_BYTES) return errorResult(`content_base64 is ${mb(data.length)} MB, above the ${mb(MAX_UPLOAD_BYTES)} MB limit.`);
          media = { data, mimeType: args.content_mime_type ? normalizeMime(args.content_mime_type) : bytesType(data, args.name, current) };
        } else {
          const s = args.source!;
          sourceKind(s, 'source');
          const blob = forDrive(await resolveFile(ctx, args.account, { ...s }, { maxBytes: MAX_UPLOAD_BYTES, nativeDefault: 'office' }));
          media = { data: blob.data, mimeType: args.content_mime_type ? normalizeMime(args.content_mime_type) : blob.mimeType };
        }
        const currentType = current.mimeType ?? '';
        if (isNative(currentType)) {
          const kind = nativeKind(currentType);
          if (!kind) throw new DriveInputError(`The content of a Google ${friendlyType(currentType)} cannot be replaced by uploading a file.`);
          assertImportable(kind, media.mimeType);
        }
      }
      let move: Record<string, QueryValue> = {};
      if (args.move_to_folder_id) {
        const target = extractFileId(args.move_to_folder_id);
        const current = await ctx.google.request<DriveFile>(args.account, SERVICE, { url: filePath(id), query: { fields: 'parents', supportsAllDrives: true } });
        move = moveParams(current.parents ?? [], target);
      }
      const updated =
        media === undefined
          ? await ctx.google.request<DriveFile>(args.account, SERVICE, {
              method: 'PATCH',
              url: filePath(id),
              query: { ...move, supportsAllDrives: true, fields: WRITE_FIELDS },
              body: withoutUndefined(metadata),
            })
          : await upload(ctx, args.account, { method: 'PATCH', fileId: id, metadata, media, query: move });
      ctx.log.info('drive file updated', { alias: args.account, moved: Boolean(args.move_to_folder_id), content: media !== undefined });
      return jsonResult({ ...fileSummary(updated), description: updated.description });
    });
  },
});

const driveShare = defineTool({
  name: 'drive_share',
  title: 'Share Drive file',
  description:
    'Adds a permission on a file (action=add: share with a user or group by email, with a whole domain, or with anyone who has the link) or removes one (action=remove with permission_id, as listed by drive_get_file). Adding sends Google\'s notification email to users/groups unless notify=false. Returns {permission_id, type, role, email, web_view_link} on add, or a removal confirmation. Sharing is a write, not a deletion.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    file_id: fileIdParam,
    action: z.enum(['add', 'remove']).optional().describe('add (default) grants access; remove revokes the permission named by permission_id.'),
    type: z.enum(['user', 'group', 'domain', 'anyone']).optional().describe('Who gets access on add (default user): user or group (needs email_address), domain (needs domain), anyone (link sharing).'),
    email_address: z.string().optional().describe('Email of the user or group to share with (add, type user/group).'),
    domain: z.string().optional().describe('Domain to share with, e.g. example.com (add, type domain).'),
    role: z.enum(['reader', 'commenter', 'writer']).optional().describe('Access level to grant (default reader).'),
    notify: z.boolean().optional().describe('Send Google\'s notification email to the user/group (default true). Ignored for domain and anyone.'),
    message: z.string().optional().describe('Personal message included in the notification email (user/group only).'),
    permission_id: z.string().optional().describe('Permission to revoke (action=remove); get ids from drive_get_file permissions.'),
    reviewed_by_user: reviewedByUserParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const id = extractFileId(args.file_id);
      if (args.action === 'remove') {
        if (!args.permission_id) return errorResult('permission_id is required for action=remove (see drive_get_file permissions).');
        await ctx.google.request(args.account, SERVICE, { method: 'DELETE', url: filePath(id, `/permissions/${encodeURIComponent(args.permission_id)}`), query: { supportsAllDrives: true } });
        ctx.log.info('drive permission removed', { alias: args.account });
        return jsonResult({ file_id: id, permission_id: args.permission_id, removed: true });
      }
      const type = args.type ?? 'user';
      const isPerson = type === 'user' || type === 'group';
      if (isPerson && !args.email_address) return errorResult(`email_address is required when type is ${type}.`);
      if (type === 'domain' && !args.domain) return errorResult('domain is required when type is domain.');
      const held =
        isPerson && (args.notify ?? true)
          ? notificationRefusal(ctx, [args.email_address!], "Google's sharing notification (with your message)", args.reviewed_by_user, 'share with notify: false')
          : undefined;
      if (held) return errorResult(held);
      const file = await ctx.google.request<DriveFile>(args.account, SERVICE, { url: filePath(id), query: { fields: 'name,webViewLink', supportsAllDrives: true } });
      const permission = await ctx.google.request<DrivePermission>(args.account, SERVICE, {
        method: 'POST',
        url: filePath(id, '/permissions'),
        // sendNotificationEmail/emailMessage are only accepted for user and group permissions.
        query: {
          supportsAllDrives: true,
          sendNotificationEmail: isPerson ? (args.notify ?? true) : undefined,
          emailMessage: isPerson ? args.message : undefined,
          fields: 'id,type,role,emailAddress,domain',
        },
        body: stripEmpty({
          type,
          role: args.role ?? 'reader',
          emailAddress: isPerson ? args.email_address : undefined,
          domain: type === 'domain' ? args.domain : undefined,
          // "anyone with the link": never make the file discoverable by search.
          allowFileDiscovery: type === 'anyone' ? false : undefined,
        }),
      });
      ctx.log.info('drive permission added', { alias: args.account, type, role: args.role ?? 'reader' });
      return jsonResult({
        file_id: id,
        file_name: file.name,
        permission_id: permission.id,
        type: permission.type,
        role: permission.role,
        email: permission.emailAddress,
        domain: permission.domain,
        web_view_link: file.webViewLink,
      });
    });
  },
});

const driveTrash = defineTool({
  name: 'drive_trash',
  title: 'Move Drive file to trash',
  description:
    'Moves a file or folder (with its contents) to the Drive trash. Google empties the trash after 30 days. Returns {id, name, trashed: true}. Undo with drive_update_file restore_from_trash=true.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    file_id: fileIdParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const id = extractFileId(args.file_id);
      const file = await ctx.google.request<DriveFile>(args.account, SERVICE, {
        method: 'PATCH',
        url: filePath(id),
        query: { supportsAllDrives: true, fields: 'id,name,mimeType,trashed' },
        body: { trashed: true },
      });
      ctx.log.info('drive file trashed', { alias: args.account });
      return jsonResult({ id: file.id, name: file.name, type: friendlyType(file.mimeType), trashed: file.trashed ?? true, note: 'Restore with drive_update_file restore_from_trash=true.' });
    });
  },
});

export const driveTools: ToolDefinition[] = [driveSearch, driveGetFile, driveCreateFile, driveUpdateFile, driveShare, driveTrash];
