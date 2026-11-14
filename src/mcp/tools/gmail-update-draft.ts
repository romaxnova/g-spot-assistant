/**
 * gmail_update_draft: edits a draft in place. The draft is fetched as its raw
 * RFC 5322 message, only the requested fields and parts are changed in the
 * parsed MIME tree (gmail-mime-edit.ts) and the result is saved back with
 * drafts.update, so formatting, images pasted into the text, other
 * attachments, the thread and reply headers and the sender alias survive.
 */
import * as z from 'zod';
import { GoogleApiError } from '../../google/client.js';
import { accountParam, defineTool, errorResult, jsonResult, type ToolDefinition } from '../registry.js';
import { cleanText } from '../text.js';
import { attachmentsParam, mb } from './file-sources.js';
import { placeholderWarning } from './placeholders.js';
import { gmailIdentity, gmailWebUrl, withSignature } from './gmail-identity.js';
import {
  attachedSummary,
  draftTarget,
  encodeId,
  guarded,
  MAX_OUTGOING_ATTACHMENT_BYTES,
  optionalAddresses,
  outgoingAttachments,
  recipients,
  savedDraftBlanks,
  SERVICE,
  signatureParam,
  uploadRawMessage,
  type Draft,
} from './gmail.js';
import { addressHeaderValue, attachmentEntityText, bodyEntityText, decodeBase64Url, encodeHeader, htmlToText, parseAddresses } from './gmail-mime.js';
import {
  addParts,
  bodyEntity,
  headerValues,
  listAttachments,
  MimeEditError,
  parseEntity,
  parseMessage,
  removeParts,
  replaceBody,
  serializeMessage,
  setHeader,
  type AttachmentInfo,
  type MimeEntity,
} from './gmail-mime-edit.js';

/** Line breaks as CRLF, the form the parser works in (bytes kept as they are otherwise). */
function withCrlf(raw: Buffer): Buffer {
  return Buffer.from(raw.toString('latin1').replace(/\r\n|\r|\n/g, '\r\n'), 'latin1');
}

/** What the draft carries, for error messages: part ids with names, pasted images marked. */
function describeAttachments(current: AttachmentInfo[]): string {
  if (!current.length) return 'It has no attachments.';
  return `Its attachments: ${current.map((a) => `${a.partId} (${a.filename ?? a.type}${a.inline ? ', inline in the text' : ''})`).join(', ')}.`;
}

/** Finds the entity with this part id. */
function findPart(entity: MimeEntity, partId: string): MimeEntity | undefined {
  if (entity.partId === partId) return entity;
  for (const child of entity.parts ?? []) {
    const hit = findPart(child, partId);
    if (hit) return hit;
  }
  return undefined;
}

/** Attachments (not pasted images) inside `within`, which is about to be replaced. */
function attachmentsWithin(message: MimeEntity, within: MimeEntity | undefined): MimeEntity[] {
  if (!within) return [];
  const prefix = within.partId;
  return listAttachments(message)
    .filter((a) => !(a.inline && a.type.startsWith('image/')))
    .filter((a) => prefix === '' || a.partId === prefix || a.partId.startsWith(`${prefix}.`))
    .map((a) => findPart(message, a.partId))
    .filter((e): e is MimeEntity => e !== undefined && e.body !== undefined);
}

/** A leaf as a stand-alone part: its Content-* fields and its body exactly as they were (a whole-message file drops From, To, ...). */
function asPart(entity: MimeEntity): string {
  const fields = entity.headers.filter((h) => /^content-/i.test(h));
  // A whole message's body runs to the end of the message, final line break included; a part's stops before it.
  const body = entity.partId === '' ? (entity.body ?? '').replace(/\r\n$/, '') : (entity.body ?? '');
  return `${fields.join('\r\n')}\r\n\r\n${body}`;
}

interface RawDraft {
  id: string;
  message?: { id: string; threadId?: string; raw?: string };
}

