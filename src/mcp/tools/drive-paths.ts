/**
 * Folder paths for Drive listings ("My Drive/Appartements/Lisbonne"), so
 * Claude sees where documents live and where similar ones belong. Drive only
 * gives a file's parent ids: each folder up the chain is read once per call
 * (files.get name,parents,driveId) and cached, and a call reads at most
 * MAX_PATH_LOOKUPS folders. The top of a chain is My Drive (the folder whose id
 * files.get 'root' gives, read once per call, whatever Google calls it), a
 * shared drive (driveId; its name comes from drives.get), or else a folder
 * outside My Drive: shared with the account on its own, a computer backed up
 * by Drive for desktop, or an orphan whose parent was deleted. Such a top, and
 * a parent that cannot be read (not shared with the account, or past the cap),
 * start the path with "…/", which drive_save refuses as a path: only complete
 * paths are reused. Nothing here is logged.
 */
import { AccountError, GoogleApiError } from '../../google/client.js';
import type { ToolContext } from '../registry.js';
import { mapConcurrent } from './cross.js';

export const MAX_PATH_LOOKUPS = 40;
/** Deeper chains (or a cycle Drive should never have) end with "…/". */
const MAX_DEPTH = 30;
const CONCURRENCY = 5;
export const MY_DRIVE = 'My Drive';
export const SHARED_DRIVE = 'Shared drive';
const CUT = '…/';

interface FolderMeta {
  name?: string;
  parents?: string[];
  driveId?: string;
}

/** Resolves folder paths for one account, with a lookup budget shared by every path asked of it. */
export class FolderPaths {
  private readonly folders = new Map<string, Promise<FolderMeta | undefined>>();
  private readonly drives = new Map<string, Promise<string>>();
  private root?: Promise<string | undefined>;
  private lookups = 0;
  /** True once a folder was left unread because the budget was spent. */
  capped = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly account: string,
    private readonly maxLookups = MAX_PATH_LOOKUPS,
  ) {}

  /** Path of the folder holding a file with these parents; undefined when Drive gives none (e.g. shared with the account on its own). */
  async parentPath(parents: readonly string[] | undefined): Promise<string | undefined> {
    const parent = parents?.[0];
    return parent ? this.folderPath(parent) : undefined;
  }

  /** Full path of a folder, its own name included. 'root' is My Drive. */
  async folderPath(id: string): Promise<string> {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      if (current === 'root' || current === (await this.rootId())) return [MY_DRIVE, ...names].join('/');
      if (seen.has(current) || seen.size >= MAX_DEPTH) return CUT + names.join('/');
      seen.add(current);
      const folder = await this.folder(current);
      if (!folder) return CUT + names.join('/');
      const parent = folder.parents?.[0];
      if (!parent) {
        if (folder.driveId) return [await this.driveName(folder.driveId), ...names].join('/');
        // Outside My Drive (shared on its own, a backed-up computer, an orphan): no path leads to it.
        return CUT + [folder.name ?? '?', ...names].join('/');
      }
      names.unshift(folder.name ?? '?');
      current = parent;
    }
  }

  private take(): boolean {
    if (this.lookups >= this.maxLookups) {
      this.capped = true;
      return false;
    }
    this.lookups++;
    return true;
  }

  /** My Drive's real id, read once; undefined when it cannot be read, so that no folder is taken for My Drive. */
  private rootId(): Promise<string | undefined> {
    this.root ??= this.take()
      ? this.ctx.google
          .request<{ id?: string }>(this.account, 'drive', { url: '/files/root', query: { fields: 'id' } })
          .then((r) => r.id)
          .catch((err: unknown) => {
            if (err instanceof GoogleApiError || err instanceof AccountError) return undefined;
            throw err;
          })
      : Promise.resolve(undefined);
    return this.root;
  }

  private folder(id: string): Promise<FolderMeta | undefined> {
    let cached = this.folders.get(id);
    if (!cached) {
      if (!this.take()) return Promise.resolve(undefined);
      cached = this.ctx.google
        .request<FolderMeta>(this.account, 'drive', { url: `/files/${encodeURIComponent(id)}`, query: { fields: 'name,parents,driveId', supportsAllDrives: true } })
        .catch((err: unknown) => {
          if (err instanceof GoogleApiError || err instanceof AccountError) return undefined;
          throw err;
        });
      this.folders.set(id, cached);
    }
    return cached;
  }

  private driveName(driveId: string): Promise<string> {
    let cached = this.drives.get(driveId);
    if (!cached) {
      if (!this.take()) return Promise.resolve(SHARED_DRIVE);
      cached = this.ctx.google
        .request<{ name?: string }>(this.account, 'drive', { url: `/drives/${encodeURIComponent(driveId)}`, query: { fields: 'name' } })
        .then((d) => d.name || SHARED_DRIVE)
        .catch((err: unknown) => {
          if (err instanceof GoogleApiError || err instanceof AccountError) return SHARED_DRIVE;
          throw err;
        });
      this.drives.set(driveId, cached);
    }
    return cached;
  }
}

/** Paths of the folders holding `files` (same order), and a note when the lookup budget cut some of them. */
export async function folderPathsOf(ctx: ToolContext, account: string, files: readonly { parents?: string[] }[]): Promise<{ paths: (string | undefined)[]; note?: string }> {
  const resolver = new FolderPaths(ctx, account);
  const paths = await mapConcurrent(files, CONCURRENCY, (f) => resolver.parentPath(f.parents));
  return { paths, note: resolver.capped ? `Paths starting with "${CUT}" are incomplete: at most ${MAX_PATH_LOOKUPS} folders are looked up per call.` : undefined };
}
