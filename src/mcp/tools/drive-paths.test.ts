import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../log.js';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall } from '../../test-support.js';
import type { ToolDefinition } from '../registry.js';
import { runTool } from '../server.js';
import { driveTools } from './drive.js';
import { GOOGLE_MIME } from './drive-files.js';
import { FolderPaths, MAX_PATH_LOOKUPS } from './drive-paths.js';
import { driveSearchAll } from './drive-search-all.js';

const FOLDER = GOOGLE_MIME.folder;
const driveSearch = driveTools.find((t) => t.name === 'drive_search') as ToolDefinition;

interface Meta {
  name?: string;
  parents?: string[];
  driveId?: string;
}

/**
 * files.list answers `listed`; files.get answers from `folders` (404 for any
 * other id), and 'root' with My Drive's id `root` (404 when empty);
 * drives.get answers from `drives`.
 */
function fake(listed: Record<string, unknown>[], folders: Record<string, Meta>, drives: Record<string, string> = {}, root = 'ROOT'): FakeGoogle {
  return (c) => {
    const p = c.url.pathname;
    if (p === '/drive/v3/files') return { json: { files: listed, nextPageToken: c.url.searchParams.get('pageSize') === '1' ? 'more' : undefined } };
    const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)?.[1];
    if (file === 'root') return root ? { json: { id: root } } : undefined;
    if (file && folders[file]) return { json: folders[file] };
    const drive = /^\/drive\/v3\/drives\/([^/]+)$/.exec(p)?.[1];
    if (drive && drives[drive]) return { json: { name: drives[drive] } };
    return undefined;
  };
}

/** My Drive (id ROOT) / Appartements / Lisbonne, a shared drive SD with a Contracts folder, and folders whose parent is not shared. */
const FOLDERS: Record<string, Meta> = {
  ROOT: { name: 'Mon Drive' },
  appts: { name: 'Appartements', parents: ['ROOT'] },
  bgd: { name: 'Lisbonne', parents: ['appts'] },
  SD: { name: 'Drive', driveId: 'SD' },
  sdc: { name: 'Contracts', parents: ['SD'], driveId: 'SD' },
  orphan: { name: 'From Partner', parents: ['hidden'] },
  sharedTop: { name: 'Papers' },
  sharedSub: { name: '2015', parents: ['sharedTop'] },
};

const folderGets = (calls: RecordedCall[]) => calls.filter((c) => /^\/drive\/v3\/(files|drives)\/[^/]+$/.test(c.url.pathname));

