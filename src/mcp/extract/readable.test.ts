import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf, makePng } from '../../test-fixtures.js';
import { effectiveType, guessLegacyCharset, isTextType, MAX_IMAGE_BYTES, readFileContent, textCharset } from './readable.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

test('effectiveType refines generic labels from the file name and the bytes', () => {
  const pdf = makePdf([['x']]);
  assert.equal(effectiveType(pdf, 'application/octet-stream', 'ticket.pdf'), 'application/pdf');
  assert.equal(effectiveType(pdf, undefined, undefined), 'application/pdf', 'sniffed');
  assert.equal(effectiveType(ZIP_MAGIC, 'application/octet-stream', 'report.docx'), DOCX, 'a ZIP named .docx is a Word file');
  assert.equal(effectiveType(ZIP_MAGIC, 'application/zip', 'report.docx'), DOCX);
  assert.equal(effectiveType(ZIP_MAGIC, 'application/zip', 'photos.zip'), 'application/zip');
  assert.equal(effectiveType(makePng(), 'image/jpeg', 'x.jpg'), 'image/png', 'bytes win over a wrong image label');
  assert.equal(effectiveType(Buffer.from('a,b'), 'text/csv', 'x.csv'), 'text/csv');
  assert.equal(effectiveType(Buffer.from('a,b'), 'Text/CSV; charset=utf-8', undefined), 'text/csv');
});

test('isTextType covers text/*, JSON, XML, +xml/+json and mail', () => {
  for (const t of ['text/plain', 'text/calendar', 'application/json', 'application/ld+json', 'image/svg+xml', 'message/rfc822', 'application/x-yaml']) assert.ok(isTextType(t), t);
  for (const t of ['application/pdf', 'image/png', 'application/zip', DOCX]) assert.ok(!isTextType(t), t);
});

test('text files are decoded with their charset and cleaned per format', async () => {
  const csv = await readFileContent(Buffer.from('a,b,,\r\n1,2,,\r\n,,,\r\n'), { mimeType: 'text/csv' });
  assert.deepEqual(csv, { kind: 'text', text: 'a,b\n1,2', format: 'text/csv' });

  const html = await readFileContent(Buffer.from('<h1>Title</h1><p>Body &amp; more</p>'), { mimeType: 'text/html' });
  assert.equal(html.kind, 'text');
  assert.deepEqual(html.kind === 'text' && [html.text, html.format, html.extractedFrom], ['Title\n\nBody & more', 'text/plain', 'html']);

  const cp1251 = await readFileContent(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), { mimeType: 'text/plain', charset: 'windows-1251' });
  assert.equal(cp1251.kind === 'text' && cp1251.text, 'Привет');

  const md = await readFileContent(Buffer.from('# Notes​\n\n\n\nline  \n'), { filename: 'notes.md', mimeType: 'application/octet-stream' });
  assert.deepEqual(md, { kind: 'text', text: '# Notes\n\nline', format: 'text/markdown' });

  const json = await readFileContent(Buffer.from('{\r\n "a": 1\r\n}\r\n'), { mimeType: 'application/json' });
  assert.deepEqual(json, { kind: 'text', text: '{\n "a": 1\n}\n', format: 'application/json' });

  const unlabelled = await readFileContent(Buffer.from('plain words'), {});
  assert.deepEqual(unlabelled, { kind: 'text', text: 'plain words', format: 'text/plain' });
});

test('PDFs become Markdown pages; unreadable PDFs explain why', async () => {
  const pdf = await readFileContent(makePdf([['Hello'], ['World']]), { mimeType: 'application/pdf', filename: 'a.pdf' });
  assert.deepEqual(pdf, { kind: 'text', text: '## Page 1\nHello\n\n## Page 2\nWorld', format: 'text/markdown', extractedFrom: 'pdf', note: undefined });

  const capped = await readFileContent(makePdf([['1'], ['2'], ['3']]), { mimeType: 'application/pdf', maxPdfPages: 1 });
  assert.match(capped.kind === 'text' ? (capped.note ?? '') : '', /first 1 of 3 pages/);

  const scan = await readFileContent(makePdf([[]]), { mimeType: 'application/pdf' });
  assert.equal(scan.kind, 'none');
  assert.match(scan.kind === 'none' ? scan.note : '', /no text layer/);

  const broken = await readFileContent(Buffer.from('%PDF-1.4 truncated'), { mimeType: 'application/pdf' });
  assert.equal(broken.kind, 'none');
  assert.match(broken.kind === 'none' ? broken.note : '', /could not be read as a PDF/);
});

