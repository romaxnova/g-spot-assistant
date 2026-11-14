import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as z from 'zod';
import { apiCalls, createTestContext, resultJson, resultText, type FakeGoogle, type TestContext } from '../../test-support.js';
import type { ToolContext, ToolDefinition } from '../registry.js';
import { calendarTools } from './calendar.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

function tool(name: string): ToolDefinition {
  const def = calendarTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return tool(name).handler(args, ctx);
}

function lastCall(ctx: TestContext) {
  const calls = apiCalls(ctx);
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no API call recorded');
  return call;
}

const timedEvent = {
  kind: 'calendar#event',
  etag: '"x"',
  id: 'evt1',
  summary: 'Standup',
  description: '<p>Daily <b>sync</b></p>',
  location: 'Room 1',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  created: '2026-03-01T10:00:00.000Z',
  updated: '2026-03-02T10:00:00.000Z',
  start: { dateTime: '2026-03-14T09:30:00+01:00', timeZone: 'Europe/Paris' },
  end: { dateTime: '2026-03-14T10:00:00+01:00', timeZone: 'Europe/Paris' },
  creator: { email: 'boss@example.com' },
  organizer: { email: 'boss@example.com', displayName: 'Boss' },
  attendees: [
    { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
    { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
    { email: 'guest@example.com', optional: true, responseStatus: 'declined', comment: 'sorry' },
  ],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij', label: 'meet.google.com/abc-defg-hij' }] },
  recurringEventId: 'evt1_series',
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
  visibility: 'default',
  transparency: 'opaque',
};

const allDayEvent = {
  id: 'evt2',
  summary: 'Holiday',
  status: 'confirmed',
  start: { date: '2026-03-16' },
  end: { date: '2026-03-17' },
  organizer: { email: 'me@example.com', self: true },
};

test('tool inventory: names, service and honest annotations', () => {
  const byName = Object.fromEntries(calendarTools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'calendar_create_event',
    'calendar_delete_event',
    'calendar_free_busy',
    'calendar_get_event',
    'calendar_list_calendars',
    'calendar_list_events',
    'calendar_respond',
    'calendar_update_event',
  ]);
  for (const t of calendarTools) {
    assert.equal(t.service, 'calendar', t.name);
    assert.ok(t.inputSchema['account'], `${t.name} has account param`);
    assert.ok(t.title && t.description.length > 40, t.name);
  }
  const readOnly = ['calendar_list_calendars', 'calendar_list_events', 'calendar_get_event', 'calendar_free_busy'];
  for (const t of calendarTools) {
    assert.equal(t.annotations.readOnlyHint, readOnly.includes(t.name), `${t.name} readOnlyHint`);
    assert.equal(t.annotations.destructiveHint, t.name === 'calendar_delete_event', `${t.name} destructiveHint`);
  }
  assert.equal(byName['calendar_update_event']!.annotations.idempotentHint, true);
  assert.equal(byName['calendar_create_event']!.annotations.idempotentHint, false);
  // Deleted events sit in the calendar's trash for ~30 days; the description must not call that "permanent".
  const del = byName['calendar_delete_event']!.description;
  assert.doesNotMatch(del, /permanent/i);
  assert.match(del, /trash for about 30 days/);
  for (const name of ['calendar_list_events', 'calendar_free_busy']) {
    assert.match((byName[name]!.inputSchema['time_max'] as z.ZodType).description ?? '', /Default: time_min \+ 7 days/, `${name} time_max default`);
  }
});

test('account without calendar access yields an error that mentions re-linking', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'work', services: ['gmail'] }] });
  await assert.rejects(run('calendar_list_calendars', { account: 'work' }, ctx), /Re-link it with Google Calendar/);
  await assert.rejects(run('calendar_list_events', { account: 'work' }, ctx), /not granted Google Calendar.*Re-link/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('calendar_list_calendars maps the calendar list', async () => {
  const ctx = createTestContext({
    google: () => ({
      json: {
        items: [
          { kind: 'calendar#calendarListEntry', etag: '"1"', id: 'me@example.com', summary: 'me@example.com', primary: true, accessRole: 'owner', timeZone: 'Europe/Paris', selected: true },
          { id: 'home@group.calendar.google.com', summary: 'Household', summaryOverride: 'Home', accessRole: 'writer', timeZone: 'Europe/Paris', description: 'shared' },
          { id: 'ro@group.calendar.google.com', summary: 'Holidays', accessRole: 'reader', timeZone: 'UTC', selected: false },
        ],
      },
    }),
  });
  const out = resultJson(await run('calendar_list_calendars', { account: 'me' }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.href, `${BASE}/users/me/calendarList?maxResults=250`);
  assert.deepEqual(out, {
    calendars: [
      { id: 'me@example.com', summary: 'me@example.com', primary: true, access_role: 'owner', time_zone: 'Europe/Paris', selected: true },
      { id: 'home@group.calendar.google.com', summary: 'Home', access_role: 'writer', time_zone: 'Europe/Paris', description: 'shared' },
      { id: 'ro@group.calendar.google.com', summary: 'Holidays', access_role: 'reader', time_zone: 'UTC' },
    ],
  });
});

test('calendar_list_events: query params, compact events and paging', async () => {
  const ctx = createTestContext({ google: () => ({ json: { items: [timedEvent, allDayEvent], nextPageToken: 'tok2', timeZone: 'Europe/Paris' } }) });
  const out = resultJson(await run(
    'calendar_list_events',
    { account: 'me', calendar_id: 'home@group.calendar.google.com', time_min: '2026-03-14', time_max: '2026-03-21T18:00', query: 'sync', max_results: 50, page_token: 'tok1', show_deleted: true },
    ctx,
  ));
  const call = lastCall(ctx);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.pathname, '/calendar/v3/calendars/home%40group.calendar.google.com/events');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), {
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: '2026-03-14T00:00:00+01:00',
    timeMax: '2026-03-21T18:00:00+01:00',
    q: 'sync',
    maxResults: '50',
    pageToken: 'tok1',
    timeZone: 'Europe/Paris',
    showDeleted: 'true',
  });
  assert.deepEqual(out, {
    calendar_id: 'home@group.calendar.google.com',
    time_min: '2026-03-14T00:00:00+01:00',
    time_max: '2026-03-21T18:00:00+01:00',
    time_zone: 'Europe/Paris',
    events: [
      {
        id: 'evt1',
        summary: 'Standup',
        start: '2026-03-14T09:30:00+01:00',
        end: '2026-03-14T10:00:00+01:00',
        location: 'Room 1',
        status: 'confirmed',
        organizer: 'boss@example.com',
        attendee_count: 3,
        my_response: 'needsAction',
        meet_link: 'https://meet.google.com/abc-defg-hij',
        recurring_event_id: 'evt1_series',
        description: 'Daily sync',
      },
      { id: 'evt2', summary: 'Holiday', start: '2026-03-16', end: '2026-03-17', all_day: true, status: 'confirmed', organizer: 'me@example.com' },
    ],
    next_page_token: 'tok2',
  });
});

