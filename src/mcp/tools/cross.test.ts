import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createTestContext, fakeFetch, resultJson, resultText, type FakeResponse, type RecordedCall, type TestAccountSpec, type TestContext } from '../../test-support.js';
import { GoogleAuth, GOOGLE_TOKEN_URL } from '../../google/oauth.js';
import { GoogleClient } from '../../google/client.js';
import { silentLogger } from '../../log.js';
import { runTool } from '../server.js';
import { crossTools, decodeSnippet, defaultCalendars, mapConcurrent, todayIn, zonedDayStart, zonedIso } from './cross.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';

type AliasHandler = (alias: string, call: RecordedCall) => FakeResponse | undefined | Promise<FakeResponse | undefined>;

/**
 * A context whose fake Google knows which alias is calling: the token endpoint
 * mints `token-<alias>` from the refresh token, and the handler gets the alias
 * back from the bearer header. Needed because cross tools hit identical URLs
 * for every account.
 */
function aliasAwareContext(accounts: TestAccountSpec[], handler: AliasHandler): { ctx: TestContext; calls: RecordedCall[] } {
  const ctx = createTestContext({ accounts });
  const calls: RecordedCall[] = [];
  const apiFetch = fakeFetch((call) => handler(call.headers['authorization']!.replace('Bearer token-', ''), call), calls);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) return apiFetch(input, init);
    const alias = new URLSearchParams(String(init?.body)).get('refresh_token')!.replace('refresh-', '');
    return new Response(JSON.stringify({ access_token: `token-${alias}`, expires_in: 3600, token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const auth = new GoogleAuth({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://connector.test/auth/google/callback' }, fetchImpl);
  ctx.google = new GoogleClient(ctx.accounts, auth, silentLogger, { adminUrl: 'https://connector.test/admin', fetchImpl, sleep: async () => {} });
  return { ctx, calls };
}

function tool(name: string) {
  const def = crossTools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

function call(ctx: TestContext, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return runTool(tool(name), args, ctx);
}

function path(c: RecordedCall): string {
  return c.url.pathname.replace('/gmail/v1/users/me', '').replace('/calendar/v3', '');
}

function query(c: RecordedCall): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const k of new Set(c.url.searchParams.keys())) {
    const all = c.url.searchParams.getAll(k);
    out[k] = all.length === 1 ? all[0]! : all;
  }
  return out;
}

const UNAUTHORIZED: FakeResponse = { status: 401, json: { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } };

// ---------------------------------------------------------------------------
// Gmail fakes

function metaMessage(id: string, from: string, subject: string, snippet = 'hello', internalDate = String(Date.parse('2026-09-23T10:00:00Z'))) {
  return {
    id,
    threadId: `t-${id}`,
    snippet,
    internalDate,
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Tue, 23 Sep 2026 12:00:00 +0200' }] },
  };
}

/** A Gmail that answers list, metadata and the INBOX label for one alias (UNREAD answers too, with the wrong, mailbox-wide number). */
function gmailFake(ids: string[], unread = 3): (c: RecordedCall) => FakeResponse | undefined {
  return (c) => {
    if (c.url.href.startsWith(GMAIL + '/messages?')) return { json: { messages: ids.map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: ids.length * 10 } };
    if (c.url.href.startsWith(GMAIL + '/labels/INBOX')) return { json: { id: 'INBOX', messagesUnread: unread, messagesTotal: 99 } };
    if (c.url.href.startsWith(GMAIL + '/labels/UNREAD')) return { json: { id: 'UNREAD', messagesUnread: unread + 40, messagesTotal: 999 } };
    const m = /\/messages\/([^?]+)/.exec(c.url.pathname);
    if (m && ids.includes(m[1]!)) return { json: metaMessage(m[1]!, `sender-${m[1]}@example.com`, `Subject ${m[1]}`, `It&#39;s about ${m[1]} &amp; more`) };
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Contract

test('tool contract: two read-only cross tools without a service or account parameter', () => {
  assert.deepEqual(crossTools.map((t) => t.name), ['inbox_overview', 'agenda']);
  for (const t of crossTools) {
    assert.equal(t.service, undefined, `${t.name} spans services`);
    assert.ok(!('account' in t.inputSchema) && 'accounts' in t.inputSchema, `${t.name} takes accounts[]`);
    assert.ok(t.title && t.description.length > 80, t.name);
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, t.name);
    for (const [key, schema] of Object.entries(t.inputSchema)) {
      assert.ok((schema as { description?: string }).description, `${t.name}.${key} is described`);
    }
  }
});

// ---------------------------------------------------------------------------
// inbox_overview

test('inbox_overview: defaults to accounts with Gmail, sends the expected calls and compacts messages', async () => {
  const { ctx, calls } = aliasAwareContext(
    [
      { alias: 'me', services: ['gmail', 'calendar'] },
      { alias: 'cal', services: ['calendar'] },
    ],
    (alias, c) => (alias === 'me' ? gmailFake(['m1', 'm2'])(c) : undefined),
  );
  const out = resultJson<{ accounts: Record<string, unknown>[] }>(await call(ctx, 'inbox_overview'));

  const api = calls.filter((c) => c.url.href !== GOOGLE_TOKEN_URL);
  assert.deepEqual(
    api.map((c) => [c.method, path(c)]),
    [['GET', '/messages'], ['GET', '/labels/INBOX'], ['GET', '/messages/m1'], ['GET', '/messages/m2']],
  );
  assert.deepEqual(query(api[0]!), { q: 'is:unread in:inbox', maxResults: '8' });
  assert.deepEqual(query(api[2]!), { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
  for (const c of api) assert.equal(c.headers['authorization'], 'Bearer token-me');

  assert.equal(out.accounts.length, 1);
  assert.deepEqual(out.accounts[0], {
    alias: 'me',
    email: 'me@example.com',
    unread_total: 3, // INBOX's counter (unread mail in the inbox), not UNREAD's mailbox-wide 43
    count_shown: 2,
    messages: [
      { id: 'm1', thread_id: 't-m1', date: '2026-09-23T10:00:00.000Z', from: 'sender-m1@example.com', subject: 'Subject m1', snippet: "It's about m1 & more" },
      { id: 'm2', thread_id: 't-m2', date: '2026-09-23T10:00:00.000Z', from: 'sender-m2@example.com', subject: 'Subject m2', snippet: "It's about m2 & more" },
    ],
  });
});

test('inbox_overview: custom query skips the unread counter, honours max_per_account and handles an empty result', async () => {
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['gmail'] }], (_alias, c) =>
    c.url.href.startsWith(GMAIL + '/messages?') ? { json: { resultSizeEstimate: 0 } } : undefined,
  );
  const out = resultJson<{ accounts: Record<string, unknown>[] }>(await call(ctx, 'inbox_overview', { query: 'from:boss newer_than:2d', max_per_account: 25 }));
  const api = calls.filter((c) => c.url.href !== GOOGLE_TOKEN_URL);
  assert.deepEqual(api.map(path), ['/messages']);
  assert.deepEqual(query(api[0]!), { q: 'from:boss newer_than:2d', maxResults: '25' });
  assert.deepEqual(out.accounts, [{ alias: 'me', email: 'me@example.com', count_shown: 0 }]);
});

test('inbox_overview: snippets are trimmed to 120 chars', async () => {
  const long = 'x'.repeat(300);
  const { ctx } = aliasAwareContext([{ alias: 'me', services: ['gmail'] }], (_alias, c) => {
    if (c.url.href.startsWith(GMAIL + '/messages?')) return { json: { messages: [{ id: 'a', threadId: 't' }] } };
    if (c.url.pathname.endsWith('/labels/INBOX')) return { json: { messagesUnread: 0 } };
    return { json: metaMessage('a', 'x@y', 's', long) };
  });
  const out = resultJson<{ accounts: { unread_total?: number; messages: { snippet: string }[] }[] }>(await call(ctx, 'inbox_overview'));
  const snippet = out.accounts[0]!.messages[0]!.snippet;
  assert.equal(snippet.length, 120);
  assert.ok(snippet.endsWith('…'));
  assert.equal(out.accounts[0]!.unread_total, 0, 'a zero counter is still reported');
});

test('inbox_overview: an explicitly requested account without Gmail or unknown yields an inline error, others succeed', async () => {
  const { ctx } = aliasAwareContext(
    [
      { alias: 'me', services: ['gmail'] },
      { alias: 'cal', services: ['calendar'] },
    ],
    (alias, c) => (alias === 'me' ? gmailFake(['m1'])(c) : undefined),
  );
  const res = await call(ctx, 'inbox_overview', { accounts: ['cal', ' ME ', 'nobody', 'me'] });
  assert.ok(!res.isError);
  const out = resultJson<{ accounts: { alias: string; email?: string; error?: string; count_shown?: number }[] }>(res);
  assert.deepEqual(out.accounts.map((a) => a.alias), ['cal', 'me', 'nobody'], 'normalised and deduplicated');
  assert.equal(out.accounts[0]!.email, 'cal@example.com');
  assert.match(out.accounts[0]!.error!, /not granted Gmail/);
  assert.match(out.accounts[0]!.error!, /Re-link/);
  assert.equal(out.accounts[1]!.count_shown, 1);
  assert.match(out.accounts[2]!.error!, /Unknown account alias "nobody"/);
});

test('inbox_overview: an account Google keeps rejecting is marked needs_relink and reported inline', async () => {
  const { ctx, calls } = aliasAwareContext(
    [
      { alias: 'me', services: ['gmail'] },
      { alias: 'bad', services: ['gmail'] },
    ],
    (alias, c) => (alias === 'bad' ? UNAUTHORIZED : gmailFake(['m1'])(c)),
  );
  const out = resultJson<{ accounts: { alias: string; email?: string; error?: string; count_shown?: number }[] }>(await call(ctx, 'inbox_overview'));
  assert.deepEqual(out.accounts.map((a) => a.alias), ['me', 'bad']);
  assert.equal(out.accounts[0]!.count_shown, 1);
  assert.equal(out.accounts[1]!.email, 'bad@example.com');
  assert.match(out.accounts[1]!.error!, /"bad".*needs to be re-linked/);
  assert.equal(ctx.accounts.get('bad')!.status, 'needs_relink');
  // The list and the INBOX label are fetched concurrently; each got a 401, a token refresh and a retry that failed too.
  assert.equal(calls.filter((c) => c.headers['authorization'] === 'Bearer token-bad').length, 4);
});

test('inbox_overview: no linked account with Gmail is a clear error', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'cal', services: ['calendar'] }] });
  const res = await call(ctx, 'inbox_overview');
  assert.ok(res.isError);
  assert.match(resultText(res), /No linked account grants Gmail/);
});

