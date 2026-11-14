/**
 * Google Calendar tools: calendars, events (list/get/create/update/delete),
 * invitation responses and free/busy.
 *
 * Calendar ids contain '@' and event ids can contain '_' suffixes for
 * recurring instances, so both are always URL-encoded in paths.
 */
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { accountParam, defineTool, errorResult, jsonResult, maxCharsParam, offsetParam, pageTokenParam, type ToolContext, type ToolDefinition } from '../registry.js';
import { assertTimeZone, DateInputError, DAY_MS, formatInZone, toRfc3339 } from './calendar-dates.js';
import { buildEventBody, compactEvent, eventDetails, freeGaps, selfAttendee, type BusyBlock, type GcalEvent } from './calendar-events.js';
import { notificationRefusal, reviewedByUserParam } from './sensitive.js';

const SERVICE = 'calendar' as const;

/* ---------- Shared parameters ---------- */

const calendarIdParam = z
  .string()
  .min(1)
  .optional()
  .describe("Calendar id from calendar_list_calendars. Default 'primary' (the account's main calendar).");
const eventIdParam = z.string().min(1).describe('Event id as returned by calendar_list_events or calendar_get_event.');
const timeZoneParam = z.string().min(1).optional().describe('IANA time zone (e.g. Europe/Paris) used to read naive datetimes and to render times. Default: the server time zone.');
const sendUpdatesParam = (fallback: 'all' | 'none') =>
  z
    .enum(['all', 'externalOnly', 'none'])
    .optional()
    .describe(`Whether Google emails attendees about this change: all, externalOnly (non-Google-Calendar guests only) or none. Default ${fallback}.`);
const dateInputDoc = "'YYYY-MM-DD' for an all-day event, or an ISO 8601 datetime ('2026-03-14T09:30:00' read in time_zone, or with an explicit offset '2026-03-14T09:30:00+01:00').";

/** Fields accepted by both create and update (summary is required only on create). */
const eventWriteFields = {
  description: z.string().optional().describe('Event description (plain text or simple HTML).'),
  location: z.string().optional().describe('Free-text location.'),
  end: z.string().optional().describe(`End: ${dateInputDoc} For all-day events the end date is exclusive.`),
  time_zone: timeZoneParam,
  attendees: z.array(z.email()).max(200).optional().describe('Attendee email addresses. On update this replaces the whole attendee list.'),
  recurrence: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("RFC 5545 lines such as 'RRULE:FREQ=WEEKLY;BYDAY=MO' or 'EXDATE;TZID=Europe/Paris:20260316T093000'. Omit for a single event."),
  reminders: z
    .object({
      use_default: z.boolean().optional().describe("Use the calendar's default reminders. Defaults to true unless overrides are given."),
      overrides: z
        .array(z.object({ method: z.enum(['popup', 'email']).describe('Reminder channel.'), minutes: z.number().int().min(0).max(40320).describe('Minutes before the start.') }))
        .max(5)
        .optional()
        .describe('Explicit reminders (max 5). Implies use_default=false.'),
    })
    .optional()
    .describe('Reminder settings for this event.'),
  add_meet: z.boolean().optional().describe('Attach a new Google Meet link (default false).'),
  visibility: z.enum(['default', 'public', 'private']).optional().describe("Event visibility. Default 'default' (calendar's setting)."),
  color_id: z.string().optional().describe("Google Calendar event color id ('1'-'11').")
};

/* ---------- Helpers ---------- */

function encodePath(calendarId: string, eventId?: string): string {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
}

/** Runs a handler and turns DateInputError (Claude can fix the argument) into an errorResult. */
async function withDateErrors(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DateInputError) return errorResult(err.message);
    throw err;
  }
}

function resolveTimeZone(ctx: ToolContext, requested: string | undefined): string {
  return assertTimeZone(requested ?? ctx.config.defaultTimezone);
}

/** [timeMin, timeMax] as RFC 3339 in the zone; timeMin defaults to now, timeMax to timeMin + 7 days. */
function timeWindow(timeMin: string | undefined, timeMax: string | undefined, timeZone: string, now = Date.now()): { timeMin: string; timeMax: string } {
  const min = timeMin ? toRfc3339(timeMin, timeZone) : formatInZone(now, timeZone);
  // Relative to the resolved min, not to now: a time_min weeks out would otherwise end before it starts.
  const max = timeMax ? toRfc3339(timeMax, timeZone) : formatInZone(Date.parse(min) + 7 * DAY_MS, timeZone);
  if (Date.parse(max) <= Date.parse(min)) throw new DateInputError('time_max must be after time_min.');
  return { timeMin: min, timeMax: max };
}

