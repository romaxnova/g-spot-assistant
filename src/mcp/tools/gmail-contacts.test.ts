import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCalls, createTestContext, resultJson, resultText, type RecordedCall } from '../../test-support.js';
import { runTool } from '../server.js';
import { cleanContactQuery, fold, gmailFindContacts } from './gmail-contacts.js';
import { recipients } from './gmail.js';

const GMAIL = '/gmail/v1/users/me';
const SEND_AS = {
  sendAs: [
    { sendAsEmail: 'me@example.com', displayName: 'Sam Sender', isPrimary: true },
    { sendAsEmail: 'Alias@Example.org', displayName: 'Sam (work)', verificationStatus: 'accepted' },
  ],
};

interface Msg {
  id: string;
  /** YYYY-MM-DD; the message is dated at noon UTC that day. */
  date: string;
  from: string;
  to?: string;
  cc?: string;
  bcc?: string;
  labels?: string[];
}

interface Found {
  contacts?: { name?: string; email: string; address: string; messages: number; last_seen?: string; you_wrote?: number; they_wrote?: number }[];
  scanned: number;
  note?: string;
}

function metadata(m: Msg) {
  const headers = Object.entries({ From: m.from, To: m.to, Cc: m.cc, Bcc: m.bcc })
    .filter(([, value]) => value)
    .map(([name, value]) => ({ name, value }));
  return {
    id: m.id,
    threadId: `t-${m.id}`,
    labelIds: m.labels,
    internalDate: String(Date.parse(`${m.date}T12:00:00Z`)),
    payload: { mimeType: 'text/plain', headers },
  };
}

/** A Gmail that lists every message whatever the query (the tool must filter itself) and serves their metadata. */
function fake(messages: Msg[], extraIds: string[] = []) {
  return (c: RecordedCall) => {
    const p = c.url.pathname.replace(GMAIL, '');
    if (p === '/settings/sendAs') return { json: SEND_AS };
    if (p === '/messages') return { json: { messages: [...messages.map((m) => m.id), ...extraIds].map((id) => ({ id, threadId: `t-${id}` })) } };
    const m = messages.find((x) => p === `/messages/${x.id}`);
    return m ? { json: metadata(m) } : undefined;
  };
}

async function find(messages: Msg[], args: Record<string, unknown>, extraIds?: string[]) {
  const ctx = createTestContext({ google: fake(messages, extraIds) });
  const result = await runTool(gmailFindContacts, { account: 'me', ...args }, ctx);
  assert.ok(!result.isError, resultText(result));
  return { ctx, out: resultJson<Found>(result) };
}

const emails = (out: Found) => (out.contacts ?? []).map((c) => c.email);
const gmailQuery = (q: string) => `{from:(${q}) to:(${q}) cc:(${q}) bcc:(${q})} -in:drafts`;