test('calendar_list_events: defaults to now → +7 days, primary calendar, 25 results, server zone', async () => {
  const ctx = createTestContext({ google: () => ({ json: { items: [] } }) });
  const before = Date.now();
  const out = resultJson<{ time_min: string; time_max: string; time_zone: string }>(await run('calendar_list_events', { account: 'me' }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.url.pathname, '/calendar/v3/calendars/primary/events');
  const q = Object.fromEntries(call.url.searchParams);
  assert.equal(q['maxResults'], '25');
  assert.equal(q['showDeleted'], 'false');
  assert.equal(q['timeZone'], 'Europe/Paris');
  assert.equal(q['q'], undefined);
  assert.equal(q['pageToken'], undefined);
  assert.ok(Math.abs(Date.parse(q['timeMin']!) - before) < 5_000, 'timeMin ≈ now');
  assert.ok(Math.abs(Date.parse(q['timeMax']!) - (before + 7 * 86_400_000)) < 5_000, 'timeMax ≈ now + 7d');
  assert.match(out.time_min, /[+-]\d{2}:\d{2}$/);
  assert.equal(out.time_zone, 'Europe/Paris');
});

test('calendar_list_events: a future time_min without time_max lists the week starting there', async () => {
  const ctx = createTestContext({ google: () => ({ json: { items: [] } }) });
  const timeMin = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const out = resultJson<{ time_min: string; time_max: string }>(await run('calendar_list_events', { account: 'me', time_min: timeMin }, ctx));
  assert.equal(out.time_min.slice(0, 10), timeMin, 'window starts at the given day');
  assert.equal(Date.parse(out.time_max) - Date.parse(out.time_min), 7 * 86_400_000, 'window ends 7 days after time_min, not after now');
  const q = Object.fromEntries(lastCall(ctx).url.searchParams);
  assert.equal(q['timeMin'], out.time_min);
  assert.equal(q['timeMax'], out.time_max);
});

test('calendar_list_events: clips long descriptions and flags it', async () => {
  const ctx = createTestContext({ google: () => ({ json: { items: [{ id: 'e', summary: 'Long', description: 'x'.repeat(500), start: { date: '2026-01-01' }, end: { date: '2026-01-02' } }] } }) });
  const out = resultJson<{ events: { description: string; description_truncated?: boolean }[] }>(await run('calendar_list_events', { account: 'me' }, ctx));
  assert.equal(out.events[0]!.description.length, 200);
  assert.equal(out.events[0]!.description_truncated, true);
});

test('calendar_list_events: bad dates and zones are validation errors, not crashes', async () => {
  const ctx = createTestContext();
  const bad = await run('calendar_list_events', { account: 'me', time_min: 'next tuesday' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad), /Cannot parse date "next tuesday"/);
  const zone = await run('calendar_list_events', { account: 'me', time_zone: 'Nowhere/City' }, ctx);
  assert.equal(zone.isError, true);
  assert.match(resultText(zone), /Unknown time zone/);
  const order = await run('calendar_list_events', { account: 'me', time_min: '2026-03-20', time_max: '2026-03-14' }, ctx);
  assert.equal(order.isError, true);
  assert.match(resultText(order), /time_max must be after time_min/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('calendar_get_event returns the full event with attendees and clipped description', async () => {
  const ctx = createTestContext({ google: () => ({ json: timedEvent }) });
  const out = resultJson(await run('calendar_get_event', { account: 'me', event_id: 'evt1' }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.href, `${BASE}/calendars/primary/events/evt1`);
  assert.deepEqual(out, {
    id: 'evt1',
    summary: 'Standup',
    description: 'Daily sync',
    location: 'Room 1',
    start: '2026-03-14T09:30:00+01:00',
    end: '2026-03-14T10:00:00+01:00',
    time_zone: 'Europe/Paris',
    status: 'confirmed',
    creator: 'boss@example.com',
    organizer: 'boss@example.com',
    attendees: [
      { email: 'boss@example.com', response_status: 'accepted', organizer: true },
      { email: 'me@example.com', response_status: 'needsAction', self: true },
      { email: 'guest@example.com', response_status: 'declined', optional: true, comment: 'sorry' },
    ],
    recurring_event_id: 'evt1_series',
    reminders: { use_default: false, overrides: [{ method: 'popup', minutes: 10 }] },
    conference: [{ type: 'video', uri: 'https://meet.google.com/abc-defg-hij', label: 'meet.google.com/abc-defg-hij' }],
    html_link: 'https://www.google.com/calendar/event?eid=abc',
    created: '2026-03-01T10:00:00.000Z',
    updated: '2026-03-02T10:00:00.000Z',
    visibility: 'default',
    transparency: 'opaque',
  });
});

test('calendar_get_event pages through a long description with max_chars/offset', async () => {
  const description = 'a'.repeat(300) + 'b'.repeat(300);
  const ctx = createTestContext({ google: () => ({ json: { ...allDayEvent, description } }) });
  const first = resultJson<Record<string, unknown>>(await run('calendar_get_event', { account: 'me', calendar_id: 'x@y.z', event_id: 'a_b/c', max_chars: 400 }, ctx));
  assert.equal(lastCall(ctx).url.pathname, '/calendar/v3/calendars/x%40y.z/events/a_b%2Fc');
  assert.equal((first['description'] as string).length, 400);
  assert.equal(first['truncated'], true);
  assert.equal(first['total_chars'], 600);
  assert.equal(first['next_offset'], 400);
  assert.equal(first['all_day'], true);
  const second = resultJson<Record<string, unknown>>(await run('calendar_get_event', { account: 'me', event_id: 'evt2', max_chars: 400, offset: 400 }, ctx));
  assert.equal(second['description'], 'b'.repeat(200));
  assert.equal(second['truncated'], undefined);
  assert.equal(second['total_chars'], 600);
  assert.equal(second['next_offset'], undefined);
});

test('calendar_create_event posts the body with defaults and returns the compact event', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: { ...timedEvent, id: 'new1', ...(c.json as object) } }) });
  const out = resultJson<Record<string, unknown>>(await run(
    'calendar_create_event',
    { account: 'me', summary: 'Lunch', start: '2026-03-14T12:00', location: 'Cafe', attendees: ['a@example.com'], reminders: { overrides: [{ method: 'email', minutes: 30 }] } },
    ctx,
  ));
  const call = lastCall(ctx);
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/calendar/v3/calendars/primary/events');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { sendUpdates: 'none', conferenceDataVersion: '1' });
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.json, {
    summary: 'Lunch',
    location: 'Cafe',
    start: { dateTime: '2026-03-14T12:00:00', timeZone: 'Europe/Paris' },
    end: { dateTime: '2026-03-14T13:00:00', timeZone: 'Europe/Paris' },
    attendees: [{ email: 'a@example.com' }],
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 30 }] },
  });
  assert.equal(out['id'], 'new1');
  assert.equal(out['summary'], 'Lunch');
  assert.equal(out['html_link'], 'https://www.google.com/calendar/event?eid=abc');
  assert.equal(out['meet_link'], 'https://meet.google.com/abc-defg-hij');
});

