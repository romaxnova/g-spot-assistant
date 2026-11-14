/**
 * drive_save: keeps documents for next time. Files the user uploaded in the
 * chat, email attachments and Drive files of any linked account are saved into
 * a Drive folder, named by id/URL or by a path from the top of My Drive
 * ("Appartements/Lisbonne/Contrats", missing folders created) or of a shared
 * drive (as drive_search shows its paths), so a later request finds them with
 * drive_search instead of asking for a new upload. Path walks of one account
 * run one at a time, so calls made at once never create a folder twice.
 *
 * - A file whose identical bytes are already in the folder is not saved again:
 *   its MD5 is compared with the md5Checksum Drive keeps for every binary file
 *   (the folder's children are listed once per call, up to 1000). A Google
 *   Doc/Sheet/Slides deck has no checksum: one of the same type and name counts.
 * - A Drive file of the same account is copied inside Google (files.copy, no
 *   bytes through the connector); every other source is resolved like any file
 *   source (file-sources.ts) and uploaded. A Google Doc/Sheet/Slides deck of
 *   another account travels as docx/xlsx/pptx and becomes a Google file again.
 * - Each file succeeds or fails on its own: one bad source never loses the others.
 *
 * Logs carry counts only: never names, paths, descriptions or sources.
 */
import { createHash } from 'node:crypto';
import * as z from 'zod';
import { AccountError, GoogleApiError } from '../../google/client.js';
import { extensionForMime, extensionOf, mimeFromFilename } from '../file-types.js';
import { accountParam, defineTool, jsonResult, ToolInputError, type ToolContext } from '../registry.js';
import { copyWithinAccount, createMetadataOnly, isNative, MAX_UPLOAD_BYTES, nativeKind, sizeBytes, upload, withInputErrors, withoutExtension, type DriveFile } from './drive.js';
import { DriveInputError, escapeQ, extractFileId, friendlyType, GOOGLE_MIME } from './drive-files.js';
import { FolderPaths, MY_DRIVE, SHARED_DRIVE } from './drive-paths.js';
import { forDrive, isLinkId, linkFiles, resolveFile, sourceKind, type FileSpec } from './file-sources.js';

const SERVICE = 'drive' as const;
/** Files saved by one call once upload links are expanded (one link carries up to 50). */
export const MAX_SAVE_FILES = 50;
/** No file is started after this long, well inside claude.ai's 240 s per tool call; the rest are reported for another call. */
const TIME_BUDGET_MS = 120_000;
/** Children of the target folder compared for duplicates. */
const MAX_CHILDREN = 1000;

/* ---------- Target folder ---------- */

interface FolderTarget {
  id: string;
  path: string;
  webViewLink?: string;
  created: string[];
  ambiguous?: boolean;
}

interface FolderMeta extends DriveFile {
  md5Checksum?: string;
}