test('inbox_overview: metadata fetches run at most 5 at a time', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
  let inFlight = 0;
  let peak = 0;
  const { ctx } = aliasAwareContext([{ alias: 'me', services: ['gmail'] }], async (_alias, c) => {
    if (!/\/messages\/m\d+/.test(c.url.pathname)) return gmailFake(ids)(c);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return gmailFake(ids)(c);
  });
  const out = resultJson<{ accounts: { messages: { id: string }[] }[] }>(await call(ctx, 'inbox_overview', { max_per_account: 12 }));
  assert.equal(out.accounts[0]!.messages.length, 12);
  assert.deepEqual(out.accounts[0]!.messages.map((m) => m.id), ids, 'order preserved');
  assert.ok(peak <= 5 && peak >= 2, `peak concurrency was ${peak}`);
});

test('mapConcurrent: empty input and a limit above the item count', async () => {
  assert.deepEqual(await mapConcurrent([], 5, async (x: number) => x), []);
  assert.deepEqual(await mapConcurrent([1, 2, 3], 10, async (x) => x * 2), [2, 4, 6]);
});

test('decodeSnippet: named, decimal and hex entities, whitespace collapsed', () => {
  assert.equal(decodeSnippet('Tom &amp; Jerry &#39;s &#x2764; &lt;b&gt;  \n done &unknown;'), "Tom & Jerry 's ❤ <b> done &unknown;");
});

