/**
 * drive_doc_pdf: the PDF of a document Claude writes, made inside Google. A
 * letter is kept as a Google Doc (written in Markdown or HTML, which Drive
 * converts); each revision updates the Doc and refreshes its PDF in Drive from
 * Google's own export, in one call, with no bytes passing through Claude's
 * output. Before this, every revision of a 30 KB letter took ten base64 chunks
 * and ten minutes.
 *
 * The PDF replaced is the one given, else the one of the same name in the
 * folder, so a revision keeps its id and links (Drive keeps the old versions);
 * otherwise it is created next to the Doc. Logs carry no names or content.
 */
import * as z from 'zod';
import { accountParam, defineTool, errorResult, jsonResult, type ToolContext } from '../registry.js';
import { CONVERSION_TIMEOUT_MS, listFiles, nativeKind, sizeBytes, upload, withInputErrors, within, type DriveFile } from './drive.js';
import { assertImportable, DriveInputError, escapeQ, extractFileId, friendlyType, GOOGLE_MIME } from './drive-files.js';
import { mb, normalizeMime } from './file-sources.js';

const SERVICE = 'drive' as const;
const PDF = 'application/pdf';
/** Google exports at most 10 MB. */
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const FIELDS = 'id,name,mimeType,parents,webViewLink,size,modifiedTime,trashed';
/** Every step together stays inside claude.ai's 240 s per tool call. */
const BUDGET_MS = 220_000;

function filePath(id: string, suffix = ''): string {
  return `/files/${encodeURIComponent(id)}${suffix}`;
}

/** "Lettre.pdf" for "Lettre", "Lettre (modifiable)" → "Lettre (modifiable).pdf". */
export function pdfName(docName: string): string {
  return /\.pdf$/i.test(docName) ? docName : `${docName}.pdf`;
}

async function fileMeta(ctx: ToolContext, account: string, id: string): Promise<DriveFile> {
  return ctx.google.request<DriveFile>(account, SERVICE, { url: filePath(id), query: { fields: FIELDS, supportsAllDrives: true } });
}

/** The PDF of that name in the folder, if one is there (the most recently changed when several). */
async function pdfInFolder(ctx: ToolContext, account: string, folder: string, name: string): Promise<DriveFile | undefined> {
  const q = `name = '${escapeQ(name)}' and '${escapeQ(folder)}' in parents and mimeType = '${PDF}' and trashed = false`;
  return (await listFiles(ctx, account, { q, orderBy: 'modifiedTime desc', pageSize: 1 })).files?.[0];
}