/** A Drive URL, or one word that looks like a Drive id (15+ letters, digits, - or _, with a digit), names a folder by id; anything else is a path. */
function folderIdOf(input: string): string | undefined {
  if (/^https?:\/\//i.test(input)) return extractFileId(input);
  return /^[A-Za-z0-9_-]{15,}$/.test(input) && /\d/.test(input) ? input : undefined;
}

/** Several names of a path are tried as one folder name when the first is missing ("Ugovori 2014/2015"); at most this many. */
const MAX_JOINED = 3;

interface ParsedPath {
  segments: string[];
  /** The same segments untrimmed, so that a name holding " / " ("Bills / Receipts") is looked for as written. */
  written: string[];
  /** The path starts with My Drive, so its first folder is never looked for among shared drives. */
  myDrive: boolean;
}

/** "My Drive/Appartements//Lisbonne/" → ["Appartements", "Lisbonne"]: trimmed, empty segments and a leading My Drive dropped. */
export function parsePath(path: string): ParsedPath {
  const written = path.split('/').filter((s) => s.trim());
  const segments = written.map((s) => s.trim());
  const myDrive = segments[0]?.toLowerCase() === MY_DRIVE.toLowerCase();
  if (myDrive) {
    segments.shift();
    written.shift();
  }
  if (segments.some((s) => /^(?:…|\.{2,3})$/.test(s))) {
    throw new DriveInputError(`"${path}" is not a complete path ("…" and ".." cannot be resolved). Give the folder id instead (drive_search shows it in parents).`);
  }
  if (!myDrive && segments[0]?.toLowerCase() === SHARED_DRIVE.toLowerCase()) {
    throw new DriveInputError(`"${path}" is in a shared drive whose name could not be read: give the folder id instead (drive_search shows it in parents).`);
  }
  return { segments, written, myDrive };
}

/** Names that segments i..i+n-1 may stand for: one segment, or several joined as written ("Bills / Receipts") and tightly ("Ugovori 2014/2015"). */
function namesAt(path: ParsedPath, i: number, n: number): string[] {
  const tight = path.segments.slice(i, i + n).join('/');
  const asWritten = path.written.slice(i, i + n).join('/').trim();
  return n === 1 || asWritten === tight ? [tight] : [asWritten, tight];
}

async function childFolders(ctx: ToolContext, account: string, parent: string, name: string): Promise<DriveFile[]> {
  const q = `name = '${escapeQ(name)}' and mimeType = '${GOOGLE_MIME.folder}' and '${escapeQ(parent)}' in parents and trashed = false`;
  const list = await ctx.google.request<{ files?: DriveFile[] }>(account, SERVICE, {
    url: '/files',
    query: { q, fields: 'files(id,name,createdTime,webViewLink)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true },
  });
  return list.files ?? [];
}

/** Shared drives of this name the account belongs to (a personal account has none). */
async function sharedDrives(ctx: ToolContext, account: string, name: string): Promise<DriveFile[]> {
  const list = await ctx.google.request<{ drives?: DriveFile[] }>(account, SERVICE, {
    url: '/drives',
    query: { q: `name = '${escapeQ(name)}'`, fields: 'drives(id,name,createdTime)', pageSize: 10 },
  });
  return list.drives ?? [];
}

function oldest(folders: DriveFile[]): DriveFile | undefined {
  return [...folders].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0];
}

/**
 * Path walks of one account run one at a time (one instance serves every
 * call): two calls saving at once into the same missing folder create it once,
 * the second finding what the first created.
 */
const walks = new Map<string, Promise<unknown>>();

async function oneWalkAtATime<T>(account: string, walk: () => Promise<T>): Promise<T> {
  const key = account.trim().toLowerCase();
  const run = (walks.get(key) ?? Promise.resolve()).then(walk);
  const settled = run.catch(() => undefined);
  walks.set(key, settled);
  try {
    return await run;
  } finally {
    if (walks.get(key) === settled) walks.delete(key);
  }
}

/**
 * Walks (and, when allowed, creates) a path from the top of My Drive, or of a
 * shared drive when the first name is no My Drive folder but a shared drive's
 * (drive_search shows "<shared drive>/Contracts"). A missing name is also
 * tried joined with the next ones, since a folder name may contain "/"
 * (with its spaces, as drive_search shows it, then without).
 */
async function folderByPath(ctx: ToolContext, account: string, path: ParsedPath, createFolders: boolean): Promise<FolderTarget> {
  const { segments } = path;
  const target: FolderTarget = { id: 'root', path: MY_DRIVE, created: [] };
  const names = [MY_DRIVE];
  for (let i = 0; i < segments.length; ) {
    let folder: DriveFile | undefined;
    let used = 1;
    // Below a folder this call created there is nothing to look for.
    for (let n = 1; !target.created.length && !folder && n <= Math.min(MAX_JOINED, segments.length - i); n++) {
      for (const name of namesAt(path, i, n)) {
        const matches = await childFolders(ctx, account, target.id, name);
        if (matches.length > 1) target.ambiguous = true;
        folder = oldest(matches);
        if (folder) break;
      }
      used = n;
    }
    if (!folder && i === 0 && !path.myDrive) {
      const drives = await sharedDrives(ctx, account, segments[0]!);
      const drive = oldest(drives);
      if (drive?.id) {
        if (drives.length > 1) target.ambiguous = true;
        target.id = drive.id;
        names[0] = drive.name ?? segments[0]!;
        i = 1;
        continue;
      }
    }
    if (!folder) {
      const segment = segments[i]!;
      if (!createFolders) {
        throw new DriveInputError(`There is no folder "${segment}" in ${names.join('/')}. Set create_folders to create it, or choose an existing folder (drive_search type "folder" lists folders: give a folder's id, or its path followed by its name).`);
      }
      folder = await createMetadataOnly(ctx, account, { name: segment, parents: [target.id], mimeType: GOOGLE_MIME.folder });
      target.created.push(segment);
      used = 1;
    }
    if (!folder.id) throw new GoogleApiError('Drive returned a folder without an id.', 0, 'invalid_response');
    target.id = folder.id;
    target.webViewLink = folder.webViewLink;
    names.push(folder.name ?? segments.slice(i, i + used).join('/'));
    i += used;
  }
  target.path = names.join('/');
  return target;
}

async function folderById(ctx: ToolContext, account: string, id: string): Promise<FolderTarget> {
  const get = async (fileId: string) => {
    try {
      return await ctx.google.request<FolderMeta>(account, SERVICE, {
        url: `/files/${encodeURIComponent(fileId)}`,
        query: { fields: 'id,name,mimeType,webViewLink,trashed,shortcutDetails', supportsAllDrives: true },
      });
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) {
        throw new DriveInputError(`No folder "${fileId}" in this account's Drive. To name a folder rather than give its id, write it as a path, e.g. "${MY_DRIVE}/${fileId}".`);
      }
      throw err;
    }
  };
  let folder = await get(id);
  if (folder.mimeType === GOOGLE_MIME.shortcut && folder.shortcutDetails?.targetId) folder = await get(folder.shortcutDetails.targetId);
  if (folder.mimeType !== GOOGLE_MIME.folder) throw new DriveInputError(`"${folder.name ?? id}" is a ${friendlyType(folder.mimeType)}, not a folder.`);
  if (folder.trashed) throw new DriveInputError(`The folder "${folder.name ?? id}" is in the trash: restore it first (drive_update_file restore_from_trash) or choose another.`);
  const folderId = folder.id ?? id;
  return { id: folderId, path: await new FolderPaths(ctx, account).folderPath(folderId), webViewLink: folder.webViewLink, created: [] };
}

