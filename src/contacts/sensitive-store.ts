/**
 * The owner's own list of sensitive contacts: addresses or whole domains marked
 * sensitive (with an optional note: "handles the lease dispute"), and ones
 * exempted from the built-in categories (a friendly notary). Addresses are
 * personal, so the list is one AES-256-GCM blob under a key derived for this
 * purpose only; the previous TOKEN_ENCRYPTION_KEY still opens it after a
 * rotation, and it is re-encrypted with the current key at start. A blob no
 * configured key opens is kept, unseen, until such a key is configured again.
 */
import type { Db } from '../db.js';
import { bytesKeyId, decryptBytes, DecryptError, deriveKey, encryptBytes, keyId } from '../crypto.js';

const CONTEXT = 'sensitive-contacts';
/** Entries kept at most, marked and exempt together. */
export const MAX_ENTRIES = 300;

export interface MarkedContact {
  /** Lower-case address, or "@domain" for a whole domain. */
  entry: string;
  note?: string;
  added_at: number;
}

export interface SensitiveList {
  marked: MarkedContact[];
  /** Lower-case addresses or "@domain": never sensitive, whatever their category. */
  exempt: string[];
}

export class SensitiveContactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SensitiveContactsError';
  }
}

const ADDRESS_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const DOMAIN_RE = /^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** "Jean <Jean@Cabinet.fr>", "jean@cabinet.fr" → "jean@cabinet.fr"; "cabinet.fr", "@cabinet.fr" → "@cabinet.fr". */
export function normalizeEntry(value: string): string {
  const v = value.trim().toLowerCase();
  const inBrackets = /<([^<>]+)>/.exec(v)?.[1]?.trim();
  const address = inBrackets ?? v;
  if (ADDRESS_RE.test(address)) return address;
  if (DOMAIN_RE.test(address)) return address.startsWith('@') ? address : `@${address}`;
  throw new SensitiveContactsError(`"${value.slice(0, 80)}" is neither an email address nor a domain (e.g. jean@cabinet.fr or cabinet.fr).`);
}

export class SensitiveContactsStore {
  private readonly keys: Buffer[];
  /** True when a stored list exists that no configured key opens (it is kept, and treated as empty). */
  readonly unreadable: boolean = false;

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => k !== undefined).map((k) => deriveKey(k, 'sensitive contacts v1'));
    if (!this.keys.length) throw new Error('SensitiveContactsStore needs an encryption key');
    db.exec(`CREATE TABLE IF NOT EXISTS sensitive_contacts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_enc BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const blob = this.blob();
    if (blob) {
      const kid = bytesKeyId(blob) ?? '';
      if (!this.keys.some((k) => keyId(k) === kid)) this.unreadable = true;
      else if (kid !== keyId(this.keys[0]!)) this.write(this.get());
    }
  }

  get(): SensitiveList {
    return this.read() ?? { marked: [], exempt: [] };
  }

  /** Whether the saved list can be read now: when it cannot, the guard treats every outside recipient as sensitive. */
  readable(): boolean {
    return this.read() !== undefined;
  }

  /** The list; undefined when one is saved that cannot be read (no configured key opens it, or it is damaged). */
  private read(): SensitiveList | undefined {
    const blob = this.blob();
    if (!blob) return { marked: [], exempt: [] };
    try {
      const v = JSON.parse(decryptBytes(blob, this.keys, CONTEXT).toString('utf8')) as Partial<SensitiveList>;
      return { marked: Array.isArray(v.marked) ? v.marked : [], exempt: Array.isArray(v.exempt) ? v.exempt : [] };
    } catch (err) {
      if (!(err instanceof DecryptError || err instanceof SyntaxError)) throw err;
      return undefined;
    }
  }

  /** Marks entries sensitive (a note replaces an earlier one); they leave the exempt list. */
  mark(entries: string[], note?: string): SensitiveList {
    const list = this.writable();
    for (const raw of entries) {
      const entry = normalizeEntry(raw);
      list.exempt = list.exempt.filter((e) => e !== entry);
      const existing = list.marked.find((m) => m.entry === entry);
      if (existing) existing.note = note?.trim() || existing.note;
      else list.marked.push({ entry, note: note?.trim() || undefined, added_at: this.now() });
    }
    return this.save(list);
  }

  /** Exempts entries from every category; they leave the marked list. */
  exempt(entries: string[]): SensitiveList {
    const list = this.writable();
    for (const raw of entries) {
      const entry = normalizeEntry(raw);
      list.marked = list.marked.filter((m) => m.entry !== entry);
      if (!list.exempt.includes(entry)) list.exempt.push(entry);
    }
    return this.save(list);
  }

  /** Takes entries off both lists: back to the built-in categories. */
  forget(entries: string[]): SensitiveList {
    const list = this.writable();
    const gone = new Set(entries.map(normalizeEntry));
    list.marked = list.marked.filter((m) => !gone.has(m.entry));
    list.exempt = list.exempt.filter((e) => !gone.has(e));
    return this.save(list);
  }

  private writable(): SensitiveList {
    // Writing over a list no key opens would lose it for good.
    if (this.unreadable || !this.readable()) throw new SensitiveContactsError('The saved list of sensitive contacts cannot be opened with the configured key; it is kept as it is until TOKEN_ENCRYPTION_KEY opens it again.');
    return this.get();
  }

  private save(list: SensitiveList): SensitiveList {
    if (list.marked.length + list.exempt.length > MAX_ENTRIES) throw new SensitiveContactsError(`At most ${MAX_ENTRIES} entries; forget some first.`);
    this.write(list);
    return list;
  }

  private blob(): Uint8Array | undefined {
    const row = this.db.prepare('SELECT data_enc FROM sensitive_contacts WHERE id = 1').get() as { data_enc: Uint8Array } | undefined;
    return row?.data_enc;
  }

  private write(list: SensitiveList): void {
    const blob = encryptBytes(Buffer.from(JSON.stringify(list), 'utf8'), this.keys[0]!, CONTEXT);
    this.db
      .prepare('INSERT INTO sensitive_contacts (id, data_enc, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at')
      .run(blob, this.now());
  }
}