test('calendar_create_event: all-day, explicit zone, meet, recurrence, send_updates', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: { id: 'new2', ...(c.json as object) } }) });
  await run(
    'calendar_create_event',
    {
      account: 'me',
      calendar_id: 'home@group.calendar.google.com',
      summary: 'Trip',
      start: '2026-04-01',
      end: '2026-04-04',
      time_zone: 'America/New_York',
      add_meet: true,
      recurrence: ['RRULE:FREQ=YEARLY'],
      send_updates: 'all',
      visibility: 'private',
      color_id: '3',
      description: 'Pack',
    },
    ctx,
  );
  const call = lastCall(ctx);
  assert.equal(call.url.pathname, '/calendar/v3/calendars/home%40group.calendar.google.com/events');
  assert.equal(call.url.searchParams.get('sendUpdates'), 'all');
  const body = call.json as Record<string, unknown>;
  assert.deepEqual(body['start'], { date: '2026-04-01' });
  assert.deepEqual(body['end'], { date: '2026-04-04' });
  assert.deepEqual(body['recurrence'], ['RRULE:FREQ=YEARLY']);
  assert.equal(body['visibility'], 'private');
  assert.equal(body['colorId'], '3');
  assert.equal(body['description'], 'Pack');
  const conf = body['conferenceData'] as { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } };
  assert.equal(conf.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.ok(conf.createRequest.requestId.length >= 16);
});