async function fetchEvent(ctx: ToolContext, account: string, calendarId: string, eventId: string): Promise<GcalEvent> {
  return ctx.google.request<GcalEvent>(account, SERVICE, { url: encodePath(calendarId, eventId) });
}

/* ---------- Google list shapes ---------- */

interface CalendarListEntry {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  selected?: boolean;
}

interface EventsPage {
  items?: GcalEvent[];
  nextPageToken?: string;
  timeZone?: string;
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: BusyBlock[]; errors?: { domain?: string; reason?: string }[] }>;
}

/* ---------- Tools ---------- */

const listCalendars = defineTool({
  name: 'calendar_list_calendars',
  title: 'List calendars',
  description:
    "Lists the calendars visible to the account (own, subscribed and shared) with id, name, whether it is the primary calendar, your access role (owner/writer/reader/freeBusyReader) and time zone. Use the id as calendar_id in the other calendar tools; 'primary' always works for the main calendar.",
  service: SERVICE,
  inputSchema: { account: accountParam },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async ({ account }, ctx) => {
    const res = await ctx.google.request<{ items?: CalendarListEntry[] }>(account, SERVICE, { url: '/users/me/calendarList', query: { maxResults: 250 } });
    const calendars = (res.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride ?? c.summary,
      primary: c.primary || undefined,
      access_role: c.accessRole,
      time_zone: c.timeZone,
      selected: c.selected || undefined,
      description: c.description,
    }));
    return jsonResult({ calendars });
  },
});

const listEvents = defineTool({
  name: 'calendar_list_events',
  title: 'List or search events',
  description:
    'Lists events in a time window (default: the 7 days from time_min, which defaults to now), expanded to single instances and ordered by start time; optionally filtered by free-text query (matches title, description, location, attendees). Returns compact events (descriptions clipped to 200 chars; use calendar_get_event for the full event) and next_page_token when more exist.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    calendar_id: calendarIdParam,
    time_min: z.string().optional().describe(`Window start: ${dateInputDoc} Default: now.`),
    time_max: z.string().optional().describe(`Window end (exclusive): ${dateInputDoc} Default: time_min + 7 days.`),
    query: z.string().optional().describe('Free-text search (Google matches title, description, location, attendee names/emails).'),
    max_results: z.number().int().min(1).max(100).optional().describe('Events per page, 1-100 (default 25).'),
    page_token: pageTokenParam,
    time_zone: timeZoneParam,
    show_deleted: z.boolean().optional().describe("Include cancelled events with status 'cancelled' (default false)."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    withDateErrors(async () => {
      const timeZone = resolveTimeZone(ctx, args.time_zone);
      const window = timeWindow(args.time_min, args.time_max, timeZone);
      const calendarId = args.calendar_id ?? 'primary';
      const res = await ctx.google.request<EventsPage>(args.account, SERVICE, {
        url: encodePath(calendarId),
        query: {
          // singleEvents expands recurring series into instances; orderBy=startTime is only valid with it.
          singleEvents: true,
          orderBy: 'startTime',
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          q: args.query,
          maxResults: args.max_results ?? 25,
          pageToken: args.page_token,
          timeZone,
          showDeleted: args.show_deleted ?? false,
        },
      });
      const events = (res.items ?? []).map(compactEvent);
      ctx.log.debug('calendar list', { alias: args.account, count: events.length });
      return jsonResult({ calendar_id: calendarId, time_min: window.timeMin, time_max: window.timeMax, time_zone: res.timeZone ?? timeZone, events, next_page_token: res.nextPageToken });
    }),
});

const getEvent = defineTool({
  name: 'calendar_get_event',
  title: 'Get event',
  description:
    'Returns one event in full: times, attendees with their responses, organizer, recurrence rules, reminders, conference links and description as plain text. Long descriptions are clipped to max_chars; when truncated is true, call again with offset=next_offset.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    calendar_id: calendarIdParam,
    event_id: eventIdParam,
    max_chars: maxCharsParam(4000),
    offset: offsetParam,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const event = await fetchEvent(ctx, args.account, args.calendar_id ?? 'primary', args.event_id);
    return jsonResult(eventDetails(event, args.max_chars ?? 4000, args.offset ?? 0));
  },
});

