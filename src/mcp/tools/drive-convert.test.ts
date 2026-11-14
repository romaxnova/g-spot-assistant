import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../log.js';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall, type TestContext } from '../../test-support.js';
import type { ToolDefinition } from '../registry.js';
import { runTool } from '../server.js';
import { createdFileLookup, driveTools } from './drive.js';
import { driveDocPdf, pdfName } from './drive-pdf.js';
import { gmailTools } from './gmail.js';
import { GOOGLE_MIME } from './drive-files.js';

const PDF_ID = 'pdf1AbCdEfGhIjKlMnOpQrSt';
const DOC_ID = 'doc1AbCdEfGhIjKlMnOpQrSt';
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const byName = (name: string): ToolDefinition => [...driveTools, ...gmailTools].find((t) => t.name === name)!;
const call = (def: ToolDefinition, ctx: TestContext, args: Record<string, unknown>) => runTool(def, { account: 'me', ...args }, ctx);
const path = (c: RecordedCall) => `${c.method} ${c.url.pathname}`;

createdFileLookup.delaysMs = [0, 0];

const scan = { id: PDF_ID, name: 'PV AG.pdf', mimeType: 'application/pdf', size: '17500000', parents: ['f1'] };

test('a conversion that times out is found by the tag it was created with, and returned once: no duplicate, no error', async () => {
  let lists = 0;
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${PDF_ID}`) return { json: scan };
      if (c.method === 'POST' && c.url.pathname === `/drive/v3/files/${PDF_ID}/copy`) throw timeout();
      if (c.method === 'GET' && c.url.pathname === '/drive/v3/files') return { json: { files: ++lists < 2 ? [] : [{ id: 'newdoc', name: 'PV AG', mimeType: GOOGLE_MIME.document }] } };
      return undefined;
    },
  });
  const out = resultJson<{ id: string; note?: string }>(await call(byName('drive_create_file'), ctx, { source: { drive_file_id: PDF_ID }, kind: 'document', parent_folder_id: 'f1' }));
  assert.equal(out.id, 'newdoc');
  assert.match(out.note ?? '', /not duplicated/);
  const copies = apiCalls(ctx).filter((c) => c.url.pathname.endsWith('/copy'));
  assert.equal(copies.length, 1, 'a conversion is never sent twice');
  const tag = copies[0]!.createTag!;
  assert.match(tag, /^[A-Za-z0-9_-]{16}$/);
  const q = apiCalls(ctx).find((c) => c.url.pathname === '/drive/v3/files')!.url.searchParams.get('q');
  assert.equal(q, `appProperties has { key='connectorCreate' and value='${tag}' } and trashed = false`, 'only the file this create made, never a namesake');
  assert.equal(lists, 2, 'looked again while Google finished');
});

test('a conversion that times out and is not found says not to create it again', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${PDF_ID}`) return { json: scan };
      if (c.method === 'POST' && c.url.pathname.endsWith('/copy')) throw timeout();
      if (c.method === 'GET' && c.url.pathname === '/drive/v3/files') return { json: { files: [] } };
      return undefined;
    },
  });
  const result = await call(byName('drive_create_file'), ctx, { source: { drive_file_id: PDF_ID }, kind: 'document', name: "L'acte" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /"L'acte" in time.*Do not create it again: look for it with drive_search/);
});

/** A fake Drive for OCR: the scan, a copy that becomes `tmp`, its export, its deletion, and the tagged Docs listed. */
function ocrDrive(opts: { tagged?: unknown[]; copy?: 'ok' | 'timeout'; del?: 'ok' | 'forbidden' } = {}) {
  return createTestContext({
    google: (c) => {
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${PDF_ID}`) return { json: scan };
      if (c.method === 'GET' && c.url.pathname === '/drive/v3/files') return { json: { files: c.url.searchParams.get('q')!.includes('connectorOcr') ? (opts.tagged ?? []) : [] } };
      if (c.method === 'POST' && c.url.pathname === `/drive/v3/files/${PDF_ID}/copy`) {
        if (opts.copy === 'timeout') throw timeout();
        return { json: { id: 'tmp', name: (c.json as { name: string }).name, mimeType: GOOGLE_MIME.document } };
      }
      if (c.method === 'GET' && /\/drive\/v3\/files\/(tmp|earlier)\/export$/.test(c.url.pathname)) return { text: '# Procès-verbal\n\nRésolution 1 : adoptée' };
      if (c.method === 'DELETE') return opts.del === 'forbidden' ? { status: 403, json: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } } } : new Response(null, { status: 204 });
      return undefined;
    },
  });
}

test('drive_get_file ocr: the scan is converted into a temporary Doc tagged with its source, read as Markdown, and the Doc deleted', async () => {
  const ctx = ocrDrive();
  const out = resultJson<{ content: string; extracted_from: string }>(await call(byName('drive_get_file'), ctx, { file_id: PDF_ID, ocr: true }));
  assert.equal(out.extracted_from, 'ocr');
  assert.match(out.content, /Résolution 1 : adoptée/);
  const copy = apiCalls(ctx).find((c) => c.url.pathname.endsWith('/copy'))!;
  const body = copy.json as { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
  assert.deepEqual([body.name, body.mimeType, body.parents], ['_ocr PV AG', GOOGLE_MIME.document, ['root']]);
  assert.match(body.appProperties['connectorOcr']!, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(apiCalls(ctx).map(path).slice(-2), ['GET /drive/v3/files/tmp/export', 'DELETE /drive/v3/files/tmp']);

  const doc = createTestContext({ google: (c) => (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${DOC_ID}` ? { json: { id: DOC_ID, name: 'Doc', mimeType: GOOGLE_MIME.document } } : undefined) });
  assert.match(resultText(await call(byName('drive_get_file'), doc, { file_id: DOC_ID, ocr: true })), /ocr only applies to PDFs and images/);
});

