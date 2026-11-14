import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateInputError, DAY_MS, HOUR_MS, assertTimeZone, formatInZone, instantOf, parseDateInput, shiftEventDate, toRfc3339, tzOffsetMs } from './calendar-dates.js';
import { buildEventBody, freeGaps, plainText } from './calendar-events.js';

const TZ = 'Europe/Paris';

test('parseDateInput: all-day date', () => {
  assert.deepEqual(parseDateInput('2026-03-14', TZ), { date: '2026-03-14' });
  assert.deepEqual(parseDateInput('  2026-03-14 ', TZ), { date: '2026-03-14' });
});

test('parseDateInput: datetime with offset keeps the offset and normalizes it', () => {
  assert.deepEqual(parseDateInput('2026-03-14T09:30:00+01:00', TZ), { dateTime: '2026-03-14T09:30:00+01:00', timeZone: TZ });
  assert.deepEqual(parseDateInput('2026-03-14T09:30+0100', TZ), { dateTime: '2026-03-14T09:30:00+01:00', timeZone: TZ });
  assert.deepEqual(parseDateInput('2026-03-14T09:30:00.250Z', TZ), { dateTime: '2026-03-14T09:30:00Z', timeZone: TZ });
  assert.deepEqual(parseDateInput('2026-03-14T09:30:00z', TZ), { dateTime: '2026-03-14T09:30:00Z', timeZone: TZ });
});

test('parseDateInput: naive datetime is tagged with the zone', () => {
  assert.deepEqual(parseDateInput('2026-03-14T09:30', TZ), { dateTime: '2026-03-14T09:30:00', timeZone: TZ });
  assert.deepEqual(parseDateInput('2026-03-14 09:30:15', 'America/New_York'), { dateTime: '2026-03-14T09:30:15', timeZone: 'America/New_York' });
});

test('parseDateInput: rejects garbage, impossible dates and times', () => {
  for (const bad of ['tomorrow', '14/03/2026', '2026-02-30', '2026-13-01', '2026-03-14T25:00', '2026-03-14T09:60', '', '2026-3-4']) {
    assert.throws(() => parseDateInput(bad, TZ), DateInputError, bad);
  }
});