const createEvent = defineTool({
  name: 'calendar_create_event',
  title: 'Create event',
  description:
    'Creates an event and returns it (id, times, html_link, meet_link when add_meet was set). If end is omitted, an all-day event lasts one day and a timed event one hour. Attendees are only emailed when send_updates is not "none".',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    calendar_id: calendarIdParam,
    summary: z.string().min(1).describe('Event title.'),
    start: z.string().describe(`Start: ${dateInputDoc}`),
    ...eventWriteFields,
    send_updates: sendUpdatesParam('none'),
    reviewed_by_user: reviewedByUserParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: (args, ctx) =>
    withDateErrors(async () => {
      const held = (args.send_updates ?? 'none') !== 'none' ? notificationRefusal(ctx, args.attendees ?? [], "Google's invitation", args.reviewed_by_user, 'create it with send_updates: "none"') : undefined;
      if (held) return errorResult(held);
      const timeZone = resolveTimeZone(ctx, args.time_zone);
      const body = buildEventBody(args, timeZone, 'create');
      const created = await ctx.google.request<GcalEvent>(args.account, SERVICE, {
        // Not idempotent: an insert repeated after a timeout would create the event twice.
        method: 'POST',
        url: encodePath(args.calendar_id ?? 'primary'),
        // conferenceDataVersion=1 is required for Google to honour conferenceData in the body.
        query: { sendUpdates: args.send_updates ?? 'none', conferenceDataVersion: 1 },
        body,
      });
      ctx.log.info('calendar event created', { alias: args.account, meet: Boolean(args.add_meet) });
      return jsonResult({ ...compactEvent(created), html_link: created.htmlLink });
    }),
});

const updateEvent = defineTool({
  name: 'calendar_update_event',
  title: 'Update event',
  description:
    'Patches an existing event: only the fields you pass change (attendees and recurrence replace the whole list when given). Returns the updated event. To move an event pass start and end together; passing only one is allowed but must keep the other consistent (Google rejects an end before the start). To turn an all-day event into a timed one or back, pass both start and end in the new form.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    calendar_id: calendarIdParam,
    event_id: eventIdParam,
    summary: z.string().min(1).optional().describe('New event title.'),
    start: z.string().optional().describe(`New start: ${dateInputDoc}`),
    ...eventWriteFields,
    send_updates: sendUpdatesParam('none'),
    reviewed_by_user: reviewedByUserParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    withDateErrors(async () => {
      const timeZone = resolveTimeZone(ctx, args.time_zone);
      const body = buildEventBody(args, timeZone, 'update');
      if (Object.values(body).every((v) => v === undefined)) return errorResult('Nothing to update: pass at least one field to change.');
      if ((args.send_updates ?? 'none') !== 'none' && !args.reviewed_by_user) {
        const attendees = args.attendees ?? (await fetchEvent(ctx, args.account, args.calendar_id ?? 'primary', args.event_id)).attendees?.map((a) => a.email ?? '') ?? [];
        const held = notificationRefusal(ctx, attendees, "Google's update email", false, 'update it with send_updates: "none"');
        if (held) return errorResult(held);
      }
      const updated = await ctx.google.request<GcalEvent>(args.account, SERVICE, {
        method: 'PATCH',
        url: encodePath(args.calendar_id ?? 'primary', args.event_id),
        query: { sendUpdates: args.send_updates ?? 'none', conferenceDataVersion: 1 },
        body,
      });
      ctx.log.info('calendar event updated', { alias: args.account });
      return jsonResult({ ...compactEvent(updated), html_link: updated.htmlLink });
    }),
});

const deleteEvent = defineTool({
  name: 'calendar_delete_event',
  title: 'Delete event',
  description: "Deletes an event. Google keeps it in the calendar's trash for about 30 days, where it can be restored from the Calendar UI. For a recurring series pass the series id to delete all instances, or an instance id for a single occurrence.",
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    calendar_id: calendarIdParam,
    event_id: eventIdParam,
    send_updates: sendUpdatesParam('none'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (args, ctx) => {
    const calendarId = args.calendar_id ?? 'primary';
    await ctx.google.request(args.account, SERVICE, {
      method: 'DELETE',
      url: encodePath(calendarId, args.event_id),
      query: { sendUpdates: args.send_updates ?? 'none' },
    });
    ctx.log.info('calendar event deleted', { alias: args.account });
    return jsonResult({ deleted: true, calendar_id: calendarId, event_id: args.event_id });
  },
});

const respond = defineTool({
  name: 'calendar_respond',
  title: 'Respond to invitation',
  description:
    'Accepts, declines or tentatively accepts an invitation on behalf of the account (the account must be listed as an attendee). Optionally adds a comment for the organizer. By default the organizer is notified (send_updates=all).',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    calendar_id: calendarIdParam,
    event_id: eventIdParam,
    response: z.enum(['accepted', 'declined', 'tentative']).describe('Your RSVP.'),
    comment: z.string().max(1000).optional().describe('Optional note sent with the response.'),
    send_updates: sendUpdatesParam('all'),
    reviewed_by_user: reviewedByUserParam,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const calendarId = args.calendar_id ?? 'primary';
    const event = await fetchEvent(ctx, args.account, calendarId, args.event_id);
    const me = selfAttendee(event);
    if (!me) {
      return errorResult(
        `Account "${args.account}" is not an attendee of this event (${event.attendees?.length ?? 0} attendees, organizer ${event.organizer?.email ?? 'unknown'}), so it cannot respond. Only invited accounts can RSVP; the organizer edits the event instead.`,
      );
    }
    if (args.comment?.trim() && (args.send_updates ?? 'all') !== 'none') {
      const held = notificationRefusal(ctx, [event.organizer?.email ?? ''], 'Your comment to the organizer', args.reviewed_by_user, 'respond without a comment');
      if (held) return errorResult(held);
    }
    // PATCH replaces the attendee list wholesale, so send every attendee with only our row changed.
    const attendees = event.attendees!.map((a) => (a === me ? { ...a, responseStatus: args.response, ...(args.comment !== undefined ? { comment: args.comment } : {}) } : a));
    const updated = await ctx.google.request<GcalEvent>(args.account, SERVICE, {
      method: 'PATCH',
      url: encodePath(calendarId, args.event_id),
      query: { sendUpdates: args.send_updates ?? 'all' },
      body: { attendees },
    });
    ctx.log.info('calendar rsvp', { alias: args.account, response: args.response });
    return jsonResult({ event_id: updated.id ?? args.event_id, summary: updated.summary, my_response: selfAttendee(updated)?.responseStatus ?? args.response });
  },
});