test('addresses are gathered from From, To and Cc and counted per message; who wrote to whom', async () => {
  const { ctx, out } = await find(
    [
      { id: 'm1', date: '2026-09-01', from: 'Stéphane Moreau <contact@maisonmoreau.fr>', to: 'Sam Sender <me@example.com>' },
      { id: 'm2', date: '2026-09-10', from: 'me@example.com', to: '"Maison Moreau" <Contact@MaisonMoreau.fr>', cc: 'Paul Moreau <paul@moreau.com>' },
      { id: 'm3', date: '2026-08-20', from: 'Ann Lee <ann@example.com>', to: 'me@example.com', cc: 'contact@maisonmoreau.fr, Paul Moreau <paul@moreau.com>' },
    ],
    { query: 'Moreau' },
  );
  assert.deepEqual(out, {
    contacts: [
      {
        name: 'Maison Moreau',
        email: 'contact@maisonmoreau.fr',
        address: 'Maison Moreau <contact@maisonmoreau.fr>',
        messages: 3,
        last_seen: '2026-09-10',
        you_wrote: 1,
        they_wrote: 1,
      },
      { name: 'Paul Moreau', email: 'paul@moreau.com', address: 'Paul Moreau <paul@moreau.com>', messages: 2, last_seen: '2026-09-10', you_wrote: 1 },
    ],
    scanned: 3,
  });
  const [list, ...gets] = apiCalls(ctx);
  assert.equal(list!.url.pathname, `${GMAIL}/messages`);
  assert.equal(list!.url.searchParams.get('q'), gmailQuery('Moreau'));
  assert.equal(list!.url.searchParams.get('maxResults'), '60');
  assert.equal(gets.length, 3);
  assert.equal(gets[0]!.url.searchParams.get('format'), 'metadata');
  assert.deepEqual(gets[0]!.url.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Cc', 'Bcc', 'Date']);
});

test('matching ignores accents and case, both ways, and looks at the address too', async () => {
  const messages: Msg[] = [
    { id: 'm1', date: '2026-09-01', from: 'Stephane Roux <sroux@example.com>', to: 'me@example.com' },
    { id: 'm2', date: '2026-09-02', from: 'Stéphane Blanc <sblanc@example.com>', to: 'me@example.com' },
    { id: 'm3', date: '2026-09-03', from: 'Ann Lee <ann@example.com>', to: 'me@example.com' },
  ];
  assert.deepEqual(emails((await find(messages, { query: 'Stéphane' })).out).sort(), ['sblanc@example.com', 'sroux@example.com']);
  assert.deepEqual(emails((await find(messages, { query: 'STEPHANE' })).out).sort(), ['sblanc@example.com', 'sroux@example.com']);
  assert.deepEqual(emails((await find(messages, { query: 'sroux@EXAMPLE' })).out), ['sroux@example.com']);
  assert.equal(fold('Élodie Müller'), 'elodie muller');
});

test('every word of the query must match, in the name or the address', async () => {
  const messages: Msg[] = [
    { id: 'm1', date: '2026-09-01', from: 'Stephane Roux <sroux@example.com>', to: 'me@example.com' },
    { id: 'm2', date: '2026-09-02', from: 'Stéphane Blanc <sblanc@example.com>', to: 'me@example.com' },
  ];
  assert.deepEqual(emails((await find(messages, { query: 'stéphane blanc' })).out), ['sblanc@example.com']);
  assert.deepEqual(emails((await find(messages, { query: 'Roux  Stéphane' })).out), ['sroux@example.com']);
  assert.deepEqual(emails((await find(messages, { query: 'Stephane sblanc' })).out), ['sblanc@example.com']);
  assert.equal((await find(messages, { query: 'Stephane Moreau' })).out.contacts, undefined);
});

test('the account\'s own address and its send-as aliases are never contacts', async () => {
  const { out } = await find(
    [
      { id: 'm1', date: '2026-09-01', from: 'Sam Sender <ME@example.com>', to: 'Sam (work) <ALIAS@example.org>', cc: 'Sam Petit <sam.petit@example.com>' },
      { id: 'm2', date: '2026-09-02', from: 'Sam Petit <sam.petit@example.com>', to: 'Sam Sender <me@example.com>', bcc: 'alias@example.org' },
    ],
    { query: 'Sam' },
  );
  assert.deepEqual(emails(out), ['sam.petit@example.com']);
  assert.equal(out.contacts![0]!.you_wrote, 1, 'sent from the account (in upper case)');
  assert.equal(out.contacts![0]!.they_wrote, 1);
});

test('the name is the one used most often, the most recent on a tie; an address repeated as a name is no name', async () => {
  const { out } = await find(
    [
      { id: 'm1', date: '2026-07-01', from: 'J. Dupont <jean@dupont.fr>', to: 'me@example.com' },
      { id: 'm2', date: '2026-07-02', from: '"J.  Dupont" <jean@dupont.fr>', to: 'me@example.com' },
      { id: 'm3', date: '2026-09-01', from: 'me@example.com', to: 'Jean Dupont <jean@dupont.fr>' },
      { id: 'm4', date: '2026-09-02', from: '"jean@dupont.fr" <jean@dupont.fr>', to: 'me@example.com' },
      { id: 'm5', date: '2026-06-01', from: 'Marie <marie@dupont.fr>', to: 'me@example.com' },
      { id: 'm6', date: '2026-06-02', from: "'Marie Dupont' <marie@dupont.fr>", to: 'me@example.com' },
      { id: 'm7', date: '2026-06-03', from: 'contact@dupont-sa.fr', to: 'me@example.com' },
    ],
    { query: 'dupont' },
  );
  const byEmail = new Map((out.contacts ?? []).map((c) => [c.email, c]));
  assert.equal(byEmail.get('jean@dupont.fr')!.name, 'J. Dupont');
  assert.equal(byEmail.get('jean@dupont.fr')!.address, '"J. Dupont" <jean@dupont.fr>');
  assert.equal(byEmail.get('marie@dupont.fr')!.name, 'Marie Dupont', 'tie: the most recent');
  assert.equal(byEmail.get('contact@dupont-sa.fr')!.name, undefined);
  assert.equal(byEmail.get('contact@dupont-sa.fr')!.address, 'contact@dupont-sa.fr');
});

test('contacts are ranked by messages, then by the most recent; max_results keeps the first', async () => {
  const messages: Msg[] = [
    { id: 'a1', date: '2026-01-01', from: 'Alpha Martin <a@martin.fr>', to: 'me@example.com' },
    { id: 'a2', date: '2026-02-01', from: 'Alpha Martin <a@martin.fr>', to: 'me@example.com' },
    { id: 'b1', date: '2026-03-01', from: 'Beta Martin <b@martin.fr>', to: 'me@example.com' },
    { id: 'b2', date: '2026-05-01', from: 'Beta Martin <b@martin.fr>', to: 'me@example.com' },
    { id: 'c1', date: '2025-01-01', from: 'Gamma Martin <c@martin.fr>', to: 'me@example.com' },
    { id: 'c2', date: '2025-01-02', from: 'Gamma Martin <c@martin.fr>', to: 'me@example.com' },
    { id: 'c3', date: '2025-01-03', from: 'Gamma Martin <c@martin.fr>', to: 'me@example.com' },
    { id: 'd1', date: '2026-09-01', from: 'Delta Martin <d@martin.fr>', to: 'me@example.com' },
  ];
  assert.deepEqual(emails((await find(messages, { query: 'Martin' })).out), ['c@martin.fr', 'b@martin.fr', 'a@martin.fr', 'd@martin.fr']);
  const top = (await find(messages, { query: 'Martin', max_results: 2 })).out;
  assert.deepEqual(emails(top), ['c@martin.fr', 'b@martin.fr']);
  assert.equal(top.scanned, 8);
});

test('Gmail search syntax is taken out of the query; a query left empty is refused before any call', async () => {
  const { ctx } = await find([], { query: ' "Maison  Moreau" (contact): {x}\\ ', scan: 25 });
  const list = apiCalls(ctx)[0]!;
  assert.equal(list.url.searchParams.get('q'), gmailQuery('Maison Moreau contact x'));
  assert.equal(list.url.searchParams.get('maxResults'), '25');
  assert.equal(cleanContactQuery('a:"b"'), 'a b');

  const empty = createTestContext({ google: fake([]) });
  const refused = await runTool(gmailFindContacts, { account: 'me', query: ' "( ):" ' }, empty);
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), /^query: /);
  assert.equal(empty.calls.length, 0);
});

