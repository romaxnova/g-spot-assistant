/**
 * drive_search_all: one Drive search in several linked accounts at once, for a
 * document whose owner is unclear (the user's Drive or a relative's). Same
 * query semantics as drive_search (name or full text, which covers the text
 * Drive reads in PDFs and images); each file comes with the path of the folder
 * holding it and, unless it is a folder itself, that folder's id (what
 * drive_save takes to save a similar document next to it; a folder found here
 * is saved into by its own id, so no parent id invites saving one level up).
 * Failures are reported per account so one dead grant never hides the others.
 */
import * as z from 'zod';
import { defineTool, errorResult, jsonResult, type ToolContext } from '../registry.js';
import { accountsParam, forEachAccount, noAccountsError, targetAliases } from './cross.js';
import { listFiles, sizeBytes } from './drive.js';
import { buildSearchQuery, friendlyType, GOOGLE_MIME, SEARCH_TYPES } from './drive-files.js';
import { folderPathsOf } from './drive-paths.js';

async function searchAccount(ctx: ToolContext, alias: string, q: string, max: number) {
  const email = ctx.google.resolve(alias, 'drive').email;
  const list = await listFiles(ctx, alias, { q, pageSize: max });
  const found = list.files ?? [];
  const { paths, note } = await folderPathsOf(ctx, alias, found);
  return {
    alias,
    email,
    files: found.map((f, i) => ({
      id: f.id,
      name: f.name,
      type: friendlyType(f.mimeType),
      modified_time: f.modifiedTime,
      size: sizeBytes(f),
      path: paths[i],
      folder_id: f.mimeType === GOOGLE_MIME.folder ? undefined : f.parents?.[0],
      web_view_link: f.webViewLink,
    })),
    more_available: list.nextPageToken ? true : undefined,
    note,
  };
}

export const driveSearchAll = defineTool({
  name: 'drive_search_all',
  title: 'Search Drive across accounts',
  description:
    'Searches Google Drive in several linked accounts at once (default: every account with Drive) by file name or full text (Drive also reads the text inside PDFs and images). ' +
    'Use it to find a document when it is unclear whose Drive holds it (e.g. the user\'s or a relative\'s). ' +
    'Returns per account {alias, email, files: [{id, name, type, modified_time, size, path, folder_id, web_view_link}], more_available}, newest first; path is the folder holding the file and folder_id that folder\'s id (not on folders: save into a found folder by its own id). Ids work with the drive_* tools (drive_save folder) together with that alias. ' +
    'An account that fails is reported as {alias, email, error} without affecting the others. Read-only.',
  inputSchema: {
    query: z.string().min(1).describe('Words to look for in file names and contents (as drive_search query).'),
    type: z.enum(SEARCH_TYPES).optional().describe('Restrict to one kind (default any): folder, document, spreadsheet, presentation, pdf, image or other.'),
    accounts: accountsParam,
    max_per_account: z.number().int().min(1).max(25).optional().describe('Files to list per account, 1-25 (default 8).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const query = args.query?.trim();
    if (!query) return errorResult('query is required: words from the file name or its content.');
    const aliases = targetAliases(ctx, 'drive', args.accounts);
    if (!aliases.length) return noAccountsError(ctx, 'drive');
    const q = buildSearchQuery({ query, type: args.type });
    const max = args.max_per_account ?? 8;
    ctx.log.debug('drive_search_all', { accounts: aliases.length, max });
    const accounts = await forEachAccount(ctx, aliases, (alias) => searchAccount(ctx, alias, q, max));
    const none = accounts.every((a) => 'files' in a && a.files.length === 0);
    return jsonResult({ accounts, note: none ? 'No files matched in any account.' : undefined });
  },
});
