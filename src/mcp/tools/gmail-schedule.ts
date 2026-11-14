/**
 * gmail_schedule_send, and the sender that runs it: Gmail's API has no
 * scheduled send, so the connector keeps the schedule and sends the draft
 * itself at that time, with no chat open.
 *
 * The draft is checked when scheduled (it exists, no unfilled blanks unless
 * confirmed, sensitive contacts reviewed with the token of that exact version,
 * as for gmail_send_draft) and again when it is due. A draft to sensitive
 * contacts edited after its approval is not sent: what goes out is what the
 * user approved. A draft that cannot be sent leaves a notice in the account's
 * inbox (messages.insert, nothing sent to anyone) so nothing fails silently.
 * Sends are never retried after Gmail was asked: a repeat could deliver twice.
 * Logs carry ids and statuses only.
 */
import * as z from 'zod';
import { AccountError, GoogleApiError } from '../../google/client.js';
import type { Logger } from '../../log.js';
import { MAX_PENDING_SENDS, ScheduleError, type ScheduledSend, type ScheduledSendStore } from '../../mail/scheduled-store.js';
import { accountParam, defineTool, errorResult, jsonResult, ToolInputError, type ToolContext, type ToolDefinition } from '../registry.js';
import { oneLine } from '../text.js';
import { DateInputError, formatInZone, instantOf, parseDateInput } from './calendar-dates.js';
import { gmailWebUrl } from './gmail-identity.js';
import { buildMimeMessage, encodeBase64Url, formatAddress, headerValue, parseAddresses, type GmailPart } from './gmail-mime.js';
import { accountEmail, encodeId, FETCH_CONCURRENCY, mapLimit, messageBlanks, ownText, SERVICE } from './gmail.js';
import { allowPlaceholdersParam, quoteList } from './placeholders.js';
import { reviewedByUserParam, reviewFor, reviewToken, reviewTokensParam, sensitiveRecipients, type CadenceCache } from './sensitive.js';

/** A send may be scheduled up to this far ahead. */
const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
/** A send the server could not make within this long after its time is not made late: the user is told instead. */
export const LATE_MS = 12 * 60 * 60 * 1000;
/** A send left half-done (the server stopped while Gmail was asked) is settled after this long. */
const STALE_MS = 10 * 60 * 1000;
const NOTICE_SENDER = 'Scheduled send';

interface FullDraft {
  id: string;
  message?: { id: string; threadId?: string; payload?: GmailPart };
}

async function readDraft(ctx: ToolContext, account: string, id: string): Promise<FullDraft | undefined> {
  try {
    const d = await ctx.google.request<FullDraft>(account, SERVICE, { url: `/drafts/${encodeId(id)}`, query: { format: 'full' } });
    return d.message ? d : undefined;
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 400)) return undefined;
    throw err;
  }
}

function recipientsOf(payload: GmailPart | undefined) {
  const h = payload?.headers;
  return [headerValue(h, 'To'), headerValue(h, 'Cc'), headerValue(h, 'Bcc')].flatMap((v) => (v ? parseAddresses(v) : [])).filter((a) => a.email.includes('@'));
}

function describe(d: FullDraft) {
  const h = d.message?.payload?.headers;
  return { to: oneLine(headerValue(h, 'To') ?? '') || undefined, subject: oneLine(headerValue(h, 'Subject') ?? '') || undefined };
}

// ---------------------------------------------------------------------------
// The tool

