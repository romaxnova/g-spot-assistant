/**
 * gmail_create_drafts: mail merge. One template (subject, text, optional HTML)
 * becomes one draft per recipient, each {{field}} replaced by that recipient's
 * value. Nothing is sent: the user reviews the drafts, then gmail_send_draft
 * with draft_ids sends them together (and refuses any that still has blanks).
 *
 * Every recipient is checked before the first Google call, so a missing field
 * or a bad address leaves no half-made batch; after that, a failure costs only
 * its own draft, except an account error, which stops the rest. Nothing here
 * logs addresses, names, subjects or field values.
 */
import * as z from 'zod';
import { AccountError, GoogleApiError } from '../../google/client.js';
import { accountParam, defineTool, errorResult, jsonResult, ToolInputError, type ToolContext, type ToolDefinition } from '../registry.js';
import { oneLine } from '../text.js';
import { attachmentsParam, compactAttachmentsParam, mb, transferTimeoutMs, type FileSpec } from './file-sources.js';
import { findPlaceholders, placeholderWarning } from './placeholders.js';
import { fromHeader, gmailIdentity, gmailWebUrl, withSignature } from './gmail-identity.js';
import { buildMimeMessage, htmlToText, parseAddresses, type MimeAttachment } from './gmail-mime.js';
import {
  draftTarget,
  guarded,
  InputError,
  MAX_OUTGOING_ATTACHMENT_BYTES,
  optionalAddresses,
  outgoingAttachments,
  recipients,
  SERVICE,
  signatureParam,
  uploadRawMessage,
  type Draft,
} from './gmail.js';

/** As many as gmail_send_draft sends in one call, so a reviewed batch goes out together. */
const MAX_RECIPIENTS = 25;
/** The connector's limit on files attached to one email (see outgoingAttachments). */
const MAX_FILES = 20;
/**
 * The result must reach Claude within claude.ai's 4 minutes per tool call: a lost result invites a retry, and a
 * retry would create every draft twice. So no draft is started after TIME_BUDGET_MS, and no upload is started
 * that could still be running, at its timeout, after DEADLINE_MS.
 */
const TIME_BUDGET_MS = 120_000;
const DEADLINE_MS = 230_000;
const OUT_OF_TIME = 'Not created: this call ran out of time. Call gmail_create_drafts again with only the recipients that have an error.';
/** Time kept for a draft's upload after its own files arrive. */
const UPLOAD_RESERVE_MS = 30_000;
const OUT_OF_TIME_MARK = Symbol('out of time');

/**
 * The promise's value, or OUT_OF_TIME_MARK when it takes longer than `ms`. The work is not cancelled (a fetch
 * cannot be), only no longer waited for; its eventual failure is swallowed so it cannot crash the process.
 */