test('drive_get_file ocr: when Google is too slow, the next call reads the Doc it finished instead of converting again', async () => {
  const slow = ocrDrive({ copy: 'timeout' });
  const late = await call(byName('drive_get_file'), slow, { file_id: PDF_ID, ocr: true });
  assert.match(resultText(late), /OCR did not finish in time.*Call again with ocr: true in a minute or two/);
  const again = ocrDrive({ tagged: [{ id: 'earlier', name: '_ocr PV AG', mimeType: GOOGLE_MIME.document }] });
  const out = resultJson<{ content: string }>(await call(byName('drive_get_file'), again, { file_id: PDF_ID, ocr: true }));
  assert.match(out.content, /Résolution 1/);
  assert.ok(!apiCalls(again).some((c) => c.url.pathname.endsWith('/copy')), 'not converted twice');
  assert.ok(apiCalls(again).some((c) => c.method === 'DELETE' && c.url.pathname === '/drive/v3/files/earlier'));
});

test('drive_get_file ocr: a temporary Doc that cannot be deleted is named so it can be trashed', async () => {
  const out = resultJson<{ content: string; content_note?: string }>(await call(byName('drive_get_file'), ocrDrive({ del: 'forbidden' }), { file_id: PDF_ID, ocr: true }));
  assert.match(out.content, /Procès-verbal/);
  assert.match(out.content_note ?? '', /could not be deleted; trash it with drive_trash \(tmp\)/);
});

test('gmail_get_attachment ocr: the attachment goes up as a temporary Doc in the same account, is read, and deleted', async () => {
  const pdf = Buffer.from('%PDF-1.4 scanned');
  const ctx = createTestContext({
    google: (c) => {
      if (c.url.pathname === '/gmail/v1/users/me/messages/m1') {
        return {
          json: {
            id: 'm1',
            threadId: 't1',
            payload: { mimeType: 'multipart/mixed', parts: [{ partId: '0', mimeType: 'text/plain', body: { data: 'aGk' } }, { partId: '1', mimeType: 'application/x-pdf', filename: 'procuration.pdf', body: { attachmentId: 'att1', size: pdf.length } }] },
          },
        };
      }
      if (c.url.pathname === '/gmail/v1/users/me/messages/m1/attachments/att1') return { json: { size: pdf.length, data: pdf.toString('base64url') } };
      if (c.method === 'GET' && c.url.pathname === '/drive/v3/files') return { json: { files: [] } };
      if (c.method === 'POST' && c.url.pathname === '/upload/drive/v3/files') return { json: { id: 'tmp', name: '_ocr', mimeType: GOOGLE_MIME.document } };
      if (c.url.pathname === '/drive/v3/files/tmp/export') return { text: 'Punomoćje' };
      if (c.method === 'DELETE' && c.url.pathname === '/drive/v3/files/tmp') return new Response(null, { status: 204 });
      return undefined;
    },
  });
  const out = resultJson<{ text: string; extracted_from: string; filename: string }>(await call(byName('gmail_get_attachment'), ctx, { message_id: 'm1', part_id: '1', ocr: true }));
  assert.deepEqual([out.text, out.extracted_from, out.filename], ['Punomoćje', 'ocr', 'procuration.pdf']);
  const up = apiCalls(ctx).find((c) => c.url.pathname === '/upload/drive/v3/files')!;
  assert.match(up.body ?? '', /"mimeType":"application\/vnd\.google-apps\.document"/);
  assert.match(up.body ?? '', /Content-Type: application\/pdf\r?\n/i, 'application/x-pdf goes to Google as application/pdf');
  assert.ok(apiCalls(ctx).some((c) => c.method === 'DELETE' && c.url.pathname === '/drive/v3/files/tmp'));
});