export const gmailScheduleSend: ToolDefinition = defineTool({
  name: 'gmail_schedule_send',
  title: 'Schedule drafts to send later',
  description:
    'Sends existing drafts at a later time (e.g. tomorrow 09:00): the connector keeps the schedule and sends them itself, with no chat open. Write the mail as a draft first (gmail_create_draft, or the draft a send to a sensitive contact saved). ' +
    'send_at is an ISO 8601 date and time, read in the default time zone unless it has an offset (2026-10-20T09:00). The same checks as gmail_send_draft apply now and again at sending time: unfilled blanks refuse it unless allow_placeholders; ' +
    'drafts to sensitive contacts need reviewed_by_user: true with their review_token, and are not sent if edited after that approval (the user gets a notice in the inbox instead, as for any draft that cannot be sent). Scheduling a draft again replaces its earlier time. ' +
    'cancel takes schedule ids. With no draft, lists what is scheduled (and the latest sends, failed ones with why). Returns schedule ids and the times in the default time zone.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    draft_id: z.string().min(1).optional().describe('Draft to schedule (draft id, as gmail_search with in:drafts or gmail_create_draft gives it).'),
    draft_ids: z.array(z.string().min(1)).min(1).max(25).optional().describe('Several drafts to send at the same time.'),
    send_at: z.string().optional().describe('When to send: ISO 8601 date and time, e.g. "2026-10-20T09:00" (default time zone) or "2026-10-20T09:00:00+02:00".'),
    allow_placeholders: allowPlaceholdersParam,
    reviewed_by_user: reviewedByUserParam,
    review_tokens: reviewTokensParam,
    cancel: z.array(z.string().min(1)).max(50).optional().describe('Schedule ids (ss_...) to cancel; the drafts stay in the drafts folder.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (args, ctx) => {
    const store = ctx.schedules;
    if (!store) return errorResult('This server keeps no schedule of sends.');
    const tz = ctx.config.defaultTimezone;
    const email = accountEmail(ctx, args.account);
    const when = (ms: number) => formatInZone(ms, tz);

    if (args.cancel?.length) {
      const results = args.cancel.map((id) => {
        const s = store.get(id.trim());
        if (!s || s.account !== ctx.google.resolve(args.account, SERVICE).alias) return { id, cancelled: false, error: 'no such schedule in this account' };
        return store.cancel(s.id) ? { id, cancelled: true, draft_id: s.draft_id } : { id, cancelled: false, error: `already ${s.status}` };
      });
      ctx.log.info('scheduled sends cancelled', { alias: args.account, count: results.filter((r) => r.cancelled).length });
      return jsonResult({ results, note: 'Cancelled sends leave their drafts in the drafts folder.' });
    }

    const ids = [...new Set([...(args.draft_id ? [args.draft_id] : []), ...(args.draft_ids ?? [])].map((x) => x.trim()).filter(Boolean))];
    const alias = ctx.google.resolve(args.account, SERVICE).alias;
    if (!ids.length) {
      const pending = store.pending(alias);
      const rows = await mapLimit(pending, FETCH_CONCURRENCY, async (s) => {
        const d = await readDraft(ctx, alias, s.draft_id).catch(() => undefined);
        return { id: s.id, draft_id: s.draft_id, send_at: when(s.send_at), ...(d ? describe(d) : { note: 'draft not found: it will not be sent' }), edited_since: d && d.message!.id !== s.message_id ? true : undefined };
      });
      const recent = store.recent(5, alias).map((s) => ({ id: s.id, draft_id: s.draft_id, send_at: when(s.send_at), status: s.status, error: s.error }));
      return jsonResult({ scheduled: rows, recent, note: rows.length ? undefined : 'Nothing is scheduled in this account.' });
    }

    if (ids.length > 25) return errorResult('At most 25 drafts per call; schedule the rest in another call.');
    if (!args.send_at) return errorResult('Give send_at, e.g. "2026-10-20T09:00" (read in the default time zone).');
    let at: number;
    try {
      const parsed = parseDateInput(args.send_at, tz);
      if ('date' in parsed && parsed.date) return errorResult(`send_at needs a time of day too, e.g. "${parsed.date}T09:00".`);
      at = instantOf(parsed, tz);
    } catch (err) {
      if (err instanceof DateInputError) return errorResult(err.message);
      throw err;
    }
    const now = Date.now();
    if (!Number.isFinite(at)) return errorResult(`send_at "${args.send_at}" is not a valid time (check the offset, e.g. +02:00).`);
    if (at < now + 60_000) return errorResult(`send_at (${when(at)}) is not in the future. To send now, use gmail_send_draft.`);
    if (at > now + MAX_AHEAD_MS) return errorResult('send_at is more than 60 days ahead.');

    const drafts = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => ({ id, draft: await readDraft(ctx, alias, id) }));
    const missing = drafts.filter((d) => !d.draft).map((d) => d.id);
    if (missing.length) return errorResult(`Nothing was scheduled: this account has no draft ${missing.map((m) => `"${m}"`).join(', ')} (it needs the draft id, not the message id).`);
    const checked = drafts.map(({ id, draft }) => {
      const payload = draft!.message!.payload;
      return {
        id,
        ...describe(draft!),
        message_id: draft!.message!.id,
        payload,
        blanks: messageBlanks(payload),
        sensitive: sensitiveRecipients(ctx, recipientsOf(payload)),
        token: reviewToken(ctx, alias, id, draft!.message!.id),
      };
    });
    const withBlanks = checked.filter((d) => d.blanks.length);
    if (withBlanks.length && !args.allow_placeholders) {
      return errorResult(
        `Nothing was scheduled: ${withBlanks.map((d) => `${d.id} (${d.subject ?? 'no subject'}): ${quoteList(d.blanks)}`).join('; ')} still look like unfilled blanks. ` +
          'Fill them in with gmail_update_draft (ask the user), or call again with allow_placeholders: true if they belong there.',
      );
    }
    const tokens = new Set(args.reviewed_by_user ? (args.review_tokens ?? []) : []);
    const toReview = checked.filter((d) => d.sensitive.length && !tokens.has(d.token));
    if (toReview.length) {
      const cache: CadenceCache = new Map();
      const reviews = await mapLimit(toReview, FETCH_CONCURRENCY, async (d) => ({
        draft_id: d.id,
        to: d.to,
        subject: d.subject,
        review: { ...(await reviewFor(ctx, alias, d.sensitive, d.subject, ownText(d.payload), cache)), review_token: d.token },
      }));
      ctx.log.info('schedule held for review', { alias, drafts: toReview.length });
      return jsonResult({
        scheduled: 0,
        note:
          'Nothing was scheduled: these drafts go to sensitive contacts. Go through the review with the user (show the final text), then call again with reviewed_by_user: true and review_tokens once they confirm. ' +
          'If the draft is edited after that, it will not be sent.',
        reviews,
      });
    }
    let scheduled: ScheduledSend[];
    try {
      // All or none: a refusal (the cap, a draft being sent right now) schedules and cancels nothing.
      scheduled = store.scheduleMany(
        checked.map((d) => ({ account: alias, draft_id: d.id, message_id: d.message_id, send_at: at, approved_sensitive: d.sensitive.length > 0, allow_placeholders: args.allow_placeholders === true })),
      );
    } catch (err) {
      if (err instanceof ScheduleError) throw new ToolInputError(err.message);
      throw err;
    }
    ctx.log.info('sends scheduled', { alias, count: scheduled.length });
    return jsonResult({
      scheduled: scheduled.map((s, i) => ({ id: s.id, draft_id: s.draft_id, to: checked[i]!.to, subject: checked[i]!.subject, send_at: when(s.send_at), web_url: gmailWebUrl(email, 'draft', s.message_id) })),
      note:
        `The connector sends ${scheduled.length > 1 ? 'them' : 'it'} at ${when(at)} by itself, with no chat open; the draft stays in the drafts folder until then. ` +
        (checked.some((d) => d.sensitive.length)
          ? 'A draft to sensitive contacts edited before then is not sent (the user gets a notice in the inbox). '
          : 'Edits made before then go out with it. ') +
        'cancel with the schedule id stops it.',
    });
  },
});

