/**
 * Tools that bring files from the Claude chat into the connector: a PDF the
 * user uploaded, a chart Claude drew. claude.ai gives connectors no access to
 * chat files, so they are staged first (see src/uploads.ts) and then used by
 * upload_id in attachments and Drive sources.
 *
 * Routes:
 * - create_upload_link: a one-time URL. The user opens it on their phone or
 *   computer and picks the files (full size, several at once), or code in
 *   Claude's sandbox POSTs a file to it when the sandbox may reach this server.
 *   list_uploads then finds what came through the link.
 * - upload_file: the bytes as base64 inside tool calls, in chunks, each
 *   checked by offset and SHA-256. Works without network access from the
 *   sandbox, but every byte passes through Claude's output, so it only suits
 *   small files.
 */
import * as z from 'zod';
import { mimeFromFilename, sniffMime } from '../file-types.js';
import { defineTool, errorResult, jsonResult, type ToolDefinition } from '../registry.js';
import { sha256Hex, UploadError } from '../../uploads.js';
import { decodeBase64Strict, normalizeMime } from './file-sources.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

function attachHint(id: string): string {
  return `Attach it with {"upload_id": "${id}"} in gmail_send, gmail_reply or gmail_create_draft attachments or gmail_update_draft add_attachments (as many times as needed, e.g. in several drafts), or save it with drive_create_file source {"upload_id": "${id}"}.`;
}

