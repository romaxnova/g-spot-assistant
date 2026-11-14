import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitResult, MAX_RESULT_CHARS } from './registry.js';
import { transferTimeoutMs } from './tools/file-sources.js';

const size = (r: unknown) => JSON.stringify(r).length;

test('results within the limit are returned untouched', () => {
  const r = { content: [{ type: 'text' as const, text: 'hello' }] };
  assert.equal(fitResult(r), r);
});

test('an oversized result loses its largest image first, then has its longest text cut, with notes', () => {
  const image = { type: 'image' as const, data: 'A'.repeat(200_000), mimeType: 'image/png' };
  const small = { type: 'image' as const, data: 'B'.repeat(1_000), mimeType: 'image/png' };
  const withImage = fitResult({ content: [{ type: 'text', text: '{"note":"x"}' }, image, small] });
  assert.ok(size(withImage) <= MAX_RESULT_CHARS);
  assert.equal(withImage.content.length, 3);
  assert.match((withImage.content[1] as { text: string }).text, /An image of 146 KB was left out: a tool result can carry about 150,000 characters/);
  assert.deepEqual(withImage.content[2], small, 'the image that fits stays');

  const quoted = '"\n'.repeat(60_000); // escapes double in JSON: 240,000 serialized characters
  const text = fitResult({ content: [{ type: 'text', text: 'short' }, { type: 'text', text: quoted }], isError: true });
  assert.ok(size(text) <= MAX_RESULT_CHARS, `${size(text)} characters`);
  assert.equal(text.isError, true);
  assert.equal((text.content[0] as { text: string }).text, 'short');
  assert.match((text.content[1] as { text: string }).text, /\[Cut after \d+ of 120000 characters: a tool result can carry about 150,000\. Ask for less/);
});

test('transfer timeouts grow with size but stay well inside the 240 s tool call limit', () => {
  assert.equal(transferTimeoutMs(0), 60_000);
  assert.equal(transferTimeoutMs(3 * 1024 * 1024), 90_000);
  assert.equal(transferTimeoutMs(25 * 1024 * 1024), 150_000);
  assert.equal(transferTimeoutMs(50 * 1024 * 1024), 150_000);
});

test('cuts are measured on the serialized result: as much text as fits is kept, and an emoji is never split', () => {
  const escaped = fitResult({ content: [{ type: 'text', text: '"'.repeat(200_000) }] });
  const kept = Number(/Cut after (\d+) of 200000/.exec((escaped.content[0] as { text: string }).text)?.[1]);
  assert.ok(size(escaped) <= MAX_RESULT_CHARS);
  assert.ok(kept > 69_000, `kept ${kept}: each quote costs two serialized characters, so about 70,000 fit`);

  const emoji = fitResult({ content: [{ type: 'text', text: '😀'.repeat(100_000) }] });
  const text = (emoji.content[0] as { text: string }).text;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'no lone high surrogate');

  const many = fitResult({ content: Array.from({ length: 50 }, (_, i) => ({ type: 'text' as const, text: `${i}`.padEnd(4_000, 'x') })) });
  assert.ok(size(many) <= MAX_RESULT_CHARS, 'many medium blocks are cut until the whole result fits');
});

test('an image that fits is kept when cutting text is enough', () => {
  const image = { type: 'image' as const, data: 'A'.repeat(100_000), mimeType: 'image/png' };
  const out = fitResult({ content: [{ type: 'text', text: 'y'.repeat(60_000) }, image] });
  assert.ok(size(out) <= MAX_RESULT_CHARS);
  assert.deepEqual(out.content[1], image);
  assert.match((out.content[0] as { text: string }).text, /^y+\n\[Cut after \d+ of 60000 characters/);
});
