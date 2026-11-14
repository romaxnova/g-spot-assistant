import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBombPdf, makeCjkPdf, makePdf } from '../../test-fixtures.js';
import { extractPdfText, PdfError } from './pdf.js';

test('extracts text page by page, keeping lines and accents', async () => {
  const pdf = makePdf([['Ticket de caisse', 'Total: 42,50 EUR', 'Merci (et à bientôt)'], ['Second page']]);
  const out = await extractPdfText(pdf);
  assert.equal(out.pages, 2);
  assert.equal(out.pagesRead, 2);
  assert.equal(out.text, '## Page 1\nTicket de caisse\nTotal: 42,50 EUR\nMerci (et à bientôt)\n\n## Page 2\nSecond page');
  assert.equal(out.note, undefined);
});

test('caps the number of pages and says so', async () => {
  const pdf = makePdf([['one'], ['two'], ['three']]);
  const out = await extractPdfText(pdf, { maxPages: 2 });
  assert.equal(out.pagesRead, 2);
  assert.match(out.text, /## Page 2\ntwo$/);
  assert.match(out.note ?? '', /first 2 of 3 pages/);
});

test('a PDF without a text layer is reported, not returned as empty text', async () => {
  const out = await extractPdfText(makePdf([[], []]));
  assert.equal(out.text, '');
  assert.match(out.note ?? '', /no text layer/);
});

test('garbage and password-protected files raise clear PdfErrors', async () => {
  await assert.rejects(extractPdfText(Buffer.from('not a pdf at all')), (e: Error) => e instanceof PdfError && /could not be read as a PDF/.test(e.message));
  await assert.rejects(extractPdfText(makePdf([['secret']], { encrypt: true })), (e: Error) => e instanceof PdfError && /password-protected/.test(e.message));
});

test('a damaged page is marked and the rest of the document is still read', async () => {
  const out = await extractPdfText(makePdf([['one'], ['two'], ['three']], { damagedPages: [2] }));
  assert.match(out.text, /^## Page 1\none\n\n## Page 2\n\[this page could not be read\]/);
  assert.match(out.note ?? '', /Page 2 could not be read \(damaged\)/);
});

test('Chinese, Japanese and Korean fonts are read through the bundled character maps', async () => {
  const out = await extractPdfText(makeCjkPdf('テスト日本語'));
  assert.equal(out.text, '## Page 1\nテスト日本語');
});

test('a decompression bomb is stopped by the memory budget, a slow file by the time limit', async () => {
  // 1.3 KB on disk, 128 MB once inflated.
  const bomb = await makeBombPdf(128 * 1024 * 1024);
  assert.ok(bomb.length < 4096);
  const started = Date.now();
  await assert.rejects(extractPdfText(bomb, { maxMemoryBytes: 32 * 1024 * 1024 }), (e: Error) => e instanceof PdfError && /expands to far more data than it contains/.test(e.message));
  assert.ok(Date.now() - started < 10_000, 'stopped early, not after inflating everything');
  await assert.rejects(extractPdfText(makePdf([['x']]), { timeoutMs: 1 }), (e: Error) => e instanceof PdfError && /took longer than 0\.001 s/.test(e.message));
  // The reader is usable again afterwards.
  assert.equal((await extractPdfText(makePdf([['after']]))).text, '## Page 1\nafter');
});

test('concurrent extractions are queued and each gets its own result', async () => {
  const results = await Promise.all(['A', 'B', 'C'].map((t) => extractPdfText(makePdf([[t]]))));
  assert.deepEqual(results.map((r) => r.text), ['## Page 1\nA', '## Page 1\nB', '## Page 1\nC']);
});