// ---------------------------------------------------------------------------
// The sender

export interface SenderOutcome {
  sent: number;
  failed: number;
}

export class ScheduledSender {
  private running = false;

  constructor(
    private readonly store: ScheduledSendStore,
    private readonly makeCtx: () => ToolContext,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sends what is due, one after the other; settles sends left half-done. Undefined when a run is already going. */
  async tick(): Promise<SenderOutcome | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const outcome: SenderOutcome = { sent: 0, failed: 0 };
    try {
      const now = this.now();
      const { due, stale } = this.store.due(now, now - STALE_MS);
      for (const s of stale) await this.settleStale(s);
      for (const s of due) {
        const result = await this.send(s, now);
        if (result === 'sent') outcome.sent++;
        else if (result === 'failed') outcome.failed++;
      }
      if (due.length || stale.length) this.log.info('scheduled sends run', { due: due.length, stale: stale.length, sent: outcome.sent, failed: outcome.failed });
      return outcome;
    } finally {
      this.running = false;
    }
  }

  private async send(s: ScheduledSend, now: number): Promise<'sent' | 'failed' | 'later' | 'skipped'> {
    if (!this.store.claim(s.id)) return 'skipped';
    const ctx = this.makeCtx();
    if (now - s.send_at > LATE_MS) {
      await this.fail(ctx, s, undefined, 'missed', 'the server could not send it in time (it was down or Gmail refused it); it was not sent late');
      return 'failed';
    }
    let draft: FullDraft | undefined;
    try {
      draft = await readDraft(ctx, s.account, s.draft_id);
    } catch (err) {
      if (!(err instanceof AccountError || err instanceof GoogleApiError)) throw err;
      // Gmail or the account is unavailable for now: tried again on the next ticks, until it is too late (unless
      // the user cancelled it meanwhile).
      this.store.release(s.id);
      this.log.info('scheduled send postponed', { id: s.id, error: err.name });
      return 'later';
    }
    if (!draft) {
      await this.fail(ctx, s, undefined, 'draft gone', 'the draft was no longer in the drafts folder (sent or deleted by hand?)');
      return 'failed';
    }
    const payload = draft.message!.payload;
    const sensitive = sensitiveRecipients(ctx, recipientsOf(payload));
    if (sensitive.length && (!s.approved_sensitive || draft.message!.id !== s.message_id)) {
      await this.fail(ctx, s, draft, 'changed since approval', 'it goes to a sensitive contact and was edited after the user approved it, or was never reviewed: review it again before sending');
      return 'failed';
    }
    // Blanks the user confirmed belong to the version they saw: an edited draft's blanks are checked again.
    const blanks = messageBlanks(payload);
    if (blanks.length && (!s.allow_placeholders || draft.message!.id !== s.message_id)) {
      await this.fail(ctx, s, draft, 'unfilled blanks', `it still has what look like unfilled blanks: ${quoteList(blanks)}`);
      return 'failed';
    }
    // Cancelled while the draft was being checked: not sent.
    if (!this.store.stillSending(s.id)) return 'skipped';
    try {
      const sent = await ctx.google.request<{ id: string }>(s.account, SERVICE, { method: 'POST', url: '/drafts/send', body: { id: s.draft_id }, idempotent: false });
      this.store.update(s.id, { status: 'sent', sent_message_id: sent.id });
      this.log.info('scheduled send sent', { id: s.id, alias: s.account });
      return 'sent';
    } catch (err) {
      if (!(err instanceof AccountError || err instanceof GoogleApiError)) throw err;
      await this.fail(ctx, s, draft, 'send failed', 'Gmail refused it or did not answer; check the Sent folder before sending it again');
      return 'failed';
    }
  }

