/**
 * Memory soak: the real Express app on an on-disk database and a fake Google,
 * driven through its MCP endpoint over HTTP with the mix of calls claude.ai
 * makes (initialize, tools/list, searches, threads, a PDF attachment read, a
 * send with a file staged through an upload link, Drive, the agenda, the
 * follow-ups). It measures the process's memory after forced garbage
 * collections and prints it as one JSON line per checkpoint.
 *
 *   npm run soak                      # 1,000 rounds
 *   npm run soak -- 3000              # 3,000 rounds
 *   SOAK_MIX=heavy npm run soak -- 200  # an 8 MB upload sent and a 40-page PDF read each round
 *
 * It exits 1 when the live heap grows more than SOAK_MAX_GROWTH_MB (default 10)
 * from the warm-up to the end, or resident memory more than SOAK_MAX_RSS_GROWTH_MB
 * (default 40) from the first checkpoint to the end: a leak grows with the number
 * of requests, while the allocator's working set levels off within the first rounds.
 *
 * Runs with --expose-gc (set by the npm script); reaches nothing outside this process.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { writeHeapSnapshot } from 'node:v8';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { compact, openDatabase } from '../db.js';
import { containerMemory } from '../memory.js';
import { AccountStore } from '../accounts.js';
import { AuthStore } from '../auth/store.js';
import { ClientRegistry } from '../auth/clients.js';
import { ConnectorOAuthProvider } from '../auth/provider.js';
import { GoogleAuth } from '../google/oauth.js';
import { GoogleClient } from '../google/client.js';
import { createApp } from '../app.js';
import { silentLogger } from '../log.js';
import { SERVICE_SCOPES } from '../config.js';
import { fakeFetch, testConfig, type RecordedCall } from '../test-support.js';
import { allTools } from '../mcp/tools/index.js';
import { SqliteUploadVault, UploadStore } from '../uploads.js';
import { FollowupStore } from '../followups/store.js';
import { SensitiveContactsStore } from '../contacts/sensitive-store.js';
import { ScheduledSendStore } from '../mail/scheduled-store.js';
import { DigestScheduler, DigestSettingsStore } from '../followups/digest.js';
import type { ToolContext } from '../mcp/registry.js';

/** A one-page PDF with a text layer. */
export function tinyPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A long PDF with compressed text pages, closer to a real contract or statement than tinyPdf. */
export function longPdf(pages: number, linesPerPage = 60): Buffer {
  const objects: (string | Buffer)[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: string[] = [];
  const font = 3;
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let p = 0; p < pages; p++) {
    const lines = Array.from({ length: linesPerPage }, (_, l) => `BT /F1 9 Tf 40 ${780 - l * 12} Td (Page ${p + 1} line ${l + 1}: the parties agree to the terms set out in clause ${l} of annex ${p}.) Tj ET`).join('\n');
    const data = deflateSync(Buffer.from(lines, 'latin1'));
    const contentNo = objects.length + 1;
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    const pageNo = objects.length + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(`${pageNo} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const PDF = tinyPdf('Quote for the roof repair');
const LONG_PDF = longPdf(80);
/** A photo-sized file staged through an upload link and sent as an attachment in the heavy mix. */
const PHOTO = randomBytes(8 * 1024 * 1024);
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function message(id: string, threadId: string, from: string, subject: string, withPdf = false) {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: 'me@example.com' },
    { name: 'Subject', value: subject },
    { name: 'Date', value: 'Tue, 10 Nov 2026 09:00:00 +0100' },
    { name: 'Message-ID', value: `<${id}@mail.example.com>` },
  ];
  const text = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { size: 600, data: b64url('Hello,\n\n' + 'Here is the information you asked for. '.repeat(15)) } };
  const payload = withPdf
    ? { mimeType: 'multipart/mixed', headers, parts: [{ partId: '0', ...text }, { partId: '1', mimeType: 'application/pdf', filename: 'quote.pdf', headers: [], body: { attachmentId: 'att-1', size: PDF.length } }] }
    : { ...text, headers };
  return { id, threadId, labelIds: ['INBOX'], snippet: 'Here is the information you asked for', internalDate: String(Date.now() - 3_600_000), sizeEstimate: 2000, payload };
}

function fakeGoogle(c: RecordedCall): { json?: unknown; status?: number } | undefined {
  const p = c.url.pathname;
  if (p.endsWith('/settings/sendAs')) return { json: { sendAs: [{ sendAsEmail: 'me@example.com', displayName: 'Me', isPrimary: true, signature: '<div>Me</div>' }] } };
  if (p === '/gmail/v1/users/me/labels') return { json: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] } };
  if (p === '/gmail/v1/users/me/messages') return { json: { messages: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` })), resultSizeEstimate: 10 } };
  if (p === '/gmail/v1/users/me/threads') return { json: { threads: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, snippet: 'x' })) } };
  if (p === '/gmail/v1/users/me/drafts') return { json: { drafts: [] } };
  let m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/[^/]+$/.exec(p);
  if (m) return { json: m[1] === 'long1' ? { size: LONG_PDF.length, data: b64url(LONG_PDF) } : { size: PDF.length, data: b64url(PDF) } };
  m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p);
  if (m && c.method === 'GET') return { json: message(m[1]!, `t-${m[1]}`, 'Ann Lee <ann@example.com>', 'Roof repair', m[1] === 'pdf1' || m[1] === 'long1') };
  m = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(p);
  if (m) return { json: { id: m[1], messages: [0, 1, 2].map((i) => message(`${m![1]}-${i}`, m![1]!, i % 2 ? 'me@example.com' : 'Ann Lee <ann@example.com>', 'Re: Roof repair')) } };
  if (p.endsWith('/messages/send')) return { json: { id: 'sent-' + Math.random().toString(36).slice(2), threadId: 't-sent', labelIds: ['SENT'] } };
  if (p === '/drive/v3/files') {
    return { json: { files: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, name: `Contract ${i}.pdf`, mimeType: 'application/pdf', modifiedTime: '2026-11-01T10:00:00Z', size: '20480', parents: ['folder1'], webViewLink: `https://drive.google.com/file/d/f${i}/view` })) } };
  }
  m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (m) return { json: { id: m[1], name: 'Documents', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] } };
  if (p === '/calendar/v3/users/me/calendarList') return { json: { items: [{ id: 'me@example.com', summary: 'Me', primary: true, selected: true, accessRole: 'owner', timeZone: 'Europe/Paris' }] } };
  if (/^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(p)) {
    return { json: { items: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, status: 'confirmed', summary: `Meeting ${i}`, start: { dateTime: '2026-11-18T10:00:00+01:00' }, end: { dateTime: '2026-11-18T11:00:00+01:00' } })) } };
  }
  return undefined;
}

