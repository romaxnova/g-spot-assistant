/**
 * Cross-account convenience tools: one call, every linked account.
 *
 * Unlike the per-service modules these tools take an optional `accounts`
 * list and default to every healthy account that grants the needed service.
 * Failures are reported per account so one dead grant never hides the others.
 * Google is called directly with the smallest field sets that make sense.
 */
import * as z from 'zod';
import { SERVICE_LABELS, type Service } from '../../config.js';
import { AccountError, GoogleApiError } from '../../google/client.js';
import { defineTool, errorResult, jsonResult, type ToolContext, type ToolDefinition } from '../registry.js';
import { oneLine } from '../text.js';

// ---------------------------------------------------------------------------
// Shared: fan-out over accounts

export const accountsParam = z
  .array(z.string().min(1))
  .optional()
  .describe('Account aliases to include (see list_accounts). Default: every linked account that grants the needed service.');

interface AccountFailure {
  alias: string;
  email?: string;
  error: string;
}

/**
 * Runs `work` for each alias concurrently. Account and Google errors become an
 * `{ alias, email, error }` entry so the other accounts still answer; anything
 * else is a bug and propagates.
 */
export async function forEachAccount<T extends { alias: string }>(
  ctx: ToolContext,
  aliases: string[],
  work: (alias: string) => Promise<T>,
): Promise<Array<T | AccountFailure>> {
  return Promise.all(
    aliases.map(async (alias) => {
      try {
        return await work(alias);
      } catch (err) {
        if (err instanceof AccountError || err instanceof GoogleApiError) {
          return { alias, email: ctx.accounts.get(alias)?.email, error: err.message };
        }
        throw err;
      }
    }),
  );
}