test('assertTimeZone accepts IANA names and rejects unknown ones', () => {
  assert.equal(assertTimeZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(assertTimeZone('UTC'), 'UTC');
  assert.throws(() => assertTimeZone('Mars/Olympus'), /Unknown time zone/);
});

test('tzOffsetMs and instantOf respect DST', () => {
  assert.equal(tzOffsetMs(Date.parse('2026-07-01T12:00:00Z'), TZ), 2 * HOUR_MS);
  assert.equal(tzOffsetMs(Date.parse('2026-01-01T12:00:00Z'), TZ), HOUR_MS);
  assert.equal(tzOffsetMs(Date.parse('2026-01-01T12:00:00Z'), 'America/New_York'), -5 * HOUR_MS);
  // 09:00 wall clock in Paris in summer is 07:00Z, in winter 08:00Z.
  assert.equal(instantOf({ dateTime: '2026-07-01T09:00:00', timeZone: TZ }, TZ), Date.parse('2026-07-01T07:00:00Z'));
  assert.equal(instantOf({ dateTime: '2026-01-15T09:00:00', timeZone: TZ }, TZ), Date.parse('2026-01-15T08:00:00Z'));
  // Explicit offset wins over the zone.
  assert.equal(instantOf({ dateTime: '2026-07-01T09:00:00-04:00', timeZone: TZ }, TZ), Date.parse('2026-07-01T13:00:00Z'));
  // All-day = midnight in the zone.
  assert.equal(instantOf({ date: '2026-07-01' }, TZ), Date.parse('2026-06-30T22:00:00Z'));
});

test('instantOf: wall time on the day of the spring-forward transition', () => {
  // Paris switches at 02:00 → 03:00 on 2026-03-29. 04:00 local is 02:00Z.
  assert.equal(instantOf({ dateTime: '2026-03-29T04:00:00', timeZone: TZ }, TZ), Date.parse('2026-03-29T02:00:00Z'));
  // 01:30 local is still winter time: 00:30Z.
  assert.equal(instantOf({ dateTime: '2026-03-29T01:30:00', timeZone: TZ }, TZ), Date.parse('2026-03-29T00:30:00Z'));
});

test('formatInZone renders with the zone offset', () => {
  assert.equal(formatInZone(Date.parse('2026-07-01T07:00:00Z'), TZ), '2026-07-01T09:00:00+02:00');
  assert.equal(formatInZone(Date.parse('2026-01-15T08:00:00Z'), TZ), '2026-01-15T09:00:00+01:00');
  assert.equal(formatInZone(Date.parse('2026-01-15T08:00:00Z'), 'America/New_York'), '2026-01-15T03:00:00-05:00');
  assert.equal(formatInZone(Date.parse('2026-01-15T08:00:00Z'), 'Asia/Kolkata'), '2026-01-15T13:30:00+05:30');
  assert.equal(formatInZone(Date.parse('2026-01-15T08:00:00Z'), 'UTC'), '2026-01-15T08:00:00+00:00');
});

test('toRfc3339 accepts every input form', () => {
  assert.equal(toRfc3339('2026-07-01', TZ), '2026-07-01T00:00:00+02:00');
  assert.equal(toRfc3339('2026-07-01T09:00', TZ), '2026-07-01T09:00:00+02:00');
  assert.equal(toRfc3339('2026-07-01T09:00:00Z', TZ), '2026-07-01T11:00:00+02:00');
});

test('shiftEventDate keeps the shape of the boundary', () => {
  assert.deepEqual(shiftEventDate({ date: '2026-12-31' }, DAY_MS), { date: '2027-01-01' });
  assert.deepEqual(shiftEventDate({ dateTime: '2026-03-14T23:30:00', timeZone: TZ }, HOUR_MS), { dateTime: '2026-03-15T00:30:00', timeZone: TZ });
  assert.deepEqual(shiftEventDate({ dateTime: '2026-03-14T09:00:00+05:30', timeZone: TZ }, HOUR_MS), { dateTime: '2026-03-14T10:00:00+05:30', timeZone: TZ });
  assert.deepEqual(shiftEventDate({ dateTime: '2026-03-14T09:00:00Z', timeZone: TZ }, HOUR_MS), { dateTime: '2026-03-14T10:00:00Z', timeZone: TZ });
});

test('buildEventBody: defaults the end and sends only given fields', () => {
  assert.deepEqual(buildEventBody({ summary: 'Lunch', start: '2026-03-14T12:00' }, TZ, 'create'), {
    summary: 'Lunch',
    description: undefined,
    location: undefined,
    recurrence: undefined,
    visibility: undefined,
    colorId: undefined,
    start: { dateTime: '2026-03-14T12:00:00', timeZone: TZ },
    end: { dateTime: '2026-03-14T13:00:00', timeZone: TZ },
  });
  const allDay = buildEventBody({ start: '2026-03-14' }, TZ, 'create');
  assert.deepEqual(allDay.start, { date: '2026-03-14' });
  assert.deepEqual(allDay.end, { date: '2026-03-15' });
});

test('buildEventBody: update mode sends no default end and nulls the unused boundary fields', () => {
  // PATCH merges nested objects, so the fields of the other form must be null to clear them.
  const allDay = buildEventBody({ start: '2026-03-14' }, TZ, 'update');
  assert.deepEqual(allDay.start, { date: '2026-03-14', dateTime: null, timeZone: null });
  assert.equal(allDay.end, undefined);
  const timed = buildEventBody({ start: '2026-03-14T12:00', end: '2026-03-14T13:00+01:00' }, TZ, 'update');
  assert.deepEqual(timed.start, { date: null, dateTime: '2026-03-14T12:00:00', timeZone: TZ });
  assert.deepEqual(timed.end, { date: null, dateTime: '2026-03-14T13:00:00+01:00', timeZone: TZ });
  // Nulls survive serialization (undefined would not), which is what makes the PATCH work.
  assert.equal(JSON.stringify(allDay.start), '{"date":"2026-03-14","dateTime":null,"timeZone":null}');
  // Range validation applies in update mode too.
  assert.throws(() => buildEventBody({ start: '2026-03-14', end: '2026-03-14T18:00' }, TZ, 'update'), /both be all-day/);
});

test('buildEventBody: attendees, reminders, meet and validation', () => {
  const body = buildEventBody(
    { attendees: ['a@example.com'], reminders: { overrides: [{ method: 'popup', minutes: 10 }] }, add_meet: true, visibility: 'private', color_id: '7' },
    TZ,
    'update',
  );
  assert.deepEqual(body.attendees, [{ email: 'a@example.com' }]);
  assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
  assert.equal(body.conferenceData?.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.match(body.conferenceData!.createRequest.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(body.visibility, 'private');
  assert.equal(body.colorId, '7');
  assert.deepEqual(buildEventBody({ reminders: { use_default: true } }, TZ, 'update').reminders, { useDefault: true, overrides: undefined });

  assert.throws(() => buildEventBody({ start: '2026-03-14T12:00', end: '2026-03-14T11:00' }, TZ, 'create'), /end must be after start/);
  assert.throws(() => buildEventBody({ start: '2026-03-14', end: '2026-03-14' }, TZ, 'create'), /exclusive/);
  assert.throws(() => buildEventBody({ start: '2026-03-14', end: '2026-03-14T18:00' }, TZ, 'create'), /both be all-day/);
  // Explicit offset vs naive compare as instants: 11:00+05:30 is 07:30 in Paris (summer), before an 08:00 start.
  assert.throws(() => buildEventBody({ start: '2026-07-01T08:00', end: '2026-07-01T11:00+05:30' }, TZ, 'create'), /end must be after start/);
  // ...while 12:00+05:30 (08:30 Paris) is fine.
  assert.ok(buildEventBody({ start: '2026-07-01T08:00', end: '2026-07-01T12:00+05:30' }, TZ, 'create').end);
});

test('plainText strips HTML only when present', () => {
  assert.equal(plainText('plain & simple'), 'plain & simple');
  assert.equal(plainText('<p>Hello<br>world</p><p>Join: <a href="https://x">link</a> &amp; more</p>'), 'Hello\nworld\nJoin: link & more');
});

test('freeGaps merges overlapping busy blocks and clamps to the window', () => {
  const start = Date.parse('2026-07-01T07:00:00Z'); // 09:00 Paris
  const end = Date.parse('2026-07-01T16:00:00Z'); // 18:00 Paris
  const gaps = freeGaps(
    [
      { start: '2026-07-01T10:00:00Z', end: '2026-07-01T11:00:00Z' },
      { start: '2026-07-01T06:00:00Z', end: '2026-07-01T08:00:00Z' }, // starts before the window
      { start: '2026-07-01T10:30:00Z', end: '2026-07-01T12:00:00Z' }, // overlaps the first
      { start: '2026-07-01T15:00:00Z', end: '2026-07-01T17:00:00Z' }, // runs past the window
    ],
    start,
    end,
    TZ,
  );
  assert.deepEqual(gaps, [
    { start: '2026-07-01T10:00:00+02:00', end: '2026-07-01T12:00:00+02:00' },
    { start: '2026-07-01T14:00:00+02:00', end: '2026-07-01T17:00:00+02:00' },
  ]);
  assert.deepEqual(freeGaps([], start, end, TZ), [{ start: '2026-07-01T09:00:00+02:00', end: '2026-07-01T18:00:00+02:00' }]);
  assert.deepEqual(freeGaps([{ start: '2026-07-01T00:00:00Z', end: '2026-07-02T00:00:00Z' }], start, end, TZ), []);
});