interface Sample {
  round: number;
  /** Resident memory as the process left it, before the forced collections (what a host measures). */
  rssLiveMb: number;
  heapMb: number;
  rssMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /** The process's memory cgroup, as a container host reads it: page cache of files touched, and anonymous memory. */
  cgroupFileMb?: number;
  cgroupAnonMb?: number;
  /** Sizes of the database file and its write-ahead log. */
  dbMb?: number;
  walMb?: number;
}

const fileMb = (path: string) => (existsSync(path) ? mb(statSync(path).size) : 0);

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

async function settledMemory(round: number, dbPath?: string): Promise<Sample> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('Run with node --expose-gc');
  const rssLiveMb = mb(process.memoryUsage.rss());
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 20));
  }
  const m = process.memoryUsage();
  const cg = containerMemory();
  return {
    round,
    rssLiveMb,
    heapMb: mb(m.heapUsed),
    rssMb: mb(m.rss),
    externalMb: mb(m.external),
    arrayBuffersMb: mb(m.arrayBuffers),
    ...(cg ? { cgroupFileMb: cg.containerFileMb, cgroupAnonMb: cg.containerAnonMb } : {}),
    ...(dbPath ? { dbMb: fileMb(dbPath), walMb: fileMb(`${dbPath}-wal`) } : {}),
  };
}

export interface SoakResult {
  baseline: Sample;
  last: Sample;
  samples: Sample[];
  failures: number;
}