/** Explicit aliases (normalised, deduplicated) or every healthy account granting the service. */
export function targetAliases(ctx: ToolContext, service: Service, requested: string[] | undefined): string[] {
  const explicit = [...new Set((requested ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (explicit.length) return explicit;
  return ctx.google.accountsFor(service).map((a) => a.alias);
}

export function noAccountsError(ctx: ToolContext, service: Service) {
  return errorResult(`No linked account grants ${SERVICE_LABELS[service]}. Link one at ${ctx.config.baseUrl.href}admin or call list_accounts.`);
}

/** Like Promise.all over `items`, but at most `limit` calls of `fn` are in flight. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// inbox_overview

const DEFAULT_INBOX_QUERY = 'is:unread in:inbox';
const SNIPPET_CHARS = 120;
const METADATA_CONCURRENCY = 5;

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

interface GmailMetadataMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Gmail snippets arrive HTML-escaped (`It&#39;s`), which reads badly and wastes tokens. */
export function decodeSnippet(snippet: string): string {
  const decoded = snippet.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
  // Invisible preheader padding (U+034F, zero-width joiners...) is common in marketing snippets.
  return oneLine(decoded);
}

function header(msg: GmailMetadataMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function summariseMessage(msg: GmailMetadataMessage) {
  const snippet = decodeSnippet(msg.snippet ?? '');
  return {
    id: msg.id,
    thread_id: msg.threadId,
    // internalDate is epoch milliseconds as a string; more reliable than the Date header.
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined,
    from: header(msg, 'From'),
    subject: header(msg, 'Subject'),
    snippet: snippet.length > SNIPPET_CHARS ? snippet.slice(0, SNIPPET_CHARS - 1) + '…' : snippet,
  };
}

async function inboxForAccount(ctx: ToolContext, alias: string, query: string, maxResults: number) {
  const email = ctx.google.resolve(alias, 'gmail').email;
  const [list, inboxLabel] = await Promise.all([
    ctx.google.request<GmailListResponse>(alias, 'gmail', { url: '/messages', query: { q: query, maxResults } }),
    // A label's messagesUnread counter is the cheap way to get a total. INBOX's is the count of unread mail
    // carrying the INBOX label, exactly what the default query matches; UNREAD's would also count unread mail
    // that was archived or sits in Spam/Trash. Meaningless for any other query, so it is skipped then.
    query === DEFAULT_INBOX_QUERY
      ? ctx.google.request<{ messagesUnread?: number }>(alias, 'gmail', { url: '/labels/INBOX' })
      : Promise.resolve(undefined),
  ]);
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await mapConcurrent(ids, METADATA_CONCURRENCY, (id) =>
    ctx.google.request<GmailMetadataMessage>(alias, 'gmail', {
      url: `/messages/${encodeURIComponent(id)}`,
      query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] },
    }),
  );
  return {
    alias,
    email,
    unread_total: inboxLabel?.messagesUnread,
    count_shown: messages.length,
    // Gmail's resultSizeEstimate is left out: it reads ~201 for any sizeable mailbox whatever the query.
    more_available: list.nextPageToken ? true : undefined,
    messages: messages.map(summariseMessage),
  };
}

const inboxOverview = defineTool({
  name: 'inbox_overview',
  title: 'Inbox overview across accounts',
  description:
    'Lists recent messages matching a Gmail query in several accounts at once (default: unread inbox mail in every account with Gmail). ' +
    'Returns per account: unread_total (exact count of unread messages in the inbox; only for the default query), more_available when more messages match than are shown, and up to max_per_account messages ' +
    '(id, thread_id, date, from, subject, snippet clipped to 120 chars), newest first. Message ids work with the gmail_* tools together with the alias. ' +
    'An account that fails (not granted Gmail, needs re-linking, Google error) is reported as { alias, email, error } without affecting the others. Read-only.',
  inputSchema: {
    accounts: accountsParam,
    query: z.string().optional().describe(`Gmail search query (same syntax as the Gmail search box). Default "${DEFAULT_INBOX_QUERY}".`),
    max_per_account: z.number().int().min(1).max(25).optional().describe('Messages to list per account, 1-25 (default 8).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const aliases = targetAliases(ctx, 'gmail', args.accounts);
    if (!aliases.length) return noAccountsError(ctx, 'gmail');
    const query = args.query?.trim() || DEFAULT_INBOX_QUERY;
    const max = args.max_per_account ?? 8;
    ctx.log.debug('inbox_overview', { accounts: aliases.length, max });
    const accounts = await forEachAccount(ctx, aliases, (alias) => inboxForAccount(ctx, alias, query, max));
    return jsonResult({ accounts });
  },
});

// ---------------------------------------------------------------------------
// Time zone helpers (kept here: the calendar module is written independently)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True when `tz` is an IANA zone the runtime knows. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in a zone, read back through Intl. */
function wallClock(instant: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  // hourCycle h23 avoids the "24:00" that hour12:false produces on some ICU builds.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(fmt.formatToParts(instant).find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function tzOffsetMs(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - instant.getTime();
}

/** Parses 'YYYY-MM-DD' strictly (rejects 2026-02-30). Returns null when invalid. */
function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * The first instant at which the wall clock in `tz` shows the calendar day
 * `dateStr`.
 *
 * Intl only converts instant -> wall clock, so we start from UTC midnight,
 * apply the zone's offset at that instant, then apply the offset at the result
 * (they differ when a DST change lies in between). Of the two candidates we
 * keep the earliest that lands on the requested day: when a zone springs
 * forward at midnight (America/Santiago) the day starts at 01:00, and when it
 * falls back at midnight the day starts at the second midnight, not the first.
 */
export function zonedDayStart(dateStr: string, tz: string): Date {
  const d = parseCalendarDate(dateStr);
  if (!d) throw new RangeError(`Invalid date "${dateStr}": expected YYYY-MM-DD`);
  const guess = Date.UTC(d.year, d.month - 1, d.day);
  const first = new Date(guess - tzOffsetMs(new Date(guess), tz));
  const second = new Date(guess - tzOffsetMs(first, tz));
  const onDay = (instant: Date) => {
    const w = wallClock(instant, tz);
    return w.year === d.year && w.month === d.month && w.day === d.day;
  };
  return [first, second].filter(onDay).sort((a, b) => a.getTime() - b.getTime())[0] ?? first;
}

/** 'YYYY-MM-DD' `days` days after `dateStr` (pure calendar arithmetic, no zone involved). */
function addCalendarDays(dateStr: string, days: number): string {
  const d = parseCalendarDate(dateStr);
  if (!d) throw new RangeError(`Invalid date "${dateStr}": expected YYYY-MM-DD`);
  return new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Today's calendar date in `tz` as 'YYYY-MM-DD'. */
export function todayIn(tz: string, now = new Date()): string {
  const w = wallClock(now, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** ISO 8601 with the zone's offset, e.g. 2026-03-29T00:00:00+01:00 — easier to read than UTC. */
export function zonedIso(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  const offsetMin = Math.round(tzOffsetMs(instant, tz) / 60_000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}:${p(w.second)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

// ---------------------------------------------------------------------------
// agenda

const MAX_EVENTS_PER_ACCOUNT = 200;

interface CalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  selected?: boolean;
  hidden?: boolean;
  primary?: boolean;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

interface AgendaCalendar {
  id: string;
  name?: string;
}

interface AgendaEvent {
  id: string;
  calendar_id: string;
  calendar?: string;
  summary?: string;
  start?: string;
  end?: string;
  /** Present (true) only for all-day events, so timed events stay compact. */
  all_day?: true;
  location?: string;
  my_response?: string;
  meet_link?: string;
}

/**
 * Calendars to show by default: the ones ticked in the Google Calendar sidebar
 * (`selected`) that are not hidden. A fresh account may have none ticked from
 * the API's point of view, so fall back to the primary calendar.
 */
export function defaultCalendars(entries: CalendarListEntry[]): AgendaCalendar[] {
  const toCalendar = (e: CalendarListEntry): AgendaCalendar => ({ id: e.id, name: e.summaryOverride ?? e.summary });
  const selected = entries.filter((e) => e.selected === true && !e.hidden);
  if (selected.length) return selected.map(toCalendar);
  const primary = entries.find((e) => e.primary);
  return [primary ? toCalendar(primary) : { id: 'primary' }];
}

/** The account's own responseStatus, in Google's spelling (needsAction, accepted, declined, tentative) so it matches the calendar_* tools. */
function myResponse(event: CalendarEvent): string | undefined {
  return event.attendees?.find((a) => a.self)?.responseStatus;
}

function meetLink(event: CalendarEvent): string | undefined {
  return event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
}

function toAgendaEvent(event: CalendarEvent, calendar: AgendaCalendar): AgendaEvent {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id,
    calendar_id: calendar.id,
    calendar: calendar.name,
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    all_day: allDay ? true : undefined,
    location: event.location,
    my_response: myResponse(event),
    meet_link: meetLink(event),
  };
}

/** Sort key: all-day events sort at the start of their day in the agenda's zone. */
function startInstant(event: AgendaEvent, tz: string): number {
  if (!event.start) return Number.MAX_SAFE_INTEGER;
  return event.all_day ? zonedDayStart(event.start, tz).getTime() : Date.parse(event.start);
}

interface AgendaWindow {
  timeMin: Date;
  timeMax: Date;
  timeZone: string;
  /** Events kept per calendar before reading stops and the calendar is reported as truncated. */
  maxPerCalendar: number;
  includeDeclined: boolean;
  calendarIds: string[] | undefined;
}

interface CalendarRead {
  events: AgendaEvent[];
  /** True when reading stopped at maxPerCalendar while Google still had a page to give. */
  truncated: boolean;
}

/**
 * Reads one calendar page by page. Google may return fewer items than
 * maxResults together with a nextPageToken (cancelled instances of recurring
 * events count against maxResults and are then filtered out here), so the loop
 * follows the token instead of treating a short page as the end.
 */
async function readCalendar(ctx: ToolContext, alias: string, calendar: AgendaCalendar, w: AgendaWindow): Promise<CalendarRead> {
  const events: AgendaEvent[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const res = await ctx.google.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(alias, 'calendar', {
      url: `/calendars/${encodeURIComponent(calendar.id)}/events`,
      query: {
        singleEvents: true,
        orderBy: 'startTime',
        timeMin: w.timeMin.toISOString(),
        timeMax: w.timeMax.toISOString(),
        timeZone: w.timeZone,
        // Google never returns more than maxResults, so asking only for what is still missing keeps the limit exact.
        maxResults: w.maxPerCalendar - events.length,
        pageToken,
        fields: 'nextPageToken,items(id,status,summary,location,start,end,attendees(self,responseStatus),hangoutLink,conferenceData/entryPoints)',
      },
    });
    for (const e of res.items ?? []) {
      if (e.status === 'cancelled') continue;
      const event = toAgendaEvent(e, calendar);
      if (!w.includeDeclined && event.my_response === 'declined') continue;
      events.push(event);
    }
    if (!res.nextPageToken) return { events, truncated: false };
    if (events.length >= w.maxPerCalendar) return { events, truncated: true };
    pageToken = res.nextPageToken;
  }
}

async function agendaForAccount(ctx: ToolContext, alias: string, w: AgendaWindow) {
  const email = ctx.google.resolve(alias, 'calendar').email;
  const calendars: AgendaCalendar[] = w.calendarIds
    ? w.calendarIds.map((id) => ({ id }))
    : defaultCalendars(
        (
          await ctx.google.request<{ items?: CalendarListEntry[] }>(alias, 'calendar', {
            url: '/users/me/calendarList',
            query: { maxResults: 250, fields: 'items(id,summary,summaryOverride,selected,hidden,primary)' },
          })
        ).items ?? [],
      );
  const reads = await Promise.all(calendars.map((calendar) => readCalendar(ctx, alias, calendar, w)));
  const events = reads.flatMap((r) => r.events).sort((a, b) => startInstant(a, w.timeZone) - startInstant(b, w.timeZone));
  return {
    alias,
    email,
    calendars: w.calendarIds ? undefined : calendars.map((c) => c.name ?? c.id),
    events: events.slice(0, MAX_EVENTS_PER_ACCOUNT),
    // Fetched but cut by the per-account cap. Events never fetched (see truncated_calendars) are not counted here.
    events_omitted: Math.max(0, events.length - MAX_EVENTS_PER_ACCOUNT) || undefined,
    truncated_calendars: calendars.filter((_, i) => reads[i]!.truncated).map((c) => c.id),
  };
}

const agenda = defineTool({
  name: 'agenda',
  title: 'Agenda across accounts',
  description:
    'Lists the events of one or more days across several accounts and calendars at once (default: today in every account with Calendar, ' +
    'on every calendar ticked in the Google Calendar sidebar, or the primary calendar if none is ticked). Recurring events are expanded. ' +
    'Returns per account the events sorted by start: id, calendar_id, calendar name, summary, start/end (ISO 8601 with offset, or YYYY-MM-DD with all_day=true; ' +
    'all-day end dates are exclusive), location, my_response (needsAction, accepted, declined or tentative, as the calendar_* tools return it) and meet_link. ' +
    'Events you declined are skipped unless include_declined is set. Each calendar is read page by page up to max_per_calendar events; ' +
    'at most 200 events per account are returned: events_omitted counts fetched events that were cut, and truncated_calendars lists the calendar ids ' +
    'that still had events unread, so those may hold more than events_omitted says. ' +
    'Event ids work with the calendar_* tools together with the alias and calendar_id. ' +
    'An account that fails (not granted Calendar, needs re-linking, Google error) is reported as { alias, email, error } without affecting the others. Read-only.',
  inputSchema: {
    accounts: accountsParam,
    date: z.string().optional().describe('First day to show, YYYY-MM-DD in time_zone. Default: today.'),
    days: z.number().int().min(1).max(14).optional().describe('Number of days to show starting at date, 1-14 (default 1).'),
    time_zone: z.string().optional().describe('IANA time zone that defines the day boundaries and the offsets in the output (default: the server default, usually Europe/Paris).'),
    calendar_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Calendar ids to read in every account (e.g. "primary" or an address from calendar_list_calendars). Default: the calendars ticked in the sidebar.'),
    max_per_calendar: z
      .number()
      .int()
      .min(1)
      .max(250)
      .optional()
      .describe('Most events to return per calendar, 1-250 (default 200). A calendar that reaches it is listed in truncated_calendars.'),
    include_declined: z.boolean().optional().describe('Also show events you declined (default false).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const timeZone = args.time_zone?.trim() || ctx.config.defaultTimezone;
    if (!isKnownTimeZone(timeZone)) return errorResult(`Unknown time zone "${timeZone}". Use an IANA name such as Europe/Paris or America/New_York.`);
    const date = args.date?.trim() || todayIn(timeZone);
    if (!parseCalendarDate(date)) return errorResult(`Invalid date "${args.date}": expected YYYY-MM-DD.`);
    const aliases = targetAliases(ctx, 'calendar', args.accounts);
    if (!aliases.length) return noAccountsError(ctx, 'calendar');
    const days = args.days ?? 1;
    const window: AgendaWindow = {
      timeMin: zonedDayStart(date, timeZone),
      timeMax: zonedDayStart(addCalendarDays(date, days), timeZone),
      timeZone,
      maxPerCalendar: args.max_per_calendar ?? MAX_EVENTS_PER_ACCOUNT,
      includeDeclined: args.include_declined ?? false,
      calendarIds: args.calendar_ids?.length ? args.calendar_ids : undefined,
    };
    ctx.log.debug('agenda', { accounts: aliases.length, days, timeZone });
    const accounts = await forEachAccount(ctx, aliases, (alias) => agendaForAccount(ctx, alias, window));
    return jsonResult({ time_zone: timeZone, from: zonedIso(window.timeMin, timeZone), to: zonedIso(window.timeMax, timeZone), accounts });
  },
});

export const crossTools: ToolDefinition[] = [inboxOverview, agenda];
