import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { FollowupError, FollowupStore, MAX_OPEN_FOLLOWUPS } from './store.js';

function clock(start = Date.parse('2026-10-01T08:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const DAY = 24 * 60 * 60 * 1000;

/** Every stored byte of both tables, as one buffer to search for plaintext. */
function dump(db: Db): Buffer {
  const rows = [...db.prepare('SELECT * FROM followups').all(), ...db.prepare('SELECT * FROM followup_dismissals').all()] as Record<string, unknown>[];
  return Buffer.concat(rows.flatMap((r) => Object.values(r).map((v) => (v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v))))));
}

test('items are encrypted at rest: no title, step, notes, address or thread in the database', () => {
  const db = openDatabase(':memory:');
  const store = new FollowupStore(db, [randomBytes(32)]);
  const item = store.create({
    account: 'me',
    title: 'Procuration Kovačić',
    next_step: 'Envoyer la procuration aux traducteurs',
    notes: 'Maître Kovačić, Lisbonne',
    waiting_on: ['counsel@example.com'],
    watch_threads: [{ account: 'partner', thread_id: 'thread-secret-1' }],
    due: '2026-10-15',
  });
  assert.match(item.id, /^fu_[A-Za-z0-9_-]{12}$/);
  store.update(item.id, { arrived: { account: 'partner', thread_id: 't9', message_id: 'm9', from: 'Ivan Kovačić <counsel@example.com>', subject: 'Punomoćje', date: '2026-10-02T09:00:00.000Z' } });
  store.dismiss('me', 'thread-dismissed', 123);

  const raw = dump(db);
  for (const secret of ['Procuration', 'traducteurs', 'Kovač', 'counsel@example', 'thread-secret-1', 'Punomo']) {
    assert.ok(!raw.includes(secret), `${secret} is not stored in clear`);
  }
  const row = db.prepare('SELECT id, account, status, due_date FROM followups').get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { id: item.id, account: 'me', status: 'open', due_date: '2026-10-15' }, 'only ids, statuses and dates are plain');

  const back = store.get(item.id)!;
  assert.equal(back.title, 'Procuration Kovačić');
  assert.deepEqual(back.waiting_on, ['counsel@example.com']);
  assert.deepEqual(back.watch_threads, [{ account: 'partner', thread_id: 'thread-secret-1' }]);
  assert.equal(back.arrived?.subject, 'Punomoćje');
});