test('with no one matching, a note says what was looked at and what to try', async () => {
  const two: Msg[] = [
    { id: 'm1', date: '2026-09-01', from: 'Ann Lee <ann@example.com>', to: 'me@example.com' },
    { id: 'm2', date: '2026-09-02', from: 'me@example.com', to: 'Bob <bob@example.com>' },
  ];
  assert.deepEqual((await find(two, { query: 'Zorglub' })).out, {
    scanned: 2,
    note: 'No one matching "Zorglub" in the 2 most recent messages that mention it; try another spelling, part of the address.',
  });
  const ten = Array.from({ length: 10 }, (_, i): Msg => ({ id: `m${i}`, date: '2026-09-01', from: 'Ann Lee <ann@example.com>', to: 'me@example.com' }));
  assert.equal(
    (await find(ten, { query: 'Zorglub', scan: 10 })).out.note,
    'No one matching "Zorglub" in the 10 most recent messages that mention it; try another spelling, part of the address, or a larger scan.',
  );
  assert.deepEqual((await find([], { query: 'Zorglub' })).out, {
    scanned: 0,
    note: 'No message mentions "Zorglub" in its From, To, Cc or Bcc; try another spelling or part of the address.',
  });
});

test('a message deleted between the list and the read is skipped', async () => {
  const { out } = await find([{ id: 'm1', date: '2026-09-01', from: 'Ann Moreau <ann@moreau.fr>', to: 'me@example.com' }], { query: 'moreau' }, ['gone']);
  assert.deepEqual(emails(out), ['ann@moreau.fr']);
  assert.equal(out.scanned, 1);
});

