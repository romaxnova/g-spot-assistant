/**
 * Google Sheets tools: spreadsheet info (tabs), read a range, write a range,
 * append rows, create a spreadsheet.
 *
 * Surprises in the Sheets API worth knowing when reading this file:
 * - values.get returns only the used part of a range: trailing empty cells in a
 *   row are omitted and fully empty rows come back as [] (or are dropped at the end).
 * - In values.update a JSON null cell means "leave the cell as it is"; only an
 *   empty string clears a cell.
 * - values.append looks for a "table" inside the given range and writes below
 *   its last row, so the range is a search area, not the destination.
 * - Ranges live in the URL path, so they are always encodeURIComponent'ed.
 */
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { GoogleApiError } from '../../google/client.js';
import { accountParam, defineTool, errorResult, jsonResult, stripEmpty, textResult, type ToolContext, type ToolDefinition } from '../registry.js';
import { extractSpreadsheetId, joinA1, normalizeRange, quoteTab, SheetsInputError, splitA1 } from './sheets-a1.js';

const SERVICE = 'sheets' as const;

/* ---------- Shared parameters ---------- */

const spreadsheetIdParam = z.string().min(1).describe('Spreadsheet id (the long token in the sheet URL) or the full Google Sheets URL; both are accepted.');
const valueInputParam = z
  .enum(['USER_ENTERED', 'RAW'])
  .optional()
  .describe("How Google interprets the values: USER_ENTERED (default) parses like typing in the UI, so '=SUM(A1:A3)' becomes a formula and '2026-03-14' a date; RAW stores strings verbatim.");
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valuesParam = (what: string) =>
  z
    .array(z.array(cellValue).max(1000))
    .min(1)
    .max(10_000)
    .describe(`${what} as a 2-D array of rows (outer) and cells (inner), e.g. [["Name","Qty"],["Bolt",12]]. Rows may differ in length. A null cell is skipped (left as is); use "" to clear a cell.`);
const createTabParam = z
  .boolean()
  .optional()
  .describe('When true and the tab named in range does not exist yet, add it first (default false: a missing tab is an error).');

/* ---------- Google shapes ---------- */

interface SpreadsheetInfo {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string; locale?: string; timeZone?: string };
  sheets?: {
    properties?: {
      sheetId?: number;
      title?: string;
      index?: number;
      gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
    };
  }[];
}

interface ValueRange {
  range?: string;
  values?: unknown[][];
}

interface UpdateValuesResponse {
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

interface AppendValuesResponse {
  tableRange?: string;
  updates?: UpdateValuesResponse;
}

const INFO_FIELDS = 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount,frozenRowCount))),spreadsheetUrl';

/* ---------- Helpers ---------- */

/** Runs a handler and turns SheetsInputError (Claude can fix the argument) into an errorResult. */
async function withInputErrors(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SheetsInputError) return errorResult(err.message);
    throw err;
  }
}

function valuesPath(spreadsheetId: string, range: string, suffix = ''): string {
  return `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
}

async function fetchInfo(ctx: ToolContext, account: string, spreadsheetId: string): Promise<SpreadsheetInfo> {
  return ctx.google.request<SpreadsheetInfo>(account, SERVICE, { url: `/spreadsheets/${encodeURIComponent(spreadsheetId)}`, query: { fields: INFO_FIELDS } });
}

function tabSummaries(info: SpreadsheetInfo) {
  return (info.sheets ?? [])
    .map((s) => s.properties ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({
      sheet_id: p.sheetId,
      title: p.title,
      index: p.index,
      rows: p.gridProperties?.rowCount,
      cols: p.gridProperties?.columnCount,
      frozen_rows: p.gridProperties?.frozenRowCount,
    }));
}

function tabTitles(info: SpreadsheetInfo): string[] {
  return tabSummaries(info).map((t) => t.title ?? '');
}

function compactUpdate(u: UpdateValuesResponse | undefined) {
  return { updated_range: u?.updatedRange, updated_rows: u?.updatedRows, updated_columns: u?.updatedColumns, updated_cells: u?.updatedCells };
}

interface TabTarget {
  /** Range to send to Google. When the tab exists under a differently-cased title, that exact title is substituted in. */
  range: string;
  /** Title of the tab that was added, so the caller can report it. */
  createdTab?: string;
}

/**
 * Adds the tab named in `range` when `create` is set and it does not exist.
 * A range without a tab (bare cells) always targets the first tab and never
 * creates anything. Tab titles are unique case-insensitively in Sheets: with a
 * "Log" tab present, addSheet "log" fails with 400, so an existing title is
 * matched ignoring case and reused as written in the spreadsheet.
 */
async function ensureTab(ctx: ToolContext, account: string, spreadsheetId: string, range: string, create: boolean): Promise<TabTarget> {
  const { tab, cells } = splitA1(range);
  if (!create || tab === undefined) return { range };
  const info = await fetchInfo(ctx, account, spreadsheetId);
  const wanted = tab.toLowerCase();
  const existing = tabTitles(info).find((t) => t.toLowerCase() === wanted);
  if (existing !== undefined) return { range: joinA1({ tab: existing, cells }) };
  // Deliberately not idempotent: a retried addSheet after a timeout would fail on the duplicate title.
  await ctx.google.request(account, SERVICE, {
    method: 'POST',
    url: `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    body: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
  ctx.log.info('sheets tab created', { alias: account });
  return { range, createdTab: tab };
}