export async function beforeDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof OUT_OF_TIME_MARK> {
  work.catch(() => {});
  if (ms <= 0) return OUT_OF_TIME_MARK;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof OUT_OF_TIME_MARK>((resolve) => {
    timer = setTimeout(() => resolve(OUT_OF_TIME_MARK), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
/** Letters of any language ({{prénom}}), digits, _ . - */
const FIELD_CHARS = '[\\p{L}\\p{M}\\p{N}_.-]{1,40}';
const FIELD_NAME = new RegExp(`^${FIELD_CHARS}$`, 'u');
/** {{ name }}, inner spaces allowed. */
const FIELD_REF = new RegExp(`\\{\\{\\s*(${FIELD_CHARS})\\s*\\}\\}`, 'gu');
const ONE_FIELD_REF = new RegExp(`^\\{\\{\\s*${FIELD_CHARS}\\s*\\}\\}$`, 'u');
/** Any {{...}}, as the blank check in placeholders.ts sees it. */
const ANY_BRACES = /\{\{[^{}\n]+\}\}/g;
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The field names the templates use, each once, in order of appearance. */
export function templateFields(...templates: (string | undefined)[]): string[] {
  return [...new Set(templates.flatMap((t) => [...(t ?? '').normalize('NFC').matchAll(FIELD_REF)].map((m) => m[1]!)))];
}

/** The {{...}} that are not field references ({{prénom}}, {{first name}}): no value can fill them, so each draft would keep them. */
export function badFieldRefs(...templates: (string | undefined)[]): string[] {
  return [...new Set(templates.flatMap((t) => [...(t ?? '').matchAll(ANY_BRACES)].map((m) => m[0]).filter((ref) => !ONE_FIELD_REF.test(ref))))];
}

/**
 * Fields the recipients were given that the template misspells with single braces ({first_name},
 * {{first_name}, {first_name}}): no other check would catch them and every draft would keep the typo.
 */
export function mistypedRefs(given: string[], ...templates: (string | undefined)[]): string[] {
  const text = templates.map((t) => (t ?? '').normalize('NFC')).join('\n');
  const found: string[] = [];
  for (const name of new Set(given.map((n) => n.normalize('NFC')))) {
    // Only field names are looked for (letters, digits, _ . -); "." is the one that means something in a pattern.
    if (!FIELD_NAME.test(name)) continue;
    const n = name.replace(/\./g, '\\.');
    const typo = new RegExp(`(?<!\\{)\\{\\s*${n}\\s*\\}(?!\\})|\\{\\{\\s*${n}\\s*\\}(?!\\})|(?<!\\{)\\{\\s*${n}\\s*\\}\\}`, 'u');
    const m = typo.exec(text);
    if (m) found.push(m[0]);
  }
  return found;
}

/**
 * A recipient's value for a field; own keys only, so "constructor" is not found on every object. Names are
 * compared in Unicode NFC, so an "é" typed as e + accent in one place and as one character in the other match.
 */
function fieldValue(fields: Record<string, string> | undefined, name: string): string | undefined {
  if (!fields) return undefined;
  const wanted = name.normalize('NFC');
  const key = Object.hasOwn(fields, wanted) ? wanted : Object.keys(fields).find((k) => k.normalize('NFC') === wanted);
  const value = key === undefined ? undefined : fields[key];
  return typeof value === 'string' ? value : undefined;
}

/** The template with each {{field}} replaced in one pass: a value that itself looks like {{x}} stays as written. */
export function fillTemplate(template: string, fields: Record<string, string> | undefined, html = false): string {
  return template.normalize('NFC').replace(FIELD_REF, (ref, name: string) => {
    const value = fieldValue(fields, name);
    if (value === undefined) return ref;
    // In HTML a line break in a value is <br>, so the rich version keeps the lines the text version has.
    return html ? value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!).replace(/\r\n|\r|\n/g, '<br>') : value;
  });
}

/** How a recipient is named in errors: its first address, bare. */
function recipientLabel(to: string[] | undefined, index: number): string {
  const first = to?.[0]?.trim();
  return `recipient ${index + 1} (${(first && parseAddresses(first)[0]?.email) || first || 'no address'})`;
}

/** Addresses for results, as the user writes them ("Élodie <e@x>"); the headers carry them encoded. */
function shownAddresses(values: string[]): string {
  return values
    .flatMap((v) => parseAddresses(v))
    .map((a) => {
      const name = a.name?.replace(/\s+/g, ' ').trim();
      if (!name) return a.email;
      return `${/[",;<>@\\]/.test(name) ? JSON.stringify(name) : name} <${a.email}>`;
    })
    .join(', ');
}

/** A recipient's own files; a problem is named as recipients[i].attachments, not as the shared attachments. */
async function ownAttachments(ctx: ToolContext, account: string, given: FileSpec[] | undefined, index: number): Promise<MimeAttachment[]> {
  try {
    return await outgoingAttachments(ctx, account, given);
  } catch (err) {
    // An account error here is about a file's source (from_account), not the account the drafts go to.
    if (!(err instanceof InputError || err instanceof AccountError || err instanceof GoogleApiError)) throw err;
    const path = `recipients[${index}].attachments`;
    throw new InputError(/^attachments[[:]/.test(err.message) ? err.message.replace(/^attachments/, path) : `${path}: ${err.message}`);
  }
}

const ADDRESS_HINT = 'as email addresses, optionally with a display name ("Ann Lee <ann@example.com>").';

const recipientSchema = z.object({
  to: z.array(z.string().min(1)).min(1).describe(`This draft's recipients, ${ADDRESS_HINT}`),
  cc: optionalAddresses("This draft's Cc recipients,"),
  bcc: optionalAddresses("This draft's Bcc recipients,"),
  fields: z
    .record(z.string().regex(FIELD_NAME), z.string())
    .optional()
    .describe('Values for the template\'s {{field}} names, e.g. {"first_name": "Ann", "company": "Acme"}. Names: letters (accents are fine), digits, _ . - (up to 40). An empty string leaves the spot empty.'),
  attachments: compactAttachmentsParam.describe("Extra files for this recipient's draft only, in the same forms as attachments (up to 10)."),
});

export const gmailCreateDrafts: ToolDefinition = defineTool({
  name: 'gmail_create_drafts',
  title: 'Mail merge: one draft per recipient',
  description:
    'Mail merge: creates one personalised draft per recipient (up to 25) from one template. {{field}} in subject, body_text and body_html is replaced by that recipient\'s fields ' +
    '(names: letters, accented ones too, digits, _ . -, e.g. {{prénom}} or {{company}}; values are HTML-escaped in body_html); every field the template uses must be given for every recipient, and every address must be valid, or nothing is created. ' +
    'Nothing is sent: the user reviews the drafts (web_url opens each in Gmail), then gmail_send_draft with draft_ids sends them together; it refuses drafts that still have blanks such as "[téléphone]", flagged here in warning. ' +
    'attachments go in every draft, a recipient\'s own attachments only in theirs. The account\'s Gmail name and signature are added as in gmail_create_draft. ' +
    'Returns one row per recipient, in order: draft_id, message_id, to, subject, attachments, warning and web_url, or error (the other drafts are still created: call again with only the failed recipients; an account error stops the rest).',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    subject: z.string().describe('Subject template, e.g. "Devis pour {{company}}".'),
    body_text: z.string().describe('Plain-text body template (UTF-8), e.g. "Bonjour {{first_name}},". Always included, as the text alternative when body_html is given.'),
    body_html: z.string().optional().describe('Optional HTML body template; field values are HTML-escaped in it.'),
    recipients: z.array(recipientSchema).min(1).max(MAX_RECIPIENTS).describe('One entry per draft (1-25), in the order the drafts are created.'),
    attachments: attachmentsParam.describe(`Files attached to every draft (fetched once). ${attachmentsParam.description ?? ''}`.trim()),
    signature: signatureParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: guarded(async (args, ctx) => {
    const started = Date.now();
    const list = args.recipients ?? [];
    if (!list.length || list.length > MAX_RECIPIENTS) return errorResult(`Give 1 to ${MAX_RECIPIENTS} recipients; draft the rest in another call.`);
    // Everything is checked before the first Google call: the batch is created whole, or not at all.
    const bad = badFieldRefs(args.subject, args.body_text, args.body_html);
    if (bad.length) {
      return errorResult(
        `The template has ${bad.slice(0, 10).join(', ')}, which no field can fill: a field name has only letters (accents are fine, spaces are not), digits and _ . - (up to 40), e.g. {{prénom}} or {{first_name}}. ` +
          'Rename them in the template and in each recipient\'s fields. Nothing was created.',
      );
    }
    const names = templateFields(args.subject, args.body_text, args.body_html);
    const unused = list.flatMap((r) => Object.keys(r.fields ?? {})).filter((n) => !names.includes(n.normalize('NFC')));
    const typos = mistypedRefs(unused, args.subject, args.body_text, args.body_html);
    if (typos.length) {
      return errorResult(`The template has ${typos.slice(0, 10).join(', ')}: a field is written between double braces, e.g. {{first_name}}. Correct the template. Nothing was created.`);
    }
    const problems: string[] = [];
    let missingFields = false;
    let badAddress = false;
    const addressed = list.map((r, i) => {
      const label = recipientLabel(r.to, i);
      const missing = names.filter((n) => fieldValue(r.fields, n) === undefined);
      if (missing.length) {
        missingFields = true;
        problems.push(`${label}: missing ${missing.join(', ')}`);
      }
      try {
        const to = recipients(r.to, 'to');
        if (!to.length) throw new InputError('to: give at least one address.');
        return { to, cc: recipients(r.cc, 'cc'), bcc: recipients(r.bcc, 'bcc'), shown: shownAddresses(r.to) };
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        badAddress = true;
        problems.push(`${label}: ${err.message}`);
        return { to: [], cc: [], bcc: [], shown: '' };
      }
    });
    if (problems.length) {
      const hints = [
        missingFields ? `Give every recipient a value for each field the template uses (${names.map((n) => `{{${n}}}`).join(', ')}); ask the user for any you do not have.` : '',
        badAddress ? 'Correct the addresses.' : '',
      ];
      return errorResult(`These recipients cannot be drafted:\n${problems.map((p) => `- ${p}`).join('\n')}\n${hints.filter(Boolean).join(' ')} Nothing was created.`);
    }

    const identity = await gmailIdentity(ctx, args.account);
    let shared: MimeAttachment[];
    try {
      shared = await outgoingAttachments(ctx, args.account, args.attachments);
    } catch (err) {
      if (err instanceof InputError) throw new InputError(`${err.message} Nothing was created.`);
      throw err;
    }

    const rows: Record<string, unknown>[] = [];
    const created: string[] = [];
    let stopped: string | undefined;
    for (const [i, r] of list.entries()) {
      const who = addressed[i]!;
      const to = who.shown;
      if (stopped || Date.now() - started > TIME_BUDGET_MS) {
        rows.push({ to, error: stopped ?? OUT_OF_TIME });
        continue;
      }
      try {
        const subject = fillTemplate(args.subject, r.fields);
        const text = fillTemplate(args.body_text, r.fields);
        const filled = args.body_html === undefined ? undefined : fillTemplate(args.body_html, r.fields, true);
        // An empty HTML body would make an HTML part that shows only the signature.
        const html = filled?.trim() ? filled : undefined;
        // Its own files are fetched only while there is time to upload the draft afterwards.
        const left = DEADLINE_MS - UPLOAD_RESERVE_MS - (Date.now() - started);
        const own = r.attachments?.length ? await beforeDeadline(ownAttachments(ctx, args.account, r.attachments, i), left) : [];
        if (own === OUT_OF_TIME_MARK) {
          rows.push({ to, error: OUT_OF_TIME });
          stopped = OUT_OF_TIME;
          continue;
        }
        const files = [...shared, ...own];
        if (files.length > MAX_FILES) throw new InputError(`With the shared attachments this draft would carry ${files.length} files; at most ${MAX_FILES} can be attached to one email.`);
        const bytes = files.reduce((sum, f) => sum + f.content.length, 0);
        if (bytes > MAX_OUTGOING_ATTACHMENT_BYTES) {
          throw new InputError(`With the shared attachments this draft's files add up to ${mb(bytes)} MB, above Gmail's 25 MB limit. Share large files as Drive links instead (drive_share).`);
        }
        const body = withSignature({ text, html }, identity, args.signature ?? true);
        const mime = buildMimeMessage({ from: fromHeader(identity), to: who.to, cc: who.cc, bcc: who.bcc, subject, text: body.text, html: body.html, attachments: files });
        // Its own files may have taken a while: start the upload only if it ends in time even at its timeout.
        if (Date.now() - started + transferTimeoutMs(Buffer.byteLength(mime)) > DEADLINE_MS) {
          rows.push({ to, error: OUT_OF_TIME });
          continue;
        }
        const draft = await uploadRawMessage<Draft>(ctx, args.account, draftTarget(undefined, undefined), mime);
        const messageId = draft.message?.id;
        created.push(draft.id);
        rows.push({
          draft_id: draft.id,
          message_id: messageId,
          to,
          subject: oneLine(subject),
          attachments: files.map((f) => f.filename),
          // The blanks Claude or the template left, before the signature (which is the user's own text).
          warning: placeholderWarning(findPlaceholders({ subject, texts: [text, html ? htmlToText(html) : ''] })),
          web_url: messageId ? gmailWebUrl(identity.email, 'draft', messageId) : undefined,
        });
      } catch (err) {
        if (err instanceof AccountError) {
          // The account itself fails (re-link, permissions): every other draft would fail the same way.
          if (!created.length) return errorResult(`${err.message} No draft was created.`);
          rows.push({ to, error: err.message });
          stopped = 'Not created: stopped at the account error above. Once it is fixed, call gmail_create_drafts again with only the recipients that have an error.';
          continue;
        }
        if (!(err instanceof GoogleApiError || err instanceof InputError || err instanceof ToolInputError)) throw err;
        rows.push({ to, error: err.message });
      }
    }

    const failed = rows.length - created.length;
    ctx.log.info('gmail merge', { alias: args.account, created: created.length, failed });
    return jsonResult({
      created: created.length,
      failed: failed || undefined,
      drafts: rows,
      next: created.length ? `Review them, then send with gmail_send_draft draft_ids: ${JSON.stringify(created)}` : undefined,
    });
  }),
});