/** Runs `rounds` rounds of the request mix against a fresh app and returns the memory samples. */
export async function soak(
  rounds: number,
  opts: { every?: number; onSample?: (s: Sample) => void; snapshotDir?: string; mix?: 'all' | 'no-pdf' | 'pdf-only' | 'heavy' } = {},
): Promise<SoakResult> {
  const mix = opts.mix ?? 'all';
  const dir = mkdtempSync(join(tmpdir(), 'gspot-soak-'));
  const config = testConfig({ BASE_URL: 'http://localhost', DB_PATH: join(dir, 'connector.sqlite') });
  // The fake records nothing: a growing record of calls would be the soak's own leak.
  const discard = { push: () => 0 } as unknown as RecordedCall[];
  const fetchImpl = fakeFetch(fakeGoogle, discard);
  const db = openDatabase(config.dbPath);
  const accounts = new AccountStore(db, config.encryptionKey);
  accounts.upsertLinked({ alias: 'me', email: 'me@example.com', googleSub: 'sub-me', label: undefined, refreshToken: '1//soak', grantedScopes: Object.values(SERVICE_SCOPES), requestedServices: ['gmail', 'calendar', 'sheets', 'drive'] });
  const store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: true, fetchImpl }, silentLogger);
  const provider = new ConnectorOAuthProvider(store, clients, { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 }, silentLogger);
  const googleAuth = new GoogleAuth({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: `${config.baseUrl.origin}/auth/google/callback` }, fetchImpl);
  const googleClient = new GoogleClient(accounts, googleAuth, silentLogger, { adminUrl: `${config.baseUrl.origin}/admin`, fetchImpl });
  // Links last seconds instead of 30 minutes, so the soak keeps opening new ones without hitting the cap of open links.
  const uploads = new UploadStore({ linkTtlMs: 4_000, maxLinks: 10_000 }, Date.now, new SqliteUploadVault(db, [config.encryptionKey]));
  const followups = new FollowupStore(db, [config.encryptionKey]);
  const sensitive = new SensitiveContactsStore(db, [config.encryptionKey]);
  const schedules = new ScheduledSendStore(db);
  const toolCtx: ToolContext = { config, accounts, google: googleClient, log: silentLogger, uploads, followups, sensitive, schedules };
  const digest = new DigestScheduler(new DigestSettingsStore(db, config.defaultTimezone), () => toolCtx, silentLogger);
  toolCtx.digest = digest;
  const app = createApp({ config, log: silentLogger, accounts, store, clients, provider, googleAuth, googleClient, tools: allTools, uploads, followups, sensitive, schedules, digest });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { accessToken } = store.issueTokenPair({ clientId: 'soak', subjectEmail: 'owner@example.com', scope: '', resource: config.mcpUrl.href, accessTtlSeconds: 86400, refreshTtlSeconds: 86400 });

  let id = 0;
  let failures = 0;
  // A different client address per request, so the per-IP rate limits measure nothing here.
  const from = () => `10.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}`;
  const rpc = async (method: string, params: unknown, protocol = '2025-06-18') => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, 'x-forwarded-for': from() },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await res.text();
    const body = text.startsWith('{') ? text : (text.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5) ?? '{}');
    const json = JSON.parse(body) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: unknown };
    if (res.status !== 200 || json.error || json.result?.isError) failures++;
    return json;
  };
  const call = (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args });

  async function round(i: number): Promise<void> {
    if (mix === 'heavy') {
      await call('gmail_get_attachment', { account: 'me', message_id: 'long1', attachment_id: 'att-1', part_id: '1' });
      const link = await call('create_upload_link', {});
      const linkText = link.result?.content?.[0]?.text ?? '';
      const url = /"upload_url":\s*"([^"]+)"/.exec(linkText)?.[1];
      const linkId = /"link_id":\s*"([^"]+)"/.exec(linkText)?.[1];
      if (!url || !linkId) {
        failures++;
        return;
      }
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(PHOTO)], { type: 'image/jpeg' }), 'photo.jpg');
      const up = await fetch(url.replace(config.baseUrl.origin, base), { method: 'POST', body: form, headers: { accept: 'application/json', 'x-forwarded-for': from() } });
      if (up.status !== 201) failures++;
      await up.arrayBuffer();
      await call('gmail_send', { account: 'me', to: ['ann@example.com'], subject: 'Photo', body_text: 'Here it is.', attachments: [{ upload_id: linkId }] });
      await call('delete_uploads', { all: true });
      return;
    }
    if (mix === 'pdf-only') {
      await call('gmail_get_attachment', { account: 'me', message_id: 'pdf1', attachment_id: 'att-1', part_id: '1' });
      return;
    }
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'soak', version: '0' } });
    await rpc('tools/list', {});
    await call('gmail_search', { account: 'me', query: 'newer_than:7d', max_results: 10 });
    await call('gmail_get_thread', { account: 'me', thread_id: `t${i % 10}` });
    await call('drive_search', { account: 'me', query: 'contract' });
    await call('agenda', { days: 1 });
    await call('inbox_overview', {});
    if (mix === 'all') await call('gmail_get_attachment', { account: 'me', message_id: 'pdf1', attachment_id: 'att-1', part_id: '1' });
    if (i % 5 === 0) {
      // A file through an upload link, attached to a sent mail, then cleared.
      const link = await call('create_upload_link', {});
      const linkText = link.result?.content?.[0]?.text ?? '';
      const url = /"upload_url":\s*"([^"]+)"/.exec(linkText)?.[1];
      const linkId = /"link_id":\s*"([^"]+)"/.exec(linkText)?.[1];
      if (url && linkId) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(PDF)], { type: 'application/pdf' }), 'quote.pdf');
        const up = await fetch(url.replace(config.baseUrl.origin, base), { method: 'POST', body: form, headers: { accept: 'application/json', 'x-forwarded-for': from() } });
        if (up.status !== 201) failures++;
        await up.arrayBuffer();
        await call('gmail_send', { account: 'me', to: ['ann@example.com'], subject: 'Quote', body_text: 'Here it is.', attachments: [{ upload_id: linkId }] });
        await call('delete_uploads', { all: true });
      } else failures++;
    }
    if (i % 10 === 0) await call('followups', { sections: ['owed', 'waiting', 'drafts'] });
  }

  const every = opts.every ?? 100;
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < 20; i++) await round(i); // warm-up: module caches, JIT
    const baseline = await settledMemory(0, config.dbPath);
    samples.push(baseline);
    opts.onSample?.(baseline);
    if (opts.snapshotDir) writeHeapSnapshot(join(opts.snapshotDir, 'before.heapsnapshot'));
    for (let i = 1; i <= rounds; i++) {
      await round(i);
      // The server's hourly upkeep, every 50 rounds here.
      if (i % 50 === 0) {
        uploads.sweep();
        compact(db);
      }
      if (i % every === 0 || i === rounds) {
        const s = await settledMemory(i, config.dbPath);
        samples.push(s);
        opts.onSample?.(s);
      }
    }
    if (opts.snapshotDir) writeHeapSnapshot(join(opts.snapshotDir, 'after.heapsnapshot'));
    return { baseline, last: samples[samples.length - 1]!, samples, failures };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const rounds = Number(process.argv[2] ?? 1000);
  const snapshotDir = process.env['SOAK_SNAPSHOT_DIR'];
  const mix = (process.env['SOAK_MIX'] ?? 'all') as 'all' | 'no-pdf' | 'pdf-only' | 'heavy';
  const result = await soak(rounds, { onSample: (s) => process.stdout.write(JSON.stringify(s) + '\n'), snapshotDir, mix });
  const heapGrowthMb = Math.round((result.last.heapMb - result.baseline.heapMb) * 10) / 10;
  // Resident memory from the first checkpoint after the baseline: the allocator's working set is in place by then.
  const settled = result.samples[1] ?? result.baseline;
  const rssGrowthMb = Math.round((result.last.rssMb - settled.rssMb) * 10) / 10;
  const maxHeap = Number(process.env['SOAK_MAX_GROWTH_MB'] ?? 10);
  const maxRss = Number(process.env['SOAK_MAX_RSS_GROWTH_MB'] ?? 40);
  const ok = result.failures === 0 && heapGrowthMb <= maxHeap && rssGrowthMb <= maxRss;
  process.stdout.write(JSON.stringify({ rounds, mix, failures: result.failures, heapGrowthMb, rssGrowthMb, maxHeapGrowthMb: maxHeap, maxRssGrowthMb: maxRss, ok }) + '\n');
  if (!ok) process.exit(1);
}
