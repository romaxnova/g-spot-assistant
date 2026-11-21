import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { makePdf } from '../../test-fixtures.js';
import { createTestContext, resultJson, resultText } from '../../test-support.js';
import { runTool } from '../server.js';
import { sendToLink } from './send-to-link.js';
import { UploadStore } from '../../uploads.js';
import { uploadRouter } from '../../web/upload.js';
import { silentLogger } from '../../log.js';

/** Another connector (the WhatsApp connector runs this same upload code) on a local port. */
async function peer() {
  const uploads = new UploadStore();
  const app = express();
  app.use('/upload', uploadRouter(uploads, silentLogger));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return { uploads, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('send_to_link: staged files and written content reach the peer connector intact', async () => {
  const p = await peer();
  try {
    const ctx = createTestContext({ config: { PEER_UPLOAD_HOSTS: p.host } });
    const pdf = makePdf([['Dossier de location']]);
    const staged = ctx.uploads.put(pdf, { filename: 'dossier.pdf', mimeType: 'application/pdf' });
    const link = p.uploads.createLink();
    const out = resultJson<{ sent: number; files: { upload_id: string; file: string }[]; link_id: string }>(
      await runTool(sendToLink, { account: 'me', upload_url: `${p.origin}/upload/${link.token}`, files: [{ upload_id: staged.id }, { content: 'a,b\n1,2\n', filename: 'table.csv' }] }, ctx),
    );
    assert.equal(out.sent, 2);
    assert.equal(out.link_id, link.linkId);
    const got = p.uploads.get(out.files[0]!.upload_id)!;
    assert.equal(got.filename, 'dossier.pdf');
    assert.equal(got.mimeType, 'application/pdf');
    assert.deepEqual(got.data, pdf);
    assert.equal(p.uploads.get(out.files[1]!.upload_id)!.data.toString(), 'a,b\n1,2\n');
  } finally {
    p.close();
  }
});

test('send_to_link: refuses hosts that are not the owner\'s connectors, and anything when none is set', async () => {
  const ctx = createTestContext({ config: { PEER_UPLOAD_HOSTS: 'wa.example' } });
  const staged = ctx.uploads.put(Buffer.from('x'), { filename: 'x.txt' });
  const evil = await runTool(sendToLink, { account: 'me', upload_url: 'https://evil.example/upload/AAAAAAAAAAAAAAAAAAAAAAAA', files: [{ upload_id: staged.id }] }, ctx);
  assert.equal(evil.isError, true);
  assert.match(resultText(evil), /not one of the owner's connectors/);
  const none = createTestContext();
  const refused = await runTool(sendToLink, { account: 'me', upload_url: 'https://wa.example/upload/AAAAAAAAAAAAAAAAAAAAAAAA', files: [{ content: 'x', filename: 'x.txt' }] }, none);
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), /PEER_UPLOAD_HOSTS/);
});