export const gmailUpdateDraft: ToolDefinition = defineTool({
  name: 'gmail_update_draft',
  title: 'Edit a draft',
  description:
    'Edits an existing draft in place and keeps everything not changed: formatting, images pasted into the text, other attachments, the thread and reply headers, the sender address. Nothing is sent. ' +
    'to/cc/bcc replace the current lists ([] clears cc or bcc); subject replaces the subject; body_text (optionally with body_html) replaces the whole text, including images pasted into it. ' +
    'add_attachments takes the same sources as gmail_send (Drive files, attachments of other emails, {upload_id} for files from this chat, text or base64). remove_attachments takes part ids or file names as gmail_get_message lists them for the draft\'s message. ' +
    'draft_id comes from gmail_search with "in:drafts" or from gmail_create_draft. Returns the draft id, its new message id (part ids change after an edit) and the attachments it now has.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    draft_id: z.string().min(1).describe('Draft id (not the message id), from gmail_search "in:drafts" or gmail_create_draft.'),
    to: optionalAddresses('New To list, replacing the current one'),
    cc: optionalAddresses('New Cc list, replacing the current one ([] removes all)'),
    bcc: optionalAddresses('New Bcc list, replacing the current one ([] removes all)'),
    subject: z.string().optional().describe('New subject.'),
    body_text: z.string().optional().describe('New plain text of the message; replaces the current text and its formatting.'),
    body_html: z.string().optional().describe('New HTML version of the text. With only body_html, the plain text is derived from it.'),
    add_attachments: attachmentsParam,
    remove_attachments: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('Attachments to remove, by part_id or file name (case-insensitive), as gmail_get_message lists them for the draft. A name that several attachments share is refused: give their part ids.'),
    signature: signatureParam.describe("With new text: add the account's Gmail signature below it (default true; nothing is added when the account has none or the new text already contains it)."),
  },
  // Drafts keep no history: replaced text and removed attachments cannot be brought back.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    const changes = (['to', 'cc', 'bcc', 'subject', 'body_text', 'body_html', 'add_attachments', 'remove_attachments'] as const).filter((k) => args[k] !== undefined);
    if (!changes.length) return errorResult('Nothing to change: give to, cc, bcc, subject, body_text/body_html, add_attachments or remove_attachments.');
    if (args.to !== undefined && !args.to.length) return errorResult('to cannot be empty; a draft needs at least one recipient.');
    const to = args.to && recipients(args.to, 'to');
    const cc = args.cc && recipients(args.cc, 'cc');
    const bcc = args.bcc && recipients(args.bcc, 'bcc');

    let draft: RawDraft;
    try {
      draft = await ctx.google.request<RawDraft>(args.account, SERVICE, { url: `/drafts/${encodeId(args.draft_id)}`, query: { format: 'raw' } });
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 400)) {
        return errorResult(`No draft "${args.draft_id}" in this account. It needs the draft id (gmail_search with "in:drafts" lists it as draft_id), not the message id; the draft may also have been sent or deleted.`);
      }
      throw err;
    }
    if (!draft.message?.raw) return errorResult('Gmail returned the draft without its content; try again.');

    try {
      const original = decodeBase64Url(draft.message.raw);
      const message = parseMessage(original);
      // Defence in depth: only a draft the parser reproduces byte for byte is edited, so an
      // unusual structure is refused rather than damaged.
      if (!serializeMessage(message).equals(withCrlf(original))) {
        return errorResult('This draft is built in a way the editor cannot reproduce exactly, so it was left unchanged. gmail_create_draft with draft_id can rewrite it completely instead.');
      }
      if (to) setHeader(message, 'To', addressHeaderValue('To', to));
      if (cc) setHeader(message, 'Cc', cc.length ? addressHeaderValue('Cc', cc) : undefined);
      if (bcc) setHeader(message, 'Bcc', bcc.length ? addressHeaderValue('Bcc', bcc) : undefined);
      if (args.subject !== undefined) setHeader(message, 'Subject', encodeHeader(args.subject));

      // Removals are resolved on the draft as fetched and applied first: replacing the text renumbers the parts.
      const removed: string[] = [];
      if (args.remove_attachments?.length) {
        const current = listAttachments(message);
        const ids = new Set<string>();
        for (const wanted of args.remove_attachments) {
          const key = wanted.trim();
          const byId = current.filter((a) => a.partId === key);
          // Names only match files the user sees as attachments: Gmail names every image pasted into the text
          // "image.png", and gmail_get_message does not list those, so a name must not reach them.
          const byName = current.filter((a) => (!a.inline || !a.type.startsWith('image/')) && (a.filename ?? '').toLowerCase() === key.toLowerCase());
          const matches = byId.length ? byId : byName;
          if (!matches.length) return errorResult(`The draft has no attachment "${key}". ${describeAttachments(current)}`);
          if (matches.length > 1) {
            return errorResult(`"${key}" names ${matches.length} attachments (part ids ${matches.map((m) => m.partId).join(', ')}). Give the part id of each one to remove. Nothing was changed.`);
          }
          ids.add(matches[0]!.partId);
        }
        for (const part of current.filter((a) => ids.has(a.partId))) removed.push(part.filename ?? part.partId);
        removeParts(message, [...ids]);
      }

      let signatureAdded = false;
      if (args.body_text !== undefined || args.body_html !== undefined) {
        // New text replaces the old signature with it, so the signature is added again (unless the text has it).
        // The signature of the address the draft is written from (it may be a send-as alias), none if it has none.
        const from = parseAddresses(headerValues(message, 'From')[0])[0]?.email;
        const signed = withSignature(
          { text: args.body_text ?? cleanText(htmlToText(args.body_html ?? '')), html: args.body_html },
          await gmailIdentity(ctx, args.account),
          args.signature ?? true,
          from,
        );
        signatureAdded = signed.added;
        const text = signed.text;
        // Files nested inside the text's own part (Apple Mail puts attachments inside the alternative; a scanned
        // document can be the whole message) would go with the old text, so they are carried over as attachments.
        const carried = attachmentsWithin(message, bodyEntity(message)).map((e) => parseEntity(asPart(e)));
        replaceBody(message, parseEntity(bodyEntityText(text, signed.html)));
        if (carried.length) addParts(message, carried);
        if (!headerValues(message, 'MIME-Version').length) setHeader(message, 'MIME-Version', '1.0');
      }

      const files = await outgoingAttachments(ctx, args.account, args.add_attachments);
      if (files.length) {
        const kept = listAttachments(message).reduce((sum, a) => sum + a.size, 0);
        const total = kept + files.reduce((sum, f) => sum + f.content.length, 0);
        if (total > MAX_OUTGOING_ATTACHMENT_BYTES) {
          return errorResult(`With the new files the draft's attachments would total ${mb(total)} MB, above Gmail's 25 MB limit. Remove some (remove_attachments) or share large files as Drive links (drive_share).`);
        }
        addParts(message, files.map((f) => parseEntity(attachmentEntityText(f))));
      }

      const raw = serializeMessage(message);
      const updated = await uploadRawMessage<Draft>(ctx, args.account, draftTarget(args.draft_id, draft.message.threadId), raw);
      ctx.log.info('draft updated', { alias: args.account, changes: changes.join(',') });
      const threadId = updated.message?.threadId ?? draft.message.threadId;
      const leftThread = draft.message.threadId !== undefined && threadId !== draft.message.threadId;
      // Read back from Gmail so the check covers the draft as saved, including blanks this edit left alone.
      const blanks = await savedDraftBlanks(ctx, args.account, updated.message?.id);
      return jsonResult({
        draft_id: updated.id,
        message_id: updated.message?.id,
        thread_id: threadId,
        changed: changes,
        signature_added: signatureAdded || undefined,
        removed_attachments: removed.length ? removed : undefined,
        added_attachments: attachedSummary(files),
        // Listed from the saved bytes, so the part ids are the ones the new message has.
        attachments: listAttachments(parseMessage(raw)).map((a) => ({ part_id: a.partId, filename: a.filename, mime_type: a.type, size: a.size, inline: a.inline || undefined })),
        note: leftThread
          ? 'Gmail moved the draft out of its thread (a reply stays in its thread only while the subject matches). Set the subject back to keep it there.'
          : 'Part ids change with every edit; the ones above belong to the new message_id. Files marked inline are shown inside the text (e.g. pasted images).',
        warning: placeholderWarning(blanks),
        web_url: updated.message?.id ? gmailWebUrl(ctx.google.resolve(args.account, SERVICE).email, 'draft', updated.message.id) : undefined,
      });
    } catch (err) {
      if (err instanceof MimeEditError) return errorResult(err.message);
      throw err;
    }
  }),
});