async function resolveFolder(ctx: ToolContext, account: string, folder: string | undefined, createFolders: boolean): Promise<FolderTarget> {
  const raw = folder?.trim() ?? '';
  if (raw.toLowerCase() === 'root') return { id: 'root', path: MY_DRIVE, created: [] };
  const id = raw ? folderIdOf(raw) : undefined;
  if (id) return folderById(ctx, account, id);
  const path = parsePath(raw);
  return oneWalkAtATime(account, () => folderByPath(ctx, account, path, createFolders));
}

/* ---------- Duplicates ---------- */

interface Child {
  id?: string;
  name?: string;
  mimeType?: string;
  md5Checksum?: string;
  size?: string;
  webViewLink?: string;
}

/** The target folder's files, listed on first use, plus the ones this call saved (two identical uploads in one call save once). */
class FolderContents {
  private listing?: Promise<Child[]>;
  private readonly added: Child[] = [];

  constructor(
    private readonly ctx: ToolContext,
    private readonly account: string,
    private readonly folderId: string,
    /** Created by this call: nothing to list. */
    private readonly fresh: boolean,
  ) {}

  /** A file with these bytes. */
  byMd5(md5: string): Promise<Child | undefined> {
    return this.find((c) => c.md5Checksum === md5);
  }

  /** A Google Doc/Sheet/Slides deck (no checksum) of this type and name. */
  byName(name: string, mimeType: string): Promise<Child | undefined> {
    return this.find((c) => c.mimeType === mimeType && c.name === name);
  }

  private async find(match: (c: Child) => boolean): Promise<Child | undefined> {
    const existing = this.fresh ? [] : await (this.listing ??= this.list());
    return [...existing, ...this.added].find(match);
  }

  add(child: Child): void {
    this.added.push(child);
  }