test('drive_search shows each file\'s folder path, reading every folder once', async () => {
  const listed = [
    { id: 'f1', name: 'Ugovor 2014.pdf', mimeType: 'application/pdf', parents: ['bgd'] },
    { id: 'f2', name: 'Ugovor 2015.jpg', mimeType: 'image/jpeg', parents: ['bgd'] },
    { id: 'f3', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet, parents: ['ROOT'] },
    { id: 'f4', name: 'Lease.pdf', mimeType: 'application/pdf', parents: ['sdc'] },
    { id: 'f5', name: 'Scan.pdf', mimeType: 'application/pdf', parents: ['orphan'] },
    { id: 'f6', name: 'Shared alone.pdf', mimeType: 'application/pdf' },
    { id: 'f7', name: 'Deed.pdf', mimeType: 'application/pdf', parents: ['sharedSub'] },
  ];
  const ctx = createTestContext({ google: fake(listed, FOLDERS, { SD: 'Household' }) });
  const out = resultJson(await runTool(driveSearch, { account: 'me', query: 'ugovor' }, ctx));
  const files = out['files'] as Record<string, unknown>[];
  assert.deepEqual(
    files.map((f) => f['path']),
    ['My Drive/Appartements/Lisbonne', 'My Drive/Appartements/Lisbonne', 'My Drive', 'Household/Contracts', '…/From Partner', undefined, '…/Papers/2015'],
  );
  const gets = folderGets(apiCalls(ctx));
  assert.deepEqual(gets.map((c) => c.url.pathname.split('/').slice(-2).join('/')).sort(), ['drives/SD', 'files/SD', 'files/appts', 'files/bgd', 'files/hidden', 'files/orphan', 'files/root', 'files/sdc', 'files/sharedSub', 'files/sharedTop']);
  assert.equal(gets.find((c) => c.url.pathname.endsWith('/root'))!.url.searchParams.get('fields'), 'id', "My Drive's own id, not its folder");
  const lookup = gets.find((c) => c.url.pathname.endsWith('/bgd'))!;
  assert.equal(lookup.url.searchParams.get('fields'), 'name,parents,driveId');
  assert.equal(lookup.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(out['note'], undefined);
});

test('a shared drive whose name cannot be read is "Shared drive"; include_paths false reads no folder', async () => {
  const listed = [{ id: 'f4', name: 'Lease.pdf', mimeType: 'application/pdf', parents: ['sdc'] }];
  const ctx = createTestContext({ google: fake(listed, FOLDERS) });
  const out = resultJson(await runTool(driveSearch, { account: 'me', query: 'lease' }, ctx));
  assert.equal((out['files'] as Record<string, unknown>[])[0]!['path'], 'Shared drive/Contracts');

  const quiet = createTestContext({ google: fake(listed, FOLDERS) });
  const plain = resultJson(await runTool(driveSearch, { account: 'me', query: 'lease', include_paths: false }, quiet));
  assert.equal((plain['files'] as Record<string, unknown>[])[0]!['path'], undefined);
  assert.equal(apiCalls(quiet).length, 1, 'the listing only');
});

test(`drive_search reads at most ${MAX_PATH_LOOKUPS} folders per call and says when paths were cut`, async () => {
  const folders: Record<string, Meta> = { ROOT: { name: 'My Drive' } };
  const listed = Array.from({ length: 60 }, (_, i) => {
    folders[`d${i}`] = { name: `Folder ${i}`, parents: ['ROOT'] };
    return { id: `f${i}`, name: `file ${i}`, mimeType: 'application/pdf', parents: [`d${i}`] };
  });
  const ctx = createTestContext({ google: fake(listed, folders) });
  const out = resultJson(await runTool(driveSearch, { account: 'me', max_results: 60 }, ctx));
  assert.equal(folderGets(apiCalls(ctx)).length, MAX_PATH_LOOKUPS);
  const paths = (out['files'] as Record<string, unknown>[]).map((f) => String(f['path']));
  assert.equal(paths.filter((p) => p.startsWith('My Drive/Folder ')).length, MAX_PATH_LOOKUPS - 1, "one lookup goes to My Drive's id");
  assert.ok(paths.filter((p) => p.startsWith('…/')).length >= 60 - MAX_PATH_LOOKUPS);
  assert.match(String(out['note']), /incomplete: at most 40 folders are looked up per call/);
});

test('a folder outside My Drive (a computer backed up by Drive for desktop, an orphan) starts with "…/", never with My Drive', async () => {
  const folders: Record<string, Meta> = {
    ...FOLDERS,
    laptop: { name: 'My Laptop' },
    docs: { name: 'Documents', parents: ['laptop'] },
    scans: { name: 'Scans', parents: ['docs'] },
    myDocs: { name: 'Documents', parents: ['ROOT'] },
  };
  const listed = [
    { id: 'f1', name: 'Lease.pdf', mimeType: 'application/pdf', parents: ['scans'] },
    { id: 'f2', name: 'Notes.pdf', mimeType: 'application/pdf', parents: ['myDocs'] },
  ];
  const ctx = createTestContext({ google: fake(listed, folders) });
  const out = resultJson(await runTool(driveSearch, { account: 'me', query: 'lease' }, ctx));
  assert.deepEqual((out['files'] as Record<string, unknown>[]).map((f) => f['path']), ['…/My Laptop/Documents/Scans', 'My Drive/Documents']);
  const gets = folderGets(apiCalls(ctx)).map((c) => c.url.pathname.split('/').pop());
  assert.equal(gets.filter((g) => g === 'root').length, 1, "My Drive's id is read once per call");
  assert.equal(gets.includes('ROOT'), false, 'My Drive itself needs no lookup');

  const paths = new FolderPaths(ctx, 'me');
  assert.equal(await paths.folderPath('laptop'), '…/My Laptop');
  assert.equal(await paths.folderPath('ROOT'), 'My Drive');

  // When My Drive's id cannot be read, no path claims to be in My Drive.
  const blind = new FolderPaths(createTestContext({ google: fake([], folders, {}, '') }), 'me');
  assert.equal(await blind.folderPath('bgd'), '…/Mon Drive/Appartements/Lisbonne');
  assert.equal(await blind.folderPath('root'), 'My Drive');
});

test('FolderPaths: a folder\'s own path, the root alias, and a cycle that ends with "…/"', async () => {
  const ctx = createTestContext({ google: fake([], { ...FOLDERS, a: { name: 'A', parents: ['b'] }, b: { name: 'B', parents: ['a'] } }) });
  const paths = new FolderPaths(ctx, 'me');
  assert.equal(await paths.folderPath('bgd'), 'My Drive/Appartements/Lisbonne');
  assert.equal(await paths.folderPath('root'), 'My Drive');
  assert.equal(await paths.folderPath('a'), '…/B/A');
  assert.equal(await paths.parentPath(undefined), undefined);
  assert.equal(await paths.parentPath(['missing']), '…/');
});

/* ---------- drive_search_all ---------- */

test('drive_search_all searches every account with Drive in parallel and reports a failing one apart', async () => {
  const listed = [{ id: 'f1', name: 'Ugovor 2014.pdf', mimeType: 'application/pdf', modifiedTime: '2026-01-01T00:00:00Z', size: '2048', parents: ['bgd'], webViewLink: 'https://drive/f1', owners: [{ emailAddress: 'x@example.com' }] }];
  const ctx = createTestContext({
    accounts: [{ alias: 'me' }, { alias: 'partner', email: 'partner@example.com' }, { alias: 'work', status: 'needs_relink' }, { alias: 'mailonly', services: ['gmail'] }],
    google: fake(listed, FOLDERS),
  });
  const out = resultJson(await runTool(driveSearchAll, { query: "Ulica Primer's", type: 'pdf' }, ctx));
  const accounts = out['accounts'] as Record<string, unknown>[];
  assert.deepEqual(accounts.map((a) => a['alias']), ['me', 'partner'], 'default: healthy accounts that grant Drive');
  const expectedFile = { id: 'f1', name: 'Ugovor 2014.pdf', type: 'pdf', modified_time: '2026-01-01T00:00:00Z', size: 2048, path: 'My Drive/Appartements/Lisbonne', folder_id: 'bgd', web_view_link: 'https://drive/f1' };
  assert.deepEqual(accounts[1], { alias: 'partner', email: 'partner@example.com', files: [expectedFile] });
  const lists = apiCalls(ctx).filter((c) => c.url.pathname === '/drive/v3/files');
  assert.equal(lists.length, 2);
  assert.equal(lists[0]!.url.searchParams.get('q'), "(name contains 'Ulica Primer\\'s' or fullText contains 'Ulica Primer\\'s') and mimeType = 'application/pdf' and trashed = false");
  assert.equal(lists[0]!.url.searchParams.get('pageSize'), '8');
  assert.equal(lists[0]!.url.searchParams.get('includeItemsFromAllDrives'), 'true');

  const explicit = resultJson(await runTool(driveSearchAll, { query: 'ugovor', accounts: ['Partner', 'work', 'mailonly'], max_per_account: 1 }, ctx));
  const rows = explicit['accounts'] as Record<string, unknown>[];
  assert.deepEqual(rows[0], { alias: 'partner', email: 'partner@example.com', files: [expectedFile], more_available: true });
  assert.equal(rows[1]!['alias'], 'work');
  assert.match(String(rows[1]!['error']), /needs to be re-linked/);
  assert.match(String(rows[2]!['error']), /was not granted Google Drive/);
});

test('drive_search_all gives folder_id (the folder holding a file) on file rows only: a folder is saved into by its own id', async () => {
  const listed = [
    { id: 'bgd', name: 'Lisbonne', mimeType: FOLDER, parents: ['appts'] },
    { id: 'f1', name: 'Lisbonne lease.pdf', mimeType: 'application/pdf', parents: ['bgd'] },
  ];
  const ctx = createTestContext({ google: fake(listed, FOLDERS) });
  const out = resultJson(await runTool(driveSearchAll, { query: 'Lisbonne' }, ctx));
  const files = (out['accounts'] as Record<string, unknown>[])[0]!['files'] as Record<string, unknown>[];
  assert.deepEqual(
    files.map((f) => [f['id'], f['type'], f['path'], f['folder_id']]),
    [
      ['bgd', 'folder', 'My Drive/Appartements', undefined],
      ['f1', 'pdf', 'My Drive/Appartements/Lisbonne', 'bgd'],
    ],
  );
  assert.match(driveSearchAll.description, /folder_id.*folder holding/);
});

test('drive_search_all: an empty query and no Drive account are errors; logs carry counts only', async () => {
  const lines: string[] = [];
  const ctx = { ...createTestContext({ google: fake([], FOLDERS) }), log: createLogger('debug', {}, (l) => lines.push(l)) };
  const empty = await runTool(driveSearchAll, { query: '  ' }, ctx);
  assert.equal(empty.isError, true);
  const none = resultJson(await runTool(driveSearchAll, { query: 'kupoprodaja' }, ctx));
  assert.equal(none['note'], 'No files matched in any account.');
  for (const l of lines) assert.doesNotMatch(l, /kupoprodaja/);

  const noDrive = createTestContext({ accounts: [{ alias: 'me', services: ['gmail'] }] });
  const res = await runTool(driveSearchAll, { query: 'x' }, noDrive);
  assert.equal(res.isError, true);
  assert.match(resultText(res), /No linked account grants Google Drive/);
});