test('calendar_create_event rejects inconsistent dates before calling Google', async () => {
  const ctx = createTestContext();
  const r1 = await run('calendar_create_event', { account: 'me', summary: 'x', start: '2026-03-14T12:00', end: '2026-03-14T12:00' }, ctx);
  assert.equal(r1.isError, true);
  assert.match(resultText(r1), /end must be after start/);
  const r2 = await run('calendar_create_event', { account: 'me', summary: 'x', start: '2026-03-14', end: '2026-03-14T15:00' }, ctx);
  assert.equal(r2.isError, true);
  assert.match(resultText(r2), /both be all-day/);
  assert.equal(apiCalls(ctx).length, 0);
});

test('calendar_update_event patches only the given fields', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: { ...timedEvent, ...(c.json as object) } }) });
  const out = resultJson<Record<string, unknown>>(await run('calendar_update_event', { account: 'me', event_id: 'evt1', summary: 'Standup (moved)', start: '2026-03-14T10:00:00+01:00', end: '2026-03-14T10:30:00+01:00', send_updates: 'externalOnly' }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url.pathname, '/calendar/v3/calendars/primary/events/evt1');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { sendUpdates: 'externalOnly', conferenceDataVersion: '1' });
  assert.deepEqual(call.json, {
    summary: 'Standup (moved)',
    start: { date: null, dateTime: '2026-03-14T10:00:00+01:00', timeZone: 'Europe/Paris' },
    end: { date: null, dateTime: '2026-03-14T10:30:00+01:00', timeZone: 'Europe/Paris' },
  });
  assert.equal(out['summary'], 'Standup (moved)');
  assert.equal(out['start'], '2026-03-14T10:00:00+01:00');
  assert.equal(out['html_link'], timedEvent.htmlLink);
});