  private async list(): Promise<Child[]> {
    const out: Child[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.ctx.google.request<{ files?: Child[]; nextPageToken?: string }>(this.account, SERVICE, {
        url: '/files',
        query: {
          q: `'${escapeQ(this.folderId)}' in parents and trashed = false`,
          fields: 'nextPageToken,files(id,name,mimeType,md5Checksum,size,webViewLink)',
          pageSize: MAX_CHILDREN - out.length,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < MAX_CHILDREN);
    return out;
  }
}

/* ---------- Files ---------- */

const saveFileSchema = z.object({
  upload_id: z.string().min(1).optional().describe('A file from this chat (create_upload_link, list_uploads); a link_id saves every file uploaded through that link.'),
  gmail_message_id: z.string().min(1).optional().describe('An email attachment: the message id, with gmail_part_id (from gmail_get_message).'),
  gmail_part_id: z.string().min(1).optional(),
  drive_file_id: z.string().min(1).optional().describe('A Drive file id or URL, copied.'),
  from_account: z.string().min(1).optional().describe('Linked account owning the email or Drive file, when it is not `account`.'),
  name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Name in Drive (default: the source\'s name); the extension is added when missing. Files of one link_id are numbered "Name (1)", "Name (2)".'),
  description: z.string().max(4000).optional().describe('Drive description, which Drive search covers: what the document is, whose, which property or year.'),
});

type SaveFileSpec = z.infer<typeof saveFileSchema>;

interface SaveItem {
  spec: FileSpec;
  /** Ids only, for the result row: "upload:up_…", "gmail:<message>/<part>", "drive:<id>". */
  source: string;
  name?: string;
  description?: string;
  /** Set when the item could not even be expanded (an upload link with no files). */
  error?: string;
}

interface SaveRow {
  source: string;
  name?: string;
  id?: string;
  web_view_link?: string;
  size?: number;
  saved?: true;
  duplicate?: true;
  error?: string;
}

function sourceLabel(spec: SaveFileSpec): string {
  if (spec.upload_id) return `upload:${spec.upload_id.trim()}`;
  if (spec.drive_file_id) return `drive:${spec.drive_file_id.trim()}`;
  if (spec.gmail_message_id || spec.gmail_part_id) return `gmail:${spec.gmail_message_id?.trim() ?? '?'}/${spec.gmail_part_id?.trim() ?? '?'}`;
  return 'none';
}

/** "Contrat.pdf" → "Contrat"; "Contrat v1.2" stays (an extension counts only when it is a known one). */
function withoutKnownExtension(name: string): string {
  return mimeFromFilename(name) ? withoutExtension(name) : name;
}

/** A link_id stands for every file uploaded through it, oldest first; a name given for several is numbered. */
function expandItems(ctx: ToolContext, specs: readonly SaveFileSpec[]): SaveItem[] {
  return specs.flatMap((s): SaveItem[] => {
    const { name, description, ...fields } = s;
    const item: SaveItem = { spec: fields, source: sourceLabel(s), name: name?.trim() || undefined, description };
    if (!isLinkId(s.upload_id) || s.drive_file_id || s.gmail_message_id || s.gmail_part_id) return [item];
    let files;
    try {
      files = linkFiles(ctx, s.upload_id!.trim());
    } catch (err) {
      if (err instanceof ToolInputError) return [{ ...item, error: err.message }];
      throw err;
    }
    return files.map((f, i) => ({
      ...item,
      spec: { ...fields, upload_id: f.id },
      source: `upload:${f.id}`,
      name: item.name && files.length > 1 ? `${withoutKnownExtension(item.name)} (${i + 1})` : item.name,
    }));
  });
}

/**
 * The name a file is saved under: the given one or the source's, with the
 * extension for its type added when it has no known one (Drive search and the
 * apps that open a downloaded copy go by it).
 */
export function savedName(given: string | undefined, sourceName: string, mimeType: string): string {
  const name = given?.trim() || sourceName;
  const ext = extensionForMime(mimeType) ?? extensionOf(sourceName);
  if (!ext || mimeFromFilename(name) || extensionOf(name) === ext) return name;
  return `${name}.${ext}`;
}

interface SourceMeta {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
}

/** A Drive file of the account being saved into, following a shortcut; md5Checksum is there for binary files. */
async function driveSource(ctx: ToolContext, account: string, input: string): Promise<SourceMeta> {
  const get = (id: string) =>
    ctx.google.request<FolderMeta>(account, SERVICE, { url: `/files/${encodeURIComponent(id)}`, query: { fields: 'id,name,mimeType,md5Checksum,shortcutDetails', supportsAllDrives: true } });
  const id = extractFileId(input);
  let meta = await get(id);
  if (meta.mimeType === GOOGLE_MIME.shortcut && meta.shortcutDetails?.targetId) meta = await get(meta.shortcutDetails.targetId);
  if (meta.mimeType === GOOGLE_MIME.folder) throw new ToolInputError(`"${meta.name ?? id}" is a folder; drive_save copies files.`);
  return { id: meta.id ?? id, name: meta.name ?? id, mimeType: meta.mimeType ?? 'application/octet-stream', md5Checksum: meta.md5Checksum };
}

function savedRow(source: string, f: DriveFile): SaveRow {
  return { source, name: f.name, id: f.id, web_view_link: f.webViewLink, size: sizeBytes(f), saved: true };
}

function duplicateRow(source: string, c: Child): SaveRow {
  const size = c.size === undefined ? undefined : Number(c.size);
  return { source, name: c.name, id: c.id, web_view_link: c.webViewLink, size: Number.isFinite(size) ? size : undefined, duplicate: true };
}

async function saveOne(ctx: ToolContext, account: string, item: SaveItem, folder: FolderTarget, contents: FolderContents, skipDuplicates: boolean): Promise<SaveRow> {
  const kind = sourceKind(item.spec, 'source');
  const owner = item.spec.from_account?.trim() || account;
  const placement = { parents: [folder.id], description: item.description };

  if (kind === 'drive' && owner.toLowerCase() === account.trim().toLowerCase()) {
    const info = await driveSource(ctx, account, item.spec.drive_file_id!);
    const native = isNative(info.mimeType);
    const name = native ? (item.name ?? info.name) : savedName(item.name, info.name, info.mimeType);
    if (skipDuplicates) {
      const dup = info.md5Checksum ? await contents.byMd5(info.md5Checksum) : native ? await contents.byName(name, info.mimeType) : undefined;
      if (dup) return duplicateRow(item.source, dup);
    }
    const file = await copyWithinAccount(ctx, account, info.id, { name, ...placement });
    contents.add({ id: file.id, name: file.name, mimeType: info.mimeType, md5Checksum: info.md5Checksum, size: file.size, webViewLink: file.webViewLink });
    return savedRow(item.source, file);
  }

  const blob = forDrive(await resolveFile(ctx, account, item.spec, { maxBytes: MAX_UPLOAD_BYTES, nativeDefault: 'office' }));
  const media = { data: blob.data, mimeType: blob.mimeType };
  const back = nativeKind(blob.sourceMimeType);
  if (back) {
    const name = item.name ?? blob.sourceName ?? withoutExtension(blob.filename);
    const dup = skipDuplicates ? await contents.byName(name, GOOGLE_MIME[back]) : undefined;
    if (dup) return duplicateRow(item.source, dup);
    const file = await upload(ctx, account, { method: 'POST', metadata: { name, ...placement, mimeType: GOOGLE_MIME[back] }, media });
    contents.add({ id: file.id, name: file.name, mimeType: GOOGLE_MIME[back], webViewLink: file.webViewLink });
    return savedRow(item.source, file);
  }
  const md5 = createHash('md5').update(blob.data).digest('hex');
  if (skipDuplicates) {
    const dup = await contents.byMd5(md5);
    if (dup) return duplicateRow(item.source, dup);
  }
  const file = await upload(ctx, account, { method: 'POST', metadata: { name: savedName(item.name, blob.filename, blob.mimeType), ...placement }, media });
  contents.add({ id: file.id, name: file.name, md5Checksum: md5, size: file.size, webViewLink: file.webViewLink });
  return savedRow(item.source, file);
}

/** The message of an error that concerns one file only; undefined for a bug, which propagates. */
function fileError(err: unknown): string | undefined {
  if (err instanceof ToolInputError || err instanceof DriveInputError || err instanceof GoogleApiError || err instanceof AccountError) return err.message;
  return undefined;
}

/* ---------- Tool ---------- */

export const driveSave = defineTool({
  name: 'drive_save',
  title: 'Save files into a Drive folder',
  description:
    'Saves files into a Drive folder so they can be found again: files the user uploaded in this chat (upload_id), email attachments, or Drive files of any linked account. ' +
    'Use it to keep documents the user uploads or receives that may be needed again (contracts, IDs, certificates, statements): in the folder where similar documents already are (drive_search and drive_search_all show their path and folder id), ' +
    'under a descriptive name (e.g. "Ugovor o kupoprodaji – Ulica Primer 12 st. 3 – 2015.jpg"), in the right person\'s Drive (account); check with the user which folder when unsure. ' +
    'A file already in the folder (same bytes; for a Google Doc/Sheet/Slides deck, same name) is not saved again. Returns folder {id, path, web_view_link, created} and per file {name, id, web_view_link, size, saved | duplicate | error}; one failing file does not stop the others.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    folder: z
      .string()
      .optional()
      .describe(
        'Where to save: a folder id or URL (surest: a found folder\'s own id; next to a found file, drive_search parents or drive_search_all folder_id, the folder holding it), or a path as drive_search shows it ("My Drive/Appartements/Lisbonne": a file\'s path, or a folder\'s path followed by its name; a shared drive\'s name first) or from the top of My Drive ("Appartements/Lisbonne/Contrats"; "" or "root" is My Drive itself).',
      ),
    create_folders: z.boolean().optional().describe('Create the folders of the path that do not exist yet (default true). With false, a missing folder is an error.'),
    files: z
      .array(saveFileSchema)
      .min(1)
      .max(20)
      .describe('Files to save (1-20), each with exactly one source: upload_id, gmail_message_id + gmail_part_id, or drive_file_id (+ from_account for another linked account).'),
    skip_duplicates: z.boolean().optional().describe('Skip a file whose identical copy is already in the folder and return that copy with duplicate: true (default true).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const started = Date.now();
      if (!args.files?.length) throw new ToolInputError('files needs at least one file to save.');
      const items = expandItems(ctx, args.files);
      const folder = await resolveFolder(ctx, args.account, args.folder, args.create_folders ?? true);
      const contents = new FolderContents(ctx, args.account, folder.id, folder.created.length > 0);
      const skipDuplicates = args.skip_duplicates ?? true;
      const rows: SaveRow[] = [];
      for (const [index, item] of items.entries()) {
        if (item.error) rows.push({ source: item.source, error: item.error });
        else if (index >= MAX_SAVE_FILES) rows.push({ source: item.source, error: `Not saved: one call saves at most ${MAX_SAVE_FILES} files. Save it in another call.` });
        else if (Date.now() - started > TIME_BUDGET_MS) rows.push({ source: item.source, error: 'Not saved: this call ran out of time. Save it in another call.' });
        else {
          try {
            rows.push(await saveOne(ctx, args.account, item, folder, contents, skipDuplicates));
          } catch (err) {
            const message = fileError(err);
            if (message === undefined) throw err;
            rows.push({ source: item.source, name: item.name, error: message });
          }
        }
      }
      const saved = rows.filter((r) => r.saved).length;
      const duplicates = rows.filter((r) => r.duplicate).length;
      ctx.log.info('drive save', { alias: args.account, files: rows.length, saved, duplicates, failed: rows.length - saved - duplicates, folders_created: folder.created.length });
      const notes = [
        saved + duplicates ? 'These files can now be found with drive_search or drive_search_all (Drive also searches the text inside PDFs and images).' : '',
        duplicates ? 'duplicate: the folder already held an identical file (for a Google Doc, Sheet or Slides deck: one with the same name), so it was not saved again; skip_duplicates false saves it anyway.' : '',
        folder.ambiguous ? 'Several folders on the path had the same name; the oldest was used.' : '',
      ];
      return jsonResult({
        folder: { id: folder.id, path: folder.path, web_view_link: folder.webViewLink, created: folder.created, ambiguous: folder.ambiguous },
        files: rows,
        note: notes.filter(Boolean).join(' '),
      });
    });
  },
});
