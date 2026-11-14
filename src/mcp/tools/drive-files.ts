/**
 * Pure helpers for the Drive tools: file-id extraction from URLs, building the
 * Drive `q` expression, MIME classification, export planning and the
 * multipart/related upload body. No I/O here, so everything is unit-testable.
 */
import { randomBytes } from 'node:crypto';

/** An argument Claude can fix (bad URL, unsupported export format, ...). */
export class DriveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveInputError';
  }
}

export const GOOGLE_MIME = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
  shortcut: 'application/vnd.google-apps.shortcut',
} as const;

const GOOGLE_MIME_PREFIX = 'application/vnd.google-apps.';

/* ---------- File ids ---------- */

const FILE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Accepts a bare id ('root' included) or any Drive / Docs / Sheets / Slides URL:
 * .../d/<id>/..., .../folders/<id>, ...?id=<id>.
 */
export function extractFileId(input: string): string {
  const raw = input.trim();
  if (FILE_ID_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DriveInputError(`"${input}" is neither a Drive file id nor a Google Drive/Docs/Sheets/Slides URL.`);
  }
  const fromPath = url.pathname.match(/\/(?:d|folders)\/([A-Za-z0-9_-]+)/)?.[1];
  const id = fromPath ?? url.searchParams.get('id');
  if (!id || !FILE_ID_RE.test(id)) {
    throw new DriveInputError(`Could not find a file id in "${input}". Expected .../d/<id>/..., .../folders/<id> or ?id=<id>.`);
  }
  return id;
}

/* ---------- Search query ---------- */