test('address is readable and accepted as a recipient, whatever the name: accents, specials, a long name', async () => {
  const { out } = await find(
    [
      { id: 'm1', date: '2026-09-01', from: 'Stéphane Moreau <sm@moreau.fr>', to: 'me@example.com' },
      { id: 'm2', date: '2026-09-02', from: 'me@example.com', to: '"Moreau-Dupont de la Fontaine, Hélène (Maison Moreau)" <helene@moreau.fr>' },
      { id: 'm3', date: '2026-09-03', from: 'Jürgen Moreau-Dupont von und zu Hohenzollern-Sigmaringen <jm@moreau.de>', to: 'me@example.com' },
    ],
    { query: 'moreau' },
  );
  const byEmail = new Map((out.contacts ?? []).map((c) => [c.email, c.address]));
  assert.equal(byEmail.get('sm@moreau.fr'), 'Stéphane Moreau <sm@moreau.fr>');
  assert.equal(byEmail.get('helene@moreau.fr'), '"Moreau-Dupont de la Fontaine, Hélène (Maison Moreau)" <helene@moreau.fr>');
  assert.equal(byEmail.get('jm@moreau.de'), 'Jürgen Moreau-Dupont von und zu Hohenzollern-Sigmaringen <jm@moreau.de>', 'longer than one encoded-word');
  for (const address of byEmail.values()) {
    assert.doesNotMatch(address, /=\?UTF-8\?|[\r\n]/, address);
    assert.equal(recipients([address], 'to').length, 1, address);
  }
  assert.deepEqual(recipients([byEmail.get('helene@moreau.fr')!], 'to')[0]!.split(' <').pop(), 'helene@moreau.fr>');
});

test('drafts (and chats) are not correspondence: left out of the search and skipped if listed', async () => {
  const { ctx, out } = await find(
    [
      { id: 'm1', date: '2026-09-01', from: 'Paul Moreau <paul@moreau.fr>', to: 'me@example.com' },
      { id: 'd1', date: '2026-09-10', from: 'me@example.com', to: 'contact@moreau.fr, paul@moreau.fr', labels: ['DRAFT'] },
      { id: 'c1', date: '2026-09-11', from: 'Ann Moreau <ann@moreau.fr>', to: 'me@example.com', labels: ['CHAT'] },
    ],
    { query: 'Moreau' },
  );
  assert.deepEqual(out, {
    contacts: [{ name: 'Paul Moreau', email: 'paul@moreau.fr', address: 'Paul Moreau <paul@moreau.fr>', messages: 1, last_seen: '2026-09-01', they_wrote: 1 }],
    scanned: 1,
  });
  assert.match(apiCalls(ctx)[0]!.url.searchParams.get('q')!, / -in:drafts$/);
});

test('no-reply and notification senders are left out; a relay\'s "X via Y" name is not the relay address\'s name', async () => {
  const messages: Msg[] = [
    { id: 'n1', date: '2026-09-05', from: 'Stéphane Moreau (via Google Drive) <drive-shares-dm-noreply@google.com>', to: 'me@example.com' },
    { id: 'n2', date: '2026-09-06', from: 'Stéphane Moreau (via Google Drive) <drive-shares-dm-noreply@google.com>', to: 'me@example.com' },
    { id: 'n3', date: '2026-09-07', from: 'Stéphane Moreau (Google Docs) <comments-noreply@docs.google.com>', to: 'me@example.com' },
    { id: 'n4', date: '2026-09-08', from: 'Stéphane Moreau <calendar-notification@google.com>', to: 'me@example.com' },
    { id: 'n5', date: '2026-09-08', from: 'Stephane Moreau <bounces+123@mail.moreau.fr>', to: 'me@example.com' },
    { id: 'g1', date: '2026-09-09', from: 'Stéphane Moreau via Book-Club <book-club@googlegroups.com>', to: 'Book-Club <book-club@googlegroups.com>' },
    { id: 'g2', date: '2026-09-10', from: 'Stéphane Moreau via Book-Club <book-club@googlegroups.com>', to: 'book-club@googlegroups.com' },
    { id: 'm1', date: '2026-09-01', from: 'Stéphane Moreau <sm@moreau.fr>', to: 'me@example.com' },
    { id: 'm2', date: '2026-09-02', from: 'Octavia Stéphane <octavia@example.com>', to: 'me@example.com' },
  ];
  assert.deepEqual(emails((await find(messages, { query: 'Stéphane' })).out), ['octavia@example.com', 'sm@moreau.fr']);
  const group = (await find(messages, { query: 'book-club' })).out.contacts!;
  assert.deepEqual(
    group.map((c) => [c.email, c.name, c.messages, c.they_wrote]),
    [['book-club@googlegroups.com', 'Book-Club', 2, 2]],
  );
});

