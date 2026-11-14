/**
 * Pure helpers for Google Sheets: spreadsheet id extraction and A1-notation ranges.
 *
 * A1 notation is "Tab!A1:B2". Tab names containing anything but letters, digits
 * and underscores must be single-quoted, and a literal quote inside a quoted
 * name is doubled ('It''s'!A1). Google also accepts a bare tab name ("Tab",
 * meaning its whole used range) and a bare cell range ("A1:B2", meaning the
 * first tab).
 */

/** Thrown for input Claude can fix by changing an argument; tools turn it into errorResult. */
export class SheetsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetsInputError';
  }
}

const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Accepts a raw spreadsheet id or any Google Sheets URL (the id sits between /d/ and the next slash). */
export function extractSpreadsheetId(input: string): string {
  const value = input.trim();
  const fromUrl = /\/d\/([A-Za-z0-9_-]+)/.exec(value);
  if (fromUrl) return fromUrl[1]!;
  if (SPREADSHEET_ID_RE.test(value)) return value;
  throw new SheetsInputError(`spreadsheet_id "${input}" is neither a spreadsheet id nor a Google Sheets URL (https://docs.google.com/spreadsheets/d/<id>/...).`);
}

export interface A1Parts {
  /** Tab title with quotes removed, or undefined when the range names only cells. */
  tab?: string;
  /** Cell part ("A1:B2", "A:D", "2:5") or undefined when the range names only a tab. */
  cells?: string;
}

/**
 * Something Sheets reads as cells rather than a tab title: a cell (B7), or a
 * span of cells, columns or rows (A1:D50, A:D, A1:B, 2:10). A bare word of up
 * to three letters ("Log") is a tab name, not a column, so letters alone never match.
 */
const CELL_RANGE_RE = /^(?:[A-Za-z]{1,3}\d+|(?:[A-Za-z]{1,3}\d*|\d+):(?:[A-Za-z]{1,3}\d*|\d+))$/;

/** Splits A1 notation into tab and cells. Handles quoted tab names and bare tab names / bare cell ranges. */
export function splitA1(range: string): A1Parts {
  const value = range.trim();
  if (!value) throw new SheetsInputError('range must not be empty.');

  if (value.startsWith("'")) {
    // Quoted tab: scan for the closing quote, treating '' as an escaped quote.
    let title = '';
    let i = 1;
    for (; i < value.length; i++) {
      const ch = value[i]!;
      if (ch !== "'") {
        title += ch;
      } else if (value[i + 1] === "'") {
        title += "'";
        i++;
      } else {
        break;
      }
    }
    if (i >= value.length) throw new SheetsInputError(`range "${range}" has an unterminated quoted tab name.`);
    const rest = value.slice(i + 1);
    if (rest === '') return { tab: title };
    if (!rest.startsWith('!')) throw new SheetsInputError(`range "${range}": expected "!" after the quoted tab name.`);
    return withCells(title, rest.slice(1), range);
  }

  const bang = value.indexOf('!');
  if (bang === -1) {
    return CELL_RANGE_RE.test(value) ? { cells: value } : { tab: value };
  }
  const tab = value.slice(0, bang);
  if (!tab) throw new SheetsInputError(`range "${range}" has an empty tab name before "!".`);
  return withCells(tab, value.slice(bang + 1), range);
}

function withCells(tab: string, cells: string, original: string): A1Parts {
  const trimmed = cells.trim();
  if (!trimmed) return { tab };
  if (!CELL_RANGE_RE.test(trimmed)) throw new SheetsInputError(`range "${original}": "${trimmed}" is not a valid A1 cell range (examples: A1, A1:D50, A:D, 2:10).`);
  return { tab, cells: trimmed };
}

/** Quotes a tab title when Sheets would otherwise misread it (spaces, punctuation, or a name that looks like a cell such as "AB12"). */
export function quoteTab(title: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(title) && !CELL_RANGE_RE.test(title);
  return plain ? title : `'${title.replace(/'/g, "''")}'`;
}

/** Rebuilds A1 notation from its parts, quoting the tab when needed. */
export function joinA1(parts: A1Parts): string {
  if (parts.tab === undefined) {
    if (parts.cells === undefined) throw new SheetsInputError('range must name a tab or cells.');
    return parts.cells;
  }
  return parts.cells === undefined ? quoteTab(parts.tab) : `${quoteTab(parts.tab)}!${parts.cells}`;
}

/** Normalizes user input to the A1 string sent to Google (so 'My Tab!A1' becomes "'My Tab'!A1"). */
export function normalizeRange(range: string): string {
  return joinA1(splitA1(range));
}