// ---------------------------------------------------------------------------
// Time zone helpers

test('zonedDayStart: Europe/Paris in winter (+01:00) and summer (+02:00)', () => {
  assert.equal(zonedDayStart('2026-01-15', 'Europe/Paris').toISOString(), '2026-01-14T23:00:00.000Z');
  assert.equal(zonedDayStart('2026-07-15', 'Europe/Paris').toISOString(), '2026-07-14T22:00:00.000Z');
  assert.equal(zonedDayStart('2026-07-15', 'UTC').toISOString(), '2026-07-15T00:00:00.000Z');
  assert.equal(zonedDayStart('2026-07-15', 'America/New_York').toISOString(), '2026-07-15T04:00:00.000Z');
});

test('zonedDayStart: the DST change days in Paris are 23 and 25 hours long', () => {
  // Clocks go forward on 2026-03-29 at 02:00 and back on 2026-10-25 at 03:00.
  const springDay = zonedDayStart('2026-03-30', 'Europe/Paris').getTime() - zonedDayStart('2026-03-29', 'Europe/Paris').getTime();
  const autumnDay = zonedDayStart('2026-10-26', 'Europe/Paris').getTime() - zonedDayStart('2026-10-25', 'Europe/Paris').getTime();
  assert.equal(springDay / 3_600_000, 23);
  assert.equal(autumnDay / 3_600_000, 25);
  assert.equal(zonedDayStart('2026-03-29', 'Europe/Paris').toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(zonedDayStart('2026-03-30', 'Europe/Paris').toISOString(), '2026-03-29T22:00:00.000Z');
});

test('zonedDayStart: a zone whose DST change happens at midnight', () => {
  // Santiago springs forward at 00:00 on 2026-09-06: local midnight does not exist, the day starts at 01:00 (-03:00).
  assert.equal(zonedDayStart('2026-09-06', 'America/Santiago').toISOString(), '2026-09-06T04:00:00.000Z');
  assert.equal(zonedDayStart('2026-09-05', 'America/Santiago').toISOString(), '2026-09-05T04:00:00.000Z');
});

test('zonedDayStart rejects malformed and impossible dates', () => {
  assert.throws(() => zonedDayStart('2026-02-30', 'Europe/Paris'), RangeError);
  assert.throws(() => zonedDayStart('15/01/2026', 'Europe/Paris'), RangeError);
});

test('zonedIso and todayIn use the wall clock of the zone', () => {
  const instant = new Date('2026-07-14T22:00:00.000Z');
  assert.equal(zonedIso(instant, 'Europe/Paris'), '2026-07-15T00:00:00+02:00');
  assert.equal(zonedIso(instant, 'America/New_York'), '2026-07-14T18:00:00-04:00');
  assert.equal(zonedIso(instant, 'Asia/Kolkata'), '2026-07-15T03:30:00+05:30');
  assert.equal(todayIn('Europe/Paris', instant), '2026-07-15');
  assert.equal(todayIn('America/New_York', instant), '2026-07-14');
});

// ---------------------------------------------------------------------------
// agenda

const CALENDAR_LIST = [
  { id: 'me@example.com', summary: 'me@example.com', primary: true, selected: true },
  { id: 'work@group.calendar.google.com', summary: 'Work', summaryOverride: 'Work (override)', selected: true },
  { id: 'hidden@group.calendar.google.com', summary: 'Hidden', selected: true, hidden: true },
  { id: 'unticked@group.calendar.google.com', summary: 'Unticked', selected: false },
];

function event(id: string, start: Record<string, string>, end: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { id, status: 'confirmed', summary: `Event ${id}`, start, end, ...extra };
}

test('defaultCalendars: selected and visible, else primary, else literal "primary"', () => {
  assert.deepEqual(defaultCalendars(CALENDAR_LIST), [
    { id: 'me@example.com', name: 'me@example.com' },
    { id: 'work@group.calendar.google.com', name: 'Work (override)' },
  ]);
  assert.deepEqual(defaultCalendars([{ id: 'p', summary: 'P', primary: true }, { id: 'x', summary: 'X', selected: false }]), [{ id: 'p', name: 'P' }]);
  assert.deepEqual(defaultCalendars([]), [{ id: 'primary' }]);
});

test('agenda: default calendars, exact event queries, declined skipped, sorted across calendars, output shape', async () => {
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }, { alias: 'mail', services: ['gmail'] }], (_alias, c) => {
    if (c.url.pathname.endsWith('/users/me/calendarList')) return { json: { items: CALENDAR_LIST } };
    if (c.url.pathname === '/calendar/v3/calendars/me%40example.com/events') {
      return {
        json: {
          items: [
            event('allday', { date: '2026-09-23' }, { date: '2026-09-24' }),
            event('lunch', { dateTime: '2026-09-23T12:30:00+02:00', timeZone: 'Europe/Paris' }, { dateTime: '2026-09-23T13:30:00+02:00' }, {
              location: 'Café',
              attendees: [{ email: 'other@example.com', responseStatus: 'accepted' }, { email: 'me@example.com', self: true, responseStatus: 'needsAction' }],
              hangoutLink: 'https://meet.google.com/abc-defg-hij',
            }),
            event('declined', { dateTime: '2026-09-23T09:00:00+02:00' }, { dateTime: '2026-09-23T09:30:00+02:00' }, {
              attendees: [{ self: true, responseStatus: 'declined' }],
            }),
            event('gone', { dateTime: '2026-09-23T09:00:00+02:00' }, { dateTime: '2026-09-23T09:30:00+02:00' }, { status: 'cancelled' }),
          ],
        },
      };
    }
    if (c.url.pathname === '/calendar/v3/calendars/work%40group.calendar.google.com/events') {
      return {
        json: {
          items: [
            event('standup', { dateTime: '2026-09-23T10:00:00+02:00' }, { dateTime: '2026-09-23T10:15:00+02:00' }, {
              attendees: [{ self: true, responseStatus: 'accepted' }],
              conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+33' }, { entryPointType: 'video', uri: 'https://meet.google.com/work' }] },
            }),
          ],
        },
      };
    }
    return undefined;
  });
  const out = resultJson<{ time_zone: string; from: string; to: string; accounts: Record<string, unknown>[] }>(await call(ctx, 'agenda', { date: '2026-09-23' }));

  const api = calls.filter((c) => c.url.href !== GOOGLE_TOKEN_URL);
  assert.deepEqual(api.map(path), ['/users/me/calendarList', '/calendars/me%40example.com/events', '/calendars/work%40group.calendar.google.com/events']);
  assert.deepEqual(query(api[0]!), { maxResults: '250', fields: 'items(id,summary,summaryOverride,selected,hidden,primary)' });
  assert.deepEqual(query(api[1]!), {
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: '2026-09-22T22:00:00.000Z',
    timeMax: '2026-09-23T22:00:00.000Z',
    timeZone: 'Europe/Paris',
    maxResults: '200',
    fields: 'nextPageToken,items(id,status,summary,location,start,end,attendees(self,responseStatus),hangoutLink,conferenceData/entryPoints)',
  });

  assert.equal(out.time_zone, 'Europe/Paris');
  assert.equal(out.from, '2026-09-23T00:00:00+02:00');
  assert.equal(out.to, '2026-09-24T00:00:00+02:00');
  assert.deepEqual(out.accounts, [
    {
      alias: 'me',
      email: 'me@example.com',
      calendars: ['me@example.com', 'Work (override)'],
      events: [
        { id: 'allday', calendar_id: 'me@example.com', calendar: 'me@example.com', summary: 'Event allday', start: '2026-09-23', end: '2026-09-24', all_day: true },
        {
          id: 'standup',
          calendar_id: 'work@group.calendar.google.com',
          calendar: 'Work (override)',
          summary: 'Event standup',
          start: '2026-09-23T10:00:00+02:00',
          end: '2026-09-23T10:15:00+02:00',
          my_response: 'accepted',
          meet_link: 'https://meet.google.com/work',
        },
        {
          id: 'lunch',
          calendar_id: 'me@example.com',
          calendar: 'me@example.com',
          summary: 'Event lunch',
          start: '2026-09-23T12:30:00+02:00',
          end: '2026-09-23T13:30:00+02:00',
          location: 'Café',
          my_response: 'needsAction', // Google's spelling, as calendar_* tools return it
          meet_link: 'https://meet.google.com/abc-defg-hij',
        },
      ],
    },
  ]);
});