test('an address counts in every scanned message it appears in, named or not: the query matches the contact, not each mention', async () => {
  const messages: Msg[] = [
    { id: 'm3', date: '2026-09-03', from: 'Stéphane Moreau <sm@moreau.fr>', to: 'me@example.com' },
    { id: 'm4', date: '2026-09-04', from: 'me@example.com', to: 'sm@moreau.fr, Ann Stéphane <ann@x.fr>' },
  ];
  for (const query of ['Moreau', 'Stéphane']) {
    const sm = (await find(messages, { query })).out.contacts!.find((c) => c.email === 'sm@moreau.fr')!;
    assert.deepEqual([sm.name, sm.messages, sm.you_wrote, sm.they_wrote, sm.last_seen], ['Stéphane Moreau', 2, 1, 1, '2026-09-04'], query);
  }
});

test('punctuation around words and Gmail operators (OR, AND, a leading "-") are dropped from the query', async () => {
  const messages: Msg[] = [
    { id: 'm1', date: '2026-09-01', from: 'Stéphane Moreau <sm@moreau.fr>', to: 'me@example.com' },
    { id: 'm2', date: '2026-09-02', from: 'Paul Dupont <paul@dupont.fr>', to: 'me@example.com' },
  ];
  const comma = await find(messages, { query: 'Moreau, Stéphane.' });
  assert.deepEqual(emails(comma.out), ['sm@moreau.fr']);
  assert.equal(apiCalls(comma.ctx)[0]!.url.searchParams.get('q'), gmailQuery('Moreau Stéphane'));
  const negated = await find(messages, { query: '-Moreau' });
  assert.deepEqual(emails(negated.out), ['sm@moreau.fr']);
  assert.equal(apiCalls(negated.ctx)[0]!.url.searchParams.get('q'), gmailQuery('Moreau'));
  const or = await find(messages, { query: 'Stéphane OR Moreau AND <sm@moreau.fr>' });
  assert.deepEqual(emails(or.out), ['sm@moreau.fr']);
  assert.equal(apiCalls(or.ctx)[0]!.url.searchParams.get('q'), gmailQuery('Stéphane Moreau sm@moreau.fr'));
  assert.equal(cleanContactQuery('"Moreau", -Dupont; OR ...'), 'Moreau Dupont');
});

test('the account\'s own +tag, dotted and googlemail.com addresses are the account, not contacts', async () => {
  const ctx = createTestContext({
    google: (c: RecordedCall) => {
      const p = c.url.pathname.replace(GMAIL, '');
      if (p === '/settings/sendAs') return { json: { sendAs: [{ sendAsEmail: 'sam.sender@gmail.com', isPrimary: true }] } };
      if (p === '/messages') return { json: { messages: [{ id: 'm1', threadId: 't' }, { id: 'm2', threadId: 't2' }] } };
      if (p === '/messages/m1') return { json: metadata({ id: 'm1', date: '2026-09-01', from: 'Sam <samsender+devis@googlemail.com>', to: 'Sam Moreau <sm@moreau.example>' }) };
      if (p === '/messages/m2') return { json: metadata({ id: 'm2', date: '2026-09-02', from: 'Sam Moreau <sm@moreau.example>', to: 's.a.m.sender@gmail.com' }) };
      return undefined;
    },
    accounts: [{ alias: 'me', email: 'sam.sender@gmail.com' }],
  });
  const out = resultJson<Found>(await runTool(gmailFindContacts, { account: 'me', query: 'Sam' }, ctx));
  assert.deepEqual(emails(out), ['sm@moreau.example']);
  assert.equal(out.contacts![0]!.you_wrote, 1, 'mail from a +tag address counts as the account writing');
});
