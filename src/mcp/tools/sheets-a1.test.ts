import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSpreadsheetId, joinA1, normalizeRange, quoteTab, SheetsInputError, splitA1 } from './sheets-a1.js';

test('extractSpreadsheetId accepts ids and every common Sheets URL shape', () => {
  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  assert.equal(extractSpreadsheetId(id), id);
  assert.equal(extractSpreadsheetId(`  ${id}\n`), id);
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), id);
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/u/1/d/${id}`), id);
  assert.throws(() => extractSpreadsheetId('https://docs.google.com/spreadsheets/'), SheetsInputError);
  assert.throws(() => extractSpreadsheetId('not an id!'), /neither a spreadsheet id nor a Google Sheets URL/);
});

test('splitA1 handles plain, quoted, bare-tab and bare-cell ranges', () => {
  assert.deepEqual(splitA1('Sheet1!A1:D50'), { tab: 'Sheet1', cells: 'A1:D50' });
  assert.deepEqual(splitA1("'My Tab'!A1:B2"), { tab: 'My Tab', cells: 'A1:B2' });
  assert.deepEqual(splitA1("'It''s'!C3"), { tab: "It's", cells: 'C3' });
  assert.deepEqual(splitA1("'Q1 2026'"), { tab: 'Q1 2026' });
  assert.deepEqual(splitA1('Sheet1'), { tab: 'Sheet1' });
  assert.deepEqual(splitA1('Sheet1!'), { tab: 'Sheet1' });
  assert.deepEqual(splitA1('My Tab!A:D'), { tab: 'My Tab', cells: 'A:D' });
  assert.deepEqual(splitA1('Data!2:10'), { tab: 'Data', cells: '2:10' });
  assert.deepEqual(splitA1('A1:D50'), { cells: 'A1:D50' });
  assert.deepEqual(splitA1('B7'), { cells: 'B7' });
  assert.deepEqual(splitA1('A:A'), { cells: 'A:A' });
  assert.deepEqual(splitA1('A1:B'), { cells: 'A1:B' });
  assert.deepEqual(splitA1('Log'), { tab: 'Log' }, 'a short word is a tab, not a column');
  assert.deepEqual(splitA1('ABC'), { tab: 'ABC' });
  assert.deepEqual(splitA1(' Sheet1!A1 '), { tab: 'Sheet1', cells: 'A1' });
});

test('splitA1 rejects malformed input with a message Claude can act on', () => {
  assert.throws(() => splitA1(''), /must not be empty/);
  assert.throws(() => splitA1("'Unterminated!A1"), /unterminated quoted tab name/);
  assert.throws(() => splitA1("'Tab'A1"), /expected "!"/);
  assert.throws(() => splitA1('!A1'), /empty tab name/);
  assert.throws(() => splitA1('Sheet1!foo bar'), /not a valid A1 cell range/);
});

test('quoteTab quotes only when Sheets would misread the title', () => {
  assert.equal(quoteTab('Sheet1'), 'Sheet1');
  assert.equal(quoteTab('Data_2026'), 'Data_2026');
  assert.equal(quoteTab('My Tab'), "'My Tab'");
  assert.equal(quoteTab('2026'), "'2026'");
  assert.equal(quoteTab('AB12'), "'AB12'");
  assert.equal(quoteTab('Log'), 'Log');
  assert.equal(quoteTab("Alex's"), "'Alex''s'");
  assert.equal(quoteTab('Été'), "'Été'");
});

test('joinA1 and normalizeRange round-trip and add quotes where needed', () => {
  assert.equal(joinA1({ tab: 'Sheet1', cells: 'A1:B2' }), 'Sheet1!A1:B2');
  assert.equal(joinA1({ tab: 'My Tab' }), "'My Tab'");
  assert.equal(joinA1({ cells: 'A1' }), 'A1');
  assert.throws(() => joinA1({}), SheetsInputError);
  assert.equal(normalizeRange('My Tab!A1:D5'), "'My Tab'!A1:D5");
  assert.equal(normalizeRange("'My Tab'!A1:D5"), "'My Tab'!A1:D5");
  assert.equal(normalizeRange("'Sheet1'!A1"), 'Sheet1!A1');
  assert.equal(normalizeRange('A1:D5'), 'A1:D5');
});