export const driveDocPdf = defineTool({
  name: 'drive_doc_pdf',
  title: 'Update a Google Doc and refresh its PDF',
  description:
    'For letters and documents you write: keep them as a Google Doc and let Google make the PDF, instead of making a PDF yourself and sending it with upload_file. ' +
    'Optionally updates the Doc first: `content` (Markdown or HTML, which Google converts, replacing the whole text) into doc_id, or, without doc_id, a new Doc named `name` in folder_id. ' +
    "Then exports the Doc (or a Sheet/Slides deck) as PDF into Drive: replacing pdf_file_id, else the PDF of the same name in the folder (so it keeps its id and links; Drive keeps old versions), else a new PDF next to the Doc. Nothing passes through your output. " +
    'To attach it to a draft: gmail_update_draft with add_attachments [{drive_file_id: <pdf id>}] (and remove_attachments [the old file name]); gmail_send/gmail_create_draft also take {drive_file_id: <doc id>}, sent as PDF. ' +
    'Returns {doc, pdf: {id, name, size, web_view_link, replaced}}.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    doc_id: z.string().min(1).optional().describe('The Google Doc (or Sheet/Slides deck): id or URL. Omit to create a Doc from `content` and `name`.'),
    content: z.string().optional().describe('New text of the Doc, replacing all of it: Markdown (default) or HTML, see content_mime_type.'),
    content_mime_type: z.enum(['text/markdown', 'text/html', 'text/plain']).optional().describe('Format of `content` (default text/markdown).'),
    name: z.string().min(1).max(200).optional().describe('Name of a new Doc (without doc_id), or a new name for the Doc.'),
    folder_id: z.string().optional().describe("Folder of a new Doc and of a new PDF: id, URL or 'root' (default: the Doc's folder; for a new Doc, My Drive)."),
    pdf_file_id: z.string().min(1).optional().describe('The PDF to replace (id or URL). Default: the PDF named pdf_name in the folder, if any.'),
    pdf_name: z.string().min(1).max(200).optional().describe('Name of the PDF (default: the Doc\'s name + ".pdf").'),
  },
  // Without doc_id each call creates a Doc.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  async handler(args, ctx) {
    return withInputErrors(async () => {
      const deadline = Date.now() + BUDGET_MS;
      const account = args.account;
      const folder = args.folder_id ? extractFileId(args.folder_id) : undefined;
      const media =
        args.content === undefined ? undefined : { data: Buffer.from(args.content, 'utf8'), mimeType: normalizeMime(args.content_mime_type ?? 'text/markdown') };
      let doc: DriveFile;
      let docChange: 'created' | 'updated' | undefined;
      if (!args.doc_id) {
        if (!media || !args.name) return errorResult('Give doc_id (the Google Doc to export), or content and name to create the Doc first.');
        doc = await upload(ctx, account, { method: 'POST', metadata: { name: args.name, parents: folder ? [folder] : undefined, mimeType: GOOGLE_MIME.document }, media, deadline });
        docChange = 'created';
      } else {
        const id = extractFileId(args.doc_id);
        doc = await fileMeta(ctx, account, id);
        const type = doc.mimeType ?? '';
        if (!nativeKind(type)) {
          return errorResult(`doc_id must be a Google Doc, Sheet or Slides deck; "${doc.name}" is ${friendlyType(type)} (${type}).`);
        }
        if (media) {
          if (type !== GOOGLE_MIME.document) throw new DriveInputError(`content can only replace the text of a Google Doc; "${doc.name}" is a Google ${friendlyType(type)}.`);
          assertImportable('document', media.mimeType);
          doc = await upload(ctx, account, { method: 'PATCH', fileId: id, metadata: { name: args.name }, media, converting: true, deadline });
          docChange = 'updated';
        } else if (args.name) {
          doc = await ctx.google.request<DriveFile>(account, SERVICE, { method: 'PATCH', url: filePath(id), query: { fields: FIELDS, supportsAllDrives: true }, body: { name: args.name } });
        }
      }
      const docId = doc.id ?? '';
      const data = await ctx.google.request<Buffer>(account, SERVICE, { url: filePath(docId, '/export'), query: { mimeType: PDF }, responseType: 'buffer', timeoutMs: within(deadline, CONVERSION_TIMEOUT_MS) });
      if (data.length > MAX_EXPORT_BYTES) return errorResult(`The PDF is ${mb(data.length)} MB, above what Google exports (10 MB).`);

      const name = args.pdf_name ? pdfName(args.pdf_name) : pdfName(doc.name ?? 'Document');
      const target = folder ?? doc.parents?.[0] ?? 'root';
      let existing: DriveFile | undefined;
      if (args.pdf_file_id) {
        existing = await fileMeta(ctx, account, extractFileId(args.pdf_file_id));
        if (existing.mimeType !== PDF) return errorResult(`pdf_file_id must be a PDF; "${existing.name}" is ${friendlyType(existing.mimeType)}.`);
      } else {
        existing = await pdfInFolder(ctx, account, target, name);
      }
      const media2 = { data, mimeType: PDF };
      const pdf = existing?.id
        ? await upload(ctx, account, { method: 'PATCH', fileId: existing.id, metadata: { name: args.pdf_name ? name : undefined, trashed: existing.trashed ? false : undefined }, media: media2, converting: false, deadline })
        : await upload(ctx, account, { method: 'POST', metadata: { name, parents: [target] }, media: media2, deadline });
      ctx.log.info('drive doc pdf', { alias: account, doc: docChange ?? 'unchanged', pdf: existing ? 'replaced' : 'created', bytes: data.length });
      return jsonResult({
        doc: { id: docId, name: doc.name, change: docChange, web_view_link: doc.webViewLink },
        pdf: { id: pdf.id, name: pdf.name, size: sizeBytes(pdf) ?? data.length, web_view_link: pdf.webViewLink, replaced: existing ? true : undefined },
        note: 'To attach it: gmail_update_draft add_attachments [{drive_file_id: "' + (pdf.id ?? '') + '"}], with remove_attachments for the previous version.',
      });
    });
  },
});