test('viewable images come back as images, checked against their bytes and size', async () => {
  const png = makePng(5, 5);
  assert.deepEqual(await readFileContent(png, { mimeType: 'image/png' }), { kind: 'image', data: png, mimeType: 'image/png' });
  const relabelled = await readFileContent(png, { mimeType: 'image/jpeg', filename: 'photo.jpg' });
  assert.equal(relabelled.kind === 'image' && relabelled.mimeType, 'image/png', 'the declared type never contradicts the bytes');

  const fake = await readFileContent(Buffer.from('not really an image'), { mimeType: 'image/png' });
  assert.match(fake.kind === 'none' ? fake.note : '', /labelled image\/png but its content is not/);
  const heic = await readFileContent(Buffer.from('....ftypheic'), { mimeType: 'image/heic' });
  assert.match(heic.kind === 'none' ? heic.note : '', /\(image\/heic\) cannot be shown; only PNG, JPEG, GIF and WebP/);

  const huge = Buffer.concat([png, Buffer.alloc(Math.ceil(MAX_IMAGE_BYTES), 0)]);
  const tooBig = await readFileContent(huge, { mimeType: 'image/png' });
  assert.match(tooBig.kind === 'none' ? tooBig.note : '', /The image is 96 KB; images are shown inline up to 96 KB, the most a claude\.ai tool result can carry/);
  const fits = await readFileContent(Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES - png.length)]), { mimeType: 'image/png' });
  assert.equal(fits.kind, 'image', 'exactly 96 KB is still shown');
  assert.ok(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 < 140_000, 'the base64 of the largest inline image fits a claude.ai tool result');
});

test('other binary formats are named, not dumped', async () => {
  const zip = await readFileContent(ZIP_MAGIC, { mimeType: 'application/zip', filename: 'photos.zip' });
  assert.deepEqual(zip.kind === 'none' && [zip.type, /cannot be read; PDF, Word, Excel, PowerPoint/.test(zip.note)], ['application/zip', true]);
  const binary = await readFileContent(Buffer.from([0x00, 0xff, 0x10, 0x80]), {});
  assert.equal(binary.kind, 'none');
});

test('legacy Office labels on files that are not Office files, and Office files under other labels', () => {
  const csv = Buffer.from('a;b\n1;2\n');
  assert.equal(effectiveType(csv, 'application/vnd.ms-excel', 'export.csv'), 'text/csv', "Outlook's label for .csv");
  assert.equal(effectiveType(csv, 'application/vnd.ms-excel', 'export'), 'text/plain', 'text without a telling name');
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.equal(effectiveType(ole, 'application/vnd.ms-excel', 'old.xls'), 'application/vnd.ms-excel', 'a real .xls stays one');
  assert.equal(effectiveType(ZIP_MAGIC, 'application/vnd.ms-excel', 'new.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(effectiveType(ZIP_MAGIC, 'application/octet-stream', 'Talk.ppsx'), 'application/vnd.openxmlformats-officedocument.presentationml.slideshow');
  assert.equal(effectiveType(ZIP_MAGIC, DOCX, 'renamed.bin'), DOCX, 'an Office label on a ZIP is kept');
});

test('undeclared legacy charsets are guessed: Cyrillic as Windows-1251, anything else as Windows-1252', () => {
  assert.equal(guessLegacyCharset(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0])), 'windows-1251'); // "Привет мир"
  assert.equal(guessLegacyCharset(Buffer.from('Libellé débit crédit', 'latin1')), 'windows-1252');
  assert.equal(textCharset(Buffer.from('déjà vu', 'utf8'), undefined), undefined, 'valid UTF-8 needs no guess');
  assert.equal(textCharset(Buffer.from('déjà vu', 'latin1'), undefined), 'windows-1252');
  assert.equal(textCharset(Buffer.from('x'), ' ISO-8859-2 '), 'ISO-8859-2', 'a declared charset wins');
});

test('text read with a guessed charset says so', async () => {
  const out = await readFileContent(Buffer.from('Libellé;Débit\n', 'latin1'), { mimeType: 'text/csv' });
  assert.deepEqual(out, {
    kind: 'text',
    text: 'Libellé;Débit',
    format: 'text/csv',
    charset: 'windows-1252',
    note: 'No character set was declared and the text is not UTF-8; it was read as windows-1252.',
  });
  const declared = await readFileContent(Buffer.from('Libellé', 'latin1'), { mimeType: 'text/plain', charset: 'ISO-8859-1' });
  assert.deepEqual(declared, { kind: 'text', text: 'Libellé', format: 'text/plain', charset: 'ISO-8859-1' });
});
