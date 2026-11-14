/**
 * Conversions between Google Calendar's event resource and the compact shapes
 * the calendar tools return, plus request-body building for create/update and
 * the free-gap computation for free/busy.
 */
import { randomUUID } from 'node:crypto';
import { cleanText } from '../text.js';
import { clip } from '../registry.js';
import { DateInputError, DAY_MS, HOUR_MS, formatInZone, instantOf, isAllDay, parseDateInput, shiftEventDate, type EventDateTime } from './calendar-dates.js';

/* ---------- Google resource shapes (only the fields we read) ---------- */

export interface GcalDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GcalPerson {
  email?: string;
  displayName?: string;
  self?: boolean;
}

export interface GcalAttendee extends GcalPerson {
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  resource?: boolean;
  comment?: string;
  additionalGuests?: number;
}

export interface GcalEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  start?: GcalDate;
  end?: GcalDate;
  creator?: GcalPerson;
  organizer?: GcalPerson;
  attendees?: GcalAttendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string; label?: string }[] };
  recurringEventId?: string;
  recurrence?: string[];
  reminders?: { useDefault?: boolean; overrides?: { method?: string; minutes?: number }[] };
  visibility?: string;
  transparency?: string;
  colorId?: string;
}

/* ---------- Output shapes ---------- */

export interface CompactEvent {
  id: string | undefined;
  summary: string | undefined;
  start: string | undefined;
  end: string | undefined;
  /** Present (true) only for all-day events. */
  all_day: true | undefined;
  location: string | undefined;
  status: string | undefined;
  organizer: string | undefined;
  attendee_count: number | undefined;
  my_response: string | undefined;
  meet_link: string | undefined;
  recurring_event_id: string | undefined;
  description: string | undefined;
  description_truncated: true | undefined;
}

const LIST_DESCRIPTION_CHARS = 200;

/** One-line-ish event summary used by list/create/update. */
export function compactEvent(e: GcalEvent): CompactEvent {
  const description = e.description ? clip(plainText(e.description), LIST_DESCRIPTION_CHARS) : undefined;
  return {
    id: e.id,
    summary: e.summary,
    start: boundary(e.start),
    end: boundary(e.end),
    all_day: e.start?.date ? true : undefined,
    location: e.location,
    status: e.status,
    organizer: e.organizer?.email,
    attendee_count: e.attendees?.length,
    my_response: selfAttendee(e)?.responseStatus,
    meet_link: meetLink(e),
    recurring_event_id: e.recurringEventId,
    description: description?.text,
    description_truncated: description?.truncated ? true : undefined,
  };
}

/** Full event for calendar_get_event. The description is clipped to max_chars starting at offset. */
export function eventDetails(e: GcalEvent, maxChars: number, offset: number) {
  const description = clip(plainText(e.description ?? ''), maxChars, offset);
  return {
    id: e.id,
    summary: e.summary,
    description: description.text,
    truncated: description.truncated || undefined,
    total_chars: description.truncated || offset > 0 ? description.totalChars : undefined,
    next_offset: description.nextOffset,
    location: e.location,
    start: boundary(e.start),
    end: boundary(e.end),
    all_day: e.start?.date ? true : undefined,
    time_zone: e.start?.timeZone,
    status: e.status,
    creator: e.creator?.email,
    organizer: e.organizer?.email,
    attendees: e.attendees?.map(compactAttendee),
    recurrence: e.recurrence,
    recurring_event_id: e.recurringEventId,
    reminders: e.reminders && {
      use_default: e.reminders.useDefault,
      overrides: e.reminders.overrides?.map((o) => ({ method: o.method, minutes: o.minutes })),
    },
    conference: e.conferenceData?.entryPoints?.map((p) => ({ type: p.entryPointType, uri: p.uri, label: p.label })),
    html_link: e.htmlLink,
    created: e.created,
    updated: e.updated,
    visibility: e.visibility,
    transparency: e.transparency,
  };
}

function compactAttendee(a: GcalAttendee) {
  return {
    email: a.email,
    display_name: a.displayName,
    response_status: a.responseStatus,
    optional: a.optional || undefined,
    organizer: a.organizer || undefined,
    self: a.self || undefined,
    resource: a.resource || undefined,
    comment: a.comment,
  };
}

/** Google marks the linked account's own row with self=true; that is the row calendar_respond edits. */
export function selfAttendee(e: GcalEvent): GcalAttendee | undefined {
  return e.attendees?.find((a) => a.self === true);
}

function boundary(d: GcalDate | undefined): string | undefined {
  return d?.date ?? d?.dateTime;
}

function meetLink(e: GcalEvent): string | undefined {
  return e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
}

/** Descriptions are often HTML (Google's editor and Meet invites produce it); keep the text only. */
export function plainText(text: string): string {
  if (!/<[a-z!/]/i.test(text)) return cleanText(text);
  const stripped = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return cleanText(stripped);
}

