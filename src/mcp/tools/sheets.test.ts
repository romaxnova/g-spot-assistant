import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type RecordedCall, type TestContext } from '../../test-support.js';
import type { ToolContext, ToolDefinition } from '../registry.js';
import { runTool } from '../server.js';
import { sheetsTools } from './sheets.js';

const BASE = 'https://sheets.googleapis.com/v4';
const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const URL_FORM = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`;
const INFO_FIELDS = 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount,frozenRowCount))),spreadsheetUrl';

function tool(name: string): ToolDefinition {
  const def = sheetsTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return tool(name).handler(args, ctx);
}

function lastCall(ctx: TestContext): RecordedCall {
  const calls = apiCalls(ctx);
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no API call recorded');
  return call;
}

const infoJson = {
  spreadsheetId: ID,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
  properties: { title: 'Budget', locale: 'fr_FR', timeZone: 'Europe/Paris' },
  sheets: [
    { properties: { sheetId: 99, title: 'Notes', index: 1, gridProperties: { rowCount: 100, columnCount: 10 } } },
    { properties: { sheetId: 0, title: 'Q1 2026', index: 0, gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 } } },
  ],
};

/** Fake Google that answers spreadsheet info and records everything else through `rest`. */
function withInfo(rest: FakeGoogle = () => undefined): FakeGoogle {
  return (call) => {
    if (call.method === 'GET' && call.url.pathname === `/v4/spreadsheets/${ID}`) return { json: infoJson };
    return rest(call);
  };
}

test('tool inventory: names, service and honest annotations', () => {
  const byName = Object.fromEntries(sheetsTools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['sheets_append', 'sheets_create', 'sheets_get_info', 'sheets_read', 'sheets_write']);
  for (const t of sheetsTools) {
    assert.equal(t.service, 'sheets', t.name);
    assert.ok(t.inputSchema['account'], `${t.name} has account param`);
    assert.ok(t.title && t.description.length > 40, t.name);
    assert.equal(t.annotations.destructiveHint, false, `${t.name} never deletes`);
  }
  for (const name of ['sheets_get_info', 'sheets_read']) assert.equal(byName[name]!.annotations.readOnlyHint, true, name);
  for (const name of ['sheets_write', 'sheets_append', 'sheets_create']) assert.equal(byName[name]!.annotations.readOnlyHint, false, name);
  assert.equal(byName['sheets_write']!.annotations.idempotentHint, true);
  assert.equal(byName['sheets_append']!.annotations.idempotentHint, false);
  assert.equal(byName['sheets_create']!.annotations.idempotentHint, false);
});

test('account without sheets access yields an isError result that mentions re-linking', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'work', services: ['gmail'] }] });
  const result = await runTool(tool('sheets_get_info'), { account: 'work', spreadsheet_id: ID }, ctx);
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not granted Google Sheets.*Re-link it with Google Sheets/);
  await assert.rejects(run('sheets_read', { account: 'work', spreadsheet_id: ID, range: 'Sheet1' }, ctx), /Re-link/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('sheets_get_info requests only the needed fields and lists tabs in index order', async () => {
  const ctx = createTestContext({ google: withInfo() });
  const out = resultJson(await run('sheets_get_info', { account: 'me', spreadsheet_id: URL_FORM }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.origin + call.url.pathname, `${BASE}/spreadsheets/${ID}`);
  assert.equal(call.url.searchParams.get('fields'), INFO_FIELDS);
  assert.deepEqual(out, {
    spreadsheet_id: ID,
    title: 'Budget',
    locale: 'fr_FR',
    time_zone: 'Europe/Paris',
    url: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    tabs: [
      { sheet_id: 0, title: 'Q1 2026', index: 0, rows: 1000, cols: 26, frozen_rows: 1 },
      { sheet_id: 99, title: 'Notes', index: 1, rows: 100, cols: 10 },
    ],
  });
});

test('a bad spreadsheet_id is a fixable error, not a Google call', async () => {
  const ctx = createTestContext();
  const out = await run('sheets_get_info', { account: 'me', spreadsheet_id: 'https://example.com/nothing' }, ctx);
  assert.equal(out.isError, true);
  assert.match(resultText(out), /neither a spreadsheet id nor a Google Sheets URL/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('sheets_read sends the encoded range and render options and returns rows', async () => {
  const ctx = createTestContext({
    google: () => ({ json: { range: "'My Tab'!A1:C3", majorDimension: 'ROWS', values: [['Name', 'Qty', 'Price'], ['Bolt', 12, 0.5], ['Nut', 7]] } }),
  });
  const out = resultJson(await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'My Tab!A1:C50', value_render: 'unformatted' }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.pathname, `/v4/spreadsheets/${ID}/values/'My%20Tab'!A1%3AC50`);
  assert.equal(call.url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  assert.equal(call.url.searchParams.get('majorDimension'), 'ROWS');
  assert.equal(call.url.searchParams.get('dateTimeRenderOption'), 'FORMATTED_STRING');
  assert.deepEqual(out, {
    range: "'My Tab'!A1:C3",
    rows: [['Name', 'Qty', 'Price'], ['Bolt', 12, 0.5], ['Nut', 7]],
    row_count_returned: 3,
    row_count_total: 3,
    truncated: false,
  });
});

test('sheets_read defaults to FORMATTED_VALUE without a date option and reads the first tab when range is omitted', async () => {
  const ctx = createTestContext({ google: withInfo(() => ({ json: { range: "'Q1 2026'!A1:Z1000", values: [['x']] } })) });
  const out = resultJson(await run('sheets_read', { account: 'me', spreadsheet_id: ID }, ctx));
  const calls = apiCalls(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.pathname, `/v4/spreadsheets/${ID}`);
  assert.equal(calls[1]!.url.pathname, `/v4/spreadsheets/${ID}/values/'Q1%202026'`);
  assert.equal(calls[1]!.url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
  assert.equal(calls[1]!.url.searchParams.has('dateTimeRenderOption'), false);
  assert.deepEqual(out['rows'], [['x']]);
});

test('sheets_read applies value_render=formula with text dates and quotes a bare tab name only when needed', async () => {
  const ctx = createTestContext({ google: () => ({ json: { range: 'Sheet1!A1:B2', values: [['=SUM(B:B)', 1]] } }) });
  await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Sheet1', value_render: 'formula' }, ctx);
  const call = lastCall(ctx);
  assert.equal(call.url.pathname, `/v4/spreadsheets/${ID}/values/Sheet1`);
  assert.equal(call.url.searchParams.get('valueRenderOption'), 'FORMULA');
  assert.equal(call.url.searchParams.get('dateTimeRenderOption'), 'FORMATTED_STRING', 'non-formula date cells would otherwise be day serials');
  assert.equal(apiCalls(ctx).length, 1, 'a bare tab name needs no info lookup');
});

test('sheets_read skips empty rows, caps rows and columns, and says so', async () => {
  const values = [
    ['h1', 'h2', 'h3', 'h4'],
    [],
    ['a', '', ''],
    ['', ''],
    ['b', 2, 3, 4],
    ['c', 5],
  ];
  const ctx = createTestContext({ google: () => ({ json: { range: 'Sheet1!A1:D6', values } }) });
  const out = resultJson(await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Sheet1', max_rows: 2, max_cols: 3 }, ctx));
  // Trailing empty cells carry nothing and are trimmed; inner ones stay (next test) so columns keep their positions.
  assert.deepEqual(out['rows'], [['h1', 'h2', 'h3'], ['a']]);
  assert.equal(out['row_count_returned'], 2);
  assert.equal(out['row_count_total'], 4);
  assert.equal(out['truncated'], true);
  const note = String(out['note']);
  assert.match(note, /first 2 of 4 rows/);
  assert.match(note, /cut to 3 columns/);
  assert.match(note, /2 empty row\(s\) skipped/);

  const keepAll = resultJson(await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Sheet1', skip_empty_rows: false }, ctx));
  assert.equal(keepAll['row_count_total'], 6);
  assert.equal(keepAll['truncated'], false);
  assert.equal(keepAll['note'], undefined);
  assert.deepEqual(
    keepAll['rows'],
    [['h1', 'h2', 'h3', 'h4'], [], ['a'], [], ['b', 2, 3, 4], ['c', 5]],
    'empty rows survive so row positions match the sheet',
  );
});

test('sheets_read serializes one row per line and never drops empty cells', async () => {
  const ctx = createTestContext({ google: () => ({ json: { range: 'Sheet1!A1:C2', values: [['a', '', 'c'], []] } }) });
  const text = resultText(await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Sheet1', skip_empty_rows: false }, ctx));
  assert.match(text, /"rows": \[\n  \["a","","c"\],\n  \[\]\n \]/);
  assert.deepEqual(JSON.parse(text)['rows'], [['a', '', 'c'], []]);
});

test('sheets_read reports an empty range instead of returning nothing', async () => {
  const ctx = createTestContext({ google: () => ({ json: { range: 'Sheet1!A1:Z1000' } }) });
  const out = resultJson(await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Sheet1' }, ctx));
  assert.deepEqual(out, { range: 'Sheet1!A1:Z1000', rows: [], row_count_returned: 0, row_count_total: 0, truncated: false, note: 'The range has no values.' });
});

test('an unknown tab becomes a fixable error listing the existing tabs', async () => {
  const badRange = { status: 400, json: { error: { code: 400, message: 'Unable to parse range: Nope!A1', status: 'INVALID_ARGUMENT' } } };
  const ctx = createTestContext({ google: withInfo(() => badRange) });
  const out = await run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Nope!A1' }, ctx);
  assert.equal(out.isError, true);
  assert.match(resultText(out), /Unable to parse range: Nope!A1.*Existing tabs: "Q1 2026", "Notes"/);
  assert.equal(apiCalls(ctx).length, 2);

  const write = await run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'Nope!A1', values: [[1]] }, ctx);
  assert.equal(write.isError, true);
  assert.match(resultText(write), /create_tab_if_missing=true/);
});

test('other Google errors propagate as GoogleApiError', async () => {
  const ctx = createTestContext({ google: () => ({ status: 404, json: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } }) });
  await assert.rejects(run('sheets_read', { account: 'me', spreadsheet_id: ID, range: 'Sheet1' }, ctx), /Google Sheets API error 404.*Requested entity was not found/);
  assert.equal(apiCalls(ctx).length, 1, 'no tab lookup for non-range errors');
});

test('sheets_write PUTs the values with USER_ENTERED by default', async () => {
  const ctx = createTestContext({
    google: () => ({ json: { spreadsheetId: ID, updatedRange: 'Sheet1!A1:B2', updatedRows: 2, updatedColumns: 2, updatedCells: 4 } }),
  });
  const values = [['Name', 'Qty'], ['Bolt', 12]];
  const out = resultJson(await run('sheets_write', { account: 'me', spreadsheet_id: URL_FORM, range: 'Sheet1!A1', values }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'PUT');
  assert.equal(call.url.pathname, `/v4/spreadsheets/${ID}/values/Sheet1!A1`);
  assert.equal(call.url.searchParams.get('valueInputOption'), 'USER_ENTERED');
  assert.deepEqual(call.json, { range: 'Sheet1!A1', majorDimension: 'ROWS', values });
  assert.deepEqual(out, { updated_range: 'Sheet1!A1:B2', updated_rows: 2, updated_columns: 2, updated_cells: 4 });
  assert.equal(apiCalls(ctx).length, 1, 'no info lookup unless create_tab_if_missing');
});

test('sheets_write honours value_input=RAW, keeps null cells and quotes tab names', async () => {
  const ctx = createTestContext({ google: () => ({ json: { updatedRange: "'My Tab'!B3:C3", updatedRows: 1, updatedColumns: 2, updatedCells: 1 } }) });
  await run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'My Tab!B3', values: [[null, true]], value_input: 'RAW' }, ctx);
  const call = lastCall(ctx);
  assert.equal(call.url.pathname, `/v4/spreadsheets/${ID}/values/'My%20Tab'!B3`);
  assert.equal(call.url.searchParams.get('valueInputOption'), 'RAW');
  assert.deepEqual(call.json, { range: "'My Tab'!B3", majorDimension: 'ROWS', values: [[null, true]] });
});

test('create_tab_if_missing adds the tab before writing, and skips when it exists', async () => {
  const seen: string[] = [];
  const ctx = createTestContext({
    google: withInfo((call) => {
      seen.push(`${call.method} ${call.url.pathname}`);
      if (call.url.pathname.endsWith(':batchUpdate')) return { json: { replies: [{ addSheet: { properties: { sheetId: 5, title: 'Log' } } }] } };
      return { json: { updatedRange: 'Log!A1:A1', updatedRows: 1, updatedColumns: 1, updatedCells: 1 } };
    }),
  });
  const out = resultJson(await run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'Log!A1', values: [['x']], create_tab_if_missing: true }, ctx));
  assert.deepEqual(seen, [`POST /v4/spreadsheets/${ID}:batchUpdate`, `PUT /v4/spreadsheets/${ID}/values/Log!A1`]);
  const batch = apiCalls(ctx)[1]!;
  assert.deepEqual(batch.json, { requests: [{ addSheet: { properties: { title: 'Log' } } }] });
  assert.equal(out['created_tab'], 'Log');

  seen.length = 0;
  const existing = resultJson(await run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'Notes!A1', values: [['x']], create_tab_if_missing: true }, ctx));
  assert.deepEqual(seen, [`PUT /v4/spreadsheets/${ID}/values/Notes!A1`]);
  assert.equal(existing['created_tab'], undefined);

  seen.length = 0;
  await run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'A1:B2', values: [['x']], create_tab_if_missing: true }, ctx);
  assert.deepEqual(seen, [`PUT /v4/spreadsheets/${ID}/values/A1%3AB2`], 'bare cells target the first tab: nothing to create');
});

test('create_tab_if_missing matches an existing tab ignoring case and writes to its exact title', async () => {
  const seen: string[] = [];
  const ctx = createTestContext({
    google: withInfo((call) => {
      seen.push(`${call.method} ${call.url.pathname}`);
      return { json: { updatedRange: 'Notes!B2:B2', updatedRows: 1, updatedColumns: 1, updatedCells: 1 } };
    }),
  });
  const out = resultJson(await run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'notes!B2', values: [['x']], create_tab_if_missing: true }, ctx));
  assert.deepEqual(seen, [`PUT /v4/spreadsheets/${ID}/values/Notes!B2`], 'no addSheet: Sheets tab titles are unique ignoring case');
  assert.equal((lastCall(ctx).json as { range: string }).range, 'Notes!B2');
  assert.equal(out['created_tab'], undefined);

  seen.length = 0;
  await run('sheets_append', { account: 'me', spreadsheet_id: ID, range: 'q1 2026', values: [['x']], create_tab_if_missing: true }, ctx);
  assert.deepEqual(seen, [`POST /v4/spreadsheets/${ID}/values/'Q1%202026':append`], 'bare tab names are re-quoted with the real title');
});

test('the POSTs (append, addSheet, create) are not retried after a 5xx', async () => {
  const boom = { status: 503, json: { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } } };
  const ctx = createTestContext({ google: withInfo(() => boom) });
  await assert.rejects(run('sheets_append', { account: 'me', spreadsheet_id: ID, range: 'Sheet1', values: [['x']] }, ctx), /503.*Not retried automatically/);
  assert.equal(apiCalls(ctx).length, 1, 'append sent once');

  ctx.calls.length = 0;
  await assert.rejects(run('sheets_write', { account: 'me', spreadsheet_id: ID, range: 'New!A1', values: [['x']], create_tab_if_missing: true }, ctx), /503/);
  assert.deepEqual(
    apiCalls(ctx).map((c) => `${c.method} ${c.url.pathname}`),
    [`GET /v4/spreadsheets/${ID}`, `POST /v4/spreadsheets/${ID}:batchUpdate`],
    'addSheet sent once and the write never happens',
  );

  ctx.calls.length = 0;
  await assert.rejects(run('sheets_create', { account: 'me', title: 'T' }, ctx), /503/);
  assert.equal(apiCalls(ctx).length, 1, 'spreadsheets.create sent once');
});

test('sheets_append POSTs to :append with INSERT_ROWS and returns the updates block', async () => {
  const ctx = createTestContext({
    google: () => ({
      json: { spreadsheetId: ID, tableRange: 'Sheet1!A1:D20', updates: { updatedRange: 'Sheet1!A21:D22', updatedRows: 2, updatedColumns: 4, updatedCells: 8 } },
    }),
  });
  const values = [['a', 1, true, null], ['b', 2]];
  const out = resultJson(await run('sheets_append', { account: 'me', spreadsheet_id: ID, range: 'Sheet1!A:D', values }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, `/v4/spreadsheets/${ID}/values/Sheet1!A%3AD:append`);
  assert.equal(call.url.searchParams.get('valueInputOption'), 'USER_ENTERED');
  assert.equal(call.url.searchParams.get('insertDataOption'), 'INSERT_ROWS');
  assert.deepEqual(call.json, { values });
  assert.deepEqual(out, { updated_range: 'Sheet1!A21:D22', updated_rows: 2, updated_columns: 4, updated_cells: 8, table_range: 'Sheet1!A1:D20' });
});

test('sheets_append can create the tab first and pass RAW', async () => {
  const ctx = createTestContext({
    google: withInfo((call) => (call.url.pathname.endsWith(':batchUpdate') ? { json: {} } : { json: { updates: { updatedRange: 'Log!A1:B1', updatedRows: 1, updatedCells: 2 } } })),
  });
  const out = resultJson(await run('sheets_append', { account: 'me', spreadsheet_id: ID, range: 'Log', values: [['x', 'y']], value_input: 'RAW', create_tab_if_missing: true }, ctx));
  const calls = apiCalls(ctx).map((c) => `${c.method} ${c.url.pathname}`);
  assert.deepEqual(calls, [`GET /v4/spreadsheets/${ID}`, `POST /v4/spreadsheets/${ID}:batchUpdate`, `POST /v4/spreadsheets/${ID}/values/Log:append`]);
  assert.equal(lastCall(ctx).url.searchParams.get('valueInputOption'), 'RAW');
  assert.deepEqual(out, { updated_range: 'Log!A1:B1', updated_rows: 1, updated_cells: 2, created_tab: 'Log' });
});

test('sheets_create posts the tabs, then writes initial values to the first tab', async () => {
  const ctx = createTestContext({
    google: (call) => {
      if (call.method === 'POST' && call.url.pathname === '/v4/spreadsheets') {
        return {
          json: {
            spreadsheetId: 'new123',
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new123/edit',
            properties: { title: 'Plan' },
            sheets: [
              { properties: { sheetId: 0, title: 'Tasks', index: 0 } },
              { properties: { sheetId: 1, title: 'Done 2026', index: 1 } },
            ],
          },
        };
      }
      return { json: { updatedRange: 'Tasks!A1:B2', updatedRows: 2, updatedColumns: 2, updatedCells: 4 } };
    },
  });
  const out = resultJson(
    await run('sheets_create', { account: 'me', title: 'Plan', sheet_titles: ['Tasks', 'Done 2026'], initial_values: [['Task', 'Owner'], ['Ship', 'Alex']] }, ctx),
  );
  const calls = apiCalls(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.url.pathname, '/v4/spreadsheets');
  assert.equal(calls[0]!.url.searchParams.get('fields'), INFO_FIELDS);
  assert.deepEqual(calls[0]!.json, { properties: { title: 'Plan' }, sheets: [{ properties: { title: 'Tasks' } }, { properties: { title: 'Done 2026' } }] });
  assert.equal(calls[1]!.method, 'PUT');
  assert.equal(calls[1]!.url.pathname, '/v4/spreadsheets/new123/values/Tasks!A1');
  assert.equal(calls[1]!.url.searchParams.get('valueInputOption'), 'USER_ENTERED');
  assert.deepEqual(calls[1]!.json, { range: 'Tasks!A1', majorDimension: 'ROWS', values: [['Task', 'Owner'], ['Ship', 'Alex']] });
  assert.deepEqual(out, {
    spreadsheet_id: 'new123',
    url: 'https://docs.google.com/spreadsheets/d/new123/edit',
    title: 'Plan',
    tabs: ['Tasks', 'Done 2026'],
    initial_values_written: { updated_range: 'Tasks!A1:B2', updated_rows: 2, updated_columns: 2, updated_cells: 4 },
  });
});

test('sheets_create defaults to one Sheet1 tab and rejects duplicate titles', async () => {
  const ctx = createTestContext({
    google: () => ({ json: { spreadsheetId: 'n1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/n1/edit', properties: { title: 'Empty' }, sheets: [{ properties: { title: 'Sheet1', index: 0 } }] } }),
  });
  const out = resultJson(await run('sheets_create', { account: 'me', title: 'Empty' }, ctx));
  assert.deepEqual(lastCall(ctx).json, { properties: { title: 'Empty' }, sheets: [{ properties: { title: 'Sheet1' } }] });
  assert.deepEqual(out, { spreadsheet_id: 'n1', url: 'https://docs.google.com/spreadsheets/d/n1/edit', title: 'Empty', tabs: ['Sheet1'] });
  assert.equal(apiCalls(ctx).length, 1, 'no values.update without initial_values');

  const dup = await run('sheets_create', { account: 'me', title: 'Dup', sheet_titles: ['A', 'A'] }, ctx);
  assert.equal(dup.isError, true);
  assert.match(resultText(dup), /unique/);
});

test('input schemas reject empty values and out-of-range limits before any Google call', () => {
  const writeSchema = z.object(tool('sheets_write').inputSchema);
  assert.equal(writeSchema.safeParse({ account: 'me', spreadsheet_id: ID, range: 'A1', values: [] }).success, false);
  assert.equal(writeSchema.safeParse({ account: 'me', spreadsheet_id: ID, range: 'A1', values: [[{ nested: 1 }]] }).success, false);
  assert.equal(writeSchema.safeParse({ account: 'me', spreadsheet_id: ID, range: 'A1', values: [[], ['a', 1, true, null]] }).success, true, 'ragged rows are allowed');
  const readSchema = z.object(tool('sheets_read').inputSchema);
  assert.equal(readSchema.safeParse({ account: 'me', spreadsheet_id: ID, max_rows: 0 }).success, false);
  assert.equal(readSchema.safeParse({ account: 'me', spreadsheet_id: ID, max_rows: 1001 }).success, false);
  assert.equal(readSchema.safeParse({ account: 'me', spreadsheet_id: ID, max_cols: 101 }).success, false);
  assert.equal(readSchema.safeParse({ account: 'me', spreadsheet_id: ID, value_render: 'raw' }).success, false);
  assert.equal(readSchema.safeParse({ account: 'me', spreadsheet_id: ID }).success, true);
});

test('sheets_read ranges: several ranges in one batchGet, each shaped and capped on its own', async () => {
  const ctx = createTestContext({
    google: (call) =>
      call.url.pathname.endsWith('/values:batchGet')
        ? {
            json: {
              valueRanges: [
                { range: "'Q1 2026'!A1:B3", values: [['Poste', 'Montant'], [], ['Loyer', '850']] },
                { range: 'Notes!A1:A1', values: [] },
              ],
            },
          }
        : undefined,
  });
  const result = await run('sheets_read', { account: 'me', spreadsheet_id: URL_FORM, ranges: ['Q1 2026!A1:B3', 'Notes!A1'] }, ctx);
  const out = resultJson<{ ranges: { range: string; rows: unknown[][]; row_count_returned: number; note?: string }[] }>(result);
  assert.deepEqual(out.ranges.map((r) => [r.range, r.rows, r.row_count_returned]), [
    ["'Q1 2026'!A1:B3", [['Poste', 'Montant'], ['Loyer', '850']], 2],
    ['Notes!A1:A1', [], 0],
  ]);
  assert.equal(out.ranges[1]!.note, 'The range has no values.');
  const call = lastCall(ctx);
  assert.equal(`${call.url.origin}${call.url.pathname}`, `${BASE}/spreadsheets/${ID}/values:batchGet`);
  assert.deepEqual(call.url.searchParams.getAll('ranges'), ["'Q1 2026'!A1:B3", 'Notes!A1']);
  assert.equal(call.url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
  assert.match(resultText(await runTool(tool('sheets_read'), { account: 'me', spreadsheet_id: ID, range: 'A1', ranges: ['B1'] }, ctx)), /range or ranges, not both/);
});