test('agenda: include_declined keeps declined events', async () => {
  const { ctx } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], (_alias, c) => {
    if (c.url.pathname.endsWith('/calendarList')) return { json: { items: [{ id: 'p', primary: true, selected: true }] } };
    return { json: { items: [event('d', { dateTime: '2026-09-23T09:00:00+02:00' }, { dateTime: '2026-09-23T09:30:00+02:00' }, { attendees: [{ self: true, responseStatus: 'declined' }] })] } };
  });
  const out = resultJson<{ accounts: { events: { id: string; my_response: string }[] }[] }>(await call(ctx, 'agenda', { date: '2026-09-23', include_declined: true }));
  assert.deepEqual(out.accounts[0]!.events.map((e) => [e.id, e.my_response]), [['d', 'declined']]);
});

test('agenda: explicit calendar_ids skip calendarList; days, time_zone and max_per_calendar shape the window; 200-event cap', async () => {
  const many = Array.from({ length: 205 }, (_, i) =>
    event(`e${i}`, { dateTime: `2026-03-29T${String(i % 24).padStart(2, '0')}:00:00+02:00` }, { dateTime: '2026-03-29T23:59:00+02:00' }),
  );
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], (_alias, c) =>
    c.url.pathname === '/calendar/v3/calendars/primary/events' ? { json: { items: many } } : undefined,
  );
  const out = resultJson<{ from: string; to: string; accounts: { calendars?: unknown; events: { calendar?: string }[]; events_omitted?: number; truncated_calendars?: string[] }[] }>(
    await call(ctx, 'agenda', { date: '2026-03-29', days: 3, time_zone: 'Europe/Paris', calendar_ids: ['primary'], max_per_calendar: 250 }),
  );
  const api = calls.filter((c) => c.url.href !== GOOGLE_TOKEN_URL);
  assert.deepEqual(api.map(path), ['/calendars/primary/events']);
  const q = query(api[0]!);
  // 2026-03-29 is the spring-forward day: the 3-day window is 71 hours long.
  assert.equal(q['timeMin'], '2026-03-28T23:00:00.000Z');
  assert.equal(q['timeMax'], '2026-03-31T22:00:00.000Z');
  assert.equal(q['maxResults'], '250');
  assert.equal(out.from, '2026-03-29T00:00:00+01:00');
  assert.equal(out.to, '2026-04-01T00:00:00+02:00');
  assert.equal(out.accounts[0]!.calendars, undefined, 'no calendar names when ids were given');
  assert.equal(out.accounts[0]!.events.length, 200);
  assert.equal(out.accounts[0]!.events_omitted, 5);
  assert.equal(out.accounts[0]!.truncated_calendars, undefined, 'Google had no further page');
  assert.equal(out.accounts[0]!.events[0]!.calendar, undefined);
});