/** Google answers a range naming an unknown tab with 400 "Unable to parse range"; list the tabs so Claude can retry. */
async function describeRangeError(ctx: ToolContext, account: string, spreadsheetId: string, err: unknown): Promise<CallToolResult | undefined> {
  if (!(err instanceof GoogleApiError && err.status === 400 && /unable to parse range/i.test(err.message))) return undefined;
  const info = await fetchInfo(ctx, account, spreadsheetId);
  return errorResult(`${err.message}. Existing tabs: ${tabTitles(info).map((t) => JSON.stringify(t)).join(', ')}. Use one of them, or set create_tab_if_missing=true on write/append.`);
}

/** Runs a values call and converts an unknown-tab 400 into a fixable error listing the tabs. */
async function withRangeErrors(ctx: ToolContext, account: string, spreadsheetId: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const described = await describeRangeError(ctx, account, spreadsheetId, err);
    if (described) return described;
    throw err;
  }
}

const isEmptyCell = (cell: unknown) => cell === '' || cell === null || cell === undefined;
const isBlankRow = (row: unknown[]) => row.every(isEmptyCell);

/** Google already omits trailing empty cells, but cutting a row to max_cols can expose new ones. */
function trimTrailingEmpty(row: unknown[]): unknown[] {
  let end = row.length;
  while (end > 0 && isEmptyCell(row[end - 1])) end--;
  return end === row.length ? row : row.slice(0, end);
}

/** Applies skip_empty_rows, max_rows and max_cols, and explains what was dropped. */
function shapeRows(all: unknown[][], opts: { maxRows: number; maxCols: number; skipEmpty: boolean }) {
  const kept = opts.skipEmpty ? all.filter((r) => !isBlankRow(r)) : all;
  const skipped = all.length - kept.length;
  const page = kept.slice(0, opts.maxRows);
  const rows = page.map((r) => trimTrailingEmpty(r.slice(0, opts.maxCols)));
  const rowsTruncated = kept.length > opts.maxRows;
  const colsTruncated = page.some((r) => r.length > opts.maxCols);
  const notes: string[] = [];
  if (rowsTruncated) notes.push(`showing the first ${opts.maxRows} of ${kept.length} rows; read a narrower range (e.g. rows ${opts.maxRows + 1}+) or raise max_rows`);
  if (colsTruncated) notes.push(`rows were cut to ${opts.maxCols} columns; narrow the range or raise max_cols`);
  if (skipped > 0) notes.push(`${skipped} empty row(s) skipped, so positions do not equal sheet row numbers; pass skip_empty_rows=false when row numbers matter`);
  return { rows, kept: kept.length, truncated: rowsTruncated || colsTruncated, note: notes.length ? notes.join('. ') + '.' : undefined };
}

/**
 * JSON result for a grid: metadata goes through the usual empty-stripping, but
 * rows are serialized verbatim, one row per line. jsonResult would drop "" cells
 * and [] rows, which shifts columns and row positions; the flat layout is also
 * far cheaper in tokens than indent-1 JSON with one cell per line.
 */