/* ---------- Request bodies ---------- */

export interface ReminderOverride {
  method: 'popup' | 'email';
  minutes: number;
}

/** Fields shared by calendar_create_event and calendar_update_event (all optional there). */
export interface EventFields {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  recurrence?: string[];
  reminders?: { use_default?: boolean; overrides?: ReminderOverride[] };
  add_meet?: boolean;
  visibility?: 'default' | 'public' | 'private';
  color_id?: string;
}

/**
 * Boundary shape for PATCH. Calendar's PATCH merges nested objects field by
 * field, so switching an all-day event to a timed one (or back) has to null
 * out the fields of the old form explicitly; otherwise the stored `date` and
 * the new `dateTime` coexist and Google rejects the event. JSON.stringify
 * keeps nulls (it drops undefined), which is why these are null.
 */
export type PatchEventDateTime = { date: string; dateTime: null; timeZone: null } | { date: null; dateTime: string; timeZone: string };

export interface EventBody {
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime | PatchEventDateTime;
  end?: EventDateTime | PatchEventDateTime;
  attendees?: { email: string }[];
  recurrence?: string[];
  reminders?: { useDefault: boolean; overrides?: ReminderOverride[] };
  visibility?: string;
  colorId?: string;
  conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } } };
}

/**
 * Builds the JSON body for insert ('create') or patch ('update') from the tool
 * arguments, sending only the fields Claude supplied. On create a missing end
 * is derived from start (all-day: next day, since Google's all-day end is
 * exclusive; timed: +1 h). On update, boundaries are sent in the PATCH shape
 * (see PatchEventDateTime). Throws DateInputError for unparsable or
 * inconsistent dates.
 */
export function buildEventBody(fields: EventFields, timeZone: string, mode: 'create' | 'update'): EventBody {
  const body: EventBody = {
    summary: fields.summary,
    description: fields.description,
    location: fields.location,
    recurrence: fields.recurrence,
    visibility: fields.visibility,
    colorId: fields.color_id,
  };
  const start = fields.start === undefined ? undefined : parseDateInput(fields.start, timeZone);
  let end = fields.end === undefined ? undefined : parseDateInput(fields.end, timeZone);
  if (start && !end && mode === 'create') end = shiftEventDate(start, isAllDay(start) ? DAY_MS : HOUR_MS);
  if (start && end) checkRange(start, end, timeZone);
  const shape = mode === 'update' ? forPatch : (v: EventDateTime) => v;
  if (start) body.start = shape(start);
  if (end) body.end = shape(end);

  if (fields.attendees) body.attendees = fields.attendees.map((email) => ({ email }));
  if (fields.reminders) {
    const overrides = fields.reminders.overrides;
    // Google rejects overrides together with useDefault=true, so overrides imply useDefault=false.
    body.reminders = { useDefault: fields.reminders.use_default ?? !overrides?.length, overrides };
  }
  if (fields.add_meet) {
    // requestId must be unique per create request; Google de-duplicates on it.
    body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  return body;
}

function forPatch(v: EventDateTime): PatchEventDateTime {
  return isAllDay(v) ? { date: v.date, dateTime: null, timeZone: null } : { date: null, dateTime: v.dateTime, timeZone: v.timeZone };
}

function checkRange(start: EventDateTime, end: EventDateTime, timeZone: string): void {
  if (isAllDay(start) !== isAllDay(end)) {
    throw new DateInputError('start and end must both be all-day dates (YYYY-MM-DD) or both be datetimes.');
  }
  if (instantOf(end, timeZone) <= instantOf(start, timeZone)) {
    throw new DateInputError(
      isAllDay(start)
        ? 'end must be after start. For all-day events the end date is exclusive: a one-day event on 2026-03-14 ends on 2026-03-15.'
        : 'end must be after start.',
    );
  }
}

/* ---------- Free/busy ---------- */

export interface BusyBlock {
  start: string;
  end: string;
}

/**
 * Gaps inside [windowStart, windowEnd] not covered by any busy block from any
 * calendar (blocks are merged first, so overlapping calendars do not create
 * phantom gaps). Boundaries are rendered in `timeZone`.
 */
export function freeGaps(busy: BusyBlock[], windowStart: number, windowEnd: number, timeZone: string): BusyBlock[] {
  const blocks = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const gaps: BusyBlock[] = [];
  let cursor = windowStart;
  for (const b of blocks) {
    if (b.start > cursor) gaps.push({ start: formatInZone(cursor, timeZone), end: formatInZone(Math.min(b.start, windowEnd), timeZone) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) gaps.push({ start: formatInZone(cursor, timeZone), end: formatInZone(windowEnd, timeZone) });
  return gaps.filter((g) => g.start !== g.end);
}