test('drive_doc_pdf: updates the Doc from Markdown and replaces the PDF of the same name next to it, keeping its id', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${DOC_ID}`) return { json: { id: DOC_ID, name: 'Lettre Mairie', mimeType: GOOGLE_MIME.document, parents: ['f1'] } };
      if (c.method === 'PATCH' && c.url.pathname === `/upload/drive/v3/files/${DOC_ID}`) return { json: { id: DOC_ID, name: 'Lettre Mairie', mimeType: GOOGLE_MIME.document, parents: ['f1'], webViewLink: 'https://docs.google.com/d' } };
      if (c.url.pathname === `/drive/v3/files/${DOC_ID}/export`) return { body: Buffer.from('%PDF-1.7 letter') };
      if (c.method === 'GET' && c.url.pathname === '/drive/v3/files') return { json: { files: [{ id: 'oldpdf', name: 'Lettre Mairie.pdf', mimeType: 'application/pdf' }] } };
      if (c.method === 'PATCH' && c.url.pathname === '/upload/drive/v3/files/oldpdf') return { json: { id: 'oldpdf', name: 'Lettre Mairie.pdf', mimeType: 'application/pdf', size: '15' } };
      return undefined;
    },
  });
  const out = resultJson<{ doc: { id: string; change: string }; pdf: { id: string; replaced: boolean; size: number } }>(
    await call(driveDocPdf, ctx, { doc_id: `https://docs.google.com/document/d/${DOC_ID}/edit`, content: '# Lettre\n\nMadame le Maire,' }),
  );
  assert.deepEqual([out.doc.id, out.doc.change, out.pdf.id, out.pdf.replaced, out.pdf.size], [DOC_ID, 'updated', 'oldpdf', true, 15]);
  const patch = apiCalls(ctx).find((c) => c.method === 'PATCH' && c.url.pathname === `/upload/drive/v3/files/${DOC_ID}`)!;
  assert.match(patch.body ?? '', /Content-Type: text\/markdown/i);
  assert.equal(apiCalls(ctx).find((c) => c.url.pathname.endsWith('/export'))!.url.searchParams.get('mimeType'), 'application/pdf');
  assert.equal(apiCalls(ctx).find((c) => c.url.pathname === '/drive/v3/files')!.url.searchParams.get('q'), "name = 'Lettre Mairie.pdf' and 'f1' in parents and mimeType = 'application/pdf' and trashed = false");
  assert.ok(!apiCalls(ctx).some((c) => c.method === 'POST'), 'nothing new created');
});

test('drive_doc_pdf: creates the Doc and its PDF when there is none; refuses what it cannot export', async () => {
  const ctx = createTestContext({
    google: (c) => {
      if (c.method === 'POST' && c.url.pathname === '/upload/drive/v3/files') {
        return c.body?.includes('vnd.google-apps.document')
          ? { json: { id: DOC_ID, name: 'Attestation', mimeType: GOOGLE_MIME.document, parents: ['f9'] } }
          : { json: { id: 'newpdf', name: 'Attestation.pdf', mimeType: 'application/pdf', parents: ['f9'] } };
      }
      if (c.url.pathname === `/drive/v3/files/${DOC_ID}/export`) return { body: Buffer.from('%PDF-1.7') };
      if (c.method === 'GET' && c.url.pathname === '/drive/v3/files') return { json: { files: [] } };
      if (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${PDF_ID}`) return { json: scan };
      return undefined;
    },
  });
  const out = resultJson<{ doc: { change: string }; pdf: { id: string; replaced?: boolean } }>(await call(driveDocPdf, ctx, { name: 'Attestation', content: '<p>Je soussigné</p>', content_mime_type: 'text/html', folder_id: 'f9' }));
  assert.deepEqual([out.doc.change, out.pdf.id, out.pdf.replaced], ['created', 'newpdf', undefined]);
  const posts = apiCalls(ctx).filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(posts[1]!.body ?? '', /"name":"Attestation\.pdf","parents":\["f9"\]/);
  assert.match(resultText(await call(driveDocPdf, ctx, {})), /Give doc_id/);
  assert.match(resultText(await call(driveDocPdf, ctx, { doc_id: PDF_ID })), /must be a Google Doc, Sheet or Slides deck/);
  assert.equal(pdfName('Lettre.pdf'), 'Lettre.pdf');
  assert.equal(pdfName('Lettre (modifiable)'), 'Lettre (modifiable).pdf');
});

test('an account named by its address works like its alias, and the address is never logged', async () => {
  const lines: string[] = [];
  const ctx = createTestContext({
    accounts: [{ alias: 'me', email: 'Sam.P@gmail.com' }],
    google: (c) => (c.method === 'GET' && c.url.pathname === `/drive/v3/files/${DOC_ID}` ? { json: { id: DOC_ID, name: 'Doc', mimeType: GOOGLE_MIME.document } } : undefined),
  });
  ctx.log = createLogger('debug', {}, (l) => lines.push(l));
  const ok = await runTool(byName('drive_get_file'), { account: 'samp@gmail.com', file_id: DOC_ID, include_content: false }, ctx);
  assert.equal(ok.isError, undefined, resultText(ok));
  const unknown = await runTool(byName('drive_get_file'), { account: 'someone@else.com', file_id: DOC_ID }, ctx);
  assert.match(resultText(unknown), /Unknown account alias "someone@else\.com"\. Linked aliases: me/);
  assert.ok(lines.some((l) => l.includes('"alias":"me"')));
  for (const l of lines) assert.doesNotMatch(l, /@/);
});