test('agenda: follows nextPageToken until a calendar is exhausted, asking only for what is still missing', async () => {
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], (_alias, c) => {
    if (c.url.pathname.endsWith('/calendarList')) return { json: { items: [{ id: 'p', primary: true, selected: true }] } };
    const page = c.url.searchParams.get('pageToken');
    if (page === null) {
      // A short first page with a token: cancelled instances count against maxResults but are dropped.
      return {
        json: {
          nextPageToken: 'page-2',
          items: [
            event('a', { dateTime: '2026-09-23T09:00:00+02:00' }, { dateTime: '2026-09-23T10:00:00+02:00' }),
            event('gone', { dateTime: '2026-09-23T09:30:00+02:00' }, { dateTime: '2026-09-23T10:00:00+02:00' }, { status: 'cancelled' }),
            event('b', { dateTime: '2026-09-23T11:00:00+02:00' }, { dateTime: '2026-09-23T12:00:00+02:00' }),
          ],
        },
      };
    }
    if (page === 'page-2') return { json: { items: [event('c', { dateTime: '2026-09-23T14:00:00+02:00' }, { dateTime: '2026-09-23T15:00:00+02:00' })] } };
    return undefined;
  });
  const out = resultJson<{ accounts: { events: { id: string }[]; events_omitted?: number; truncated_calendars?: string[] }[] }>(
    await call(ctx, 'agenda', { date: '2026-09-23' }),
  );
  const pages = calls.filter((c) => c.url.pathname.endsWith('/calendars/p/events'));
  assert.equal(pages.length, 2);
  assert.equal(query(pages[0]!)['pageToken'], undefined);
  assert.equal(query(pages[0]!)['maxResults'], '200');
  assert.equal(query(pages[1]!)['pageToken'], 'page-2');
  assert.equal(query(pages[1]!)['maxResults'], '198', 'two events already kept');
  assert.ok((query(pages[1]!)['fields'] as string).startsWith('nextPageToken,items('));
  assert.deepEqual(out.accounts[0]!.events.map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(out.accounts[0]!.events_omitted, undefined);
  assert.equal(out.accounts[0]!.truncated_calendars, undefined);
});

