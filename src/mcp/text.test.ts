import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, normalizeNewlines, oneLine, stripTrackingParams, trimCsv } from './text.js';

test('cleanText removes preheader padding as seen in real marketing mail', () => {
  // Shape of a real text/plain part: a sentence, then lines of U+034F + spaces, CRLF endings.
  const padding = ('  ͏  '.repeat(20) + '\r\n').repeat(5);
  const raw = `New in Claude Code Your new default, \r\nplus more room    ͏   ͏ \r\n${padding}\r\n\r\n\r\nClaude Code now runs on Opus 5.5 \r\nIt is faster.`;
  assert.equal(cleanText(raw), 'New in Claude Code Your new default,\nplus more room\n\nClaude Code now runs on Opus 5.5\nIt is faster.');
});

test('cleanText removes zero-width joiner padding but keeps meaningful joiners, indentation and inner spacing', () => {
  assert.equal(cleanText('Hello‌ ‌ ‌ ‌ world'), 'Hello world');
  assert.equal(cleanText('emoji 👨‍👩‍👧 ok'), 'emoji 👨‍👩‍👧 ok', 'emoji ZWJ sequence untouched');
  assert.equal(cleanText('می‌خواهم'), 'می‌خواهم', 'Persian ZWNJ inside a word untouched');
  assert.equal(cleanText('  indented\nItem    Qty\n  \nnext'), '  indented\nItem    Qty\n\nnext');
  assert.equal(cleanText('soft­hyphen zero​width ﻿bom'), 'softhyphen zerowidth bom');
  assert.equal(cleanText('\n\n\ntext\n\n\n\n'), 'text');
});

test('oneLine and normalizeNewlines', () => {
  assert.equal(oneLine('Receipt #2162 ͏ ͏ ͏\r\n  next'), 'Receipt #2162 next');
  assert.equal(normalizeNewlines('﻿a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(normalizeNewlines('keep ​ inside data'), 'keep ​ inside data', 'data formats keep their characters');
});

test('stripTrackingParams removes analytics parameters only', () => {
  const railway =
    'Restart Deployment ( https://railway.com/project/p1/service/s1?utm_campaign=Deployment+crashed+email&utm_content=x&utm_medium=email_action&utm_source=customer.io )';
  assert.equal(stripTrackingParams(railway), 'Restart Deployment ( https://railway.com/project/p1/service/s1 )');
  assert.equal(stripTrackingParams('see https://ex.com/a?id=7&utm_source=n&fbclid=abc#top.'), 'see https://ex.com/a?id=7#top.');
  assert.equal(stripTrackingParams('Open (https://ex.com/p?utm_medium=m), then'), 'Open (https://ex.com/p), then');
  const untouched = 'plain https://ex.com/x?a=1&b=%20two and http://[bad';
  assert.equal(stripTrackingParams(untouched), untouched);
});

test('trimCsv drops trailing empty cells and trailing empty records, keeping positions', () => {
  const csv = ',,,,\n,Statistic,,,Total,\n,Date,Sum,,,\n,"a,,",,\n,"multi\nline,,",x,,\n\n,,\n';
  assert.equal(trimCsv(csv), '\n,Statistic,,,Total\n,Date,Sum\n,"a,,"\n,"multi\nline,,",x');
  assert.equal(trimCsv('a,"say ""hi"",",\nb'), 'a,"say ""hi"","\nb');
  assert.equal(trimCsv(''), '');
});