test('a blob moved to another row does not open there: it is bound to its item', () => {
  const db = openDatabase(':memory:');
  const store = new FollowupStore(db, [randomBytes(32)]);
  const a = store.create({ account: 'me', title: 'A' });
  const b = store.create({ account: 'me', title: 'B' });
  const blob = (db.prepare('SELECT data_enc FROM followups WHERE id = ?').get(a.id) as { data_enc: Uint8Array }).data_enc;
  db.prepare('UPDATE followups SET data_enc = ? WHERE id = ?').run(blob, b.id);
  assert.equal(store.get(b.id), undefined, 'refused');
  assert.deepEqual(store.list().map((i) => i.title), ['A']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM followups').get() as { n: number }).n, 2, 'nothing is deleted');
});

test('key rotation: the previous key still opens items, which move to the current key; a key that opens nothing hides them until one does', () => {
  const db = openDatabase(':memory:');
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const before = new FollowupStore(db, [oldKey]);
  const item = before.create({ account: 'me', title: 'Devis traduction', waiting_on: ['ann@example.com'] });

  const rotated = new FollowupStore(db, [newKey, oldKey]); // a deploy with TOKEN_ENCRYPTION_KEY_PREVIOUS set
  assert.equal(rotated.get(item.id)?.title, 'Devis traduction');
  // Re-encrypted at start: the previous key can go.
  const later = new FollowupStore(db, [newKey]);
  assert.equal(later.get(item.id)?.title, 'Devis traduction');
  assert.deepEqual(later.get(item.id)?.waiting_on, ['ann@example.com']);

  assert.equal(later.unreadable, 0);

  // A deploy with a wrong key (TOKEN_ENCRYPTION_KEY_PREVIOUS forgotten, a typo): nothing opens, nothing is lost.
  const wrong = new FollowupStore(db, [randomBytes(32)]);
  assert.equal(wrong.unreadable, 1);
  assert.equal(wrong.get(item.id), undefined);
  assert.deepEqual(wrong.list(), []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM followups').get() as { n: number }).n, 1, 'kept, unread');
  const fixed = new FollowupStore(db, [newKey]);
  assert.equal(fixed.get(item.id)?.title, 'Devis traduction', 'back once the key is');
  assert.equal(fixed.unreadable, 0);
});

test('update is partial: given fields change, null and [] clear, status done closes and open reopens', () => {
  const c = clock();
  const store = new FollowupStore(openDatabase(':memory:'), [randomBytes(32)], c.now);
  const item = store.create({ account: 'me', title: 'Quote', next_step: 'Pay deposit', notes: 'n', waiting_on: ['a@b.fr'], due: '2026-10-10' });
  c.advance(1000);
  const updated = store.update(item.id, { title: 'Quote (roof)', due: null, waiting_on: [], notes: undefined })!;
  assert.equal(updated.title, 'Quote (roof)');
  assert.equal(updated.next_step, 'Pay deposit');
  assert.equal(updated.notes, 'n');
  assert.equal(updated.due, undefined);
  assert.equal(updated.waiting_on, undefined);
  assert.equal(updated.updated_at, item.created_at + 1000);
  assert.equal(store.get(item.id)?.due, undefined, 'the cleared date is cleared in its column too');

  const closed = store.close(item.id)!;
  assert.equal(closed.status, 'done');
  assert.equal(closed.closed_at, c.now());
  assert.deepEqual(store.list({ status: 'open' }), []);
  assert.deepEqual(store.list({ status: 'done' }).map((i) => i.id), [item.id]);
  const reopened = store.update(item.id, { status: 'open' })!;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.closed_at, undefined);
  assert.equal(store.update('fu_missing', { title: 'x' }), undefined);
});

test('list filters by status and by account, a watched thread in the account counting too', () => {
  const store = new FollowupStore(openDatabase(':memory:'), [randomBytes(32)]);
  const mine = store.create({ account: 'me', title: 'mine' });
  const watching = store.create({ account: 'me', title: 'watching partner', watch_threads: [{ account: 'partner', thread_id: 't1' }] });
  const hers = store.create({ account: 'partner', title: 'hers' });
  assert.deepEqual(store.list({ accounts: ['partner'] }).map((i) => i.id), [watching.id, hers.id]);
  assert.deepEqual(store.list({ accounts: ['me'] }).map((i) => i.id), [mine.id, watching.id]);
  assert.deepEqual(store.list({ accounts: ['work'] }), []);
  assert.equal(store.list().length, 3);
});

test('closed items are purged after the housekeeping delay; open ones never', () => {
  const c = clock();
  const store = new FollowupStore(openDatabase(':memory:'), [randomBytes(32)], c.now);
  const old = store.create({ account: 'me', title: 'old' });
  const open = store.create({ account: 'me', title: 'open' });
  store.close(old.id);
  c.advance(31 * DAY);
  const recent = store.create({ account: 'me', title: 'recent', status: 'done' });
  assert.equal(store.purgeClosedBefore(c.now() - 30 * DAY), 1);
  assert.deepEqual(store.list().map((i) => i.id).sort(), [open.id, recent.id].sort());
});

test(`at most ${MAX_OPEN_FOLLOWUPS} open items: the next is refused with a clear message, closed ones do not count`, () => {
  const store = new FollowupStore(openDatabase(':memory:'), [randomBytes(32)]);
  const ids = Array.from({ length: MAX_OPEN_FOLLOWUPS }, (_, i) => store.create({ account: 'me', title: `item ${i}` }).id);
  assert.throws(() => store.create({ account: 'me', title: 'one too many' }), (e: Error) => e instanceof FollowupError && /200 follow-ups are already open.*status "done"/.test(e.message));
  assert.ok(store.create({ account: 'me', title: 'recorded as done', status: 'done' }));
  store.close(ids[0]!);
  const extra = store.create({ account: 'me', title: 'fits now' });
  assert.throws(() => store.update(ids[0]!, { status: 'open' }), FollowupError, 'reopening counts too');
  assert.equal(store.openCount(), MAX_OPEN_FOLLOWUPS);
  assert.ok(extra);
});

test('dismissals: kept by account and thread, replaced on repeat, removed by undismiss and by the purge', () => {
  const c = clock();
  const store = new FollowupStore(openDatabase(':memory:'), [randomBytes(32)], c.now);
  store.dismiss('me', 't1', 1000);
  store.dismiss('me', 't2', 2000, '2026-10-20');
  store.dismiss('partner', 't1', 3000);
  store.dismiss('me', 't1', 1500);
  assert.deepEqual(store.dismissals('me').get('t1'), { dismissedAt: c.now(), lastMessageMs: 1500, untilDate: undefined, draftOnly: undefined });
  assert.equal(store.dismissals('me').get('t2')?.untilDate, '2026-10-20');
  assert.equal(store.dismissals('partner').size, 1);
  assert.equal(store.undismiss('me', 't2'), true);
  assert.equal(store.undismiss('me', 't2'), false);
  c.advance(200 * DAY);
  store.dismiss('me', 'fresh', c.now());
  assert.equal(store.purgeDismissalsBefore(c.now() - 180 * DAY), 2);
  assert.deepEqual([...store.dismissals('me').keys()], ['fresh']);

  // A dismissal may hide only the thread's draft.
  store.dismiss('me', 'drafted', 4000, undefined, true);
  assert.deepEqual(store.dismissals('me').get('drafted'), { dismissedAt: c.now(), lastMessageMs: 4000, untilDate: undefined, draftOnly: true });
  store.dismiss('me', 'drafted', 4000);
  assert.equal(store.dismissals('me').get('drafted')?.draftOnly, undefined, 'a repeat without it hides the whole thread');
});

test('a database from before draft-only dismissals gets the column, its dismissals hiding whole threads as before', () => {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE followup_dismissals (
    account TEXT NOT NULL, thread_id TEXT NOT NULL, dismissed_at INTEGER NOT NULL, last_message_ms INTEGER NOT NULL, until_date TEXT,
    PRIMARY KEY (account, thread_id)
  )`);
  db.prepare('INSERT INTO followup_dismissals VALUES (?, ?, ?, ?, ?)').run('me', 't1', 1, 2, null);
  const store = new FollowupStore(db, [randomBytes(32)]);
  assert.deepEqual(store.dismissals('me').get('t1'), { dismissedAt: 1, lastMessageMs: 2, untilDate: undefined, draftOnly: undefined });
  new FollowupStore(db, [randomBytes(32)]);
});
