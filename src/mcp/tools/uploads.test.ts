import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { makePdf } from '../../test-fixtures.js';
import { apiCalls, createTestContext, resultJson, resultText, type TestContext } from '../../test-support.js';
import { runTool } from '../server.js';
import { uploadTools } from './uploads.js';

function run(name: string, args: Record<string, unknown>, ctx: TestContext): Promise<CallToolResult> {
  const def = uploadTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return runTool(def, args, ctx);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('create_upload_link returns a one-time URL on this server with ready-to-run commands', async () => {
  const ctx = createTestContext();
  const out = resultJson<Record<string, string>>(await run('create_upload_link', { filename: 'scan.pdf' }, ctx));
  const token = /^https:\/\/connector\.test\/upload\/([A-Za-z0-9_-]{43})$/.exec(out['upload_url']!)?.[1];
  assert.ok(token, out['upload_url']);
  assert.equal(ctx.uploads.hasLink(token), true);
  assert.match(out['curl']!, /curl -sS --fail-with-body -F "file=@\/path\/to\/file\.pdf" "https:\/\/connector\.test\/upload\//);
  assert.equal(apiCalls(ctx).length, 0);
});

test('upload_file stages a small file in chunks, checking offsets and SHA-256', async () => {
  const ctx = createTestContext();
  const pdf = makePdf([['Receipt', 'Total 12,00 EUR']]);
  const half = Math.floor(pdf.length / 2);
  const first = resultJson<Record<string, unknown>>(await run('upload_file', { content_base64: pdf.subarray(0, half).toString('base64'), filename: 'receipt.pdf' }, ctx));
  const id = String(first['upload_id']);
  assert.deepEqual([first['size'], first['chunk_sha256'], first['mime_type']], [half, sha(pdf.subarray(0, half)), 'application/pdf']);

  const skipped = await run('upload_file', { upload_id: id, offset: 0, content_base64: pdf.subarray(half).toString('base64') }, ctx);
  assert.equal(skipped.isError, true);
  assert.match(resultText(skipped), /offset 0 does not match the \d+ bytes already staged/);
  const noOffset = await run('upload_file', { upload_id: id, content_base64: 'AAAA' }, ctx);
  assert.match(resultText(noOffset), /Give offset/);

  const last = resultJson<Record<string, unknown>>(
    await run('upload_file', { upload_id: id, offset: half, content_base64: pdf.subarray(half).toString('base64'), sha256: sha(pdf).toUpperCase() }, ctx),
  );
  assert.deepEqual([last['size'], last['sha256'], last['verified']], [pdf.length, sha(pdf), true]);
  assert.match(String(last['next']), /\{"upload_id": "up_/);
  assert.deepEqual(ctx.uploads.get(id)?.data, pdf);
});

test('a mistyped upload is discarded when its SHA-256 does not match', async () => {
  const ctx = createTestContext();
  const res = await run('upload_file', { content_base64: Buffer.from('hello').toString('base64'), filename: 'a.txt', sha256: sha(Buffer.from('hellO')) }, ctx);
  assert.equal(res.isError, true);
  assert.match(resultText(res), /have SHA-256 [0-9a-f]{64}, not [0-9a-f]{64}: a chunk was mistyped\. The upload was discarded/);
  assert.equal(ctx.uploads.totalBytes(), 0);
  assert.match(resultText(await run('upload_file', { content_base64: 'aGk=', sha256: 'xyz' }, ctx)), /64 hexadecimal/);
  assert.match(resultText(await run('upload_file', { content_base64: 'not base64!' }, ctx)), /not valid base64/);
});

test('delete_uploads frees space by id or all at once; create_upload_link reports the space left', async () => {
  const ctx = createTestContext();
  const a = ctx.uploads.put(Buffer.alloc(1000, 1), { filename: 'a.bin' });
  const b = ctx.uploads.put(Buffer.alloc(2000, 2), { filename: 'b.bin' });
  const link = resultJson<{ space_left: number }>(await run('create_upload_link', {}, ctx));
  assert.equal(link.space_left, ctx.uploads.limits.maxTotalBytes - 3000);
  const one = resultJson<{ deleted: number; not_found: string[] }>(await run('delete_uploads', { upload_ids: [a.id, 'up_missing'] }, ctx));
  assert.deepEqual([one.deleted, one.not_found], [1, ['up_missing']]);
  assert.equal(resultJson<{ deleted: number }>(await run('delete_uploads', { all: true }, ctx)).deleted, 1);
  assert.equal(ctx.uploads.get(b.id), undefined);
  assert.match(resultText(await run('delete_uploads', {}, ctx)), /Give upload_ids, or all=true/);
});