test('calendar_update_event: a lone end is sent without inventing a start; empty patch is refused', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: { ...timedEvent, ...(c.json as object) } }) });
  await run('calendar_update_event', { account: 'me', event_id: 'evt1', end: '2026-03-14T11:00' }, ctx);
  assert.deepEqual(lastCall(ctx).json, { end: { date: null, dateTime: '2026-03-14T11:00:00', timeZone: 'Europe/Paris' } });
  await run('calendar_update_event', { account: 'me', event_id: 'evt1', attendees: [] , reminders: { use_default: true } }, ctx);
  assert.deepEqual(lastCall(ctx).json, { attendees: [], reminders: { useDefault: true } });
  const calls = apiCalls(ctx).length;
  const empty = await run('calendar_update_event', { account: 'me', event_id: 'evt1' }, ctx);
  assert.equal(empty.isError, true);
  assert.match(resultText(empty), /Nothing to update/);
  assert.equal(apiCalls(ctx).length, calls);
});

test('calendar_update_event converts between all-day and timed by nulling the other form (PATCH merges nested objects)', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: { ...timedEvent, ...(c.json as object) } }) });
  // Timed → all-day: the stored dateTime/timeZone must be cleared or Google keeps them next to `date`.
  await run('calendar_update_event', { account: 'me', event_id: 'evt1', start: '2026-03-16', end: '2026-03-17' }, ctx);
  assert.equal(lastCall(ctx).method, 'PATCH');
  assert.equal(lastCall(ctx).body, JSON.stringify({ start: { date: '2026-03-16', dateTime: null, timeZone: null }, end: { date: '2026-03-17', dateTime: null, timeZone: null } }));
  // All-day → timed: the stored `date` must be cleared.
  await run('calendar_update_event', { account: 'me', event_id: 'evt2', start: '2026-03-16T09:00', end: '2026-03-16T10:00', time_zone: 'America/New_York' }, ctx);
  assert.deepEqual(lastCall(ctx).json, {
    start: { date: null, dateTime: '2026-03-16T09:00:00', timeZone: 'America/New_York' },
    end: { date: null, dateTime: '2026-03-16T10:00:00', timeZone: 'America/New_York' },
  });
});

test('calendar_create_event sends plain boundaries (insert does not merge) and is not retried after a 5xx', async () => {
  let attempts = 0;
  const ctx = createTestContext({
    google: () => {
      attempts++;
      return { status: 503, json: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } };
    },
  });
  await assert.rejects(run('calendar_create_event', { account: 'me', summary: 'x', start: '2026-03-16' }, ctx), /API error 503.*Not retried automatically/);
  assert.equal(attempts, 1, 'a repeated insert could create the event twice');
  assert.deepEqual(lastCall(ctx).json, { summary: 'x', start: { date: '2026-03-16' }, end: { date: '2026-03-17' } });
});