/** What Google's per-calendar free/busy error reasons mean for the user. */
const FREE_BUSY_REASONS: Record<string, string> = {
  notFound:
    'Google has no free/busy data for this calendar: holiday and other subscribed calendars do not publish any, and a person only appears when they share free/busy with this account. calendar_list_events can still read a calendar this account can see.',
  groupTooBig: 'This group has too many members for a free/busy query; ask for the members individually.',
  tooManyCalendarsRequested: 'Too many calendars in one query; ask for fewer.',
};

const freeBusy = defineTool({
  name: 'calendar_free_busy',
  title: 'Check free/busy',
  description:
    'Returns busy blocks per calendar for a window (default: the 7 days from time_min, which defaults to now) plus the free gaps computed across all requested calendars combined. Busy blocks carry no event details. ' +
    'Calendars without free/busy data (holiday calendars, people who do not share it) come back with errors and a note, and are left out of the free gaps.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    time_min: z.string().optional().describe(`Window start: ${dateInputDoc} Default: now.`),
    time_max: z.string().optional().describe(`Window end: ${dateInputDoc} Default: time_min + 7 days.`),
    calendar_ids: z.array(z.string().min(1)).min(1).max(50).optional().describe("Calendar ids (or other people's email addresses that share free/busy with you). Default ['primary']."),
    time_zone: timeZoneParam,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    withDateErrors(async () => {
      const timeZone = resolveTimeZone(ctx, args.time_zone);
      const window = timeWindow(args.time_min, args.time_max, timeZone);
      const ids = args.calendar_ids ?? ['primary'];
      const res = await ctx.google.request<FreeBusyResponse>(args.account, SERVICE, {
        method: 'POST',
        url: '/freeBusy',
        // freeBusy is a POST only because of its body size; it changes nothing, so retrying after a timeout/5xx is safe.
        idempotent: true,
        body: { timeMin: window.timeMin, timeMax: window.timeMax, timeZone, items: ids.map((id) => ({ id })) },
      });
      // One row per requested calendar (as a list so a calendar with no busy blocks still shows up).
      const calendars = ids.map((id) => {
        const entry = res.calendars?.[id];
        const errors = entry?.errors?.map((e) => e.reason ?? e.domain ?? 'error');
        const notes = [...new Set(errors ?? [])].map((reason) => FREE_BUSY_REASONS[reason]).filter(Boolean);
        return { id, busy: entry?.busy, errors, note: notes.length ? notes.join(' ') : undefined };
      });
      const allBusy = calendars.flatMap((c) => c.busy ?? []);
      const free = freeGaps(allBusy, Date.parse(window.timeMin), Date.parse(window.timeMax), timeZone);
      const unknown = calendars.filter((c) => c.errors?.length).map((c) => c.id);
      return jsonResult({
        time_min: window.timeMin,
        time_max: window.timeMax,
        time_zone: timeZone,
        calendars,
        free,
        free_note: unknown.length ? `The free gaps only reflect calendars with free/busy data; ${unknown.join(', ')} could not be checked.` : undefined,
      });
    }),
});

export const calendarTools: ToolDefinition[] = [listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent, respond, freeBusy];