/** A calendar that always has another page: `perPage` events per request (never more than maxResults). */
function endlessCalendar(perPage: number): (c: RecordedCall) => FakeResponse {
  return (c) => {
    const page = Number(c.url.searchParams.get('pageToken') ?? 0);
    const n = Math.min(perPage, Number(c.url.searchParams.get('maxResults')));
    const items = Array.from({ length: n }, (_, i) =>
      event(`p${page}-${i}`, { dateTime: `2026-09-23T${String(i % 24).padStart(2, '0')}:00:00+02:00` }, { dateTime: '2026-09-23T23:59:00+02:00' }),
    );
    return { json: { items, nextPageToken: String(page + 1) } };
  };
}

test('agenda: the 200-event cap stops paging a busy calendar and names it in truncated_calendars', async () => {
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], (_alias, c) => endlessCalendar(50)(c));
  const out = resultJson<{ accounts: { events: unknown[]; events_omitted?: number; truncated_calendars?: string[] }[] }>(
    await call(ctx, 'agenda', { date: '2026-09-23', calendar_ids: ['primary'] }),
  );
  const pages = calls.filter((c) => c.url.pathname.endsWith('/calendars/primary/events'));
  assert.deepEqual(pages.map((c) => query(c)['maxResults']), ['200', '150', '100', '50'], 'no fifth request once the cap is reached');
  assert.equal(out.accounts[0]!.events.length, 200);
  assert.equal(out.accounts[0]!.events_omitted, undefined, 'nothing fetched was cut');
  assert.deepEqual(out.accounts[0]!.truncated_calendars, ['primary']);
});