test('calendar_delete_event sends DELETE and confirms', async () => {
  const ctx = createTestContext({ google: () => new Response(null, { status: 204 }) });
  const out = resultJson(await run('calendar_delete_event', { account: 'me', calendar_id: 'home@group.calendar.google.com', event_id: 'evt1_20260314T083000Z', send_updates: 'all' }, ctx));
  const call = lastCall(ctx);
  assert.equal(call.method, 'DELETE');
  assert.equal(call.url.href, `${BASE}/calendars/home%40group.calendar.google.com/events/evt1_20260314T083000Z?sendUpdates=all`);
  assert.equal(call.body, undefined);
  assert.deepEqual(out, { deleted: true, calendar_id: 'home@group.calendar.google.com', event_id: 'evt1_20260314T083000Z' });
});

test('calendar_delete_event surfaces Google errors', async () => {
  const ctx = createTestContext({ google: () => ({ status: 410, json: { error: { code: 410, message: 'Resource has been deleted', errors: [{ reason: 'deleted' }] } } }) });
  await assert.rejects(run('calendar_delete_event', { account: 'me', event_id: 'gone' }, ctx), /Google Calendar API error 410 \(deleted\)/);
});

test('calendar_respond patches the full attendee list with my response and comment', async () => {
  const requests: FakeGoogle = (c) => {
    if (c.method === 'GET') return { json: timedEvent };
    const attendees = (c.json as { attendees: { self?: boolean; responseStatus: string }[] }).attendees;
    return { json: { ...timedEvent, attendees } };
  };
  const ctx = createTestContext({ google: requests });
  const out = resultJson(await run('calendar_respond', { account: 'me', event_id: 'evt1', response: 'tentative', comment: 'may be late' }, ctx));
  const [get, patch] = apiCalls(ctx);
  assert.equal(get!.method, 'GET');
  assert.equal(get!.url.href, `${BASE}/calendars/primary/events/evt1`);
  assert.equal(patch!.method, 'PATCH');
  assert.equal(patch!.url.href, `${BASE}/calendars/primary/events/evt1?sendUpdates=all`);
  assert.deepEqual(patch!.json, {
    attendees: [
      { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
      { email: 'me@example.com', self: true, responseStatus: 'tentative', comment: 'may be late' },
      { email: 'guest@example.com', optional: true, responseStatus: 'declined', comment: 'sorry' },
    ],
  });
  assert.deepEqual(out, { event_id: 'evt1', summary: 'Standup', my_response: 'tentative' });
});

test('calendar_respond: send_updates none, no comment leaves the attendee row otherwise untouched', async () => {
  const ctx = createTestContext({ google: (c) => ({ json: c.method === 'GET' ? timedEvent : { ...timedEvent, ...(c.json as object) } }) });
  await run('calendar_respond', { account: 'me', event_id: 'evt1', response: 'accepted', send_updates: 'none' }, ctx);
  const patch = lastCall(ctx);
  assert.equal(patch.url.searchParams.get('sendUpdates'), 'none');
  const me = (patch.json as { attendees: Record<string, unknown>[] }).attendees[1]!;
  assert.deepEqual(me, { email: 'me@example.com', self: true, responseStatus: 'accepted' });
});

test('calendar_respond refuses when the account is not an attendee', async () => {
  const ctx = createTestContext({ google: () => ({ json: allDayEvent }) });
  const out = await run('calendar_respond', { account: 'me', event_id: 'evt2', response: 'accepted' }, ctx);
  assert.equal(out.isError, true);
  assert.match(resultText(out), /not an attendee/);
  assert.equal(apiCalls(ctx).length, 1, 'no PATCH was attempted');
});

test('calendar_free_busy posts the query and computes merged free gaps', async () => {
  const ctx = createTestContext({
    google: () => ({
      json: {
        kind: 'calendar#freeBusy',
        calendars: {
          primary: { busy: [{ start: '2026-07-01T08:00:00Z', end: '2026-07-01T09:00:00Z' }] },
          'home@group.calendar.google.com': { busy: [{ start: '2026-07-01T08:30:00Z', end: '2026-07-01T10:00:00Z' }] },
          'nobody@example.com': { errors: [{ domain: 'global', reason: 'notFound' }] },
        },
      },
    }),
  });
  const out = resultJson(await run(
    'calendar_free_busy',
    { account: 'me', time_min: '2026-07-01T09:00', time_max: '2026-07-01T14:00', calendar_ids: ['primary', 'home@group.calendar.google.com', 'nobody@example.com'] },
    ctx,
  ));
  const call = lastCall(ctx);
  assert.equal(call.method, 'POST');
  assert.equal(call.url.href, `${BASE}/freeBusy`);
  assert.deepEqual(call.json, {
    timeMin: '2026-07-01T09:00:00+02:00',
    timeMax: '2026-07-01T14:00:00+02:00',
    timeZone: 'Europe/Paris',
    items: [{ id: 'primary' }, { id: 'home@group.calendar.google.com' }, { id: 'nobody@example.com' }],
  });
  assert.deepEqual(out, {
    time_min: '2026-07-01T09:00:00+02:00',
    time_max: '2026-07-01T14:00:00+02:00',
    time_zone: 'Europe/Paris',
    calendars: [
      { id: 'primary', busy: [{ start: '2026-07-01T08:00:00Z', end: '2026-07-01T09:00:00Z' }] },
      { id: 'home@group.calendar.google.com', busy: [{ start: '2026-07-01T08:30:00Z', end: '2026-07-01T10:00:00Z' }] },
      {
        id: 'nobody@example.com',
        errors: ['notFound'],
        note: 'Google has no free/busy data for this calendar: holiday and other subscribed calendars do not publish any, and a person only appears when they share free/busy with this account. calendar_list_events can still read a calendar this account can see.',
      },
    ],
    free: [
      { start: '2026-07-01T09:00:00+02:00', end: '2026-07-01T10:00:00+02:00' },
      { start: '2026-07-01T12:00:00+02:00', end: '2026-07-01T14:00:00+02:00' },
    ],
    free_note: 'The free gaps only reflect calendars with free/busy data; nobody@example.com could not be checked.',
  });
});

test('calendar_free_busy is retried after a 5xx: the POST is a pure query', async () => {
  let attempts = 0;
  const ctx = createTestContext({
    google: () => {
      attempts++;
      if (attempts === 1) return { status: 503, json: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } };
      return { json: { calendars: { primary: { busy: [] } } } };
    },
  });
  const out = resultJson<{ calendars: { id: string }[] }>(await run('calendar_free_busy', { account: 'me', time_min: '2026-07-01', time_max: '2026-07-02' }, ctx));
  assert.equal(attempts, 2);
  assert.equal(apiCalls(ctx).length, 2);
  assert.deepEqual(out.calendars, [{ id: 'primary' }]);
});

