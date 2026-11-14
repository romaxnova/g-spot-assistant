/**
 * Date handling for the calendar tools.
 *
 * Google Calendar represents event boundaries as either `{ date }` (all-day,
 * end date exclusive) or `{ dateTime, timeZone }`. Claude hands us plain
 * strings: 'YYYY-MM-DD', an ISO datetime with an offset, or a "naive" ISO
 * datetime that must be read in a named time zone. Google accepts a naive
 * dateTime as long as `timeZone` is set, so we never have to compute the
 * offset ourselves for the request body; we only need instants for
 * validation (end after start), for default windows and for free-gap maths.
 */

/** Thrown for user-supplied dates that cannot be parsed. Tools turn it into an errorResult. */
export class DateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateInputError';
  }
}

export type EventDateTime = { date: string } | { dateTime: string; timeZone: string };

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/i;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isAllDay(v: EventDateTime): v is { date: string } {
  return 'date' in v;
}

/** Throws a DateInputError unless `tz` is an IANA zone the runtime knows. */
export function assertTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new DateInputError(`Unknown time zone "${tz}". Use an IANA name such as Europe/Paris or America/New_York.`);
  }
}

/**
 * Parses 'YYYY-MM-DD' into an all-day boundary, and an ISO 8601 datetime into
 * a timed one. A datetime without an offset is interpreted in `timeZone`;
 * one with an offset keeps it (Google still records `timeZone` for recurrence).
 */
export function parseDateInput(value: string, timeZone: string): EventDateTime {
  const raw = value.trim();
  const dateMatch = DATE_RE.exec(raw);
  if (dateMatch) {
    checkCalendarDate(raw, Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
    return { date: raw };
  }
  const m = DATETIME_RE.exec(raw);
  if (!m) {
    throw new DateInputError(
      `Cannot parse date "${value}". Use YYYY-MM-DD for all-day, or an ISO 8601 datetime such as 2026-03-14T09:30:00 (read in ${timeZone}) or 2026-03-14T09:30:00+01:00.`,
    );
  }
  const [, y, mo, d, h, mi, s, offset] = m;
  checkCalendarDate(raw, Number(y), Number(mo), Number(d));
  if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) throw new DateInputError(`Invalid time of day in "${value}".`);
  const wall = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}`;
  return { dateTime: offset ? wall + normalizeOffset(offset) : wall, timeZone };
}

function checkCalendarDate(raw: string, year: number, month: number, day: number): void {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new DateInputError(`"${raw}" is not a real calendar date.`);
  }
}

function normalizeOffset(offset: string): string {
  if (offset.toUpperCase() === 'Z') return 'Z';
  const sign = offset[0];
  const digits = offset.slice(1).replace(':', '');
  return `${sign}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

/** Epoch milliseconds of an event boundary. All-day dates are taken at midnight in `timeZone`. */
export function instantOf(v: EventDateTime, timeZone: string): number {
  if (isAllDay(v)) {
    const [y, m, d] = v.date.split('-').map(Number) as [number, number, number];
    return zonedToEpoch({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timeZone);
  }
  if (OFFSET_RE.test(v.dateTime)) return Date.parse(v.dateTime);
  return zonedToEpoch(wallFromIso(v.dateTime), v.timeZone);
}

/**
 * Same boundary shifted by `ms` of wall-clock time, keeping its shape: all-day
 * stays a date, a naive datetime stays naive, an offset datetime keeps its
 * offset. Used for default ends (start + 1 h, all-day + 1 day).
 */
export function shiftEventDate(v: EventDateTime, ms: number): EventDateTime {
  if (isAllDay(v)) {
    return { date: new Date(Date.parse(`${v.date}T00:00:00Z`) + ms).toISOString().slice(0, 10) };
  }
  const offset = OFFSET_RE.exec(v.dateTime)?.[1];
  const wallIso = offset ? v.dateTime.slice(0, -offset.length) : v.dateTime;
  const shifted = new Date(Date.parse(wallIso + 'Z') + ms).toISOString().slice(0, 19);
  return { dateTime: offset ? shifted + normalizeOffset(offset) : shifted, timeZone: v.timeZone };
}

/** Converts user input (any accepted form) to an RFC 3339 instant rendered in `timeZone`, for timeMin/timeMax. */
export function toRfc3339(value: string, timeZone: string): string {
  return formatInZone(instantOf(parseDateInput(value, timeZone), timeZone), timeZone);
}

/** Formats an instant as 'YYYY-MM-DDTHH:mm:ss+HH:MM' in the given zone. */
export function formatInZone(epochMs: number, timeZone: string): string {
  const offsetMs = tzOffsetMs(epochMs, timeZone);
  const wall = new Date(epochMs + offsetMs).toISOString().slice(0, 19);
  return wall + formatOffset(offsetMs / 60_000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function wallFromIso(iso: string): WallClock {
  const [datePart, timePart = '00:00:00'] = iso.split('T') as [string, string?];
  const [year, month, day] = datePart.split('-').map(Number) as [number, number, number];
  const [hour, minute, second = 0] = timePart.split(':').map(Number) as [number, number, number?];
  return { year, month, day, hour, minute, second };
}

/**
 * Wall-clock time in a zone → epoch. Guess with UTC, correct by the zone's
 * offset at that instant, then re-check once in case the guess straddled a
 * DST transition. Times that do not exist (spring-forward gap) resolve to the
 * instant after the gap, which matches what Google does.
 */
function zonedToEpoch(w: WallClock, timeZone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(first, timeZone);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC at `epochMs`, in milliseconds (positive east of Greenwich). */
export function tzOffsetMs(epochMs: number, timeZone: string): number {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, fmt);
  }
  const whole = Math.floor(epochMs / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(whole))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!);
  return asUtc - whole;
}