test('agenda: max_per_calendar bounds each calendar separately; declined events do not count towards it', async () => {
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], (_alias, c) => {
    if (c.url.pathname === '/calendar/v3/calendars/busy/events') return endlessCalendar(2)(c);
    if (c.url.pathname === '/calendar/v3/calendars/quiet/events') {
      return {
        json: {
          items: [
            event('q-declined', { dateTime: '2026-09-23T08:00:00+02:00' }, { dateTime: '2026-09-23T08:30:00+02:00' }, { attendees: [{ self: true, responseStatus: 'declined' }] }),
            event('q1', { dateTime: '2026-09-23T08:00:00+02:00' }, { dateTime: '2026-09-23T08:30:00+02:00' }),
          ],
        },
      };
    }
    return undefined;
  });
  const out = resultJson<{ accounts: { events: { id: string }[]; events_omitted?: number; truncated_calendars?: string[] }[] }>(
    await call(ctx, 'agenda', { date: '2026-09-23', calendar_ids: ['busy', 'quiet'], max_per_calendar: 3 }),
  );
  const busy = calls.filter((c) => c.url.pathname.endsWith('/calendars/busy/events'));
  assert.deepEqual(busy.map((c) => [query(c)['pageToken'], query(c)['maxResults']]), [[undefined, '3'], ['1', '1']]);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('/calendars/quiet/events')).length, 1);
  assert.deepEqual(out.accounts[0]!.events.map((e) => e.id).sort(), ['p0-0', 'p0-1', 'p1-0', 'q1']);
  assert.equal(out.accounts[0]!.events_omitted, undefined);
  assert.deepEqual(out.accounts[0]!.truncated_calendars, ['busy']);
});

test('agenda: the per-account cap across calendars is counted in events_omitted', async () => {
  const { ctx } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], (_alias, c) => {
    const id = /calendars\/([^/]+)\/events/.exec(c.url.pathname)?.[1];
    if (id !== 'a' && id !== 'b') return undefined;
    const items = Array.from({ length: 150 }, (_, i) =>
      event(`${id}${i}`, { dateTime: `2026-09-23T${String(i % 24).padStart(2, '0')}:00:00+02:00` }, { dateTime: '2026-09-23T23:59:00+02:00' }),
    );
    return { json: { items } };
  });
  const out = resultJson<{ accounts: { events: unknown[]; events_omitted?: number; truncated_calendars?: string[] }[] }>(
    await call(ctx, 'agenda', { date: '2026-09-23', calendar_ids: ['a', 'b'] }),
  );
  assert.equal(out.accounts[0]!.events.length, 200);
  assert.equal(out.accounts[0]!.events_omitted, 100);
  assert.equal(out.accounts[0]!.truncated_calendars, undefined, 'both calendars were read to the end');
});