test('calendar_free_busy: a future time_min without time_max covers the 7 days from time_min', async () => {
  const ctx = createTestContext({ google: () => ({ json: { calendars: { primary: { busy: [] } } } }) });
  const out = resultJson<{ time_min: string; time_max: string }>(await run('calendar_free_busy', { account: 'me', time_min: '2027-01-10T08:00' }, ctx));
  assert.equal(out.time_min, '2027-01-10T08:00:00+01:00');
  assert.equal(out.time_max, '2027-01-17T08:00:00+01:00');
  const body = lastCall(ctx).json as { timeMin: string; timeMax: string };
  assert.equal(body.timeMin, out.time_min);
  assert.equal(body.timeMax, out.time_max);
});

test('calendar_free_busy defaults to primary and the next 7 days', async () => {
  const ctx = createTestContext({ google: () => ({ json: { calendars: { primary: { busy: [] } } } }) });
  const out = resultJson<{ calendars: { id: string }[]; free: { start: string; end: string }[] }>(await run('calendar_free_busy', { account: 'me' }, ctx));
  const body = lastCall(ctx).json as { timeMin: string; timeMax: string; items: unknown[] };
  assert.deepEqual(body.items, [{ id: 'primary' }]);
  assert.ok(Math.abs(Date.parse(body.timeMax) - Date.parse(body.timeMin) - 7 * 86_400_000) < 1_000);
  assert.deepEqual(out.calendars, [{ id: 'primary' }]);
  assert.equal(out.free.length, 1, 'whole window is free');
  assert.equal(out.free[0]!.start, body.timeMin);
  assert.equal(out.free[0]!.end, body.timeMax);
});