export const SEARCH_TYPES = ['any', 'folder', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'other'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchQueryOptions {
  query?: string;
  rawQ?: string;
  folderId?: string;
  type?: SearchType;
  includeTrashed?: boolean;
  sharedWithMe?: boolean;
}

/** Drive string literals use single quotes; a quote or backslash inside is backslash-escaped. */
export function escapeQ(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const KNOWN_MIMES = [GOOGLE_MIME.folder, GOOGLE_MIME.document, GOOGLE_MIME.spreadsheet, GOOGLE_MIME.presentation, 'application/pdf'];

function typeTerm(type: SearchType): string | undefined {
  switch (type) {
    case 'any':
      return undefined;
    case 'pdf':
      return "mimeType = 'application/pdf'";
    case 'image':
      return "mimeType contains 'image/'";
    case 'other':
      // Everything the named kinds do not cover. Drive's q supports `not` and `!=`.
      return [...KNOWN_MIMES.map((m) => `mimeType != '${m}'`), "not mimeType contains 'image/'"].join(' and ');
    default:
      return `mimeType = '${GOOGLE_MIME[type]}'`;
  }
}

/** Builds the `q` expression; returns '' when nothing restricts the listing. */
export function buildSearchQuery(opts: SearchQueryOptions): string {
  const terms: string[] = [];
  const rawQ = opts.rawQ?.trim();
  const query = opts.query?.trim();
  if (rawQ) terms.push(`(${rawQ})`);
  else if (query) terms.push(`(name contains '${escapeQ(query)}' or fullText contains '${escapeQ(query)}')`);
  if (opts.folderId) terms.push(`'${escapeQ(opts.folderId)}' in parents`);
  const t = typeTerm(opts.type ?? 'any');
  if (t) terms.push(t);
  if (!opts.includeTrashed) terms.push('trashed = false');
  if (opts.sharedWithMe) terms.push('sharedWithMe = true');
  return terms.join(' and ');
}

/* ---------- MIME classification ---------- */

/** Content we can hand to Claude as text via alt=media. */
export function isTextLike(mime: string): boolean {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  return (
    m.startsWith('text/') ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/javascript' ||
    /\+(xml|json)$/.test(m) ||
    /csv|markdown|yaml|x-sh$|x-python/.test(m)
  );
}

/** Short kind name for listings: folder, document, spreadsheet, presentation, pdf, image, text, word, ... */
export function friendlyType(mime: string | undefined): string {
  if (!mime) return 'other';
  if (mime.startsWith(GOOGLE_MIME_PREFIX)) return mime.slice(GOOGLE_MIME_PREFIX.length);
  if (mime === 'application/pdf') return 'pdf';
  for (const media of ['image', 'video', 'audio']) if (mime.startsWith(`${media}/`)) return media;
  if (isTextLike(mime)) return 'text';
  if (/wordprocessingml|msword|opendocument\.text/.test(mime)) return 'word';
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return 'excel';
  if (/presentationml|ms-powerpoint|opendocument\.presentation/.test(mime)) return 'powerpoint';
  if (/zip|compressed|gzip|x-tar/.test(mime)) return 'archive';
  return 'other';
}

/* ---------- Exports of Google-native files ---------- */

export const EXPORT_FORMATS = ['markdown', 'text', 'csv', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const EXPORT_MIME: Record<ExportFormat, string> = { markdown: 'text/markdown', text: 'text/plain', csv: 'text/csv', html: 'text/html' };

/** Export formats Google offers per native type, default first. */
const SUPPORTED_EXPORTS: Record<string, readonly ExportFormat[]> = {
  [GOOGLE_MIME.document]: ['markdown', 'text', 'html'],
  [GOOGLE_MIME.spreadsheet]: ['csv'],
  [GOOGLE_MIME.presentation]: ['text'],
};

export interface ExportPlan {
  mimeType: string;
  /** Tried when Google rejects mimeType (Docs markdown export is newer than the rest and may be refused). */
  fallbackMimeType?: string;
  note?: string;
}

/** Undefined when the MIME type is not an exportable Google-native type. */
export function exportPlan(mime: string, format?: ExportFormat): ExportPlan | undefined {
  const supported = SUPPORTED_EXPORTS[mime];
  if (!supported) return undefined;
  if (format && !supported.includes(format)) {
    throw new DriveInputError(`export_format "${format}" is not available for a Google ${friendlyType(mime)}; use ${supported.join(' or ')}.`);
  }
  const chosen = format ?? supported[0]!;
  const plan: ExportPlan = { mimeType: EXPORT_MIME[chosen] };
  if (mime === GOOGLE_MIME.document && chosen === 'markdown') plan.fallbackMimeType = EXPORT_MIME.text;
  if (mime === GOOGLE_MIME.spreadsheet) plan.note = 'CSV export covers the first tab only; use sheets_read for other tabs or cell-level access.';
  return plan;
}

/* ---------- Conversion into Google files ---------- */

export type NativeKind = 'document' | 'spreadsheet' | 'presentation';

/** What Google converts into each native type on upload or copy (Drive's about.importFormats, condensed). */
const IMPORTABLE: Record<NativeKind, RegExp> = {
  document:
    /^(text\/(plain|html|markdown|rtf)|application\/(rtf|pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.(document|template)|vnd\.oasis\.opendocument\.text|vnd\.ms-word\.[a-z.0-9]+)|image\/(jpeg|pjpeg|png|gif|bmp|x-bmp))$/,
  spreadsheet:
    /^(text\/(csv|tab-separated-values|comma-separated-values)|application\/(csv|vnd\.ms-excel(\.[a-z.0-9]+)?|vnd\.openxmlformats-officedocument\.spreadsheetml\.(sheet|template)|(x-)?vnd\.oasis\.opendocument\.spreadsheet))$/,
  presentation: /^application\/(vnd\.ms-powerpoint(\.[a-z.0-9]+)?|vnd\.openxmlformats-officedocument\.presentationml\.(presentation|template|slideshow)|vnd\.oasis\.opendocument\.presentation)$/,
};

const IMPORT_HINT: Record<NativeKind, string> = {
  document: 'Word (.docx, .doc), OpenDocument text, RTF, HTML, Markdown, plain text, PDF or an image (read by OCR)',
  spreadsheet: 'Excel (.xlsx, .xls), OpenDocument spreadsheets, CSV or TSV',
  presentation: 'PowerPoint (.pptx, .ppt) or OpenDocument presentations',
};

const KIND_NAME: Record<NativeKind, string> = { document: 'Google Doc', spreadsheet: 'Google Sheet', presentation: 'Google Slides deck' };

function bareMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

export function assertImportable(kind: NativeKind, mime: string): void {
  const m = bareMime(mime);
  if (!IMPORTABLE[kind].test(m)) {
    throw new DriveInputError(`Google cannot convert ${m || 'this content'} into a ${KIND_NAME[kind]}; it converts ${IMPORT_HINT[kind]}. Use kind "file" to store it as it is.`);
  }
}

/** The Google file type this content can be converted into, when there is one (PDFs and images: a Doc, by OCR). */
export function convertibleKind(mime: string): NativeKind | undefined {
  const m = bareMime(mime);
  return (['document', 'spreadsheet', 'presentation'] as const).find((k) => IMPORTABLE[k].test(m));
}

/* ---------- Uploads ---------- */

export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

/**
 * Builds the multipart/related body Drive expects for uploadType=multipart:
 * a JSON metadata part followed by the media part.
 */
export function multipartRelated(metadata: Record<string, unknown>, media: Buffer, mediaType: string, boundary = randomBytes(16).toString('hex')): MultipartBody {
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`, 'utf8'),
    media,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ];
  return { body: Buffer.concat(parts), contentType: `multipart/related; boundary=${boundary}` };
}

/** Text media types get an explicit UTF-8 charset so Drive decodes non-ASCII content correctly. */
export function withUtf8Charset(mime: string): string {
  return mime.startsWith('text/') && !/charset=/i.test(mime) ? `${mime}; charset=UTF-8` : mime;
}