/** JSON with one row per line: compact, and readable when clipped. `indent` nests it (several ranges). */
function gridText(meta: Record<string, string | number | boolean | undefined>, rows: unknown[][], indent = ''): string {
  const fields = Object.entries(stripEmpty(meta)).map(([k, v]) => `${indent} ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const grid = rows.map((r) => `${indent}  ${JSON.stringify(r)}`).join(',\n');
  fields.splice(1, 0, `${indent} "rows": [${grid ? `\n${grid}\n${indent} ` : ''}]`);
  return `${indent}{\n${fields.join(',\n')}\n${indent}}`;
}

function gridResult(meta: Record<string, string | number | boolean | undefined>, rows: unknown[][]): CallToolResult {
  return textResult(gridText(meta, rows));
}

/** At most this many ranges per sheets_read call. */
const MAX_RANGES = 10;

const VALUE_RENDER: Record<'formatted' | 'unformatted' | 'formula', string> = {
  formatted: 'FORMATTED_VALUE',
  unformatted: 'UNFORMATTED_VALUE',
  formula: 'FORMULA',
};

/* ---------- Tools ---------- */

const getInfo = defineTool({
  name: 'sheets_get_info',
  title: 'Get spreadsheet info',
  description:
    'Returns a spreadsheet\'s title, locale, time zone, URL and its tabs (sheet_id, title, index, row/column counts, frozen rows). Use it to learn tab names before sheets_read/sheets_write. Reads nothing from the cells.',
  service: SERVICE,
  inputSchema: { account: accountParam, spreadsheet_id: spreadsheetIdParam },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    withInputErrors(async () => {
      const id = extractSpreadsheetId(args.spreadsheet_id);
      const info = await fetchInfo(ctx, args.account, id);
      return jsonResult({
        spreadsheet_id: info.spreadsheetId ?? id,
        title: info.properties?.title,
        locale: info.properties?.locale,
        time_zone: info.properties?.timeZone,
        url: info.spreadsheetUrl,
        tabs: tabSummaries(info),
      });
    }),
});

const read = defineTool({
  name: 'sheets_read',
  title: 'Read a range',
  description:
    "Reads cell values from a range as rows (2-D array). Only the used part of the range is returned: trailing empty cells are omitted and empty rows are skipped by default. Output is capped by max_rows/max_cols with truncated=true and a note when cut; read a narrower range to page (e.g. 'Sheet1!A201:D400'). Omit range to read the first tab. " +
    `ranges reads up to ${MAX_RANGES} ranges (several tabs, or parts of one) in one call, each capped as above: {ranges: [{range, rows, ...}]}.`,
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    spreadsheet_id: spreadsheetIdParam,
    range: z
      .string()
      .min(1)
      .optional()
      .describe("A1 notation: 'Sheet1!A1:D50', a bare tab name ('Sheet1' or 'My Tab' for its whole used area) or bare cells ('A1:D50' on the first tab). Default: the whole first tab."),
    ranges: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_RANGES)
      .optional()
      .describe(`Several ranges at once instead of range (up to ${MAX_RANGES}), in the same notation, e.g. ["Budget", "Contacts!A1:C20"].`),
    max_rows: z.number().int().min(1).max(1000).optional().describe('Maximum rows to return (default 200).'),
    max_cols: z.number().int().min(1).max(100).optional().describe('Maximum cells per row to return (default 30).'),
    value_render: z
      .enum(['formatted', 'unformatted', 'formula'])
      .optional()
      .describe("formatted (default): values as displayed, e.g. '1,234.50' or '14/03/2026' as strings; unformatted: raw numbers/booleans, dates as text; formula: the formula source where present, other cells as unformatted (dates as text)."),
    skip_empty_rows: z.boolean().optional().describe('Drop rows with no values (default true). Set false when row positions must match sheet row numbers.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    withInputErrors(async () => {
      const id = extractSpreadsheetId(args.spreadsheet_id);
      const render = args.value_render ?? 'formatted';
      if (args.ranges) {
        if (args.range !== undefined) throw new SheetsInputError('Give range or ranges, not both.');
        const ranges = args.ranges.map(normalizeRange);
        return withRangeErrors(ctx, args.account, id, async () => {
          const res = await ctx.google.request<{ valueRanges?: ValueRange[] }>(args.account, SERVICE, {
            url: `/spreadsheets/${encodeURIComponent(id)}/values:batchGet`,
            query: { ranges, valueRenderOption: VALUE_RENDER[render], majorDimension: 'ROWS', dateTimeRenderOption: render === 'formatted' ? undefined : 'FORMATTED_STRING' },
          });
          const blocks = ranges.map((range, i) => {
            const vr = res.valueRanges?.[i];
            const shaped = shapeRows(vr?.values ?? [], { maxRows: args.max_rows ?? 200, maxCols: args.max_cols ?? 30, skipEmpty: args.skip_empty_rows ?? true });
            const meta = {
              range: vr?.range ?? range,
              row_count_returned: shaped.rows.length,
              row_count_total: shaped.kept,
              truncated: shaped.truncated,
              note: shaped.note ?? (shaped.kept === 0 ? 'The range has no values.' : undefined),
            };
            return gridText(meta, shaped.rows, '  ');
          });
          return textResult(`{\n "ranges": [\n${blocks.join(',\n')}\n ]\n}`);
        });
      }
      const range = args.range === undefined ? await firstTabRange(ctx, args.account, id) : normalizeRange(args.range);
      return withRangeErrors(ctx, args.account, id, async () => {
        const res = await ctx.google.request<ValueRange>(args.account, SERVICE, {
          url: valuesPath(id, range),
          query: {
            valueRenderOption: VALUE_RENDER[render],
            majorDimension: 'ROWS',
            // Without this, date cells come back as day serial numbers (e.g. 46095.5) under
            // UNFORMATTED_VALUE and, for cells that hold no formula, under FORMULA too.
            // Google ignores the option under FORMATTED_VALUE, so it is omitted there.
            dateTimeRenderOption: render === 'formatted' ? undefined : 'FORMATTED_STRING',
          },
        });
        const shaped = shapeRows(res.values ?? [], { maxRows: args.max_rows ?? 200, maxCols: args.max_cols ?? 30, skipEmpty: args.skip_empty_rows ?? true });
        return gridResult(
          {
            range: res.range ?? range,
            row_count_returned: shaped.rows.length,
            row_count_total: shaped.kept,
            truncated: shaped.truncated,
            note: shaped.note ?? (shaped.kept === 0 ? 'The range has no values.' : undefined),
          },
          shaped.rows,
        );
      });
    }),
});

/** A1 range covering the whole first tab (by index) of a spreadsheet. */
async function firstTabRange(ctx: ToolContext, account: string, spreadsheetId: string): Promise<string> {
  const first = tabSummaries(await fetchInfo(ctx, account, spreadsheetId))[0];
  if (!first?.title) throw new SheetsInputError('The spreadsheet has no tabs to read.');
  return quoteTab(first.title);
}

const write = defineTool({
  name: 'sheets_write',
  title: 'Write a range',
  description:
    "Overwrites cells starting at the top-left of range with the given rows (existing values in those cells are replaced; cells outside the written block are untouched). Returns the updated range and cell counts. The range can be a single anchor cell ('Sheet1!B3'), a block ('Sheet1!A1:D10') or a bare tab name (writes from A1). Not destructive beyond the cells written.",
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    spreadsheet_id: spreadsheetIdParam,
    range: z.string().min(1).describe("A1 notation of where to write, e.g. 'Sheet1!A1' (values expand right/down from there) or 'Sheet1!A1:D10'. A bare tab name means A1 of that tab."),
    values: valuesParam('Cell values to write'),
    value_input: valueInputParam,
    create_tab_if_missing: createTabParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    withInputErrors(async () => {
      const id = extractSpreadsheetId(args.spreadsheet_id);
      const { range, createdTab } = await ensureTab(ctx, args.account, id, normalizeRange(args.range), args.create_tab_if_missing ?? false);
      return withRangeErrors(ctx, args.account, id, async () => {
        const res = await ctx.google.request<UpdateValuesResponse>(args.account, SERVICE, {
          method: 'PUT',
          url: valuesPath(id, range),
          query: { valueInputOption: args.value_input ?? 'USER_ENTERED' },
          body: { range, majorDimension: 'ROWS', values: args.values },
        });
        return jsonResult({ ...compactUpdate(res), created_tab: createdTab });
      });
    }),
});

const append = defineTool({
  name: 'sheets_append',
  title: 'Append rows',
  description:
    "Appends rows below the last row of the table found in range (Google searches the range for existing data and writes under it), inserting new rows so nothing below is overwritten. Use a tab name ('Sheet1') or a column span ('Sheet1!A:D') as range. Returns the range actually written and cell counts. Not idempotent: calling twice appends twice.",
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    spreadsheet_id: spreadsheetIdParam,
    range: z.string().min(1).describe("Table range to append to, e.g. 'Sheet1!A:D' or a bare tab name. Data is appended after the last non-empty row of that table."),
    values: valuesParam('Rows to append'),
    value_input: valueInputParam,
    create_tab_if_missing: createTabParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: (args, ctx) =>
    withInputErrors(async () => {
      const id = extractSpreadsheetId(args.spreadsheet_id);
      const { range, createdTab } = await ensureTab(ctx, args.account, id, normalizeRange(args.range), args.create_tab_if_missing ?? false);
      return withRangeErrors(ctx, args.account, id, async () => {
        const res = await ctx.google.request<AppendValuesResponse>(args.account, SERVICE, {
          method: 'POST',
          url: valuesPath(id, range, ':append'),
          query: { valueInputOption: args.value_input ?? 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
          body: { values: args.values },
        });
        return jsonResult({ ...compactUpdate(res.updates), table_range: res.tableRange, created_tab: createdTab });
      });
    }),
});

const create = defineTool({
  name: 'sheets_create',
  title: 'Create a spreadsheet',
  description:
    "Creates a new spreadsheet in the account's Drive root (My Drive) with the given tabs and optionally writes initial rows to the first tab from A1. Returns the new spreadsheet id, URL, title and tab names. Move or share it afterwards with the Drive tools.",
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    title: z.string().min(1).max(500).describe('Spreadsheet (file) title.'),
    sheet_titles: z.array(z.string().min(1).max(100)).min(1).max(50).optional().describe("Tab titles, in order (default one tab named 'Sheet1'). Must be unique."),
    initial_values: valuesParam('Optional rows to write into the first tab starting at A1 (USER_ENTERED)').optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: (args, ctx) =>
    withInputErrors(async () => {
      const titles = args.sheet_titles ?? ['Sheet1'];
      if (new Set(titles).size !== titles.length) return errorResult('sheet_titles must be unique.');
      const info = await ctx.google.request<SpreadsheetInfo>(args.account, SERVICE, {
        method: 'POST',
        url: '/spreadsheets',
        query: { fields: INFO_FIELDS },
        body: { properties: { title: args.title }, sheets: titles.map((title) => ({ properties: { title } })) },
      });
      const id = info.spreadsheetId;
      if (!id) throw new GoogleApiError('Google Sheets API did not return a spreadsheet id for the new file', 0, 'invalid_response');
      ctx.log.info('sheets spreadsheet created', { alias: args.account, tabs: titles.length });
      const tabs = tabTitles(info);
      let written: UpdateValuesResponse | undefined;
      if (args.initial_values) {
        const range = joinA1({ tab: tabs[0] ?? titles[0]!, cells: 'A1' });
        written = await ctx.google.request<UpdateValuesResponse>(args.account, SERVICE, {
          method: 'PUT',
          url: valuesPath(id, range),
          query: { valueInputOption: 'USER_ENTERED' },
          body: { range, majorDimension: 'ROWS', values: args.initial_values },
        });
      }
      return jsonResult({
        spreadsheet_id: id,
        url: info.spreadsheetUrl,
        title: info.properties?.title ?? args.title,
        tabs: tabs.length ? tabs : titles,
        initial_values_written: written ? compactUpdate(written) : undefined,
      });
    }),
});

export const sheetsTools: ToolDefinition[] = [getInfo, read, write, append, create] as ToolDefinition[];