  /** A send the server stopped during: gone from the drafts means Gmail sent it; still there, it was not, and the user is told. */
  private async settleStale(s: ScheduledSend): Promise<void> {
    const ctx = this.makeCtx();
    let draft: FullDraft | undefined;
    try {
      draft = await readDraft(ctx, s.account, s.draft_id);
    } catch (err) {
      if (!(err instanceof AccountError || err instanceof GoogleApiError)) throw err;
      // Unknown for long (the account needs re-linking, or is gone): settled as not sent rather than left hanging.
      if (this.now() - s.send_at > LATE_MS) await this.fail(ctx, s, undefined, 'interrupted', 'the server stopped while sending it and could not check it since; look in the Sent folder and the drafts');
      return;
    }
    if (!draft) {
      this.store.update(s.id, { status: 'sent', error: 'sent (unconfirmed: the server stopped while sending)' });
      return;
    }
    await this.fail(ctx, s, draft, 'interrupted', 'the server stopped while sending it; it is still in the drafts folder, not sent');
  }

  /** Records the failure (fixed words) and leaves a notice in the account's inbox; a notice that cannot be put there is logged. */
  private async fail(ctx: ToolContext, s: ScheduledSend, draft: FullDraft | undefined, status: string, reason: string): Promise<void> {
    this.store.update(s.id, { status: 'failed', error: status });
    try {
      const email = ctx.google.resolve(s.account, SERVICE).email;
      const { to, subject } = draft ? describe(draft) : { to: undefined, subject: undefined };
      const tz = ctx.config.defaultTimezone;
      const link = gmailWebUrl(email, 'draft', draft?.message?.id ?? s.message_id);
      const text = [
        `The email${subject ? ` "${subject}"` : ''}${to ? ` to ${to}` : ''}, scheduled for ${formatInZone(s.send_at, tz)}, was NOT sent: ${reason}.`,
        '',
        `Draft: ${link}`,
        '',
        'Ask Claude to look at it, or send it yourself from Gmail.',
      ].join('\n');
      const mime = buildMimeMessage({ from: formatAddress(NOTICE_SENDER, email), to: [email], subject: `Not sent: ${subject ?? 'scheduled email'}`, text });
      await ctx.google.request(s.account, SERVICE, {
        method: 'POST',
        url: '/messages',
        query: { internalDateSource: 'receivedTime' },
        body: { raw: encodeBase64Url(mime), labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'] },
        idempotent: false,
        touch: false,
      });
    } catch (err) {
      this.log.warn('scheduled send notice failed', { id: s.id, error: err instanceof Error ? err.name : 'unknown' });
    }
    this.log.info('scheduled send not sent', { id: s.id, alias: s.account, reason: status });
  }
}

export { MAX_PENDING_SENDS };