const createUploadLink = defineTool({
  name: 'create_upload_link',
  title: 'Get an upload link for files',
  description:
    'Returns a one-time link (30 minutes) for getting files to this connector at full size; each file then gets an upload_id to use as an attachment ({"upload_id": ...}) or Drive source, as many times as needed (e.g. the same files in several drafts) for 24 hours. Two ways to use it:\n' +
    '1. The user opens it (best when the files are on their phone or computer, e.g. photos, and whenever your sandbox cannot reach this server): give them upload_url as a link and ask them to open it and upload the files; they can upload several times until the link expires (on a phone, photos and documents come from different pickers). When they say it is done, attach every file that came through with {"upload_id": link_id}, or call list_uploads with link_id to see or pick them.\n' +
    '2. Your code sandbox POSTs a file it has (e.g. one the user uploaded, /mnt/user-data/uploads/...) with the returned curl command; the reply carries the upload_id. If that fails with a proxy, DNS or 403 error, the sandbox may not reach this server (claude.ai code execution network settings): do not retry and do not shrink files, use way 1 instead.\n' +
    'Limits: 25 MB per file, 60 MB per upload, and the space_left the reply gives (free space with delete_uploads). Gmail takes 25 MB of attachments per email; share larger files as Drive links. Prefer this over upload_file for anything larger than a few tens of kilobytes: nothing passes through your output.',
  inputSchema: {
    filename: z.string().min(1).max(255).optional().describe('Name to give a single file POSTed without one.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async handler(args, ctx) {
    try {
      const link = ctx.uploads.createLink(args.filename);
      const url = `${ctx.config.baseUrl.origin}/upload/${link.token}`;
      return jsonResult({
        upload_url: url,
        link_id: link.linkId,
        expires_at: new Date(link.expiresAt).toISOString(),
        max_bytes_per_file: ctx.uploads.limits.maxFileBytes,
        max_bytes_per_upload: ctx.uploads.limits.maxRequestBytes,
        space_left: ctx.uploads.spaceLeft(),
        uploads_allowed: 'several, until expires_at',
        for_the_user: `Open this link and pick the files (you can select several): ${url}`,
        curl: `curl -sS --fail-with-body -F "file=@/path/to/file.pdf" "${url}"`,
        next: `After the user has uploaded: attach everything that came through with {"upload_id": "${link.linkId}"}, or see the files with list_uploads link_id "${link.linkId}". After a sandbox POST: the upload_id is in its reply.`,
      });
    } catch (err) {
      if (err instanceof UploadError) return errorResult(err.message);
      throw err;
    }
  },
});

const listUploads = defineTool({
  name: 'list_uploads',
  title: 'List files uploaded to the connector',
  description:
    'Lists the files staged on the connector (newest first): upload_id, file name, type, size, when it arrived and when it expires. Give link_id (from create_upload_link) to see only the files that came through that link, e.g. after the user uploaded them from their phone. Use the upload_ids as attachments ({"upload_id": ...}) or Drive sources.',
  inputSchema: {
    link_id: z.string().min(1).max(64).optional().describe('Only the files uploaded through this link (link_id from create_upload_link).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const files = ctx.uploads.list(args.link_id?.trim());
    if (!files.length) {
      return jsonResult({
        count: 0,
        note: args.link_id
          ? 'Nothing has come through this link yet. If the user says they uploaded, ask them whether the page said the files were received; the link works once and for 30 minutes.'
          : 'No files are staged.',
      });
    }
    return jsonResult({
      count: files.length,
      uploads: files.map((f) => ({
        upload_id: f.id,
        filename: f.filename,
        mime_type: f.mimeType,
        size: f.size,
        uploaded_at: new Date(f.createdAt).toISOString(),
        expires_at: new Date(f.expiresAt).toISOString(),
        link_id: f.linkId,
      })),
      next: 'Attach with {"upload_id": ...} in gmail_send / gmail_reply / gmail_create_draft attachments or gmail_update_draft add_attachments, or save with drive_create_file source {"upload_id": ...}.',
    });
  },
});

const uploadFile = defineTool({
  name: 'upload_file',
  title: 'Upload a small chat file as base64',
  description:
    'Stages a file by sending its bytes as base64 inside tool calls. Every byte passes through your output, so it is slow and only suits small files you made yourself (under about 100 KB, 7 pieces or fewer). For a letter or document you write, do not make the PDF yourself: write it as a Google Doc (drive_create_file kind document with Markdown or HTML) and let drive_doc_pdf make and refresh its PDF in Drive. For the user\'s photos, PDFs and anything larger, use create_upload_link: the user opens the link on their phone or computer and uploads the files at full size, even when your sandbox cannot reach this server. Do not shrink the user\'s photos to make them fit here. ' +
    'How: in your sandbox, base64-encode the file and cut the text into pieces of 20,000 characters (a multiple of 4, so each piece is exactly 15,000 bytes and decodes on its own). Send the first piece without upload_id (with filename), then each next piece with upload_id and offset = the size returned by the previous call. ' +
    'Each reply gives chunk_sha256: compare it with the SHA-256 of the same 15,000-byte slice in the sandbox to catch a mistyped piece, and pass sha256 of the whole file (sha256sum) with the last piece to verify it. Staged files last 24 hours after their last change and can be used any number of times with {"upload_id": ...} as an attachment or Drive source.',
  inputSchema: {
    content_base64: z.string().min(1).describe('This chunk of the file, base64-encoded.'),
    upload_id: z.string().min(1).optional().describe('The upload to append to (from the previous call). Omit to start a new file.'),
    offset: z.number().int().min(0).optional().describe('With upload_id: bytes already staged (size from the previous reply); refuses a repeated or skipped chunk.'),
    filename: z.string().min(1).max(255).optional().describe('File name with extension (first call).'),
    mime_type: z.string().min(1).optional().describe('MIME type, when the name and bytes do not tell (first call).'),
    sha256: z.string().optional().describe('Hex SHA-256 of the complete file; give it with the last chunk to verify the whole upload.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async handler(args, ctx) {
    const expected = args.sha256?.trim().toLowerCase();
    if (expected !== undefined && !SHA256_RE.test(expected)) return errorResult('sha256 must be 64 hexadecimal characters (the output of sha256sum).');
    try {
      const chunk = decodeBase64Strict(args.content_base64, args.filename ?? args.upload_id ?? 'the chunk');
      let file;
      if (args.upload_id) {
        if (args.offset === undefined) return errorResult('Give offset (the size returned by the previous call) when appending to an upload.');
        file = ctx.uploads.append(args.upload_id.trim(), args.offset, chunk);
      } else {
        const mimeType = args.mime_type ? normalizeMime(args.mime_type) : (mimeFromFilename(args.filename) ?? sniffMime(chunk));
        file = ctx.uploads.put(chunk, { filename: args.filename, mimeType });
      }
      if (!file.mimeType) {
        const type = mimeFromFilename(file.filename) ?? sniffMime(file.data);
        if (type) {
          file.mimeType = type;
          ctx.uploads.update(file);
        }
      }
      const sha256 = sha256Hex(file.data);
      if (expected !== undefined && expected !== sha256) {
        ctx.uploads.delete(file.id);
        return errorResult(
          `The staged bytes (${file.data.length}) have SHA-256 ${sha256}, not ${expected}: a chunk was mistyped. The upload was discarded; start again, and compare each chunk_sha256 with the sandbox to find the bad chunk.`,
        );
      }
      ctx.log.info('file staged', { via: 'base64', bytes: file.data.length });
      return jsonResult({
        upload_id: file.id,
        size: file.data.length,
        chunk_bytes: chunk.length,
        chunk_sha256: sha256Hex(chunk),
        sha256,
        verified: expected !== undefined ? true : undefined,
        filename: file.filename,
        mime_type: file.mimeType,
        expires_at: new Date(file.expiresAt).toISOString(),
        next: expected !== undefined ? attachHint(file.id) : `Send the next chunk with upload_id and offset ${file.data.length}, or pass sha256 of the whole file to verify; then: ${attachHint(file.id)}`,
      });
    } catch (err) {
      if (err instanceof UploadError) return errorResult(err.message);
      throw err;
    }
  },
});

const deleteUploads = defineTool({
  name: 'delete_uploads',
  title: 'Delete staged files',
  description:
    'Deletes files staged on the connector (by upload_id, from list_uploads or an upload reply) to free space before they expire on their own after 24 hours. Emails and Drive files they were attached to or saved as keep their copies. Delete the files you used by upload_id; all=true deletes every staged file, including ones another chat may still need, so use it only when the user asks to clear everything.',
  inputSchema: {
    upload_ids: z.array(z.string().min(1)).max(500).optional().describe('upload_ids to delete.'),
    all: z.boolean().optional().describe('Delete every staged file (only when the user asks to clear everything).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    if (!args.all && !args.upload_ids?.length) return errorResult('Give upload_ids, or all=true.');
    const ids = args.all ? ctx.uploads.list().map((f) => f.id) : (args.upload_ids ?? []).map((id) => id.trim());
    const deleted = ids.filter((id) => ctx.uploads.delete(id));
    return jsonResult({ deleted: deleted.length, not_found: ids.filter((id) => !deleted.includes(id)), space_left: ctx.uploads.spaceLeft() });
  },
});

export const uploadTools: ToolDefinition[] = [createUploadLink, listUploads, uploadFile, deleteUploads];