test('agenda: defaults to today in the default zone', async () => {
  const { ctx, calls } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], () => ({ json: { items: [] } }));
  const out = resultJson<{ from: string; accounts: unknown[] }>(await call(ctx, 'agenda'));
  const today = todayIn('Europe/Paris');
  assert.equal(out.from, zonedIso(zonedDayStart(today, 'Europe/Paris'), 'Europe/Paris'));
  const events = calls.find((c) => c.url.pathname.endsWith('/calendars/primary/events'));
  assert.ok(events, 'falls back to the primary calendar when the list is empty');
  assert.equal(query(events!)['timeMin'], zonedDayStart(today, 'Europe/Paris').toISOString());
});

test('agenda: per-account errors do not abort the other accounts', async () => {
  const { ctx } = aliasAwareContext(
    [
      { alias: 'me', services: ['calendar'] },
      { alias: 'bad', services: ['calendar'] },
      { alias: 'mail', services: ['gmail'] },
    ],
    (alias, c) => {
      if (alias === 'bad') return UNAUTHORIZED;
      if (c.url.pathname.endsWith('/calendarList')) return { json: { items: [] } };
      return { json: { items: [event('x', { date: '2026-09-23' }, { date: '2026-09-24' })] } };
    },
  );
  const out = resultJson<{ accounts: { alias: string; error?: string; events?: unknown[] }[] }>(await call(ctx, 'agenda', { date: '2026-09-23', accounts: ['me', 'bad', 'mail'] }));
  assert.deepEqual(out.accounts.map((a) => a.alias), ['me', 'bad', 'mail']);
  assert.equal(out.accounts[0]!.events!.length, 1);
  assert.match(out.accounts[1]!.error!, /needs to be re-linked/);
  assert.match(out.accounts[2]!.error!, /not granted Google Calendar/);
  assert.equal(ctx.accounts.get('bad')!.status, 'needs_relink');
});

test('agenda: a Google API error on one account is reported inline', async () => {
  const { ctx } = aliasAwareContext([{ alias: 'me', services: ['calendar'] }], () => ({ status: 404, json: { error: { message: 'Not Found', errors: [{ reason: 'notFound' }] } } }));
  const out = resultJson<{ accounts: { alias: string; error?: string }[] }>(await call(ctx, 'agenda', { date: '2026-09-23', calendar_ids: ['nope'] }));
  assert.match(out.accounts[0]!.error!, /Google Calendar API error 404 \(notFound\)/);
});

test('agenda: validation errors Claude can fix', async () => {
  const ctx = createTestContext({ accounts: [{ alias: 'me', services: ['calendar'] }] });
  let res = await call(ctx, 'agenda', { date: '23/09/2026' });
  assert.ok(res.isError);
  assert.match(resultText(res), /expected YYYY-MM-DD/);
  res = await call(ctx, 'agenda', { time_zone: 'Mars/Olympus' });
  assert.ok(res.isError);
  assert.match(resultText(res), /Unknown time zone "Mars\/Olympus"/);
  res = await call(ctx, 'agenda', { accounts: [] });
  assert.ok(!res.isError, 'an empty accounts list means the default');
  const none = createTestContext({ accounts: [{ alias: 'mail', services: ['gmail'] }] });
  res = await call(none, 'agenda');
  assert.ok(res.isError);
  assert.match(resultText(res), /No linked account grants Google Calendar/);
});

test('input schemas enforce the documented ranges (validated by the MCP SDK before the handler runs)', () => {
  const agendaSchema = z.object(tool('agenda').inputSchema);
  const inboxSchema = z.object(tool('inbox_overview').inputSchema);
  assert.ok(agendaSchema.safeParse({ days: 14, max_per_calendar: 250 }).success);
  assert.ok(!agendaSchema.safeParse({ days: 15 }).success);
  assert.ok(!agendaSchema.safeParse({ days: 1.5 }).success);
  assert.ok(!agendaSchema.safeParse({ calendar_ids: [''] }).success);
  assert.ok(inboxSchema.safeParse({ max_per_account: 25, accounts: ['me'] }).success);
  assert.ok(!inboxSchema.safeParse({ max_per_account: 0 }).success);
  assert.ok(!inboxSchema.safeParse({ max_per_account: 26 }).success);
});
